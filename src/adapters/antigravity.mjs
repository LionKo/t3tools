import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  decodeFields,
  decodePackedVarints,
  durationOrTimestampMs,
  firstField,
  nestedFields,
  stringField
} from '../core/protobuf.mjs';
import { antigravityInstanceHash } from '../core/paths.mjs';
import { normalizeModelIdentity } from '../core/pricing.mjs';
import { computeTurnCacheHit, summarizeThreadUsageMetrics } from '../analytics/usage-metrics.mjs';

const ANTIGRAVITY_PARSE_VERSION = 'v2';

function dbStamp(dbPath) {
  return ANTIGRAVITY_PARSE_VERSION + '|' + [dbPath, `${dbPath}-wal`].map(p => {
    try {
      const s = statSync(p);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return '';
    }
  }).join('|');
}

function pickStepTimestampMs(stepTime, { preferEnd = false } = {}) {
  if (!stepTime) return null;
  const order = preferEnd
    ? [stepTime.completedMs, stepTime.finishedMs, stepTime.startedMs, stepTime.viewableMs, stepTime.createdMs]
    : [stepTime.createdMs, stepTime.startedMs, stepTime.viewableMs, stepTime.finishedMs, stepTime.completedMs];
  for (const ts of order) {
    if (Number.isFinite(ts) && ts > 0) return ts;
  }
  return null;
}

export function classifyErrorCode(raw = '') {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (/\b429\b|resource_exhausted|rate\s*limit|too\s+many\s+requests|quota/i.test(text)) return 'rate-limit';
  if (/\b403\b|permission_denied|permission denied|权限受限/i.test(text)) return 'region';
  if (/unexpected\s+eof|\beof\b|connection\s+reset|broken\s+pipe/i.test(text)) return 'eof';
  if (/context\s+deadline\s+exceeded|timeout|timed\s*out/i.test(text)) return 'timeout';
  if (/\b503\b|\b502\b|\b504\b|unavailable|overloaded|capacity|high\s+demand/i.test(text)) return 'unavailable';
  if (/\b403\b|region|location|country|not\s+available|unsupported/i.test(text)) return 'region';
  if (/econnrefused|proxy|tls|handshake|dns|no\s+such\s+host|network/i.test(text)) return 'connection';
  return 'other';
}

/**
 * Decode one Antigravity gen_metadata protobuf record.
 * Throws ProtobufDecodeError on truncated/corrupted wire data.
 */
export function decodeAntigravityGeneration(bytes) {
  const generation = decodeFields(bytes);
  const chat = nestedFields(generation, 1);
  const plannerConfig = nestedFields(generation, 3);
  const planExecute = nestedFields(plannerConfig, 60);
  const usage = nestedFields(chat, 4);
  const start = nestedFields(chat, 9);
  const context = nestedFields(start, 10);
  const breakdown = nestedFields(context, 3);

  const modelEnum = firstField(chat, 3, 0) || null;
  const executionModelEnum = firstField(planExecute, 1, 0) || null;

  const inputTokens = Number(firstField(usage, 2, 0)) || 0;
  const cacheReadTokens = Number(firstField(usage, 5, 0)) || 0;
  const outputTokens = Number(firstField(usage, 3, 0)) || 0;
  const thinkingTokens = Number(firstField(usage, 9, 0)) || 0;
  const responseTokens = Number(firstField(usage, 10, 0)) || 0;
  const hasProviderUsage = usage.has(2) || usage.has(5);

  let requestId = '';
  let lastStepIndex = null;
  for (const rawEntry of chat.get(20) || []) {
    const entry = decodeFields(rawEntry);
    const key = stringField(entry, 1);
    if (key === 'request_id') {
      requestId = stringField(entry, 2);
    } else if (key === 'last_step_index') {
      const parsedIdx = Number(stringField(entry, 2));
      if (Number.isInteger(parsedIdx) && parsedIdx >= 0) {
        lastStepIndex = parsedIdx;
      }
    }
  }

  const maxTokens = Number(firstField(context, 4, 0)) || 0;
  const estUsedTokens = Number(firstField(context, 1, 0)) || 0;
  const categories = maxTokens > 0
    ? (breakdown.get(1) || []).map((rawGroup, index) => {
        const group = decodeFields(rawGroup);
        const children = (group.get(5) || []).map(rawChild => {
          const child = decodeFields(rawChild);
          return { label: stringField(child, 1), tokens: Number(firstField(child, 3, 0)) || 0 };
        });
        return {
          key: `group-${index}`,
          label: stringField(group, 1),
          tokens: Number(firstField(group, 4, 0)) || 0,
          children
        };
      })
    : [];

  return {
    executionId: stringField(generation, 4),
    error: stringField(generation, 5),
    stepIndices: decodePackedVarints(generation.get(2) || []),
    lastStepIndex,
    modelRaw: stringField(chat, 21) || stringField(chat, 19),
    modelEnum,
    executionModelEnum,
    role: executionModelEnum ? (modelEnum === executionModelEnum ? 'execution' : 'planner') : '',
    providerInputTokens: hasProviderUsage ? inputTokens + cacheReadTokens : null,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    thinkingTokens,
    responseTokens,
    requestId,
    retries: Number(firstField(chat, 14, 0)) || 0,
    retryErrors: (chat.get(17) || []).map(b => stringField(decodeFields(b), 3)).filter(Boolean),
    ttftMs: durationOrTimestampMs(firstField(chat, 11)),
    streamingMs: durationOrTimestampMs(firstField(chat, 12)),
    context: maxTokens > 0
      ? { usedTokens: estUsedTokens, maxTokens, categories }
      : null
  };
}

