import { resolveDateRange } from './weekly-window.mjs';
import { detectCacheAnomalies } from './cache-anomalies.mjs';
import { build53WeekHeatmap, summarizeAnalytics } from './heatmap-health.mjs';
import { computeTurnCacheHit, isUsageStale, summarizeThreadUsageMetrics } from './usage-metrics.mjs';

export function createAnalyticsEngine({ store, settings, t3State, antigravityAdapter, codexAdapter, quotaAdapter }) {
  let lastSyncAtMs = 0;
  const SYNC_MIN_INTERVAL_MS = 1500;

  // Revision-keyed analytics cache so 50k+ rows are NOT re-loaded/re-sorted on every query (fixes P2 #15)
  let cachedRev = -1;
  let cachedAnomalyKey = '';
  let cachedAllRequests = [];
  let cachedAnomalyResult = null;
  let cachedFacets = null;
  const heatmapCache = new Map();
  const summaryCache = new Map();

  // Sliding-window streaming TPS sampler keyed by messageId (fixes P2 #12)
  const streamingSamples = new Map(); // messageId -> { chars, atMs, emaTps }

  function syncAll({ force = false } = {}) {
    const now = Date.now();
    if (!force && now - lastSyncAtMs < SYNC_MIN_INTERVAL_MS) return;
    lastSyncAtMs = now;
    try { antigravityAdapter.syncAll(); } catch {}
    try { codexAdapter.syncAll(); } catch {}
    // Reconcile stored requests whenever T3 Code resolves nativeSessionId -> t3ThreadId (fixes P1 #3)
    try {
      const idx = t3State.readThreadIndex();
      store.syncThreadLinks(idx.nativeToThread);
    } catch {}
  }

  function getCachedHistory(anomalyConfig) {
    const rev = store.getRevision();
    const aKey = JSON.stringify(anomalyConfig || {});
    if (cachedRev === rev && cachedAnomalyKey === aKey && cachedAnomalyResult) {
      return { allRequests: cachedAllRequests, anomalyResult: cachedAnomalyResult, facets: cachedFacets };
    }
    cachedAllRequests = store.listAllRequests();
    cachedAnomalyResult = detectCacheAnomalies(cachedAllRequests, anomalyConfig);

    const accountsSet = new Set();
    const modelsSet = new Set();
    const sessionsMap = new Map();
    for (const r of cachedAllRequests) {
      if (r.accountId) accountsSet.add(r.accountId);
      if (r.modelId) modelsSet.add(r.modelId);
      const sKey = r.t3ThreadId || r.nativeSessionId;
      if (sKey && !sessionsMap.has(sKey)) {
        sessionsMap.set(sKey, {
          id: sKey,
          title: r.t3ThreadTitle || r.nativeSessionId.slice(0, 16),
          accountId: r.accountId
        });
      }
    }
    cachedFacets = {
      accounts: [...accountsSet].sort(),
      models: [...modelsSet].sort(),
      sessions: [...sessionsMap.values()].slice(0, 100)
    };
    cachedRev = rev;
    cachedAnomalyKey = aKey;
    heatmapCache.clear();
    summaryCache.clear();
    return { allRequests: cachedAllRequests, anomalyResult: cachedAnomalyResult, facets: cachedFacets };
  }

  function sampleLiveStreamingTps(streaming, now) {
    if (!streaming?.active || !streaming.messageId || !streaming.chars) return null;
    const prev = streamingSamples.get(streaming.messageId);
    let tps = null;
    if (prev && streaming.chars > prev.chars) {
      const dtMs = Math.max(200, now - prev.atMs);
      const dChars = streaming.chars - prev.chars;
      const instTps = ((dChars / 3.2) * 1000) / dtMs;
      tps = prev.emaTps != null ? Number((prev.emaTps * 0.55 + instTps * 0.45).toFixed(1)) : Number(instTps.toFixed(1));
      streamingSamples.set(streaming.messageId, { chars: streaming.chars, atMs: now, emaTps: tps });
    } else if (prev) {
      tps = prev.emaTps;
    } else {
      streamingSamples.set(streaming.messageId, { chars: streaming.chars, atMs: now, emaTps: null });
    }
    if (streamingSamples.size > 16) {
      streamingSamples.delete(streamingSamples.keys().next().value);
    }
    return tps;
  }

  /**
   * Real-time thread snapshot powering Feature 1 & Feature 2.
   * Uses indexed DB lookup instead of loading full history (fixes P2 #15).
   * Respects `allowFallback: false` for desktop injected client (fixes P1 #2).
   */
  function getLiveThreadSnapshot(requestedThreadId = '', { now = Date.now(), allowFallback = true } = {}) {
    syncAll();
    const execution = t3State.readThreadExecution(requestedThreadId, now, { allowFallback });
    const quotas = quotaAdapter.readAllQuotas(now);

    let liveContext = null;
    if (execution && !execution.unresolved) {
      // Ordered natives already put selectedRun's resolved provider_thread first (fixes P1 #3)
      for (const n of execution.natives || []) {
        if (n.driver === 'antigravity') {
          liveContext = antigravityAdapter.readLiveContext(n.accountId, n.nativeSessionId);
          if (liveContext) break;
        } else if (n.driver === 'codex') {
          liveContext = codexAdapter.readLiveContext(n.nativeSessionId);
          if (liveContext) break;
        }
      }

      // Indexed lookup fallback (O(log N), never scans whole table) (fixes P2 #15)
      if (!liveContext) {
        const nativeIds = (execution.natives || []).map(n => n.nativeSessionId);
        const recentRows = typeof store.listRecentRequestsForThread === 'function'
          ? store.listRecentRequestsForThread(execution.threadId, nativeIds, 24)
          : (() => {
              const single = store.getLatestRequestForThread(execution.threadId, nativeIds);
              return single ? [single] : [];
            })();
        const hit = recentRows[0] || null;
        if (hit) {
          const sameSessionRows = recentRows.filter(r => r.nativeSessionId === hit.nativeSessionId);
          const usageSummary = summarizeThreadUsageMetrics(sameSessionRows, { now, lastRequestAtMs: hit.timestampMs });
          const turnCacheHit = computeTurnCacheHit(sameSessionRows, { newestFirst: true });
          const used = hit.contextUsedTokens ?? (hit.inputTokens + hit.cacheReadTokens + hit.cacheWriteTokens);
          const max = hit.contextMaxTokens;
          const resolvedTps = usageSummary.decodeSpeed ?? usageSummary.outputThroughput ?? hit.tps;
          const resolvedTpsKind = usageSummary.decodeSpeed != null
            ? 'generation'
            : (usageSummary.outputThroughput != null ? 'e2e-estimate' : hit.tpsKind);
          const resolvedTpsEstimated = usageSummary.decodeSpeed != null
            ? false
            : (usageSummary.outputThroughput != null ? true : hit.tpsEstimated);
          liveContext = {
            providerDriver: hit.providerDriver,
            accountId: hit.accountId,
            nativeSessionId: hit.nativeSessionId,
            modelRaw: hit.modelRaw,
            modelId: hit.modelId,
            usedTokens: used,
            maxTokens: max,
            usedPercent: max ? Number(((used / max) * 100).toFixed(1)) : null,
            categories: [],
            compactions: 0,
            cacheReadTokens: hit.cacheReadTokens,
            inputTokens: hit.inputTokens,
            outputTokens: hit.outputTokens,
            cacheHitPercent: turnCacheHit ?? hit.cacheHitPercent,
            ttftMs: usageSummary.ttftMs ?? hit.ttftMs,
            ttftSamples: usageSummary.ttftSamples,
            streamingMs: hit.streamingMs,
            durationMs: hit.durationMs,
            decodeSpeed: usageSummary.decodeSpeed,
            decodeSamples: usageSummary.decodeSamples,
            callTps: usageSummary.callTps,
            outputThroughput: usageSummary.outputThroughput,
            throughputSamples: usageSummary.throughputSamples,
            tps: resolvedTps,
            tpsKind: resolvedTpsKind,
            tpsEstimated: resolvedTpsEstimated,
            lastRequestAtMs: hit.timestampMs,
            cacheWindowMs: 300000
          };
        }
      }

      // Sliding-window live TPS ONLY when assistant message is actively streaming (fixes P2 #12)
      const liveTps = sampleLiveStreamingTps(execution.streaming, now);
      if (execution.streaming?.active && liveTps != null) {
        liveContext = {
          ...(liveContext || {
            providerDriver: execution.natives?.[0]?.driver || 'unknown',
            accountId: execution.accountId,
            modelRaw: execution.selectedModel,
            modelId: execution.selectedModel,
            usedTokens: null,
            maxTokens: null,
            usedPercent: null,
            categories: [],
            compactions: 0,
            cacheReadTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheHitPercent: null,
            ttftMs: null,
            ttftSamples: 0,
            streamingMs: null,
            durationMs: null,
            decodeSpeed: null,
            decodeSamples: 0,
            callTps: null,
            outputThroughput: null,
            throughputSamples: 0,
            lastRequestAtMs: now,
            cacheWindowMs: 300000
          }),
          liveStreaming: true,
          liveTps,
          tps: liveTps,
          tpsKind: 'live-stream',
          tpsEstimated: true,
          stale: false
        };
      }
    }

    if (liveContext) {
      liveContext.stale = isUsageStale(liveContext.lastRequestAtMs, now, Boolean(liveContext.liveStreaming));
    }
    if (liveContext && Number.isFinite(liveContext.lastRequestAtMs) && liveContext.cacheWindowMs) {
      const ageMs = Math.max(0, now - liveContext.lastRequestAtMs);
      liveContext.cacheAgeMs = ageMs;
      liveContext.cacheRemainingMs = Math.max(0, liveContext.cacheWindowMs - ageMs);
    }

    return {
      updatedAtMs: now,
      settings: settings.get(),
      thread: execution,
      context: liveContext,
      quotas
    };
  }

  /**
   * Full dashboard & request explorer data powering Features 3, 4, 5.
   * Anomaly detection runs over full chronological history for accurate baselines,
   * while badge counts (`anomalySummary`) are scoped to the currently selected filter! (fixes P3)
   */
  function getDashboardData(query = {}, { now = Date.now(), forceSync = false } = {}) {
    syncAll({ force: forceSync });
    const cfg = settings.get();
    const quotas = quotaAdapter.readAllQuotas(now);
    const { allRequests, anomalyResult, facets } = getCachedHistory(cfg.anomalyConfig);

    const preset = query.preset || cfg.defaultRangePreset || 'weeklyQuota';
    const accountFilter = query.account || 'all';
    const modelFilter = query.model || 'all';
    const statusFilter = query.status || 'all';
    const sessionFilter = String(query.session || '').trim().toLowerCase();
    const onlyAnomalies = query.onlyAnomalies === true || query.onlyAnomalies === '1' || query.onlyAnomalies === 'true';
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(200, Math.max(10, Number(query.pageSize) || 50));

    const accountScoped = accountFilter !== 'all'
      ? allRequests.filter(r => r.accountId === accountFilter)
      : allRequests;

    const range = resolveDateRange(preset, {
      now,
      customStart: query.start || '',
      customEnd: query.end || '',
      quotaWindows: quotas.flatWindows,
      accountId: accountFilter
    });

    const poolSig = (range.pools || []).map(p => `${p.key}:${p.state}:${p.startMs}:${p.resetsAtMs}`).join('|');
    const sumKey = `${store.getRevision()}::${accountFilter}::${range.preset}::${range.start}::${Math.floor(range.end / 10000)}::${poolSig}`;
    let summary = summaryCache.get(sumKey);
    if (!summary) {
      summary = summarizeAnalytics(accountScoped, range, anomalyResult.anomalies);
      summaryCache.set(sumKey, summary);
      if (summaryCache.size > 16) summaryCache.delete(summaryCache.keys().next().value);
    }

    const dayKey = new Date(now).toISOString().slice(0, 10);
    const hmKey = `${store.getRevision()}::${accountFilter}::${dayKey}`;
    let heatmap = heatmapCache.get(hmKey);
    if (!heatmap) {
      heatmap = build53WeekHeatmap(accountScoped, now);
      heatmapCache.set(hmKey, heatmap);
    }

    // Filter without onlyAnomalies first to compute exact scoped anomaly badge counts (fixes P3)
    const baseFiltered = accountScoped.filter(r => {
      if (!range.match(r)) return false;
      if (modelFilter !== 'all' && r.modelId !== modelFilter) return false;
      if (statusFilter === 'success' && r.status !== 'success') return false;
      if (statusFilter === 'error' && r.status !== 'error') return false;
      if (statusFilter === 'retried' && !(r.retries > 0)) return false;
      if (sessionFilter) {
        const hay = `${r.t3ThreadTitle || ''} ${r.t3ThreadId || ''} ${r.nativeSessionId || ''}`.toLowerCase();
        if (!hay.includes(sessionFilter)) return false;
      }
      return true;
    });

    let scopedCleared = 0, scopedDropped = 0, scopedMissed = 0, scopedExcluded = 0;
    for (const r of baseFiltered) {
      const a = anomalyResult.anomalies.get(r.id);
      if (a) {
        if (a.kind === 'cleared') scopedCleared++;
        else if (a.kind === 'dropped') scopedDropped++;
        else if (a.kind === 'missed') scopedMissed++;
      }
      if (anomalyResult.excludedCompactions.has(r.id)) scopedExcluded++;
    }

    const filteredRequests = onlyAnomalies
      ? baseFiltered.filter(r => anomalyResult.anomalies.has(r.id))
      : baseFiltered;

    const totalFiltered = filteredRequests.length;
    const startIdx = (page - 1) * pageSize;
    const pageItems = filteredRequests.slice(startIdx, startIdx + pageSize).map(r => ({
      ...r,
      cacheAnomaly: anomalyResult.anomalies.get(r.id) || null,
      excludedCompaction: anomalyResult.excludedCompactions.has(r.id)
    }));

    // Per-account usage totals within the currently selected range (for Account Quota cards)
    const accountUsage = {};
    for (const r of allRequests) {
      if (!range.match(r)) continue;
      const aid = r.accountId || 'unknown';
      let bucket = accountUsage[aid];
      if (!bucket) {
        bucket = { requests: 0, totalTokens: 0, costUsd: 0, errors: 0 };
        accountUsage[aid] = bucket;
      }
      bucket.requests++;
      bucket.totalTokens += (r.inputTokens || 0) + (r.cacheReadTokens || 0) + (r.cacheWriteTokens || 0) + (r.outputTokens || 0);
      bucket.costUsd += (r.costUsd || 0);
      if (r.status === 'error') bucket.errors++;
    }

    return {
      updatedAtMs: now,
      range: {
        preset: range.preset,
        status: range.status,
        start: range.start,
        end: range.end,
        resetsAtMs: range.resetsAtMs,
        pools: range.pools
      },
      quotas,
      accountUsage,
      summary,
      heatmap,
      anomalySummary: {
        total: scopedCleared + scopedDropped + scopedMissed,
        cleared: scopedCleared,
        dropped: scopedDropped,
        missed: scopedMissed,
        excludedCompactions: scopedExcluded,
        allHistoryTotal: anomalyResult.summary.total
      },
      facets,
      requests: {
        total: totalFiltered,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(totalFiltered / pageSize)),
        items: pageItems
      },
      diagnostics: {
        antigravity: antigravityAdapter.getDiagnostics?.() || {},
        codex: codexAdapter.getDiagnostics?.() || {}
      }
    };
  }

  return {
    syncAll,
    getLiveThreadSnapshot,
    getDashboardData
  };
}
