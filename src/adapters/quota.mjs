import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function parseResetMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    if (/^\d+(?:\.\d+)?$/.test(value.trim())) return parseResetMs(Number(value));
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function classifyPoolKey(label = '', windowId = '', driver = '') {
  const text = `${driver} ${label} ${windowId}`.toLowerCase();
  if (/argon/.test(text)) return 'argon';
  if (/3p|claude|gpt/.test(text) && !/codex/.test(driver)) return '3p';
  if (/gemini/.test(text)) return 'gemini';
  if (/codex/.test(text)) return 'codex';
  return `${driver || 'pool'}:${windowId || 'default'}`;
}

function extractPoolLabel(label = '', poolKey = '', driver = '', fallbackDisplay = '') {
  const raw = String(label || '').trim();
  if (raw.includes('·')) {
    const prefix = raw.split('·')[0].trim();
    if (prefix) return prefix;
  }
  if (poolKey === '3p') return 'Claude & GPT (shared)';
  if (poolKey === 'gemini') return 'Gemini';
  if (poolKey === 'argon') return 'Argon';
  if (poolKey === 'codex') return 'Codex';
  if (raw && !/^(weekly|session|primary|secondary|\d+[- ]?(hour|hr|h|day|d))$/i.test(raw)) {
    return raw;
  }
  return fallbackDisplay || driver || '默认额度池';
}

function extractWindowTag(kind = '', windowDurationMins = null, label = '') {
  if (Number.isFinite(windowDurationMins) && windowDurationMins > 0) {
    if (windowDurationMins >= 1440) {
      const days = Math.round(windowDurationMins / 1440);
      return days === 7 ? '周额度 (7d)' : `${days}d 周期`;
    }
    if (windowDurationMins >= 60) {
      return `${Math.round(windowDurationMins / 60)}h 窗口`;
    }
    return `${Math.round(windowDurationMins)}m 窗口`;
  }
  if (kind === 'weekly' || /weekly|7d/i.test(String(label))) return '周额度';
  return '短周期';
}

function classifyHealth(minRemainingPercent) {
  if (minRemainingPercent == null || !Number.isFinite(minRemainingPercent)) return 'unknown';
  if (minRemainingPercent <= 15) return 'critical';
  if (minRemainingPercent <= 40) return 'warning';
  return 'healthy';
}

function groupWindowsByPool(windows = []) {
  const byPool = new Map();
  for (const w of windows) {
    const key = w.poolKey || w.windowId || 'default';
    let pool = byPool.get(key);
    if (!pool) {
      pool = {
        poolKey: key,
        poolLabel: w.poolLabel || w.label || key,
        windows: [],
        minRemainingPercent: null
      };
      byPool.set(key, pool);
    }
    pool.windows.push(w);
    if (w.remainingPercent != null) {
      pool.minRemainingPercent = pool.minRemainingPercent == null
        ? w.remainingPercent
        : Math.min(pool.minRemainingPercent, w.remainingPercent);
    }
  }
  const pools = [...byPool.values()];
  for (const p of pools) {
    p.windows.sort((a, b) => (a.windowDurationMins || 999999) - (b.windowDurationMins || 999999));
  }
  pools.sort((a, b) => a.poolLabel.localeCompare(b.poolLabel));
  return pools;
}

