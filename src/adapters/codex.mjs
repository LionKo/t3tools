import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { findLatestUsageScanCache } from '../core/paths.mjs';
import { normalizeModelIdentity } from '../core/pricing.mjs';
import { classifyErrorCode } from './antigravity.mjs';
import { computeTurnCacheHit, summarizeThreadUsageMetrics } from '../analytics/usage-metrics.mjs';

export const HAS_NATIVE_ZSTD = typeof zlib.zstdDecompressSync === 'function';
const COLD_HYDRATE_LIMIT = 8;

function normalizeFsKey(p = '') {
  const r = resolve(String(p || ''));
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function canonicalRolloutFileName(filePath = '') {
  const base = String(filePath || '').split(/[\\/]/).pop() || '';
  const m = base.match(/^(rollout-.+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl)(?:\.zst)?$/i);
  return m ? m[1].toLowerCase() : '';
}

function walkFilesChecked(dir, predicate) {
  if (!dir || !existsSync(dir)) return { ok: false, files: [] };
  const files = [];
  let ok = true;
  function walk(cur) {
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      ok = false;
      return;
    }
    for (const e of entries) {
      const full = join(cur, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && predicate(e.name, full)) files.push(full);
    }
  }
  walk(dir);
  return { ok, files };
}

function readRolloutText(filePath) {
  const buf = readFileSync(filePath);
  if (filePath.endsWith('.zst')) {
    if (!HAS_NATIVE_ZSTD) return null;
    return zlib.zstdDecompressSync(buf).toString('utf8');
  }
  return buf.toString('utf8');
}

function extractRateLimitWindows(rl, observedAtMs) {
  if (!rl || typeof rl !== 'object') return [];
  const limitId = String(rl.limit_id || 'codex').trim() || 'codex';
  const out = [];
  for (const slot of ['primary', 'secondary']) {
    const w = rl[slot];
    if (w?.used_percent == null || !Number.isFinite(Number(w.used_percent))) continue;
    const mins = Number(w.window_minutes) || (slot === 'primary' ? 10080 : 300);
    out.push({
      limitId,
      slot,
      usedPercent: Number(w.used_percent),
      windowMinutes: mins,
      resetsAt: w.resets_at ?? null,
      observedAtMs
    });
  }
  return out;
}

function isRetryMessage(eventType = '', msg = '') {
  return /retry|reconnecting/i.test(String(eventType || '')) ||
    /\breconnecting\b|\bretrying\b|\bretry\s*\d+\s*\/\s*\d+/i.test(String(msg || ''));
}

/**
 * Parse a single Codex rollout .jsonl or .jsonl.zst file.
 * Fixes from Codex Astra re-review:
 * - Reconciles individual requests (not whole-file all-or-nothing), preserving legacy-only requests
 *   in mixed rollouts while avoiding double-counting paired ledger + token_count events (P1 #6).
 * - Uses originating `payload.thread_id` for inherited ledger records in forked rollouts so copied
 *   parent responses keep one canonical ID and are never double-billed (P1 #6).
 * - Does not let paired legacy notifications corrupt timing (`lastTurnStartMs`), live context, or
 *   consume retry markers ahead of the retained ledger row (P2 #12 & #14).
 * - Correlates "Reconnecting... 1/5" retry errors onto the subsequent request instead of counting
 *   them as separate failed requests (P2 #14).
 */
