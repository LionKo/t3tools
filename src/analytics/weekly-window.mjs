const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

function parseLocalDateTimeSpec(spec, { isEnd = false } = {}) {
  const m = String(spec || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/);
  if (!m) return NaN;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const base = new Date(y, mo - 1, d, 0, 0, 0, 0);
  if (base.getFullYear() !== y || base.getMonth() !== mo - 1 || base.getDate() !== d) return NaN;

  if (m[4] == null) {
    if (isEnd) base.setDate(base.getDate() + 1);
    return +base;
  }
  const hh = Number(m[4]);
  const mm = Number(m[5]);
  if (hh === 24 && mm === 0) {
    base.setDate(base.getDate() + 1);
    return +base;
  }
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return NaN;
  base.setHours(hh, mm, 0, 0);
  return +base;
}

function requestPoolKey(req) {
  if (req.providerDriver === 'codex') return 'codex';
  const m = String(req.modelId || req.modelRaw || '').toLowerCase();
  if (/argon/.test(m)) return 'argon';
  if (/claude|gpt/.test(m)) return '3p';
  if (/gemini|orchestrator/.test(m)) return 'gemini';
  return '';
}

/**
 * Resolve the current weekly quota cycle window from live/cached quota windows.
 * - Uses each request's single canonical `billingTsMs` (never double-adds duration).
 * - Applies trailing 7-day fallback independently to unmatched or stale/expired pools
 *   instead of letting an unrelated account's pool or a stale reset leak old history.
 */
export function resolveWeeklyQuotaWindow({ quotaWindows = [], accountId = '', now = Date.now() } = {}) {
  const fallbackStart = now - WEEK_MS;
  const scoped = quotaWindows.filter(w =>
    w.kind === 'weekly' &&
    (!accountId || accountId === 'all' || w.accountId === accountId)
  );

  const poolMap = new Map();

  for (const w of scoped) {
    const durationMs = Number.isFinite(w.windowDurationMins) && w.windowDurationMins > 0
      ? w.windowDurationMins * 60 * 1000
      : WEEK_MS;
    const resetsAtMs = Number.isFinite(w.resetsAtMs) ? w.resetsAtMs : null;
    let state = 'unstarted';
    let startMs = null;

    if (resetsAtMs != null) {
      if (resetsAtMs > now) {
        state = 'active';
        startMs = resetsAtMs - durationMs;
      } else {
        // Stale reset in the past: match the advertised trailing 7-day fallback window cleanly (fixes P1 #9)
        state = 'expired';
        startMs = fallbackStart;
      }
    }

    const pool = {
      key: `${w.accountId}::${w.poolKey}`,
      accountId: w.accountId,
      poolKey: w.poolKey,
      label: w.label,
      state,
      startMs,
      resetsAtMs,
      usedPercent: w.usedPercent,
      remainingPercent: w.remainingPercent
    };
    const stateRank = { active: 3, expired: 2, unstarted: 1 };
    const existing = poolMap.get(pool.key);
    const shouldReplace = !existing ||
      stateRank[pool.state] > stateRank[existing.state] ||
      (pool.state === existing.state && (pool.resetsAtMs || 0) > (existing.resetsAtMs || 0));

    if (shouldReplace) {
      poolMap.set(pool.key, pool);
    }
  }

  const pools = [...poolMap.values()];

  const activePools = pools.filter(p => p.state === 'active' && Number.isFinite(p.startMs));
  let status = 'fallback';
  let start = fallbackStart;
  let resetsAtMs = null;

  if (activePools.length > 0) {
    status = 'active';
    start = Math.min(...activePools.map(p => p.startMs));
    resetsAtMs = Math.min(...activePools.map(p => p.resetsAtMs));
  }

  function match(req) {
    if (!req) return false;
    const billedAt = Number.isFinite(req.billingTsMs) ? req.billingTsMs : req.timestampMs;
    if (!Number.isFinite(billedAt) || billedAt > now) return false;
    if (accountId && accountId !== 'all' && req.accountId !== accountId) return false;

    const pKey = requestPoolKey(req);
    let pool = pKey ? poolMap.get(`${req.accountId}::${pKey}`) : null;
    // Support named Codex limit pools (e.g. `codex:pro` / `codex:plus`) when no default `codex` pool exists on this account (fixes P1 #9)
    if (!pool && pKey === 'codex') {
      const namedCodexPools = pools.filter(p => p.accountId === req.accountId && p.poolKey.startsWith('codex:'));
      if (namedCodexPools.length === 1) {
        pool = namedCodexPools[0];
      } else if (namedCodexPools.length > 1) {
        const activeNamed = namedCodexPools.filter(p => p.state === 'active' && Number.isFinite(p.startMs));
        if (activeNamed.length) {
          pool = activeNamed.reduce((best, p) => (p.startMs > best.startMs ? p : best), activeNamed[0]);
        }
      }
    }
    if (pool) {
      if (pool.state === 'active' && Number.isFinite(pool.startMs)) {
        return billedAt >= pool.startMs;
      }
      if (pool.state === 'expired' && Number.isFinite(pool.startMs)) {
        return billedAt >= pool.startMs;
      }
      // Unstarted pool falls back to trailing 7 days for its own requests
      return billedAt >= fallbackStart;
    }

    // Unmatched pools/accounts ALWAYS use their own trailing 7-day fallback,
    // never inheriting another account's active pool start (fixes P1 #9)
    return billedAt >= fallbackStart;
  }

  return {
    preset: 'weeklyQuota',
    status,
    start,
    end: now,
    resetsAtMs,
    pools,
    match
  };
}