export function createQuotaAdapter({ paths, store, t3State, codexAdapter }) {
  function readAllQuotas(now = Date.now(), { persist = true } = {}) {
    const instances = t3State.readProviderInstances();
    const cacheByInstance = new Map();

    if (paths.t3Caches && existsSync(paths.t3Caches)) {
      let files = [];
      try {
        files = readdirSync(paths.t3Caches).filter(f => f.endsWith('.json'));
      } catch {}

      for (const file of files) {
        let parsed;
        try {
          parsed = JSON.parse(readFileSync(join(paths.t3Caches, file), 'utf8'));
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== 'object') continue;
        const instanceId = String(parsed.instanceId || file.slice(0, -5));
        cacheByInstance.set(instanceId, parsed);
      }
    }

    // Build groups from BOTH enabled settings instances AND discovered cache files (fixes P1 #8)
    const allInstanceIds = new Set([...cacheByInstance.keys()]);
    for (const [id, cfg] of instances.entries()) {
      if (cfg.enabled) allInstanceIds.add(id);
    }

    const groups = [];
    const snapshotBuffer = [];

    for (const instanceId of allInstanceIds) {
      const parsed = cacheByInstance.get(instanceId) || null;
      const cfg = instances.get(instanceId) || null;
      const driver = String(parsed?.driver || cfg?.driver || instanceId);
      const enabled = (parsed ? parsed.enabled !== false : true) && (cfg ? cfg.enabled !== false : true);
      if (!enabled) continue;

      const displayBase = parsed?.displayName || cfg?.displayName || driver;
      const checkedAtMs = parseResetMs(parsed?.usageLimits?.checkedAt || parsed?.checkedAt) || now;
      const rawWindows = Array.isArray(parsed?.usageLimits?.windows) ? parsed.usageLimits.windows : [];
      const windows = rawWindows.filter(w => w && typeof w === 'object' && !Array.isArray(w)).map(w => {
        const rawUsed = w.usedPercent == null ? NaN : Number(w.usedPercent);
        const usedPercent = Number.isFinite(rawUsed) ? Math.min(100, Math.max(0, Number(rawUsed.toFixed(1)))) : null;
        const remainingPercent = usedPercent != null ? Math.max(0, Number((100 - usedPercent).toFixed(1))) : null;
        const resetsAtMs = parseResetMs(w.resetsAt);
        const windowDurationMins = Number.isFinite(Number(w.windowDurationMins)) ? Number(w.windowDurationMins) : null;
        const poolKey = classifyPoolKey(w.label, w.id, driver);
        const kind = String(w.kind || (windowDurationMins >= 1440 ? 'weekly' : 'session'));
        const label = String(w.label || w.id || '额度');
        const item = {
          accountId: instanceId,
          driver,
          windowId: String(w.id || w.label || 'window'),
          poolKey,
          poolLabel: extractPoolLabel(label, poolKey, driver, displayBase),
          windowTag: extractWindowTag(kind, windowDurationMins, label),
          label,
          kind,
          usedPercent,
          remainingPercent,
          resetsAtMs,
          remainingTimeMs: resetsAtMs != null ? Math.max(0, resetsAtMs - now) : null,
          isExpired: resetsAtMs != null && resetsAtMs <= now,
          isIdleFull: usedPercent === 0 && resetsAtMs == null,
          windowDurationMins,
          observedAtMs: checkedAtMs,
          source: 't3-cache'
        };
        snapshotBuffer.push(item);
        return item;
      });

      // Supplement Codex instances with per-account rollout rate_limits PER WINDOW KIND
      // (so a T3 cache with only a 5h window does NOT suppress a valid weekly rollout window!) (fixes P1 #8 & #9)
      if (driver === 'codex') {
        const existingKinds = new Set(windows.map(w => `${w.poolKey}::${w.kind}`));
        const rlWindows = codexAdapter?.getRateLimitWindows?.(instanceId) || [];
        const bestByKind = new Map();
        for (const rw of rlWindows) {
          const kind = rw.windowMinutes >= 1440 ? 'weekly' : 'session';
          const resetsAtMs = parseResetMs(rw.resetsAt);
          const isActive = resetsAtMs != null && resetsAtMs > now;
          const dedupeKey = `${rw.limitId}::${kind}`;
          const prev = bestByKind.get(dedupeKey);
          if (!prev) {
            bestByKind.set(dedupeKey, { rw, kind, resetsAtMs, isActive });
          } else if (isActive && !prev.isActive) {
            bestByKind.set(dedupeKey, { rw, kind, resetsAtMs, isActive });
          } else if (isActive === prev.isActive && (rw.observedAtMs || 0) >= (prev.rw.observedAtMs || 0)) {
            bestByKind.set(dedupeKey, { rw, kind, resetsAtMs, isActive });
          }
        }
        for (const { rw, kind, resetsAtMs } of bestByKind.values()) {
          const poolKey = rw.limitId && rw.limitId !== 'codex' ? `codex:${rw.limitId}` : 'codex';
          if (existingKinds.has(`${poolKey}::${kind}`)) continue;
          const windowId = `${rw.limitId}-${kind}`;
          const limitPrefix = rw.limitId && rw.limitId !== 'codex' ? `Codex (${rw.limitId})` : 'Codex';
          const label = kind === 'weekly' ? `${limitPrefix} · Weekly` : `${limitPrefix} · ${Math.round(rw.windowMinutes / 60)}h`;
          const usedPercent = Math.min(100, Math.max(0, Number(Number(rw.usedPercent).toFixed(1))));
          const item = {
            accountId: instanceId,
            driver,
            windowId,
            poolKey,
            poolLabel: limitPrefix,
            windowTag: extractWindowTag(kind, rw.windowMinutes, label),
            label,
            kind,
            usedPercent,
            remainingPercent: Math.max(0, Number((100 - usedPercent).toFixed(1))),
            resetsAtMs,
            remainingTimeMs: resetsAtMs != null ? Math.max(0, resetsAtMs - now) : null,
            isExpired: resetsAtMs != null && resetsAtMs <= now,
            isIdleFull: usedPercent === 0 && resetsAtMs == null,
            windowDurationMins: rw.windowMinutes,
            observedAtMs: rw.observedAtMs || now,
            observationAgeMs: Math.max(0, now - (rw.observedAtMs || now)),
            source: 'codex-rollout'
          };
          windows.push(item);
          snapshotBuffer.push(item);
        }
      }

      const rawAuth = parsed?.auth && typeof parsed.auth === 'object' ? parsed.auth : {};
      const auth = {
        status: String(rawAuth.status || (windows.length ? 'authenticated' : 'unknown')),
        type: String(rawAuth.type || ''),
        label: String(rawAuth.label || ''),
        email: String(rawAuth.email || ''),
        workspaceId: String(rawAuth.workspaceId || '')
      };

      const rawRc = parsed?.usageLimits?.resetCredits;
      const resetCredits = rawRc && Number(rawRc.availableCount) > 0
        ? {
            availableCount: Number(rawRc.availableCount),
            nextExpiresAtMs: parseResetMs(rawRc.nextExpiresAt)
          }
        : null;

      const remValues = windows.map(w => w.remainingPercent).filter(v => v != null && Number.isFinite(v));
      const minRemainingPercent = remValues.length ? Math.min(...remValues) : null;
      const avgRemainingPercent = remValues.length
        ? Number((remValues.reduce((a, b) => a + b, 0) / remValues.length).toFixed(1))
        : null;
      const futureResets = windows
        .map(w => w.resetsAtMs)
        .filter(ms => ms != null && ms > now);
      const nextResetMs = futureResets.length ? Math.min(...futureResets) : null;

      groups.push({
        accountId: instanceId,
        displayName: instanceId === driver ? displayBase : `${instanceId} (${displayBase})`,
        shortName: instanceId,
        driverLabel: displayBase,
        driver,
        accentColor: cfg?.accentColor || parsed?.accentColor || '',
        status: parsed?.status || (windows.length ? 'ready' : 'unknown'),
        auth,
        version: String(parsed?.version || ''),
        modelsCount: Array.isArray(parsed?.models) ? parsed.models.length : 0,
        resetCredits,
        checkedAtMs,
        minRemainingPercent,
        avgRemainingPercent,
        health: classifyHealth(minRemainingPercent),
        nextResetMs,
        unavailable: windows.length === 0 ? (parsed?.usageLimits?.unavailable || null) : null,
        pools: groupWindowsByPool(windows),
        windows
      });
    }

    if (persist && snapshotBuffer.length) {
      try { store.saveQuotaSnapshots(snapshotBuffer); } catch {}
    }

    groups.sort((a, b) => (b.windows.length > 0 ? 1 : 0) - (a.windows.length > 0 ? 1 : 0) || a.accountId.localeCompare(b.accountId));

    const driverMap = new Map();
    let healthyAccounts = 0;
    let warningAccounts = 0;
    let criticalAccounts = 0;
    let unknownAccounts = 0;
    let lowestWindow = null;
    let soonestResetWindow = null;

    for (const g of groups) {
      if (g.health === 'healthy') healthyAccounts++;
      else if (g.health === 'warning') warningAccounts++;
      else if (g.health === 'critical') criticalAccounts++;
      else unknownAccounts++;

      const dEntry = driverMap.get(g.driver) || { driver: g.driver, label: g.driverLabel || g.driver, count: 0 };
      dEntry.count++;
      driverMap.set(g.driver, dEntry);

      for (const w of g.windows) {
        if (w.remainingPercent != null) {
          if (!lowestWindow || w.remainingPercent < lowestWindow.remainingPercent) {
            lowestWindow = {
              accountId: g.accountId,
              displayName: g.displayName,
              driver: g.driver,
              label: w.label,
              poolLabel: w.poolLabel,
              windowTag: w.windowTag,
              kind: w.kind,
              remainingPercent: w.remainingPercent,
              usedPercent: w.usedPercent,
              resetsAtMs: w.resetsAtMs,
              remainingTimeMs: w.remainingTimeMs
            };
          }
        }
        if (w.resetsAtMs != null && w.resetsAtMs > now) {
          if (!soonestResetWindow || w.resetsAtMs < soonestResetWindow.resetsAtMs) {
            soonestResetWindow = {
              accountId: g.accountId,
              displayName: g.displayName,
              driver: g.driver,
              label: w.label,
              poolLabel: w.poolLabel,
              windowTag: w.windowTag,
              kind: w.kind,
              remainingPercent: w.remainingPercent,
              resetsAtMs: w.resetsAtMs,
              remainingTimeMs: w.remainingTimeMs
            };
          }
        }
      }
    }

    const drivers = [...driverMap.values()].sort((a, b) => b.count - a.count || a.driver.localeCompare(b.driver));

    return {
      updatedAtMs: now,
      summary: {
        totalAccounts: groups.length,
        readyAccounts: groups.filter(g => g.windows.length > 0).length,
        healthyAccounts,
        warningAccounts,
        criticalAccounts,
        unknownAccounts,
        drivers,
        lowestWindow,
        soonestResetWindow
      },
      groups,
      flatWindows: groups.flatMap(g => g.windows)
    };
  }

  return { readAllQuotas };
}