export function parseCodexRolloutContent(rawText, { filePath = '', pricing, threadLink = null } = {}) {
  if (!rawText) return { requests: [], latestContext: null, rateLimitWindows: [], nativeThreadId: '', accountId: 'codex' };
  const lines = rawText.split('\n');
  const fileIdMatch = filePath.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i);
  let nativeThreadId = fileIdMatch?.[1] || '';
  let currentModel = 'codex';
  let currentEffort = '';
  let currentTurnId = '';
  let lastContextWindow = null;
  let prevTotalTokens = -1;

  const rateLimitMap = new Map();
  const seenResponseIds = new Set();
  const rawEvents = [];

  // Pass 1: Extract ordered raw events without corrupting timing/retry state on paired duplicates
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    const tsMs = obj.timestamp ? Date.parse(obj.timestamp) : null;

    if (obj.type === 'session_meta' && obj.payload) {
      const metaId = String(obj.payload.id || obj.payload.thread_id || obj.payload.session_id || '').trim();
      if (metaId) nativeThreadId = metaId;
      continue;
    }

    if (obj.type === 'turn_context' && obj.payload) {
      if (obj.payload.model) currentModel = String(obj.payload.model);
      if (obj.payload.turn_id) currentTurnId = String(obj.payload.turn_id);
      const eff = obj.payload.collaboration_mode?.settings?.reasoning_effort || obj.payload.reasoning_effort || '';
      if (eff) currentEffort = String(eff);
      if (Number.isFinite(tsMs)) {
        rawEvents.push({ kind: 'turn_start', tsMs });
      }
      continue;
    }

    if (obj.type === 'compacted' || /compact/i.test(String(obj.payload?.type || ''))) {
      rawEvents.push({ kind: 'compaction', tsMs });
      continue;
    }

    if (obj.type === 'token_usage_record' && obj.payload) {
      const p = obj.payload;
      const originThreadId = String(p.thread_id || nativeThreadId || '').trim();
      if (!nativeThreadId && originThreadId) nativeThreadId = originThreadId;
      if (p.model) currentModel = String(p.model);
      if (Number(p.model_context_window) > 0) lastContextWindow = Number(p.model_context_window);
      const responseId = String(p.response_id || '').trim();
      if (responseId && seenResponseIds.has(responseId)) continue;
      const usage = p.usage || p.last_token_usage;
      if (!usage) continue;
      if (responseId) seenResponseIds.add(responseId);
      rawEvents.push({
        kind: 'ledger',
        tsMs: Number.isFinite(tsMs) ? tsMs : Date.now(),
        model: currentModel,
        turnId: String(p.turn_id || currentTurnId || ''),
        effort: currentEffort,
        originThreadId,
        responseId,
        usage,
        maxWindow: Number(p.model_context_window) > 0 ? Number(p.model_context_window) : lastContextWindow
      });
      continue;
    }

    if (obj.type === 'event_msg' && obj.payload?.type === 'token_count') {
      const info = obj.payload.info;
      const rl = obj.payload.rate_limits;
      if (rl && typeof rl === 'object') {
        for (const w of extractRateLimitWindows(rl, Number.isFinite(tsMs) ? tsMs : Date.now())) {
          const k = `${w.limitId}::${w.slot}`;
          const prev = rateLimitMap.get(k);
          if (!prev || w.observedAtMs >= prev.observedAtMs) {
            rateLimitMap.set(k, w);
          }
        }
      }
      if (Number(info?.model_context_window) > 0) {
        lastContextWindow = Number(info.model_context_window);
      }
      if (!info || !info.last_token_usage) continue;

      const totalTokensCum = Number(info.total_token_usage?.total_tokens);
      if (Number.isFinite(totalTokensCum) && totalTokensCum === prevTotalTokens) continue;
      if (Number.isFinite(totalTokensCum)) prevTotalTokens = totalTokensCum;

      rawEvents.push({
        kind: 'legacy',
        tsMs: Number.isFinite(tsMs) ? tsMs : Date.now(),
        model: currentModel,
        turnId: currentTurnId,
        effort: currentEffort,
        originThreadId: nativeThreadId,
        responseId: '',
        usage: info.last_token_usage,
        maxWindow: Number(info.model_context_window) > 0 ? Number(info.model_context_window) : lastContextWindow
      });
      continue;
    }

    if (obj.type === 'event_msg' && /error|retry|reconnect/i.test(String(obj.payload?.type || ''))) {
      const errMsg = String(obj.payload?.message || obj.payload?.error || '').trim();
      if (!errMsg) continue;
      rawEvents.push({
        kind: isRetryMessage(obj.payload?.type, errMsg) ? 'retry' : 'error',
        tsMs: Number.isFinite(tsMs) ? tsMs : Date.now(),
        model: currentModel,
        effort: currentEffort,
        errMsg
      });
    }
  }

  // Pass 2: Pair legacy token_count events with ledger records strictly on turn, model, and ALL 4 token counts (fixes P1 #6 & P2 #12)
  const ledgerIndices = [];
  for (let i = 0; i < rawEvents.length; i++) {
    if (rawEvents[i].kind === 'ledger') ledgerIndices.push(i);
  }
  const matchedLedger = new Set();
  const filteredEvents = [];

  for (let i = 0; i < rawEvents.length; i++) {
    const ev = rawEvents[i];
    if (ev.kind === 'legacy') {
      const u = ev.usage;
      const inTok = Number(u.input_tokens) || 0;
      const outTok = Number(u.output_tokens) || 0;
      const cRead = Number(u.cached_input_tokens) || 0;
      const cWrite = Number(u.cache_write_input_tokens) || 0;
      const evModel = normalizeModelIdentity(ev.model).id;
      let isPairedDuplicate = false;
      for (const li of ledgerIndices) {
        if (matchedLedger.has(li)) continue;
        const lev = rawEvents[li];
        const dt = Math.abs(ev.tsMs - lev.tsMs);
        const sameTurn = (!ev.turnId || !lev.turnId || ev.turnId === lev.turnId);
        const sameModel = normalizeModelIdentity(lev.model).id === evModel;
        if (
          dt <= 10000 &&
          sameTurn &&
          sameModel &&
          (Number(lev.usage.input_tokens) || 0) === inTok &&
          (Number(lev.usage.output_tokens) || 0) === outTok &&
          (Number(lev.usage.cached_input_tokens) || 0) === cRead &&
          (Number(lev.usage.cache_write_input_tokens) || 0) === cWrite
        ) {
          matchedLedger.add(li);
          // Propagate updated context window from paired notification onto ledger row (fixes P2 #12)
          if (ev.maxWindow && (!lev.maxWindow || ev.maxWindow > lev.maxWindow)) {
            lev.maxWindow = ev.maxWindow;
          }
          isPairedDuplicate = true;
          break;
        }
      }
      if (isPairedDuplicate) continue;
    }
    filteredEvents.push(ev);
  }

  // Pass 3: Build final normalized requests in strict chronological order from retained events ONLY
  const accountId = threadLink?.accountId || 'codex';
  const requests = [];
  let lastTurnStartMs = null;
  let pendingCompaction = false;
  let compactionCount = 0;
  let pendingRetries = 0;
  let pendingErrorText = '';
  let latestContext = null;
  let seq = 0;

  for (const ev of filteredEvents) {
    if (ev.kind === 'turn_start') {
      lastTurnStartMs = ev.tsMs;
      continue;
    }
    if (ev.kind === 'compaction') {
      pendingCompaction = true;
      compactionCount++;
      continue;
    }
    if (ev.kind === 'retry') {
      pendingRetries++;
      pendingErrorText = [pendingErrorText, ev.errMsg].filter(Boolean).join(' | ').slice(0, 1000);
      continue;
    }
    if (ev.kind === 'error') {
      seq++;
      const norm = normalizeModelIdentity(ev.model);
      const sid = nativeThreadId || filePath.split(/[\\/]/).pop() || 'codex';
      requests.push({
        id: `codex-err:${sid}:${ev.tsMs}:${seq}`,
        dedupeKey: null,
        providerDriver: 'codex',
        accountId,
        t3ThreadId: threadLink?.threadId || null,
        t3ThreadTitle: threadLink?.title || '',
        nativeSessionId: sid,
        modelId: norm.id,
        modelRaw: ev.model,
        effort: ev.effort || norm.effort,
        role: '',
        timestampMs: ev.tsMs,
        billingTsMs: ev.tsMs,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        contextUsedTokens: null,
        contextMaxTokens: null,
        ttftMs: null,
        streamingMs: null,
        durationMs: null,
        tps: null,
        tpsKind: 'none',
        tpsEstimated: false,
        costUsd: 0,
        savedUsd: 0,
        status: 'error',
        outcomeKnown: true,
        retries: pendingRetries,
        errorCode: classifyErrorCode(ev.errMsg),
        errorText: ev.errMsg.slice(0, 1000),
        compactionBefore: pendingCompaction
      });
      pendingCompaction = false;
      pendingRetries = 0;
      pendingErrorText = '';
      continue;
    }

    if (ev.kind === 'ledger' || ev.kind === 'legacy') {
      const usage = ev.usage;
      const totalInput = Math.max(0, Number(usage.input_tokens) || 0);
      const cacheRead = Math.max(0, Number(usage.cached_input_tokens) || 0);
      const cacheWrite = Math.max(0, Number(usage.cache_write_input_tokens) || 0);
      const uncachedInput = Math.max(0, totalInput - cacheRead - cacheWrite);
      const outputTokens = Math.max(0, Number(usage.output_tokens) || 0);
      const reasoningTokens = Math.max(0, Number(usage.reasoning_output_tokens) || 0);

      if (totalInput === 0 && outputTokens === 0) continue;

      seq++;
      const norm = normalizeModelIdentity(ev.model);
      const timestampMs = ev.tsMs;
      const durationMs = (lastTurnStartMs != null && timestampMs > lastTurnStartMs && (timestampMs - lastTurnStartMs) < 300000)
        ? (timestampMs - lastTurnStartMs)
        : null;
      const tps = durationMs != null && durationMs > 0 && outputTokens > 0
        ? Number(((outputTokens * 1000) / durationMs).toFixed(1))
        : null;
      lastTurnStartMs = timestampMs;

      const cost = pricing
        ? pricing.estimateRequestCost({
            modelId: norm.id,
            model: ev.model,
            inputTokens: uncachedInput,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
            outputTokens
          })
        : { costUsd: null, savedUsd: null };

      // Honor originating thread_id for inherited ledger rows so forks never double-bill parent responses (fixes P1 #6)
      const originSid = ev.originThreadId || nativeThreadId || filePath.split(/[\\/]/).pop() || 'codex';
      const dedupeKey = ev.responseId ? JSON.stringify(['codex', originSid, ev.responseId]) : null;
      const id = ev.responseId ? `codex:${originSid}:${ev.responseId}` : `codex:${originSid}:${timestampMs}:${seq}`;
      const resolvedMax = ev.maxWindow || lastContextWindow;

      requests.push({
        id,
        dedupeKey,
        providerDriver: 'codex',
        accountId,
        t3ThreadId: threadLink?.threadId || null,
        t3ThreadTitle: threadLink?.title || '',
        nativeSessionId: originSid,
        turnId: ev.turnId || '',
        modelId: norm.id,
        modelRaw: ev.model,
        effort: ev.effort || norm.effort,
        role: '',
        timestampMs,
        billingTsMs: timestampMs,
        inputTokens: uncachedInput,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        outputTokens,
        thinkingTokens: reasoningTokens,
        contextUsedTokens: totalInput,
        contextMaxTokens: resolvedMax,
        ttftMs: null,
        streamingMs: null,
        durationMs,
        tps,
        tpsKind: tps != null ? 'e2e-estimate' : 'none',
        tpsEstimated: true,
        costUsd: cost.costUsd,
        savedUsd: cost.savedUsd,
        status: 'success',
        outcomeKnown: true,
        retries: pendingRetries,
        errorCode: pendingRetries > 0 ? classifyErrorCode(pendingErrorText) : '',
        errorText: pendingRetries > 0 ? pendingErrorText.slice(0, 1000) : '',
        compactionBefore: pendingCompaction
      });

      const totalInForHit = uncachedInput + cacheRead + cacheWrite;
      const cacheHitPercent = totalInForHit > 0 ? Number(((cacheRead / totalInForHit) * 100).toFixed(1)) : null;
      latestContext = {
        providerDriver: 'codex',
        accountId,
        modelRaw: ev.model,
        modelId: norm.id,
        usedTokens: totalInput,
        maxTokens: resolvedMax,
        usedPercent: resolvedMax ? Number(((totalInput / resolvedMax) * 100).toFixed(1)) : null,
        categories: [
          { label: '缓存命中', tokens: cacheRead, percent: resolvedMax ? Number(((cacheRead / resolvedMax) * 100).toFixed(1)) : null },
          { label: '缓存写入', tokens: cacheWrite, percent: resolvedMax ? Number(((cacheWrite / resolvedMax) * 100).toFixed(1)) : null },
          { label: '新增输入', tokens: uncachedInput, percent: resolvedMax ? Number(((uncachedInput / resolvedMax) * 100).toFixed(1)) : null }
        ].filter(c => c.tokens > 0),
        compactions: 0,
        cacheReadTokens: cacheRead,
        inputTokens: uncachedInput,
        outputTokens,
        cacheHitPercent,
        ttftMs: null,
        streamingMs: null,
        durationMs,
        tps,
        tpsKind: tps != null ? 'e2e-estimate' : 'none',
        tpsEstimated: true,
        lastRequestAtMs: timestampMs,
        cacheWindowMs: 300000
      };

      pendingCompaction = false;
      pendingRetries = 0;
      pendingErrorText = '';
    }
  }

  if (latestContext) {
    const turnCacheHit = computeTurnCacheHit(requests);
    const usageSummary = summarizeThreadUsageMetrics(requests.slice().reverse());
    const resolvedThroughput = usageSummary.outputThroughput;
    latestContext = {
      ...latestContext,
      nativeSessionId: nativeThreadId,
      compactions: compactionCount,
      cacheHitPercent: turnCacheHit ?? latestContext.cacheHitPercent,
      decodeSpeed: usageSummary.decodeSpeed,
      decodeSamples: usageSummary.decodeSamples,
      ttftMs: usageSummary.ttftMs,
      ttftSamples: usageSummary.ttftSamples,
      callTps: usageSummary.callTps,
      outputThroughput: resolvedThroughput,
      throughputSamples: usageSummary.throughputSamples,
      tps: resolvedThroughput,
      tpsKind: resolvedThroughput != null ? 'e2e-estimate' : 'none',
      tpsEstimated: true
    };
  }

  return {
    requests,
    latestContext,
    rateLimitWindows: [...rateLimitMap.values()],
    nativeThreadId,
    accountId
  };
}

