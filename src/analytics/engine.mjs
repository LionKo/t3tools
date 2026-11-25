import { createErrorAlerts } from './error-alerts.mjs';
import { buildErrorInsights } from './error-insights.mjs';
import { buildRequestLedger } from './request-ledger.mjs';
import { resolveDateRange } from './weekly-window.mjs';
import { detectCacheAnomalies } from './cache-anomalies.mjs';
import { build53WeekHeatmap, formatLocalDay, summarizeAnalytics } from './heatmap-health.mjs';
import { computeTurnCacheHit, isUsageStale, summarizeThreadUsageMetrics } from './usage-metrics.mjs';

export function createAnalyticsEngine({ store, settings, t3State, antigravityAdapter, codexAdapter, quotaAdapter, runtimeUpdatesAdapter = null }) {
  const started = Date.now();
  const monitor = createErrorAlerts(started);
  let ackTsMs = Number(store.getMeta?.('error_ack_ts_ms')) || 0;
  let counts = { unreadCount: 0, unreadRecoveredCount: 0, unreadIncidents: 0, activeBrokenThreads: 0 };
  let countRevision = -1;
  let countDay = '';
  let cachedTodayKey = '';
  let cachedTodayRev = -1;
  let cachedTodayUsage = { day: '', costUsd: 0, totalTokens: 0, requests: 0 };

  function getTodayUsageSummary(now = Date.now()) {
    const dayKey = formatLocalDay(now);
    const rev = store.getRevision();
    if (cachedTodayRev === rev && cachedTodayKey === dayKey) {
      return cachedTodayUsage;
    }
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const startMs = +startOfToday;
    const endOfToday = new Date(startOfToday);
    endOfToday.setDate(endOfToday.getDate() + 1);
    const maxMs = Math.min(now, +endOfToday - 1);
    let summary;
    if (typeof store.getRangeUsageSummary === 'function') {
      summary = store.getRangeUsageSummary(startMs, maxMs);
    } else {
      const rows = store.listAllRequests();
      let requests = 0;
      let costUsd = 0;
      let totalTokens = 0;
      for (const r of rows) {
        const ts = Number.isFinite(r?.billingTsMs) ? r.billingTsMs : r?.timestampMs;
        if (!Number.isFinite(ts) || ts < startMs || ts > maxMs) continue;
        requests++;
        if (Number.isFinite(r.costUsd)) costUsd += r.costUsd;
        totalTokens += (r.inputTokens || 0) + (r.cacheReadTokens || 0) + (r.cacheWriteTokens || 0) + (r.outputTokens || 0);
      }
      summary = { requests, costUsd: Number(costUsd.toFixed(6)), totalTokens };
    }
    cachedTodayUsage = {
      day: dayKey,
      costUsd: summary.costUsd,
      totalTokens: summary.totalTokens,
      requests: summary.requests
    };
    cachedTodayKey = dayKey;
    cachedTodayRev = rev;
    return cachedTodayUsage;
  }

  function getRuntimeUpdates(now = Date.now(), options = {}) {
    if (!runtimeUpdatesAdapter) {
      return { updatedAtMs: now, checkedAtMs: null, checksEnabled: true, updateCount: 0, hasUpdates: false, items: [] };
    }
    try {
      return runtimeUpdatesAdapter.readRuntimeUpdates(now, options);
    } catch {
      return { updatedAtMs: now, checkedAtMs: null, checksEnabled: true, updateCount: 0, hasUpdates: false, items: [] };
    }
  }

  async function checkRuntimeUpdates(now = Date.now()) {
    if (!runtimeUpdatesAdapter) {
      return getRuntimeUpdates(now);
    }
    return runtimeUpdatesAdapter.checkNow(now);
  }
  function tickAlerts(now = Date.now()) {
    syncAll();
    const cfg = settings.get();
    const { allRequests } = getCachedHistory(cfg.anomalyConfig);
    const revision = store.getRevision();
    const todayKey = formatLocalDay(now);
    if (revision !== countRevision || countDay !== todayKey) {
      const { summary } = buildErrorInsights(allRequests, { match: () => true }, { errorOnlyToday: true, includeRetried: true }, [], ackTsMs, now);
      counts = {
        unreadCount: summary.unreadCount,
        unreadRecoveredCount: summary.unreadRecoveredCount,
        unreadIncidents: summary.unreadIncidents,
        activeBrokenThreads: summary.activeBrokenThreads
      };
      countRevision = revision;
      countDay = todayKey;
    }
    const since = Math.max(started, now - 1800000);
    const events = [];
    for (const row of allRequests) {
      if (row.timestampMs < since) break;
      if (row.status === 'error' || (row.retries > 0 && ['region','rate-limit'].includes(row.errorCode))) events.push(row);
    }
    let runs = [];
    try { runs = t3State.readFailedRuns?.(since) || []; } catch { /* T3 may be replacing its projection database. */ }
    monitor.evaluate(events.concat(runs), cfg.alertConfig, now);
  }
  function acknowledgeErrors(ts = Date.now()) {
    ackTsMs = Math.max(ts, ackTsMs);
    store.setMeta('error_ack_ts_ms', ackTsMs);
    countRevision = -1;
    tickAlerts();
    return { ackTsMs, unreadCount: counts.unreadCount };
  }
  const getAlerts = () => ({ ...counts, ...monitor.snapshot() });
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
      drivers: [...new Set(cachedAllRequests.map(r => r.providerDriver).filter(Boolean))].sort(),
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

    const threadErrors = execution?.threadId && !execution.unresolved
      ? store.listThreadIncidents?.(execution.threadId, (execution.natives || []).map(n => n.nativeSessionId), now - 1800000) || []
      : [];
    const currentUnread = execution?.threadId && !execution.unresolved
      ? store.countThreadUnread?.(execution.threadId, Math.max(ackTsMs, new Date(now).setHours(0, 0, 0, 0) - 1)) || 0 : 0;
    const todayUsage = getTodayUsageSummary(now);
    const runtimeUpdates = getRuntimeUpdates(now);
    return {
      updatedAtMs: now,
      settings: settings.get(),
      globalAlerts: { ...counts, otherUnreadCount: Math.max(0, counts.unreadCount - currentUnread), latestAlert: monitor.snapshot().latestAlert },
      threadErrors,
      thread: execution,
      context: liveContext,
      quotas,
      todayUsage,
      runtimeUpdates
    };
  }

  /**
   * Full dashboard & request explorer data powering Features 3, 4, 5.
   * Anomaly detection runs over full chronological history for accurate baselines,
   * while badge counts (`anomalySummary`) are scoped to the currently selected filter! (fixes P3)
   */
  function getDashboardData(query = {}, { now = Date.now(), forceSync = false, csvOnly = false } = {}) {
    syncAll({ force: forceSync });
    const cfg = settings.get();
    const quotas = quotaAdapter.readAllQuotas(now);
    const { allRequests, anomalyResult, facets } = getCachedHistory(cfg.anomalyConfig);

    const preset = query.preset || cfg.defaultRangePreset || 'weeklyQuota';
    const accountFilter = query.account || 'all';
    const requestedPage = Math.max(1, Math.trunc(Number(query.page)) || 1);
    const pageSize = Math.min(200, Math.max(10, Math.trunc(Number(query.pageSize)) || 50));

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

    const siblingRange = accountFilter === 'all' ? range : resolveDateRange(preset, {
      now, customStart: query.start, customEnd: query.end, quotaWindows: quotas.flatWindows, accountId: 'all'
    });
    const result = buildRequestLedger(allRequests, range, query, anomalyResult, csvOnly, siblingRange);
    if (csvOnly) return result;
    const { filtered, ledger, anomalies } = result;

    const hasRequestScopedFilter = Boolean(
      (query.model && query.model !== 'all') ||
      (query.driver && query.driver !== 'all') ||
      (query.sourceGroup && query.sourceGroup !== 'all') ||
      (query.status && query.status !== 'all') ||
      (query.errorCode && query.errorCode !== 'all') ||
      [true, 'true', '1'].includes(query.onlyAnomalies) ||
      String(query.session || query.q || '').trim() ||
      query.day ||
      query.requestId
    );
    const overviewLedger = hasRequestScopedFilter
      ? buildRequestLedger(allRequests, range, { account: accountFilter }, anomalyResult, false, siblingRange).ledger
      : ledger;

    const poolSig = (range.pools || []).map(p => `${p.key}:${p.state}:${p.startMs}:${p.resetsAtMs}`).join('|');
    const sumKey = `${store.getRevision()}::${accountFilter}::${range.preset}::${range.start}::${Math.floor(range.end / 10000)}::${poolSig}`;
    let summary = summaryCache.get(sumKey);
    if (!summary) {
      summary = summarizeAnalytics(accountScoped, range, anomalyResult.anomalies);
      summaryCache.set(sumKey, summary);
      if (summaryCache.size > 16) summaryCache.delete(summaryCache.keys().next().value);
    }

    const dayKey = formatLocalDay(now);
    const hmKey = `${store.getRevision()}::${accountFilter}::${dayKey}`;
    let heatmap = heatmapCache.get(hmKey);
    if (!heatmap) {
      heatmap = build53WeekHeatmap(accountScoped, now);
      heatmapCache.set(hmKey, heatmap);
      if (heatmapCache.size > 16) heatmapCache.delete(heatmapCache.keys().next().value);
    }

    const totalFiltered = filtered.length;
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(totalFiltered / pageSize)));
    const startIdx = (page - 1) * pageSize;
    const pageItems = filtered.slice(startIdx, startIdx + pageSize);

    // Per-account usage totals within the currently selected range (for Account Quota cards)
    const accountUsage = Object.create(null);
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

    const errorInsights = buildErrorInsights(accountScoped, range, query, summary.models, ackTsMs, now);
    const effectiveDay = errorInsights.summary.scopeDay;
    const failedRuns = monitor.snapshot().recentAlerts.filter(a => a.errorCode === 'failed');
    // A failed run may never have produced a provider request, including before daemon startup.
    if (query.errorSession && !failedRuns.some(a => a.t3ThreadId === query.errorSession)) {
      const thread = t3State.readThreadExecution?.(query.errorSession, now, { allowFallback: false });
      if (thread?.run?.status === 'failed') failedRuns.push({
        modelId: thread.selectedModel, accountId: thread.accountId, t3ThreadId: thread.threadId,
        t3ThreadTitle: thread.title, createdAtMs: thread.run.completedAtMs || thread.run.startedAtMs
      });
    }
    errorInsights.failedRuns = failedRuns.filter(a =>
      (effectiveDay ? effectiveDay === formatLocalDay(a.createdAtMs) : range.match({ timestampMs:a.createdAtMs, accountId:a.accountId, modelId:a.modelId })) &&
      (accountFilter === 'all' || accountFilter === a.accountId) &&
      (!query.errorSession || a.t3ThreadId === query.errorSession) &&
      (!query.errorModel || query.errorModel === 'all' || query.errorModel === a.modelId) &&
      (!query.errorCode || query.errorCode === 'all' || query.errorCode === 'failed'));
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
      errorInsights,
      accountUsage,
      summary,
      heatmap,
      anomalySummary: {
        ...anomalies,
        total: anomalies.cleared + anomalies.dropped + anomalies.missed,
        allHistoryTotal: anomalyResult.summary.total
      },
      facets,
      overviewLedger,
      requestsLedger: ledger,
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
    getAlerts, tickAlerts, acknowledgeErrors, testAlert: () => monitor.test(settings.get().alertConfig),
    getTodayUsageSummary,
    getRuntimeUpdates,
    checkRuntimeUpdates,
    getLiveThreadSnapshot,
    exportRequestsCsv: (query, options) => getDashboardData(query, { ...options, csvOnly: true }),
    getDashboardData
  };
}
