import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ANTIGRAVITY_CLI_MANIFEST_BASE =
  'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests';

const DEFAULT_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes
const DEFAULT_ERROR_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes on network failure
const DEFAULT_REQUEST_TIMEOUT_MS = 8000;

const DRIVER_DISPLAY_NAMES = {
  codex: 'Codex',
  antigravity: 'Antigravity',
  claudeAgent: 'Claude Code',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  gemini: 'Gemini CLI',
  pi: 'Pi',
  muse: 'Muse Code'
};

function parseSemverParts(raw) {
  const m = String(raw || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareSemver(a, b) {
  const pa = parseSemverParts(a);
  const pb = parseSemverParts(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export function resolveAntigravityManifestTarget(platform = process.platform, arch = process.arch, musl = false) {
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    return null;
  }
  const os = platform === 'win32' ? 'windows' : platform;
  const cpu = arch === 'x64' ? 'amd64' : arch;
  const suffix = platform === 'linux' && musl ? '_musl' : '';
  return `${os}_${cpu}${suffix}`;
}

function parseIsoMs(iso) {
  if (!iso) return null;
  const n = Date.parse(String(iso));
  return Number.isFinite(n) ? n : null;
}

function readJsonSafe(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readT3UpdateChecksEnabled(settingsPath) {
  const parsed = readJsonSafe(settingsPath);
  if (!parsed || typeof parsed !== 'object') return true;
  if (parsed.enableProviderUpdateChecks === false) return false;
  return true;
}

function readManagedCodexVersion(t3Root) {
  if (!t3Root) return '';
  const active = readJsonSafe(join(t3Root, 'tools', 'codex', 'active.json'));
  return typeof active?.version === 'string' ? active.version.trim() : '';
}

function formatDriverDisplayName(driver, fallback = '') {
  if (DRIVER_DISPLAY_NAMES[driver]) return DRIVER_DISPLAY_NAMES[driver];
  return fallback || driver || '未知环境';
}

/**
 * Runtime update detector (Scheme 3):
 * - For Codex (and any provider whose cache already carries T3 Code's `versionAdvisory`),
 *   reads T3 Code's persisted cache directly with ZERO duplicate network checks.
 * - For Antigravity, T3 Code does not persist `versionAdvisory` to disk and only checks
 *   when opening Settings -> Providers. When enabled & installed without cached advisory,
 *   performs a lightweight, rate-limited background check against the same public manifest.
 */
export function createRuntimeUpdatesAdapter({
  paths,
  t3State,
  fetchImpl = globalThis.fetch,
  checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
  errorBackoffMs = DEFAULT_ERROR_BACKOFF_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  platform = process.platform,
  arch = process.arch,
  enableRemoteCheck = true
} = {}) {
  let remoteAntigravity = {
    latestVersion: null,
    checkedAtMs: null,
    lastAttemptAtMs: 0,
    lastError: '',
    inFlight: null
  };

  function collectLocalProviders() {
    const instances = t3State?.readProviderInstances?.() || new Map();
    const cacheByInstance = new Map();

    if (paths?.t3Caches && existsSync(paths.t3Caches)) {
      let files = [];
      try {
        files = readdirSync(paths.t3Caches).filter(f => f.endsWith('.json'));
      } catch {}
      for (const file of files) {
        const parsed = readJsonSafe(join(paths.t3Caches, file));
        if (!parsed || typeof parsed !== 'object') continue;
        const instanceId = String(parsed.instanceId || file.slice(0, -5));
        cacheByInstance.set(instanceId, parsed);
      }
    }

    const byDriver = new Map();
    const allIds = new Set([...cacheByInstance.keys()]);
    for (const [id, cfg] of instances.entries()) {
      if (cfg.enabled) allIds.add(id);
    }

    for (const instanceId of allIds) {
      const cfg = instances.get(instanceId);
      const cache = cacheByInstance.get(instanceId);
      const enabled = cfg ? cfg.enabled !== false : cache?.enabled === true;
      if (!enabled) continue;
      if (cache && cache.enabled === false) continue;

      const driver = String(cache?.driver || cfg?.driver || instanceId).trim();
      if (!driver) continue;

      const installed = cache ? cache.installed !== false : true;
      let currentVersion = typeof cache?.version === 'string' ? cache.version.trim() : '';
      if (!currentVersion && typeof cache?.versionAdvisory?.currentVersion === 'string') {
        currentVersion = cache.versionAdvisory.currentVersion.trim();
      }
      if (!currentVersion && driver === 'codex') {
        currentVersion = readManagedCodexVersion(paths?.t3Root);
      }

      const va = cache?.versionAdvisory && typeof cache.versionAdvisory === 'object' ? cache.versionAdvisory : null;
      const vaLatest = typeof va?.latestVersion === 'string' ? va.latestVersion.trim() : '';
      const vaStatus = typeof va?.status === 'string' ? va.status.trim() : '';
      const hasValidCacheAdvisory = Boolean(
        va && (vaStatus === 'current' || vaStatus === 'behind_latest') && (vaLatest || vaStatus === 'current')
      );
      const vaCheckedAtMs = parseIsoMs(va?.checkedAt) ?? parseIsoMs(cache?.checkedAt);

      const compat = cache?.compatibilityAdvisory && typeof cache.compatibilityAdvisory === 'object'
        ? cache.compatibilityAdvisory
        : null;
      const latestVersionBlocked = compat?.latestVersionStatus === 'broken' || compat?.latestVersionStatus === 'unsupported';

      let entry = byDriver.get(driver);
      if (!entry) {
        entry = {
          driver,
          displayName: formatDriverDisplayName(driver, cache?.displayName || cfg?.displayName),
          instanceIds: [],
          installed: false,
          currentVersion: '',
          cacheAdvisory: null,
          cacheCheckedAtMs: null,
          latestVersionBlocked: false
        };
        byDriver.set(driver, entry);
      }

      entry.instanceIds.push(instanceId);
      if (installed) entry.installed = true;
      if (!entry.currentVersion && currentVersion) entry.currentVersion = currentVersion;
      if (latestVersionBlocked) entry.latestVersionBlocked = true;

      if (hasValidCacheAdvisory) {
        const prevTs = entry.cacheCheckedAtMs || 0;
        const nextTs = vaCheckedAtMs || 0;
        if (!entry.cacheAdvisory || nextTs >= prevTs) {
          entry.cacheAdvisory = {
            status: vaStatus,
            currentVersion: (typeof va.currentVersion === 'string' && va.currentVersion.trim()) || currentVersion || null,
            latestVersion: vaLatest || null,
            canUpdate: Boolean(va.canUpdate),
            updateCommand: typeof va.updateCommand === 'string' ? va.updateCommand : null,
            message: typeof va.message === 'string' ? va.message : null
          };
          entry.cacheCheckedAtMs = vaCheckedAtMs;
        }
      }
    }

    return byDriver;
  }

  function needsAntigravityRemoteCheck(byDriver) {
    if (!enableRemoteCheck || typeof fetchImpl !== 'function') return false;
    if (!readT3UpdateChecksEnabled(paths?.settingsPath)) return false;
    const agy = byDriver.get('antigravity');
    if (!agy || !agy.installed || !agy.currentVersion) return false;
    // If T3 Code itself begins persisting versionAdvisory for Antigravity, reuse it and skip remote fetch!
    if (agy.cacheAdvisory) return false;
    return Boolean(resolveAntigravityManifestTarget(platform, arch));
  }

  function fetchAntigravityLatest({ force = false, now = Date.now() } = {}) {
    if (!enableRemoteCheck || typeof fetchImpl !== 'function') return Promise.resolve(null);
    const target = resolveAntigravityManifestTarget(platform, arch);
    if (!target) return Promise.resolve(null);

    if (remoteAntigravity.inFlight) return remoteAntigravity.inFlight;

    if (!force && remoteAntigravity.lastAttemptAtMs > 0) {
      const waitMs = remoteAntigravity.lastError ? errorBackoffMs : checkIntervalMs;
      if (now - remoteAntigravity.lastAttemptAtMs < waitMs) {
        return Promise.resolve(remoteAntigravity.latestVersion);
      }
    }

    remoteAntigravity.lastAttemptAtMs = now;
    const url = `${ANTIGRAVITY_CLI_MANIFEST_BASE}/${target}.json`;

    const task = (async () => {
      try {
        const res = await fetchImpl(url, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(requestTimeoutMs)
        });
        if (!res || !res.ok) {
          throw new Error(`HTTP ${res?.status ?? 'ERR'}`);
        }
        const json = await res.json();
        const ver = typeof json?.version === 'string' ? json.version.trim() : '';
        if (!/^\d+\.\d+\.\d+$/.test(ver)) {
          throw new Error('无效的版本清单格式');
        }
        remoteAntigravity.latestVersion = ver;
        remoteAntigravity.checkedAtMs = Date.now();
        remoteAntigravity.lastError = '';
        return ver;
      } catch (err) {
        remoteAntigravity.lastError = err?.message || '检查更新失败';
        return null;
      } finally {
        remoteAntigravity.inFlight = null;
      }
    })();

    remoteAntigravity.inFlight = task;
    return task;
  }

  function buildSnapshot(byDriver, now = Date.now()) {
    const checksEnabled = readT3UpdateChecksEnabled(paths?.settingsPath);
    const items = [];
    let latestCheckedAtMs = null;

    const sortedDrivers = [...byDriver.values()].sort((a, b) => {
      const order = { codex: 0, antigravity: 1 };
      const ra = Object.prototype.hasOwnProperty.call(order, a.driver) ? order[a.driver] : 10;
      const rb = Object.prototype.hasOwnProperty.call(order, b.driver) ? order[b.driver] : 10;
      if (ra !== rb) return ra - rb;
      return a.displayName.localeCompare(b.displayName);
    });

    for (const entry of sortedDrivers) {
      if (!entry.installed && !entry.currentVersion) continue;

      let status = 'unknown';
      let currentVersion = entry.currentVersion || null;
      let latestVersion = null;
      let hasUpdate = false;
      let canUpdate = false;
      let source = 'local-only';
      let checkedAtMs = null;

      if (entry.cacheAdvisory) {
        source = 't3-cache';
        currentVersion = entry.cacheAdvisory.currentVersion || currentVersion;
        latestVersion = entry.cacheAdvisory.latestVersion || null;
        canUpdate = entry.cacheAdvisory.canUpdate;
        checkedAtMs = entry.cacheCheckedAtMs;

        if (entry.cacheAdvisory.status === 'behind_latest' && latestVersion && !entry.latestVersionBlocked) {
          const cmp = currentVersion ? compareSemver(currentVersion, latestVersion) : -1;
          if (cmp == null || cmp < 0) {
            status = 'behind_latest';
            hasUpdate = true;
          } else {
            status = 'current';
          }
        } else if (entry.cacheAdvisory.status === 'current') {
          status = 'current';
        }
      } else if (entry.driver === 'antigravity' && remoteAntigravity.latestVersion) {
        source = 'antigravity-manifest';
        latestVersion = remoteAntigravity.latestVersion;
        checkedAtMs = remoteAntigravity.checkedAtMs;
        canUpdate = true;
        if (currentVersion && !entry.latestVersionBlocked) {
          const cmp = compareSemver(currentVersion, latestVersion);
          if (cmp != null && cmp < 0) {
            status = 'behind_latest';
            hasUpdate = true;
          } else if (cmp != null) {
            status = 'current';
          }
        }
      }

      if (checkedAtMs != null && (latestCheckedAtMs == null || checkedAtMs > latestCheckedAtMs)) {
        latestCheckedAtMs = checkedAtMs;
      }

      items.push({
        driver: entry.driver,
        displayName: entry.displayName,
        instanceIds: entry.instanceIds,
        currentVersion,
        latestVersion,
        status,
        hasUpdate,
        canUpdate,
        source,
        checkedAtMs
      });
    }

    const updatable = items.filter(it => it.hasUpdate);
    return {
      updatedAtMs: now,
      checkedAtMs: latestCheckedAtMs,
      checksEnabled,
      updateCount: updatable.length,
      hasUpdates: updatable.length > 0,
      items
    };
  }

  function readRuntimeUpdates(now = Date.now(), { triggerBackground = true } = {}) {
    const byDriver = collectLocalProviders();
    if (triggerBackground && needsAntigravityRemoteCheck(byDriver)) {
      fetchAntigravityLatest({ force: false, now }).catch(() => {});
    }
    return buildSnapshot(byDriver, now);
  }

  async function checkNow(now = Date.now()) {
    const byDriver = collectLocalProviders();
    if (needsAntigravityRemoteCheck(byDriver)) {
      await fetchAntigravityLatest({ force: true, now });
    }
    return buildSnapshot(byDriver, Date.now());
  }

  return {
    readRuntimeUpdates,
    checkNow
  };
}
