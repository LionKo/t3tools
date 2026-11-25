import { formatLocalDay } from './heatmap-health.mjs';

export function isErrorResolved(item, ackTsMs = 0, resolvedState = null) {
  if (!item) return false;
  const ts = Number(item.timestampMs ?? item.createdAtMs ?? 0);
  if (ackTsMs > 0 && ts <= ackTsMs) return true;
  if (!resolvedState) return false;
  if (item.id && resolvedState.ids?.has(String(item.id))) return true;
  if (resolvedState.sessions?.size) {
    for (const key of [item.t3ThreadId, item.nativeSessionId, item.sessionKey]) {
      if (!key) continue;
      const cutoff = resolvedState.sessions.get(String(key));
      if (cutoff != null && ts <= cutoff) return true;
    }
  }
  return false;
}

export function buildErrorInsights(rows, range, query = {}, models = [], ackTsMs = 0, now = Date.now(), resolvedState = null) {
  const sessions = new Map(), days = new Map(), hours = new Map(), successes = new Map();
  const recentErrors = [], byCode = Object.create(null), byCodeRecovered = Object.create(null);
  let totalErrors = 0, totalRetried = 0, totalRetriedRecovered = 0;
  let unreadCount = 0, unreadRecoveredCount = 0, resolvedCount = 0;

  const includeRetried = ![false, 'false', '0'].includes(query.includeRetried);
  const onlyToday = ![false, 'false', '0'].includes(query.errorOnlyToday);
  const todayDay = formatLocalDay(now);
  const explicitDay = String(query.day || '').trim();
  const effectiveDay = explicitDay || (onlyToday ? todayDay : '');

  // Store rows arrive newest first. Recovery uses the full account history.
  for (const r of rows) {
    const key = r.t3ThreadId || r.nativeSessionId;
    if (key && r.status === 'success' && !successes.has(key)) successes.set(key, r.timestampMs);
    const failed = r.status === 'error';
    const recoveredRetry = !failed && (r.retries || 0) > 0;
    if (!failed && !(includeRetried && recoveredRetry)) continue;
    if (!explicitDay && !onlyToday && !range.match(r)) continue;
    if (query.errorSession && query.errorSession !== key) continue;
    if (query.errorModel && query.errorModel !== 'all' && query.errorModel !== r.modelId) continue;
    const code = r.errorCode || 'other';
    if (query.errorCode && query.errorCode !== 'all' && query.errorCode !== code) continue;

    const date = formatLocalDay(r.timestampMs);
    if (!onlyToday || date === effectiveDay) {
      const day = days.get(date) || { date, total: 0, failed: 0, recovered: 0, byCode: Object.create(null) };
      days.set(date, day);
      day.total++;
      if (failed) day.failed++;
      else day.recovered++;
      day.byCode[code] = (day.byCode[code] || 0) + 1;
    }

    if (effectiveDay && effectiveDay !== date) continue;

    const resolved = isErrorResolved(r, ackTsMs, resolvedState);
    if (resolved) resolvedCount++;

    if (failed) {
      totalErrors++;
      byCode[code] = (byCode[code] || 0) + 1;
      if (!resolved) unreadCount++;
    } else if (recoveredRetry) {
      totalRetriedRecovered++;
      byCodeRecovered[code] = (byCodeRecovered[code] || 0) + 1;
      if (!resolved) unreadRecoveredCount++;
    }
    if ((r.retries || 0) > 0) totalRetried++;

    const hr = String(new Date(r.timestampMs).getHours()).padStart(2, '0');
    const hourBucket = hours.get(hr) || { hour: hr, label: `${hr}:00`, total: 0, failed: 0, recovered: 0, byCode: Object.create(null) };
    hours.set(hr, hourBucket);
    hourBucket.total++;
    if (failed) hourBucket.failed++;
    else hourBucket.recovered++;
    hourBucket.byCode[code] = (hourBucket.byCode[code] || 0) + 1;

    if (recentErrors.length < 50) recentErrors.push({ ...r, resolved });
    if (!key) continue;
    const session = sessions.get(key) || {
      sessionKey: key,
      t3ThreadId: r.t3ThreadId,
      nativeSessionId: r.nativeSessionId,
      title: r.t3ThreadTitle || key,
      accountId: r.accountId,
      models: [],
      errorCount: 0,
      recoveredCount: 0,
      incidentCount: 0,
      unresolvedCount: 0,
      retryCount: 0,
      lastErrorAtMs: r.timestampMs,
      latestErrorCode: code,
      latestErrorText: r.errorText,
      latestIsRecovered: recoveredRetry,
      state: failed ? 'failing' : 'recovered',
      errorCodes: Object.create(null),
      errorCodeStats: Object.create(null)
    };
    if (!session.models.includes(r.modelId)) session.models.push(r.modelId);
    if (failed) session.errorCount++;
    else if (recoveredRetry) session.recoveredCount++;
    session.incidentCount++;
    if (!resolved) session.unresolvedCount++;
    session.retryCount += r.retries || 0;
    session.firstErrorAtMs = r.timestampMs;
    session.errorCodes[code] = (session.errorCodes[code] || 0) + 1;
    const cStat = session.errorCodeStats[code] || { total: 0, failed: 0, recovered: 0 };
    cStat.total++;
    if (failed) cStat.failed++;
    else cStat.recovered++;
    session.errorCodeStats[code] = cStat;
    sessions.set(key, session);
  }

  const affectedSessions = [...sessions.values()];
  for (const s of affectedSessions) {
    const success = successes.get(s.sessionKey);
    s.lastSuccessAfterErrorAtMs = success > s.lastErrorAtMs ? success : null;
    if (s.lastSuccessAfterErrorAtMs) s.state = 'recovered';
    s.onlyRecoveredRetry = s.errorCount === 0 && s.recoveredCount > 0;
    s.resolved = s.unresolvedCount === 0;
  }
  const stateRank = s => (s.resolved ? -1 : s.state === 'failing' ? 2 : s.onlyRecoveredRetry ? 1 : 0);
  affectedSessions.sort((a, b) => stateRank(b) - stateRank(a) || b.lastErrorAtMs - a.lastErrorAtMs);

  const hourlyTrend = [...hours.values()].sort((a, b) => a.hour.localeCompare(b.hour));

  return {
    summary: {
      totalErrors,
      totalRetried,
      totalRetriedRecovered,
      totalIncidents: totalErrors + totalRetriedRecovered,
      unreadCount,
      unreadRecoveredCount,
      unreadIncidents: unreadCount + unreadRecoveredCount,
      resolvedCount,
      ackTsMs,
      todayDay,
      scopeDay: effectiveDay,
      isTodayScope: effectiveDay === todayDay && !explicitDay,
      byCode,
      byCodeRecovered,
      affectedThreads: sessions.size,
      activeBrokenThreads: affectedSessions.filter(s => s.state === 'failing' && !s.resolved).length
    },
    dailyTrend: [...days.values()].reverse(),
    hourlyTrend,
    affectedSessions,
    recentErrors,
    healthyAlternatives: models.filter(m => m.successRate >= 97 && m.knownOutcomeCount >= 5).map(m => m.modelId)
  };
}