const decodedDbCache = new Map();

export function readAntigravityConversationDb(dbPath) {
  if (!dbPath || !existsSync(dbPath)) return null;
  const stamp = dbStamp(dbPath);
  const cached = decodedDbCache.get(dbPath);
  if (cached && cached.stamp === stamp) return cached.value;

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000;');
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name)
    );
    if (!tables.has('gen_metadata')) return null;

    const generations = [];
    let malformedGenerations = 0;
    for (const row of db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx').all()) {
      try {
        generations.push({ index: row.idx, ...decodeAntigravityGeneration(row.data) });
      } catch {
        malformedGenerations++;
      }
    }

    const stepTimes = new Map();
    const compactionStepIndices = [];
    if (tables.has('steps')) {
      const cols = new Set(db.prepare('PRAGMA table_info(steps)').all().map(c => c.name));
      const query = cols.has('step_type')
        ? 'SELECT idx, step_type, metadata FROM steps ORDER BY idx'
        : 'SELECT idx, metadata FROM steps ORDER BY idx';
      for (const row of db.prepare(query).all()) {
        if (cols.has('step_type') && row.step_type === 23) {
          compactionStepIndices.push(row.idx);
        }
        try {
          const f = decodeFields(row.metadata);
          stepTimes.set(row.idx, {
            createdMs: durationOrTimestampMs(firstField(f, 1)),
            viewableMs: durationOrTimestampMs(firstField(f, 6)),
            finishedMs: durationOrTimestampMs(firstField(f, 7)),
            completedMs: durationOrTimestampMs(firstField(f, 8)),
            startedMs: durationOrTimestampMs(firstField(f, 32))
          });
        } catch {
          // ignore malformed step metadata
        }
      }
    }

    const value = { generations, stepTimes, compactionStepIndices, malformedGenerations };
    decodedDbCache.set(dbPath, { stamp, value });
    if (decodedDbCache.size > 24) {
      decodedDbCache.delete(decodedDbCache.keys().next().value);
    }
    return value;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

export function discoverAntigravityInstances(paths, providerInstancesMap) {
  const hashToInstance = new Map();
  for (const [instanceId, cfg] of providerInstancesMap.entries()) {
    if (cfg.driver === 'antigravity' || instanceId === 'antigravity') {
      hashToInstance.set(antigravityInstanceHash(instanceId), instanceId);
    }
  }
  if (!hashToInstance.has(antigravityInstanceHash('antigravity'))) {
    hashToInstance.set(antigravityInstanceHash('antigravity'), 'antigravity');
  }

  const root = paths.t3AntigravityProvidersDir;
  if (!root || !existsSync(root)) return { ok: false, complete: false, instances: [] };

  try {
    const result = [];
    let complete = true;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const acpDir = join(root, entry.name, 'antigravity-acp');
      const convDir = join(acpDir, 'conversations');
      if (!existsSync(convDir)) {
        // An instance folder exists but conversations subdir is temporarily absent -> do not prune!
        complete = false;
        continue;
      }
      const accountId = hashToInstance.get(entry.name) || `antigravity:${entry.name.slice(0, 8)}`;
      result.push({ hash: entry.name, accountId, acpDir, convDir });
    }
    return { ok: true, complete, instances: result };
  } catch {
    return { ok: false, complete: false, instances: [] };
  }
}