export function createCodexAdapter({ paths, store, pricing, t3State }) {
  const rolloutMetaCache = new Map(); // filePath -> { stamp, sessionId, accountId, defaultAccountId, requestCount, usageCount, latestContext, rateLimitWindows, hydrated }
  const rateLimitsByAccount = new Map();
  let skippedZstCount = 0;
  let lastRolloutDirsCount = 0;
  let lastRolloutFilesCount = 0;

  function resolveRolloutRoots() {
    const roots = [];
    const seen = new Set();

    function addDir(dir, defaultAccountId = 'codex') {
      if (!dir) return;
      const abs = resolve(dir);
      const key = normalizeFsKey(abs);
      if (seen.has(key)) return;
      seen.add(key);
      roots.push({ dir: abs, defaultAccountId: defaultAccountId || 'codex' });
    }

    // Primary configured paths: both active `sessions` and `archived_sessions`
    // (Codex moves finished/delegated rollouts into `archived_sessions/` and compresses older ones to `.jsonl.zst`)
    addDir(paths.codexSessionsDir, 'codex');
    addDir(paths.codexArchivedSessionsDir, 'codex');

    // Also discover any Codex provider instances with custom `config.homePath` in T3 settings.json
    const instances = t3State?.readProviderInstances?.();
    if (instances && typeof instances.values === 'function') {
      const byHome = new Map();
      for (const inst of instances.values()) {
        if (inst?.driver !== 'codex' || !inst.homePath) continue;
        const hKey = normalizeFsKey(inst.homePath);
        const prev = byHome.get(hKey);
        if (!prev || (inst.enabled && !prev.enabled)) {
          byHome.set(hKey, inst);
        }
      }
      for (const inst of byHome.values()) {
        addDir(join(inst.homePath, 'sessions'), inst.instanceId);
        addDir(join(inst.homePath, 'archived_sessions'), inst.instanceId);
      }
    }

    return roots;
  }

  function rebuildRateLimitsFromCache() {
    rateLimitsByAccount.clear();
    for (const meta of rolloutMetaCache.values()) {
      for (const w of meta.rateLimitWindows || []) {
        const key = `${meta.accountId}::${w.limitId}::${w.slot}`;
        const prev = rateLimitsByAccount.get(key);
        if (!prev || w.observedAtMs >= prev.observedAtMs) {
          rateLimitsByAccount.set(key, { ...w, accountId: meta.accountId });
        }
      }
    }
  }

  function hydrateRolloutFile(filePath, { stamp, guessedId, defaultAccountId, threadIndex }) {
    let rawText = null;
    try { rawText = readRolloutText(filePath); } catch { return { status: 'error' }; }
    if (rawText === null) return { status: 'skipped-zst' };

    const threadLink = guessedId ? threadIndex.nativeToThread.get(guessedId) : null;
    const parsed = parseCodexRolloutContent(rawText, { filePath, pricing, threadLink });
    const resolvedId = parsed.nativeThreadId || guessedId;
    const finalLink = (!threadLink && resolvedId) ? threadIndex.nativeToThread.get(resolvedId) : threadLink;
    const accountId = finalLink?.accountId || defaultAccountId || parsed.accountId || 'codex';
    for (const r of parsed.requests) {
      if (finalLink) {
        r.t3ThreadId = finalLink.threadId || r.t3ThreadId;
        r.t3ThreadTitle = finalLink.title || r.t3ThreadTitle;
      }
      r.accountId = accountId;
    }
    if (parsed.latestContext) parsed.latestContext.accountId = accountId;

    const usageCount = parsed.requests.filter(r => r.status !== 'error').length;
    const meta = {
      stamp,
      sessionId: resolvedId,
      accountId,
      defaultAccountId: defaultAccountId || 'codex',
      requestCount: parsed.requests.length,
      usageCount,
      latestContext: parsed.latestContext,
      rateLimitWindows: parsed.rateLimitWindows,
      hydrated: true
    };
    rolloutMetaCache.set(filePath, meta);
    return { status: 'ok', parsed, meta };
  }

  function syncRollouts(threadIndex) {
    const roots = resolveRolloutRoots();
    const discovered = [];
    const seenFiles = new Set();
    let existingDirCount = 0;

    for (const root of roots) {
      if (!existsSync(root.dir)) continue;
      existingDirCount++;
      const walked = walkFilesChecked(root.dir, name => /\.(jsonl|jsonl\.zst)$/i.test(name));
      if (!walked.ok) {
        return {
          enumerated: false,
          coveredFiles: new Set(),
          coveredRolloutNames: new Set(),
          coveredSessionIds: new Set(),
          coverageHash: 'unenumerated'
        };
      }
      for (const fp of walked.files) {
        const key = normalizeFsKey(fp);
        if (seenFiles.has(key)) continue;
        seenFiles.add(key);
        discovered.push({ filePath: fp, defaultAccountId: root.defaultAccountId });
      }
    }

    lastRolloutDirsCount = existingDirCount;
    lastRolloutFilesCount = discovered.length;

    if (existingDirCount === 0) {
      return {
        enumerated: false,
        coveredFiles: new Set(),
        coveredRolloutNames: new Set(),
        coveredSessionIds: new Set(),
        coverageHash: 'unenumerated'
      };
    }

    const activeSources = new Set();
    const activeFiles = new Set(discovered.map(d => d.filePath));
    const coveredFiles = new Set();
    const coveredRolloutNames = new Set();
    const coveredSessionIds = new Set();
    let skippedZst = 0;
    let rateLimitsDirty = false;

    for (const fp of rolloutMetaCache.keys()) {
      if (!activeFiles.has(fp)) {
        rolloutMetaCache.delete(fp);
        rateLimitsDirty = true;
      }
    }

    const entries = [];
    const coldUnchanged = [];

    for (const item of discovered) {
      const { filePath, defaultAccountId } = item;
      const sourceKey = `codex-rollout:${filePath}`;
      // Always keep enumerated existing file in activeSources so transient read failures never prune its rows (fixes P2 #16)
      activeSources.add(sourceKey);

      let stat;
      try { stat = statSync(filePath); } catch { continue; }
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      const fileIdMatch = filePath.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i);
      const guessedId = fileIdMatch?.[1] || '';

      const cachedMeta = rolloutMetaCache.get(filePath);
      const needStoreSync = store.getSourceStamp(sourceKey) !== stamp;
      const needMetaRefresh = cachedMeta?.stamp !== stamp;

      const entry = { filePath, sourceKey, defaultAccountId, stamp, mtimeMs: stat.mtimeMs, guessedId, cachedMeta, needStoreSync, needMetaRefresh };
      entries.push(entry);
      if (!needStoreSync && needMetaRefresh) {
        coldUnchanged.push(entry);
      }
    }

    // On daemon restart when SQLite is already populated, avoid decompressing hundreds of old archived files at boot:
    // hydrate only the newest files (for live rate limits) + files without a UUID in their filename, and defer the rest to lazy readLiveContext().
    const eagerColdHydrate = new Set();
    let sourceUsageCounts = null;
    if (coldUnchanged.length > 0 && typeof store.getSourceUsageCounts === 'function') {
      sourceUsageCounts = store.getSourceUsageCounts('codex-rollout:');
      const sortedCold = coldUnchanged.slice().sort((a, b) => b.mtimeMs - a.mtimeMs);
      let budgeted = 0;
      for (const e of sortedCold) {
        if (!e.guessedId) {
          eagerColdHydrate.add(e.filePath);
        } else if (budgeted < COLD_HYDRATE_LIMIT) {
          eagerColdHydrate.add(e.filePath);
          budgeted++;
        }
      }
    }

    function markCovered(filePath) {
      coveredFiles.add(filePath);
      const canon = canonicalRolloutFileName(filePath);
      if (canon) coveredRolloutNames.add(canon);
    }

    for (const entry of entries) {
      const { filePath, sourceKey, defaultAccountId, stamp, guessedId, cachedMeta, needStoreSync, needMetaRefresh } = entry;

      if (!needStoreSync && !needMetaRefresh) {
        // Reconcile account attribution if T3 mapping resolved a new accountId (fixes P1 #3 & #8)
        const linked = cachedMeta.sessionId ? threadIndex.nativeToThread.get(cachedMeta.sessionId) : null;
        if (linked?.accountId && linked.accountId !== cachedMeta.accountId) {
          cachedMeta.accountId = linked.accountId;
          if (cachedMeta.latestContext) cachedMeta.latestContext.accountId = linked.accountId;
          rateLimitsDirty = true;
        }
        if (cachedMeta.usageCount > 0) {
          markCovered(filePath);
        }
        continue;
      }

      if (!needStoreSync && sourceUsageCounts && !eagerColdHydrate.has(filePath)) {
        const linked = guessedId ? threadIndex.nativeToThread.get(guessedId) : null;
        const usageCount = sourceUsageCounts.get(sourceKey) || 0;
        rolloutMetaCache.set(filePath, {
          stamp,
          sessionId: guessedId,
          accountId: linked?.accountId || defaultAccountId || 'codex',
          defaultAccountId: defaultAccountId || 'codex',
          requestCount: usageCount,
          usageCount,
          latestContext: null,
          rateLimitWindows: [],
          hydrated: false
        });
        if (usageCount > 0) {
          markCovered(filePath);
        }
        continue;
      }

      const res = hydrateRolloutFile(filePath, { stamp, guessedId, defaultAccountId, threadIndex });
      if (res.status === 'skipped-zst') {
        skippedZst++;
        continue;
      }
      if (res.status !== 'ok') continue;

      rateLimitsDirty = true;
      if (needStoreSync) {
        store.replaceSourceRequests(sourceKey, stamp, res.parsed.requests);
      }
      // Only mark as covered when this rollout actually imported usage rows (never let error-only files suppress cached usage) (fixes P1 #7)
      if (res.meta.usageCount > 0) {
        markCovered(filePath);
      }
    }

    if (rateLimitsDirty) rebuildRateLimitsFromCache();
    skippedZstCount = skippedZst;
    store.pruneMissingSources('codex-rollout:', activeSources);

    // Content-based hash of actual covered files & stamps (fixes P1 #7 count-collision bug & P2 #15 perf)
    const covHash = createHash('sha256')
      .update([...coveredFiles].sort().map(f => `${f}:${rolloutMetaCache.get(f)?.stamp || ''}`).join('\n'))
      .digest('hex')
      .slice(0, 16);

    return { enumerated: true, coveredFiles, coveredRolloutNames, coveredSessionIds, coverageHash: covHash };
  }

  /**
   * Secondary multi-driver ingestion from T3 Code's usage-scan-cache-v*.json.
   * Uses content-based rollout coverage hash BEFORE reading dedupe keys (fixes P1 #7 & P2 #15).
   */
  function syncUsageScanCache(threadIndex, rolloutCoverage) {
    const latestCache = findLatestUsageScanCache(paths.t3UserData);
    if (!latestCache) return;

    let stat;
    try { stat = statSync(latestCache.path); } catch { return; }
    const stamp = `v${latestCache.version}:${stat.mtimeMs}:${stat.size}:cov=${rolloutCoverage.coverageHash}`;
    const sourceKey = 't3-usage-scan-cache';
    if (store.getSourceStamp(sourceKey) === stamp) return;

    let parsed;
    try { parsed = JSON.parse(readFileSync(latestCache.path, 'utf8')); } catch { return; }
    const ingestedDedupeKeys = store.getIngestedCodexDedupeKeys();
    const models = Array.isArray(parsed?.models) ? parsed.models : [];
    const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    const filesObj = parsed?.files && typeof parsed.files === 'object' ? parsed.files : {};

    const rows = [];
    for (const [fp, entry] of Object.entries(filesObj)) {
      const driver = String(entry?.p || 'unknown');
      const canonName = driver === 'codex' ? canonicalRolloutFileName(fp) : '';
      if (driver === 'codex' && (
        rolloutCoverage.coveredFiles.has(fp) ||
        rolloutCoverage.coveredFiles.has(`${fp}.zst`) ||
        (canonName && rolloutCoverage.coveredRolloutNames?.has(canonName))
      )) {
        continue;
      }

      const records = Array.isArray(entry?.r) ? entry.r : [];
      for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        if (!Array.isArray(rec) || rec.length < 8) continue;
        const timestampMs = Number(rec[0]) || 0;
        const modelRaw = String(models[rec[1]] || driver);
        const nativeSessionId = String(sessions[rec[2]] || fp);
        const dedupeKey = typeof rec[8] === 'string' && rec[8] ? rec[8] : '';

        if (driver === 'codex') {
          // Suppress ONLY by exact response dedupeKey (never by sessionId, so sibling files never suppress distinct cached requests) (fixes P1 #7)
          if (dedupeKey && ingestedDedupeKeys.has(dedupeKey)) continue;
        }

        const uncachedInput = Math.max(0, Number(rec[3]) || 0);
        const cacheRead = Math.max(0, Number(rec[4]) || 0);
        const cacheWrite = Math.max(0, Number(rec[5]) || 0);
        const outputTokens = Math.max(0, Number(rec[6]) || 0);
        const thinkingTokens = Math.max(0, Number(rec[7]) || 0);
        const reportedCost = Number.isFinite(Number(rec[9])) && rec[9] !== null ? Number(rec[9]) : null;

        const norm = normalizeModelIdentity(modelRaw);
        const threadLink = threadIndex.nativeToThread.get(nativeSessionId);
        const cost = pricing.estimateRequestCost({
          modelId: norm.id,
          model: modelRaw,
          inputTokens: uncachedInput,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          outputTokens,
          costUsd: reportedCost
        });

        rows.push({
          id: `t3scan:${dedupeKey || `${driver}:${nativeSessionId}:${timestampMs}:${i}`}`,
          dedupeKey: dedupeKey || null,
          providerDriver: driver,
          accountId: threadLink?.accountId || driver,
          t3ThreadId: threadLink?.threadId || null,
          t3ThreadTitle: threadLink?.title || '',
          nativeSessionId,
          modelId: norm.id,
          modelRaw,
          effort: norm.effort,
          role: '',
          timestampMs,
          billingTsMs: timestampMs,
          inputTokens: uncachedInput,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          outputTokens,
          thinkingTokens,
          contextUsedTokens: uncachedInput + cacheRead + cacheWrite,
          contextMaxTokens: null,
          ttftMs: null,
          streamingMs: null,
          durationMs: null,
          tps: null,
          tpsKind: 'none',
          tpsEstimated: false,
          costUsd: cost.costUsd,
          savedUsd: cost.savedUsd,
          status: 'recorded',
          outcomeKnown: false,
          retries: 0,
          errorCode: '',
          errorText: '',
          compactionBefore: false
        });
      }
    }

    store.replaceSourceRequests(sourceKey, stamp, rows);
  }

  function syncAll() {
    const threadIndex = t3State.readThreadIndex();
    const coverage = syncRollouts(threadIndex);
    syncUsageScanCache(threadIndex, coverage);
  }

  function readLiveContext(nativeSessionId) {
    if (!nativeSessionId) return null;
    let latest = null;
    let hydratedAny = false;
    for (const [filePath, meta] of rolloutMetaCache.entries()) {
      if (meta.sessionId !== nativeSessionId) continue;
      let resolvedMeta = meta;
      if (meta.hydrated === false) {
        const res = hydrateRolloutFile(filePath, {
          stamp: meta.stamp,
          guessedId: meta.sessionId,
          defaultAccountId: meta.defaultAccountId,
          threadIndex: t3State.readThreadIndex()
        });
        if (res.status === 'ok') {
          resolvedMeta = res.meta;
          if (res.meta.rateLimitWindows?.length) hydratedAny = true;
        }
      }
      if (resolvedMeta.latestContext &&
          (!latest || resolvedMeta.latestContext.lastRequestAtMs > latest.lastRequestAtMs)) {
        latest = resolvedMeta.latestContext;
      }
    }
    if (hydratedAny) rebuildRateLimitsFromCache();
    return latest;
  }

  function getRateLimitWindows(accountId = 'codex') {
    const out = [];
    for (const w of rateLimitsByAccount.values()) {
      if (!accountId || w.accountId === accountId) out.push(w);
    }
    return out;
  }

  return {
    syncAll,
    readLiveContext,
    getRateLimitWindows,
    getDiagnostics: () => ({
      hasNativeZstd: HAS_NATIVE_ZSTD,
      skippedZstCount,
      rolloutDirsCount: lastRolloutDirsCount,
      rolloutFilesCount: lastRolloutFilesCount
    })
  };
}
