const DAY_MS = 24 * 60 * 60 * 1000;

function formatLocalDay(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Build a 53-week daily contribution heatmap ending today.
 */
export function build53WeekHeatmap(requests = [], now = Date.now()) {
  const endDate = new Date(now);
  endDate.setHours(0, 0, 0, 0);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - startDate.getDay() - 52 * 7);
  const startMs = +startDate;
  const endMs = +endDate + DAY_MS;

  const byDay = new Map();
  for (const r of requests) {
    const ts = Number.isFinite(r.billingTsMs) ? r.billingTsMs : r.timestampMs;
    if (!Number.isFinite(ts) || ts < startMs || ts >= endMs) continue;
    const key = formatLocalDay(ts);
    let bucket = byDay.get(key);
    if (!bucket) {
      bucket = { date: key, requests: 0, tokens: 0, costUsd: 0, errors: 0 };
      byDay.set(key, bucket);
    }
    bucket.requests++;
    bucket.tokens += (r.inputTokens || 0) + (r.cacheReadTokens || 0) + (r.cacheWriteTokens || 0) + (r.outputTokens || 0);
    if (Number.isFinite(r.costUsd)) bucket.costUsd += r.costUsd;
    if (r.status === 'error') bucket.errors++;
  }

  const days = [];
  let maxRequests = 0;
  let maxTokens = 0;
  let maxCost = 0;
  let activeDays = 0;

  for (let cur = new Date(startDate); +cur <= +endDate; cur.setDate(cur.getDate() + 1)) {
    const key = formatLocalDay(+cur);
    const data = byDay.get(key) || { date: key, requests: 0, tokens: 0, costUsd: 0, errors: 0 };
    data.costUsd = Number(data.costUsd.toFixed(4));
    data.weekday = cur.getDay();
    if (data.requests > 0) activeDays++;
    if (data.requests > maxRequests) maxRequests = data.requests;
    if (data.tokens > maxTokens) maxTokens = data.tokens;
    if (data.costUsd > maxCost) maxCost = data.costUsd;
    days.push(data);
  }

  return {
    startDate: days[0]?.date || '',
    endDate: days.at(-1)?.date || '',
    totalDays: days.length,
    activeDays,
    maxRequests,
    maxTokens,
    maxCost,
    days
  };
}

/**
 * Aggregate KPIs, model comparisons, and model health for a filtered range.
 * - Uses normalized input+cacheRead+cacheWrite denominator consistently (fixes P2 #11).
 * - Separates pure generation TPS vs end-to-end estimated TPS (fixes P2 #12).
 * - Computes health success rate over requests with known outcomes only (fixes P2 #14).
 */
