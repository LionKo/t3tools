/**
 * Short-interval prompt cache drop detector with strict chronological false-positive guards:
 * 1. Tracks cache warm-up strictly within each (accountId, nativeSessionId, modelId) in time order
 *    — never leaks future or cross-account cache hits into a cold session (fixes P1 #10).
 * 2. Processes compaction markers BEFORE status/size filters so even a small or failed request
 *    carrying `compactionBefore` resets the stale warm baseline (fixes P1 #10).
 * 3. Excludes cold starts, long intervals (> maxGapMs), and implicit context compaction
 *    (`curTotalIn < prevTotalIn * minKeepRatio`).
 */
export function detectCacheAnomalies(requests = [], config = {}) {
  const {
    maxGapMs = 180000,
    minPrevCache = 4000,
    minPrevHit = 50,
    minCurInput = 4000,
    minMissedInput = 16000,
    minKeepRatio = 0.6
  } = config || {};

  const anomalies = new Map();
  const excludedCompactions = new Set();

  if (!Array.isArray(requests) || requests.length === 0) {
    return { anomalies, excludedCompactions, summary: { total: 0, cleared: 0, dropped: 0, missed: 0, excludedCompactions: 0 } };
  }

  // Include ALL chronological records (even errors/small) so compaction markers always clear prior baselines
  const ordered = requests
    .filter(r => r && r.nativeSessionId && Number.isFinite(r.timestampMs))
    .slice()
    .sort((a, b) => a.timestampMs - b.timestampMs || String(a.id || '').localeCompare(String(b.id || '')));

  const lastBySeries = new Map();
  const warmedSeries = new Set(); // tracks whether THIS (account, session, model) has ever warmed cache in the past
  let cleared = 0, dropped = 0, missed = 0;

  for (const r of ordered) {
    const seriesKey = `${r.machineId || 'local'}::${r.accountId}::${r.nativeSessionId}::${r.modelId}`;

    // Always clear BOTH warm baseline AND warmedSeries on explicit compaction BEFORE status or size checks (fixes P1 #10)
    if (r.compactionBefore) {
      if (lastBySeries.has(seriesKey)) {
        excludedCompactions.add(r.id);
      }
      lastBySeries.delete(seriesKey);
      warmedSeries.delete(seriesKey);
      // Do not evaluate this compacted turn as a cache drop; allow it to start a new baseline below if valid
      if (r.status !== 'error') {
        const curIn = Math.max(0, r.inputTokens || 0);
        const curCache = Math.max(0, r.cacheReadTokens || 0);
        const curWrite = Math.max(0, r.cacheWriteTokens || 0);
        const curTotalIn = curIn + curCache + curWrite;
        if (curTotalIn >= 2000) {
          const curHit = Number(((curCache / curTotalIn) * 100).toFixed(1));
          if (curCache >= minPrevCache && curHit >= minPrevHit) warmedSeries.add(seriesKey);
          lastBySeries.set(seriesKey, { timestampMs: r.timestampMs, cache: curCache, hit: curHit, totalIn: curTotalIn, anomalous: false });
        }
      }
      continue;
    }

    if (r.status === 'error') continue;

    const curIn = Math.max(0, r.inputTokens || 0);
    const curCache = Math.max(0, r.cacheReadTokens || 0);
    const curWrite = Math.max(0, r.cacheWriteTokens || 0);
    const curTotalIn = curIn + curCache + curWrite;
    const curHit = curTotalIn > 0 ? Number(((curCache / curTotalIn) * 100).toFixed(1)) : null;

    const prev = lastBySeries.get(seriesKey);
    const hasWarmedInSeries = warmedSeries.has(seriesKey);
    let anomalous = false;

    if (prev && curHit != null) {
      const gapMs = r.timestampMs - prev.timestampMs;
      const isShortGap = gapMs >= 0 && gapMs <= maxGapMs;

      if (isShortGap) {
        // Check implicit context compaction BEFORE minCurInput threshold so large->small drops (e.g. 30k -> 3k) still clear baseline (fixes P2 #10)
        const isImplicitCompaction = curTotalIn < prev.totalIn * minKeepRatio;
        if (isImplicitCompaction) {
          excludedCompactions.add(r.id);
          lastBySeries.delete(seriesKey);
          warmedSeries.delete(seriesKey);
        } else if (curTotalIn >= minCurInput) {
          if (prev.cache >= minPrevCache && prev.hit >= minPrevHit) {
            if (curCache === 0) {
              anomalies.set(r.id, {
                kind: 'cleared',
                label: '缓存归零',
                gapMs,
                prevHit: prev.hit,
                curHit: 0,
                prevCache: prev.cache,
                curCache: 0,
                prevTotalIn: prev.totalIn,
                curTotalIn,
                reason: `间隔 ${Math.round(gapMs / 1000)}s，缓存从 ${prev.hit}% 归零`
              });
              cleared++;
              anomalous = true;
            } else if (prev.hit - curHit >= 40 && curHit < 20 && curCache < prev.cache * 0.5) {
              anomalies.set(r.id, {
                kind: 'dropped',
                label: '命中骤降',
                gapMs,
                prevHit: prev.hit,
                curHit,
                prevCache: prev.cache,
                curCache,
                prevTotalIn: prev.totalIn,
                curTotalIn,
                reason: `间隔 ${Math.round(gapMs / 1000)}s，命中率 ${prev.hit}% → ${curHit}%`
              });
              dropped++;
              anomalous = true;
            }
          } else if (
            curCache === 0 &&
            hasWarmedInSeries &&
            (prev.anomalous || prev.totalIn >= minMissedInput)
          ) {
            anomalies.set(r.id, {
              kind: 'missed',
              label: '连续未命中',
              gapMs,
              prevHit: prev.hit,
              curHit: 0,
              prevCache: prev.cache,
              curCache: 0,
              prevTotalIn: prev.totalIn,
              curTotalIn,
              reason: `间隔 ${Math.round(gapMs / 1000)}s，大上下文 (${Math.round(curTotalIn / 1000)}k) 持续未命中`
            });
            missed++;
            anomalous = true;
          }
        }
      }
    }

    if (curTotalIn >= 2000 && curHit != null) {
      if (curCache >= minPrevCache && curHit >= minPrevHit) {
        warmedSeries.add(seriesKey);
      }
      lastBySeries.set(seriesKey, {
        timestampMs: r.timestampMs,
        cache: curCache,
        hit: curHit,
        totalIn: curTotalIn,
        anomalous
      });
    }
  }

  return {
    anomalies,
    excludedCompactions,
    summary: {
      total: anomalies.size,
      cleared,
      dropped,
      missed,
      excludedCompactions: excludedCompactions.size
    }
  };
}