export function resolveDateRange(preset = 'weeklyQuota', { now = Date.now(), customStart = '', customEnd = '', quotaWindows = [], accountId = '' } = {}) {
  if (preset === 'weeklyQuota') {
    return resolveWeeklyQuotaWindow({ quotaWindows, accountId, now });
  }
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  let start = +startOfToday;
  let end = now;
  let status = 'calendar';
  let exclusiveEnd = false;
  const rawPreset = String(preset || '');
  const hoursMatch = rawPreset.match(/^last:(\d+)h$/);
  const rangeIdx = rawPreset.indexOf('..');

  if (rawPreset === 'today') {
    start = +startOfToday;
  } else if (rawPreset === '24h') {
    start = now - DAY_MS;
    status = 'rolling';
  } else if (rawPreset === 'week') {
    const d = new Date(startOfToday);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    start = +d;
  } else if (rawPreset === '7d') {
    start = now - WEEK_MS;
    status = 'rolling';
  } else if (rawPreset === '30d') {
    const d = new Date(startOfToday);
    d.setDate(d.getDate() - 29);
    start = +d;
  } else if (rawPreset === 'all') {
    start = 0;
  } else if (hoursMatch) {
    const hours = Number(hoursMatch[1]);
    if (Number.isInteger(hours) && hours >= 1 && hours <= 720) {
      start = now - hours * HOUR_MS;
      status = 'rolling';
    } else {
      start = now - DAY_MS;
      status = 'rolling';
    }
  } else if (rangeIdx > 0) {
    const fromSpec = rawPreset.slice(0, rangeIdx);
    const toSpec = rawPreset.slice(rangeIdx + 2);
    const a = parseLocalDateTimeSpec(fromSpec, { isEnd: false });
    const b = parseLocalDateTimeSpec(toSpec, { isEnd: true });
    if (Number.isFinite(a) && Number.isFinite(b) && a < b) {
      start = a;
      end = b;
      status = 'custom';
      exclusiveEnd = true;
    } else {
      start = now - DAY_MS;
    }
  } else if (rawPreset === 'custom' && customStart && customEnd) {
    const a = parseLocalDateTimeSpec(customStart, { isEnd: false });
    const b = parseLocalDateTimeSpec(customEnd, { isEnd: true });
    if (Number.isFinite(a) && Number.isFinite(b) && a < b) {
      start = a;
      end = b;
      status = 'custom';
      exclusiveEnd = true;
    } else {
      start = now - DAY_MS;
    }
  }

  return {
    preset: rawPreset,
    status,
    start,
    end,
    resetsAtMs: null,
    pools: [],
    match: req => {
      const ts = Number.isFinite(req?.billingTsMs) ? req.billingTsMs : req?.timestampMs;
      return Number.isFinite(ts) && ts >= start && (exclusiveEnd ? ts < end : ts <= end);
    }
  };
}