export function summarizeAnalytics(requests = [], range, anomalyMap = new Map()) {
  const selected = requests.filter(r => range.match(r));

  let totalRequests = 0;
  let knownOutcomeCount = 0;
  let successCount = 0;
  let errorCount = 0;
  let retryRequests = 0;
  let totalInput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalOutput = 0;
  let totalThinking = 0;
  let totalCostUsd = 0;
  let totalSavedUsd = 0;
  let pricedCount = 0;
  let anomalyCount = 0;

  const modelMap = new Map();
  const errorBreakdown = {};

  function getOrCreateModel(modelId) {
    let m = modelMap.get(modelId);
    if (!m) {
      m = {
        modelId,
        requests: 0,
        knownOutcomeCount: 0,
        success: 0,
        errors: 0,
        retries: 0,
        retryRequests: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        savedUsd: 0,
        pricedCount: 0,
        genOutputTokens: 0,
        genDurationMs: 0,
        genPeakTps: null,
        e2eOutputTokens: 0,
        e2eDurationMs: 0,
        e2ePeakTps: null,
        ttftSum: 0,
        ttftCount: 0,
        anomalies: 0,
        errorCodes: {}
      };
      modelMap.set(modelId, m);
    }
    return m;
  }

  for (const r of selected) {
    totalRequests++;
    const inTok = r.inputTokens || 0;
    const cacheRead = r.cacheReadTokens || 0;
    const cacheWrite = r.cacheWriteTokens || 0;
    const outTok = r.outputTokens || 0;
    const thinkTok = r.thinkingTokens || 0;
    const tokSum = inTok + cacheRead + cacheWrite + outTok;

    totalInput += inTok;
    totalCacheRead += cacheRead;
    totalCacheWrite += cacheWrite;
    totalOutput += outTok;
    totalThinking += thinkTok;

    const m = getOrCreateModel(r.modelId || 'unknown');
    m.requests++;
    m.inputTokens += inTok;
    m.cacheReadTokens += cacheRead;
    m.cacheWriteTokens += cacheWrite;
    m.outputTokens += outTok;
    m.thinkingTokens += thinkTok;
    m.totalTokens += tokSum;

    const hasOutcome = r.outcomeKnown !== false && r.status !== 'recorded';
    if (hasOutcome) {
      knownOutcomeCount++;
      m.knownOutcomeCount++;
      if (r.status === 'error') {
        errorCount++;
        m.errors++;
        const code = r.errorCode || 'other';
        errorBreakdown[code] = (errorBreakdown[code] || 0) + 1;
        m.errorCodes[code] = (m.errorCodes[code] || 0) + 1;
      } else {
        successCount++;
        m.success++;
      }
    }

    if ((r.retries || 0) > 0) {
      retryRequests++;
      m.retryRequests++;
      m.retries += r.retries;
    }

    if (Number.isFinite(r.costUsd)) {
      totalCostUsd += r.costUsd;
      pricedCount++;
      m.costUsd += r.costUsd;
      m.pricedCount++;
    }
    if (Number.isFinite(r.savedUsd)) {
      totalSavedUsd += r.savedUsd;
      m.savedUsd += r.savedUsd;
    }

    // Track pure generation peaks and e2e estimate peaks independently so row order never affects peakTps (fixes P2 #12)
    if (r.tpsKind === 'generation' && Number.isFinite(r.streamingMs) && r.streamingMs > 0 && outTok > 0) {
      m.genOutputTokens += outTok;
      m.genDurationMs += r.streamingMs;
      const reqTps = (outTok * 1000) / r.streamingMs;
      if (m.genPeakTps == null || reqTps > m.genPeakTps) m.genPeakTps = Number(reqTps.toFixed(1));
    } else if (Number.isFinite(r.durationMs) && r.durationMs > 0 && outTok > 0) {
      m.e2eOutputTokens += outTok;
      m.e2eDurationMs += r.durationMs;
      const reqTps = (outTok * 1000) / r.durationMs;
      if (m.e2ePeakTps == null || reqTps > m.e2ePeakTps) m.e2ePeakTps = Number(reqTps.toFixed(1));
    }

    if (Number.isFinite(r.ttftMs) && r.ttftMs >= 0) {
      m.ttftSum += r.ttftMs;
      m.ttftCount++;
    }

    if (anomalyMap.has(r.id)) {
      anomalyCount++;
      m.anomalies++;
    }
  }

  const grandTokens = totalInput + totalCacheRead + totalCacheWrite + totalOutput;
  const totalInForCache = totalInput + totalCacheRead + totalCacheWrite;
  const overallCacheHitPercent = totalInForCache > 0
    ? Number(((totalCacheRead / totalInForCache) * 100).toFixed(1))
    : null;
  const overallSuccessRate = knownOutcomeCount > 0
    ? Number(((successCount / knownOutcomeCount) * 100).toFixed(1))
    : null;

  const models = [...modelMap.values()]
    .map(m => {
      const mIn = m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens;
      const cacheHitPercent = mIn > 0 ? Number(((m.cacheReadTokens / mIn) * 100).toFixed(1)) : null;

      let avgTps = null;
      let avgTpsKind = 'none';
      if (m.genDurationMs > 0) {
        avgTps = Number(((m.genOutputTokens * 1000) / m.genDurationMs).toFixed(1));
        avgTpsKind = 'generation';
      } else if (m.e2eDurationMs > 0) {
        avgTps = Number(((m.e2eOutputTokens * 1000) / m.e2eDurationMs).toFixed(1));
        avgTpsKind = 'e2e-estimate';
      }

      const avgTtftMs = m.ttftCount > 0 ? Math.round(m.ttftSum / m.ttftCount) : null;
      const successRate = m.knownOutcomeCount > 0 ? Number(((m.success / m.knownOutcomeCount) * 100).toFixed(1)) : null;
      const retryRate = m.knownOutcomeCount > 0 ? Number(((m.retryRequests / m.knownOutcomeCount) * 100).toFixed(1)) : null;
      const tokenSharePercent = grandTokens > 0 ? Number(((m.totalTokens / grandTokens) * 100).toFixed(1)) : 0;
      const costSharePercent = totalCostUsd > 0 && m.pricedCount > 0
        ? Number(((m.costUsd / totalCostUsd) * 100).toFixed(1))
        : 0;

      let healthStatus = 'unknown';
      if (m.knownOutcomeCount > 0) {
        if (successRate < 90 || retryRate >= 25) healthStatus = 'degraded';
        else if (successRate < 97 || retryRate >= 10) healthStatus = 'warning';
        else healthStatus = 'healthy';
      }

      return {
        modelId: m.modelId,
        requests: m.requests,
        knownOutcomeCount: m.knownOutcomeCount,
        success: m.success,
        errors: m.errors,
        retries: m.retries,
        retryRequests: m.retryRequests,
        successRate,
        retryRate,
        healthStatus,
        errorCodes: m.errorCodes,
        inputTokens: m.inputTokens,
        cacheReadTokens: m.cacheReadTokens,
        cacheWriteTokens: m.cacheWriteTokens,
        outputTokens: m.outputTokens,
        thinkingTokens: m.thinkingTokens,
        totalTokens: m.totalTokens,
        tokenSharePercent,
        costUsd: m.pricedCount > 0 ? Number(m.costUsd.toFixed(4)) : null,
        savedUsd: Number(m.savedUsd.toFixed(4)),
        costSharePercent,
        cacheHitPercent,
        avgTps,
        avgTpsKind,
        peakTps: m.genDurationMs > 0 ? m.genPeakTps : m.e2ePeakTps,
        avgTtftMs,
        anomalies: m.anomalies
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests);

  return {
    selectedCount: selected.length,
    kpis: {
      totalRequests,
      knownOutcomeCount,
      successCount,
      errorCount,
      retryRequests,
      successRate: overallSuccessRate,
      totalTokens: grandTokens,
      inputTokens: totalInput,
      cacheReadTokens: totalCacheRead,
      cacheWriteTokens: totalCacheWrite,
      outputTokens: totalOutput,
      thinkingTokens: totalThinking,
      cacheHitPercent: overallCacheHitPercent,
      costUsd: pricedCount > 0 ? Number(totalCostUsd.toFixed(4)) : (totalRequests === 0 ? 0 : null),
      savedUsd: Number(totalSavedUsd.toFixed(4)),
      anomalyCount
    },
    errorBreakdown,
    models
  };
}