function computeAntigravityTps(g) {
  const out = Number(g.outputTokens) || 0;
  if (out <= 0) return { tps: null, tpsKind: 'none', tpsEstimated: false };
  // Prefer pure generation/streaming time when available (fixes P2 #12)
  if (Number.isFinite(g.streamingMs) && g.streamingMs > 0) {
    return {
      tps: Number(((out * 1000) / g.streamingMs).toFixed(1)),
      tpsKind: 'generation',
      tpsEstimated: false
    };
  }
  const totalMs = (Number.isFinite(g.ttftMs) ? g.ttftMs : 0) + (Number.isFinite(g.streamingMs) ? g.streamingMs : 0);
  if (totalMs > 0) {
    return {
      tps: Number(((out * 1000) / totalMs).toFixed(1)),
      tpsKind: 'e2e-estimate',
      tpsEstimated: true
    };
  }
  return { tps: null, tpsKind: 'none', tpsEstimated: false };
}

export function createAntigravityAdapter({ paths, store, pricing, t3State }) {
  // Retain malformed generation counts per source across unchanged sync passes (fixes P3 #22)
  const malformedBySource = new Map();

  function syncAll() {
    const providerInstances = t3State.readProviderInstances();
    const discovered = discoverAntigravityInstances(paths, providerInstances);
    if (!discovered.ok) return;

    const threadIndex = t3State.readThreadIndex();
    const activeSources = new Set();
    let allDirsEnumerated = discovered.complete;

    for (const inst of discovered.instances) {
      let files = [];
      try {
        files = readdirSync(inst.convDir).filter(f => f.endsWith('.db'));
      } catch {
        allDirsEnumerated = false;
        continue;
      }

      for (const file of files) {
        const nativeSessionId = file.slice(0, -3);
        const fullPath = join(inst.convDir, file);
        const sourceKey = `agy:${inst.accountId}:${nativeSessionId}`;
        activeSources.add(sourceKey);

        const stamp = dbStamp(fullPath);
        if (store.getSourceStamp(sourceKey) === stamp) continue;

        const parsed = readAntigravityConversationDb(fullPath);
        if (!parsed) {
          allDirsEnumerated = false;
          continue;
        }
        malformedBySource.set(sourceKey, parsed.malformedGenerations || 0);

        const threadLink = threadIndex.nativeToThread.get(nativeSessionId);
        const t3ThreadId = threadLink?.threadId || null;
        const t3ThreadTitle = threadLink?.title || '';

        const knownExecEnum = parsed.generations.find(g => g.executionModelEnum)?.executionModelEnum || null;
        const compactSteps = parsed.compactionStepIndices.slice().sort((a, b) => a - b);

        // Track last consumed compaction index so markers inside a previous generation's
        // step span are carried forward to the next generation (fixes P1 #10)
        let lastCheckedMinStep = -1;
        let fileBirthtimeMs = 0;
        let fileMtimeMs = 0;
        try {
          const st = statSync(fullPath);
          if (Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0) fileBirthtimeMs = Math.trunc(st.birthtimeMs);
          if (Number.isFinite(st.mtimeMs) && st.mtimeMs > 0) fileMtimeMs = Math.trunc(st.mtimeMs);
        } catch {}

        // Resolve immutable per-generation timestamps without letting moving file mtimeMs
        // rewrite historical failed generations (which have empty stepIndices) on later writes.
        const genAnchorTimes = parsed.generations.map(g => {
          const times = g.stepIndices.map(i => parsed.stepTimes.get(i)).filter(Boolean);
          const createdCandidates = times.map(t => pickStepTimestampMs(t, { preferEnd: false })).filter(Number.isFinite);
          if (createdCandidates.length) return Math.min(...createdCandidates);
          if (Number.isInteger(g.lastStepIndex)) {
            const anchorTs = pickStepTimestampMs(parsed.stepTimes.get(g.lastStepIndex), { preferEnd: true });
            if (Number.isFinite(anchorTs)) return anchorTs;
          }
          return null;
        });
        let firstStepTs = null;
        for (const t of parsed.stepTimes.values()) {
          const ts = pickStepTimestampMs(t, { preferEnd: false });
          if (Number.isFinite(ts) && (firstStepTs == null || ts < firstStepTs)) firstStepTs = ts;
        }
        const resolvedGenTimes = genAnchorTimes.slice();
        for (let idx = 0; idx < resolvedGenTimes.length; idx++) {
          if (Number.isFinite(resolvedGenTimes[idx])) continue;
          let neighborTs = null;
          for (let j = idx - 1; j >= 0; j--) {
            if (Number.isFinite(resolvedGenTimes[j])) { neighborTs = resolvedGenTimes[j]; break; }
          }
          if (!Number.isFinite(neighborTs)) {
            for (let j = idx + 1; j < resolvedGenTimes.length; j++) {
              if (Number.isFinite(resolvedGenTimes[j])) { neighborTs = resolvedGenTimes[j]; break; }
            }
          }
          resolvedGenTimes[idx] = neighborTs ?? firstStepTs ?? (fileBirthtimeMs || fileMtimeMs);
        }

        const rows = [];
        for (let gi = 0; gi < parsed.generations.length; gi++) {
          const g = parsed.generations[gi];
          if (!g.modelRaw && !g.error && !g.outputTokens) continue;
          const timestampMs = resolvedGenTimes[gi] || 0;

          const minStep = g.stepIndices.length ? Math.min(...g.stepIndices) : lastCheckedMinStep + 1;
          const compactionBefore = compactSteps.some(cs => cs > lastCheckedMinStep && cs <= minStep);
          lastCheckedMinStep = Math.max(lastCheckedMinStep, minStep);

          const norm = normalizeModelIdentity(g.modelRaw);
          const role = g.role || (knownExecEnum && g.modelEnum ? (g.modelEnum === knownExecEnum ? 'execution' : 'planner') : '');
          const durationMs = g.ttftMs != null && g.streamingMs != null
            ? g.ttftMs + g.streamingMs
            : (g.ttftMs ?? g.streamingMs ?? null);
          const billingTsMs = timestampMs + (Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0);
          const speed = computeAntigravityTps(g);

          const actualUsed = Number.isFinite(g.providerInputTokens) && g.providerInputTokens > 0
            ? g.providerInputTokens
            : (g.context?.usedTokens ?? null);
          const rawMax = g.context?.maxTokens > 0 ? g.context.maxTokens : null;
          const contextMaxTokens = rawMax != null && (actualUsed == null || actualUsed <= rawMax) ? rawMax : null;

          const cost = pricing.estimateRequestCost({
            modelId: norm.id,
            model: g.modelRaw,
            inputTokens: g.inputTokens,
            cacheReadTokens: g.cacheReadTokens,
            cacheWriteTokens: 0,
            outputTokens: g.outputTokens
          });

          const primaryError = g.error || g.retryErrors.join(' | ') || '';
          const status = g.error ? 'error' : 'success';
          // For failed Antigravity generations, chat[17] includes the final failed attempt itself.
          const retries = g.error
            ? Math.max(g.retries, Math.max(0, g.retryErrors.length - 1))
            : Math.max(g.retries, g.retryErrors.length);

          rows.push({
            id: g.requestId || `agy:${inst.accountId}:${nativeSessionId}:${g.index}`,
            dedupeKey: g.requestId || null,
            providerDriver: 'antigravity',
            accountId: inst.accountId,
            t3ThreadId,
            t3ThreadTitle,
            nativeSessionId,
            modelId: norm.id,
            modelRaw: g.modelRaw || norm.displayName,
            effort: norm.effort,
            role,
            timestampMs,
            billingTsMs,
            inputTokens: g.inputTokens,
            cacheReadTokens: g.cacheReadTokens,
            cacheWriteTokens: 0,
            outputTokens: g.outputTokens,
            thinkingTokens: g.thinkingTokens,
            contextUsedTokens: actualUsed,
            contextMaxTokens,
            ttftMs: g.ttftMs,
            streamingMs: g.streamingMs,
            durationMs,
            tps: speed.tps,
            tpsKind: speed.tpsKind,
            tpsEstimated: speed.tpsEstimated,
            costUsd: cost.costUsd,
            savedUsd: cost.savedUsd,
            status,
            outcomeKnown: true,
            retries,
            errorCode: classifyErrorCode(primaryError),
            errorText: primaryError.slice(0, 1000),
            compactionBefore
          });
        }

        store.replaceSourceRequests(sourceKey, stamp, rows);
      }
    }

    if (allDirsEnumerated) {
      store.pruneMissingSources('agy:', activeSources);
      for (const key of malformedBySource.keys()) {
        if (!activeSources.has(key)) malformedBySource.delete(key);
      }
    }
  }

  function readLiveContext(accountId, nativeSessionId) {
    if (typeof nativeSessionId !== 'string' || !nativeSessionId || /[\\/:\x00]/.test(nativeSessionId)) return null;
    const hash = antigravityInstanceHash(accountId || 'antigravity');
    const dbPath = join(paths.t3AntigravityProvidersDir, hash, 'antigravity-acp', 'conversations', `${nativeSessionId}.db`);
    const parsed = readAntigravityConversationDb(dbPath);
    if (!parsed || !parsed.generations.length) return null;

    const latest = [...parsed.generations].reverse().find(g => (g.providerInputTokens > 0) || (g.context?.usedTokens > 0));
    if (!latest) return null;

    const usedTokens = Number.isFinite(latest.providerInputTokens) && latest.providerInputTokens > 0
      ? latest.providerInputTokens
      : latest.context.usedTokens;
    const rawMax = latest.context?.maxTokens > 0 ? latest.context.maxTokens : null;
    const maxTokens = rawMax != null && usedTokens <= rawMax ? rawMax : null;
    const usedPercent = maxTokens ? Number(((usedTokens / maxTokens) * 100).toFixed(1)) : null;

    const rawCats = (latest.context?.categories || []).filter(c => c.tokens > 0);
    const estSum = rawCats.reduce((acc, c) => acc + c.tokens, 0);
    const categories = rawCats.map(c => {
      const tokens = estSum > 0 ? Math.round((usedTokens * c.tokens) / estSum) : c.tokens;
      return {
        label: c.label,
        tokens,
        percent: maxTokens ? Number(((tokens / maxTokens) * 100).toFixed(1)) : null
      };
    });

    const totalIn = latest.inputTokens + latest.cacheReadTokens;
    const latestCacheHitPercent = totalIn > 0 ? Number(((latest.cacheReadTokens / totalIn) * 100).toFixed(1)) : null;
    const durationMs = latest.ttftMs != null && latest.streamingMs != null
      ? latest.ttftMs + latest.streamingMs
      : (latest.ttftMs ?? latest.streamingMs ?? null);
    const speed = computeAntigravityTps(latest);

    const normalizedGens = parsed.generations.map(g => {
      const gDurationMs = g.ttftMs != null && g.streamingMs != null
        ? g.ttftMs + g.streamingMs
        : (g.ttftMs ?? g.streamingMs ?? null);
      return {
        executionId: g.executionId,
        status: g.error ? 'error' : 'success',
        inputTokens: g.inputTokens,
        cacheReadTokens: g.cacheReadTokens,
        cacheWriteTokens: 0,
        outputTokens: g.outputTokens,
        ttftMs: g.ttftMs,
        streamingMs: g.streamingMs,
        durationMs: gDurationMs
      };
    });
    const turnCacheHit = computeTurnCacheHit(normalizedGens);
    const cacheHitPercent = turnCacheHit ?? latestCacheHitPercent;
    const usageSummary = summarizeThreadUsageMetrics(normalizedGens.slice().reverse());

    const times = latest.stepIndices.map(i => parsed.stepTimes.get(i)).filter(Boolean);
    const lastTsCandidates = times.map(t => t.completedMs ?? t.finishedMs ?? t.createdMs).filter(Number.isFinite);
    const lastRequestAtMs = lastTsCandidates.length ? Math.max(...lastTsCandidates) : null;

    const resolvedTps = usageSummary.decodeSpeed ?? speed.tps;
    const resolvedTpsKind = usageSummary.decodeSpeed != null ? 'generation' : speed.tpsKind;
    const resolvedTpsEstimated = usageSummary.decodeSpeed != null ? false : speed.tpsEstimated;

    return {
      providerDriver: 'antigravity',
      accountId,
      nativeSessionId,
      modelRaw: latest.modelRaw,
      modelId: normalizeModelIdentity(latest.modelRaw).id,
      usedTokens,
      maxTokens,
      usedPercent,
      categories,
      compactions: parsed.compactionStepIndices.length,
      cacheReadTokens: latest.cacheReadTokens,
      inputTokens: latest.inputTokens,
      outputTokens: latest.outputTokens,
      cacheHitPercent,
      ttftMs: usageSummary.ttftMs ?? latest.ttftMs,
      ttftSamples: usageSummary.ttftSamples,
      streamingMs: latest.streamingMs,
      durationMs,
      decodeSpeed: usageSummary.decodeSpeed,
      decodeSamples: usageSummary.decodeSamples,
      callTps: usageSummary.callTps,
      outputThroughput: usageSummary.outputThroughput,
      throughputSamples: usageSummary.throughputSamples,
      tps: resolvedTps,
      tpsKind: resolvedTpsKind,
      tpsEstimated: resolvedTpsEstimated,
      lastRequestAtMs,
      cacheWindowMs: 300000
    };
  }

  return {
    syncAll,
    readLiveContext,
    getDiagnostics: () => ({
      malformedGenerations: [...malformedBySource.values()].reduce((a, b) => a + b, 0)
    })
  };
}
