import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync
} from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareSemver } from '../adapters/runtime-updates.mjs';
import { atomicWriteJson } from '../core/settings.mjs';

export const APP_REPO_SLUG = 'LionKo/t3tools';
export const APP_RELEASES_URL = `https://github.com/${APP_REPO_SLUG}/releases`;
export const APP_UPDATE_MANIFEST_URL = `${APP_RELEASES_URL}/latest/download/latest.json`;

export const VALID_CHECK_INTERVAL_MINUTES = [30, 60, 360, 1440];
const DEFAULT_CHECK_INTERVAL_MINUTES = 60; // 1 hour (Magpie-style configurable: 30m / 1h / 6h / 24h)
const DEFAULT_INITIAL_DELAY_MS = 5 * 1000; // 5 seconds after startup (matches Magpie)
const DEFAULT_FRESH_AFTER_MS = 5 * 60 * 1000; // 5 minutes freshness window on UI open (matches Magpie freshAfter)
const DEFAULT_TICK_INTERVAL_MS = 60 * 1000; // 1 minute dynamic settings tick (matches Magpie)
const DEFAULT_ERROR_BACKOFF_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_REQUEST_TIMEOUT_MS = 12000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 180000;
const DEFAULT_APPLY_TIMEOUT_MS = 30000;
const MAX_PACKAGE_BYTES = 160 * 1024 * 1024; // 160 MB safety cap
const MAX_REDIRECT_HOPS = 5;

const REPO_RELEASES_PREFIX = `/${APP_REPO_SLUG.toLowerCase()}/releases/`;
const ALLOWED_ASSET_REDIRECT_HOSTS = new Set([
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com'
]);

const DEFAULT_APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readJsonSafe(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function normalizeWinPath(p) {
  const full = resolve(String(p || ''));
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

export function isAllowedUpdateUrl(rawUrl, { allowLocalhost = false, allowAssetHost = true } = {}) {
  try {
    const u = new URL(String(rawUrl || '').trim());
    if (allowLocalhost && (u.protocol === 'http:' || u.protocol === 'https:')) {
      if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return true;
    }
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    const pathLower = u.pathname.toLowerCase();
    if (host === 'github.com') {
      return pathLower === `/${APP_REPO_SLUG.toLowerCase()}/releases` || pathLower.startsWith(REPO_RELEASES_PREFIX);
    }
    if (allowAssetHost && ALLOWED_ASSET_REDIRECT_HOSTS.has(host)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function isValidSha256(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || '').trim());
}

function safeHexEqual(a, b) {
  const ba = Buffer.from(String(a || '').trim().toLowerCase(), 'utf8');
  const bb = Buffer.from(String(b || '').trim().toLowerCase(), 'utf8');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Fetch with explicit hop-by-hop redirect validation against our GitHub allowlist
 * so an open redirect can never steer a download to an untrusted host.
 */
async function fetchWithValidatedRedirects(fetchImpl, initialUrl, {
  headers = {},
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  allowLocalhost = false,
  initialAllowAssetHost = false
} = {}) {
  let currentUrl = String(initialUrl || '').trim();
  if (!isAllowedUpdateUrl(currentUrl, { allowLocalhost, allowAssetHost: initialAllowAssetHost })) {
    throw new Error('更新地址不在允许的仓库白名单内');
  }

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const res = await fetchImpl(currentUrl, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res) throw new Error('网络请求无响应');

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers?.get?.('location');
      if (!location) throw new Error(`重定向响应缺少 Location (HTTP ${res.status})`);
      const nextUrl = new URL(location, currentUrl).toString();
      if (!isAllowedUpdateUrl(nextUrl, { allowLocalhost, allowAssetHost: true })) {
        throw new Error('更新重定向目标不在受信任的 GitHub 域名白名单内');
      }
      currentUrl = nextUrl;
      continue;
    }

    if (res.url && !isAllowedUpdateUrl(res.url, { allowLocalhost, allowAssetHost: true })) {
      throw new Error('更新响应地址不在受信任的 GitHub 域名白名单内');
    }
    return res;
  }
  throw new Error('更新请求重定向次数过多');
}

/**
 * Inspect where T3Tools is running from:
 * - Installed/portable layout: <installDir>/T3Tools.exe + <installDir>/release.json + <installDir>/app/...
 * - Dev checkout layout: contains .git or lacks release.json/T3Tools.exe -> auto-update disabled to protect source tree.
 */
export function detectInstallContext({
  appRoot = DEFAULT_APP_ROOT,
  nodeVersion = process.versions.node,
  trayExeOverride = process.env.T3TOOLS_TRAY_EXE || ''
} = {}) {
  const resolvedAppRoot = resolve(appRoot);
  const parentDir = dirname(resolvedAppRoot);
  const hasGitInApp = existsSync(join(resolvedAppRoot, '.git'));
  const hasGitInParent = existsSync(join(parentDir, '.git'));

  let installDir = resolvedAppRoot;
  let releaseMeta = null;

  const parentRelease = readJsonSafe(join(parentDir, 'release.json'));
  const appRelease = readJsonSafe(join(resolvedAppRoot, 'release.json'));

  if (!hasGitInApp && !hasGitInParent && parentRelease && existsSync(join(parentDir, 'T3Tools.exe'))) {
    installDir = parentDir;
    releaseMeta = parentRelease;
  } else if (!hasGitInApp && appRelease && existsSync(join(resolvedAppRoot, 'T3Tools.exe'))) {
    installDir = resolvedAppRoot;
    releaseMeta = appRelease;
  }

  const hasBundledNode = existsSync(join(installDir, 'runtime', 'node.exe'));
  const trayExePath = join(installDir, 'T3Tools.exe');

  if (!releaseMeta) {
    return {
      mode: 'dev',
      canAutoUpdate: false,
      cannotUpdateReason: hasGitInApp || hasGitInParent
        ? '当前运行于开发源码目录（.git），已禁用自动覆盖以保护本地代码'
        : '当前非标准 Release 安装目录，请从 GitHub Releases 下载安装包升级',
      installDir,
      appRoot: resolvedAppRoot,
      trayExePath: existsSync(trayExePath) ? trayExePath : '',
      hasBundledNode,
      nodeVersion: String(nodeVersion || ''),
      channel: 'dev'
    };
  }

  const mode = releaseMeta.installMode === 'portable' ? 'portable' : 'installed';

  // If a parent tray process declared its executable path, verify it belongs to this installDir
  const declaredTray = String(trayExeOverride || '').trim();
  if (declaredTray && normalizeWinPath(declaredTray) !== normalizeWinPath(trayExePath)) {
    return {
      mode,
      canAutoUpdate: false,
      cannotUpdateReason: '当前托盘程序与后台服务不在同一安装目录，请从同一目录重启 T3Tools 后再更新',
      installDir,
      appRoot: resolvedAppRoot,
      trayExePath,
      hasBundledNode,
      nodeVersion: String(nodeVersion || ''),
      channel: String(releaseMeta.channel || 'stable')
    };
  }

  return {
    mode,
    canAutoUpdate: true,
    cannotUpdateReason: '',
    installDir,
    appRoot: resolvedAppRoot,
    trayExePath,
    hasBundledNode,
    nodeVersion: String(nodeVersion || ''),
    channel: String(releaseMeta.channel || 'stable')
  };
}

/**
 * Pick lightweight appPackage (~245KB) for normal updates, and fall back to
 * fullPackage (with bundled node.exe) only when minNodeVersion exceeds local Node.
 */
export function selectUpdatePackage(manifest, {
  currentNodeVersion = process.versions.node,
  allowLocalhost = false
} = {}) {
  if (!manifest || typeof manifest !== 'object') return null;

  const normalizePkg = (raw, kind) => {
    if (!raw || typeof raw !== 'object') return null;
    const url = String(raw.url || '').trim();
    const sha256 = String(raw.sha256 || '').trim().toLowerCase();
    const size = Number(raw.size) || 0;
    if (!url || !isAllowedUpdateUrl(url, { allowLocalhost, allowAssetHost: false }) || !isValidSha256(sha256)) {
      return null;
    }
    return { kind, url, sha256, size };
  };

  const appPkg = normalizePkg(manifest.appPackage, 'app');
  const fullPkg = normalizePkg(manifest.fullPackage, 'full');

  const minNode = String(manifest.minNodeVersion || '').trim();
  const needsNodeUpgrade = Boolean(
    minNode &&
    currentNodeVersion &&
    compareSemver(currentNodeVersion, minNode) === -1
  );

  if (needsNodeUpgrade) {
    // Never downgrade or serve a delta app package when the runtime requires a Node upgrade
    return fullPkg;
  }
  if (appPkg) return appPkg;
  if (fullPkg) return fullPkg;
  return null;
}

function normalizeReleaseUrl(manifest) {
  const candidate = String(manifest?.releaseUrl || '').trim();
  if (candidate && isAllowedUpdateUrl(candidate, { allowAssetHost: false })) return candidate;
  const ver = String(manifest?.version || '').trim().replace(/^v/i, '');
  return ver ? `${APP_RELEASES_URL}/tag/v${encodeURIComponent(ver)}` : APP_RELEASES_URL;
}

function consumeJsonMarker(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  const parsed = readJsonSafe(filePath);
  try { unlinkSync(filePath); } catch {}
  return parsed && typeof parsed === 'object' ? parsed : null;
}

function cleanupStalePendingUpdate(installDir, currentVersion) {
  if (!installDir) return;
  const pendingPath = join(installDir, '_staging', 'pending-update.json');
  const pending = readJsonSafe(pendingPath);
  if (!pending) return;
  const pendingVer = String(pending.version || '').trim();
  const requestedAtMs = Number(pending.requestedAtMs) || 0;
  const isOutdated = Boolean(pendingVer && compareSemver(pendingVer, currentVersion) <= 0);
  const isExpired = requestedAtMs > 0 && (Date.now() - requestedAtMs) > 10 * 60 * 1000;
  if (isOutdated || isExpired) {
    try { unlinkSync(pendingPath); } catch {}
  }
}

export function createAppUpdater({
  currentVersion = '0.1.0',
  settings,
  paths,
  appRoot = DEFAULT_APP_ROOT,
  manifestUrl = APP_UPDATE_MANIFEST_URL,
  fetchImpl = globalThis.fetch,
  enableBackgroundCheck = true,
  checkIntervalMs = null,
  initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
  freshAfterMs = DEFAULT_FRESH_AFTER_MS,
  tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
  errorBackoffMs = DEFAULT_ERROR_BACKOFF_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  downloadTimeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
  applyTimeoutMs = DEFAULT_APPLY_TIMEOUT_MS,
  nodeVersion = process.versions.node,
  trayExeOverride = process.env.T3TOOLS_TRAY_EXE || '',
  allowLocalhostForTest = false
} = {}) {
  const installCtx = detectInstallContext({ appRoot, nodeVersion, trayExeOverride });
  const justUpdatedPath = paths?.pluginDataDir ? join(paths.pluginDataDir, 'just-updated.json') : '';
  const lastUpdateErrorPath = paths?.pluginDataDir ? join(paths.pluginDataDir, 'last-update-error.json') : '';

  const justUpdated = consumeJsonMarker(justUpdatedPath);
  const previousSwapError = consumeJsonMarker(lastUpdateErrorPath);
  if (installCtx.canAutoUpdate) {
    cleanupStalePendingUpdate(installCtx.installDir, currentVersion);
  }

  const state = {
    status: previousSwapError?.error ? 'error' : 'idle',
    hasUpdate: false,
    latestVersion: null,
    publishedAt: null,
    releaseUrl: APP_RELEASES_URL,
    releaseNotes: '',
    minNodeVersion: '',
    selectedPackage: null,
    downloadedBytes: 0,
    progressPercent: 0,
    stagedZipPath: '',
    stagedSha256: '',
    stagedVersion: '',
    applyRequestedAtMs: null,
    checkedAtMs: null,
    lastAttemptAtMs: 0,
    lastError: previousSwapError?.error ? `上次更新回滚：${previousSwapError.error}` : ''
  };

  let inFlightCheck = null;
  let inFlightInstall = null;
  let applyTimeoutTimer = null;
  let initialTimer = null;
  let intervalTimer = null;
  let stopped = false;

  function clearApplyTimeout() {
    if (applyTimeoutTimer) {
      clearTimeout(applyTimeoutTimer);
      applyTimeoutTimer = null;
    }
  }

  function armApplyTimeout() {
    clearApplyTimeout();
    if (!Number.isFinite(applyTimeoutMs) || applyTimeoutMs <= 0) return;
    applyTimeoutTimer = setTimeout(() => {
      applyTimeoutTimer = null;
      if (stopped || state.status !== 'ready') return;
      state.status = 'error';
      state.applyRequestedAtMs = null;
      state.lastError = '等待托盘接管更新超时，请确认从 T3Tools 托盘程序运行后重试';
    }, applyTimeoutMs);
    applyTimeoutTimer.unref?.();
  }

  function readUpdateSettings() {
    const cfg = settings?.get?.() || {};
    const au = cfg.appUpdates && typeof cfg.appUpdates === 'object' ? cfg.appUpdates : {};
    const rawMins = Number(au.checkIntervalMinutes);
    const checkIntervalMinutes = Number.isInteger(rawMins) && VALID_CHECK_INTERVAL_MINUTES.includes(rawMins)
      ? rawMins
      : DEFAULT_CHECK_INTERVAL_MINUTES;
    return {
      autoCheck: au.autoCheck !== false,
      checkIntervalMinutes,
      skippedVersion: String(au.skippedVersion || '').trim()
    };
  }

  function getEffectiveCheckIntervalMs(updateCfg = readUpdateSettings()) {
    if (Number.isFinite(checkIntervalMs) && checkIntervalMs > 0) {
      return checkIntervalMs;
    }
    return updateCfg.checkIntervalMinutes * 60 * 1000;
  }

  function getStatus() {
    const updateCfg = readUpdateSettings();
    const isSkipped = Boolean(
      state.hasUpdate &&
      state.latestVersion &&
      updateCfg.skippedVersion &&
      updateCfg.skippedVersion.replace(/^v/i, '') === state.latestVersion.replace(/^v/i, '')
    );
    return {
      currentVersion,
      installMode: installCtx.mode,
      installDir: installCtx.installDir,
      hasBundledNode: installCtx.hasBundledNode,
      canAutoUpdate: installCtx.canAutoUpdate,
      cannotUpdateReason: installCtx.cannotUpdateReason,
      status: state.status,
      hasUpdate: state.hasUpdate,
      isSkipped,
      latestVersion: state.latestVersion,
      publishedAt: state.publishedAt,
      releaseUrl: state.releaseUrl,
      releaseNotes: state.releaseNotes,
      minNodeVersion: state.minNodeVersion,
      packageKind: state.selectedPackage?.kind || null,
      downloadSize: state.selectedPackage?.size || 0,
      downloadedBytes: state.downloadedBytes,
      progressPercent: state.progressPercent,
      stagedZipPath: state.stagedZipPath,
      stagedSha256: state.stagedSha256,
      stagedVersion: state.stagedVersion,
      applyRequestedAtMs: state.applyRequestedAtMs,
      checkedAtMs: state.checkedAtMs,
      lastError: state.lastError,
      autoCheck: updateCfg.autoCheck,
      checkIntervalMinutes: updateCfg.checkIntervalMinutes,
      skippedVersion: updateCfg.skippedVersion,
      justUpdated: justUpdated ? {
        fromVersion: String(justUpdated.fromVersion || ''),
        toVersion: String(justUpdated.toVersion || currentVersion),
        updatedAt: String(justUpdated.updatedAt || '')
      } : null
    };
  }

  async function checkForUpdates({ force = false } = {}) {
    if (inFlightCheck) return inFlightCheck;
    if (typeof fetchImpl !== 'function') {
      state.status = 'error';
      state.lastError = '当前环境不支持网络请求';
      return getStatus();
    }

    const now = Date.now();
    if (!force && state.lastAttemptAtMs > 0) {
      const waitMs = state.lastError ? errorBackoffMs : getEffectiveCheckIntervalMs();
      if (now - state.lastAttemptAtMs < waitMs) {
        return getStatus();
      }
    }

    const busyInstall = ['downloading', 'verifying', 'ready', 'applying'].includes(state.status);
    if (!busyInstall) {
      state.status = 'checking';
      state.lastError = '';
    }
    state.lastAttemptAtMs = now;

    inFlightCheck = (async () => {
      try {
        const res = await fetchWithValidatedRedirects(fetchImpl, manifestUrl, {
          headers: {
            Accept: 'application/json',
            'Cache-Control': 'no-cache',
            'User-Agent': `T3Tools/${currentVersion}`
          },
          timeoutMs: requestTimeoutMs,
          allowLocalhost: allowLocalhostForTest,
          initialAllowAssetHost: false
        });
        if (!res.ok) {
          throw new Error(`检查更新失败 (HTTP ${res.status})`);
        }
        const manifest = await res.json();
        const latestVer = String(manifest?.version || '').trim().replace(/^v/i, '');
        if (!latestVer || compareSemver(latestVer, latestVer) !== 0) {
          throw new Error('更新清单版本号格式无效');
        }

        const cmp = compareSemver(currentVersion, latestVer);
        const hasUpdate = cmp === -1;
        const pkg = hasUpdate
          ? selectUpdatePackage(manifest, {
            currentNodeVersion: installCtx.nodeVersion,
            allowLocalhost: allowLocalhostForTest
          })
          : null;

        state.checkedAtMs = Date.now();
        state.latestVersion = latestVer;
        state.publishedAt = manifest.publishedAt ? String(manifest.publishedAt) : null;
        state.releaseUrl = normalizeReleaseUrl(manifest);
        state.releaseNotes = String(manifest.notes || '').trim();
        state.minNodeVersion = String(manifest.minNodeVersion || '').trim();
        state.hasUpdate = hasUpdate;

        const stillBusy = ['downloading', 'verifying', 'ready', 'applying'].includes(state.status);
        if (!stillBusy) {
          state.selectedPackage = pkg;
          state.lastError = '';
          state.status = hasUpdate ? 'available' : 'up-to-date';
          if (!hasUpdate) {
            state.downloadedBytes = 0;
            state.progressPercent = 0;
            state.stagedZipPath = '';
            state.stagedSha256 = '';
            state.stagedVersion = '';
            state.applyRequestedAtMs = null;
          }
        }
      } catch (err) {
        state.checkedAtMs = Date.now();
        state.lastError = err?.message || '检查更新失败';
        const stillBusy = ['downloading', 'verifying', 'ready', 'applying'].includes(state.status);
        if (!stillBusy) {
          state.status = state.hasUpdate ? 'available' : 'error';
        }
      } finally {
        inFlightCheck = null;
      }
      return getStatus();
    })();

    return inFlightCheck;
  }

  function cleanStaleStagingFiles(stagingDir, keepPrefix = '') {
    if (!existsSync(stagingDir)) return;
    try {
      for (const name of readdirSync(stagingDir)) {
        if (keepPrefix && name.startsWith(keepPrefix)) continue;
        try { rmSync(join(stagingDir, name), { recursive: true, force: true }); } catch {}
      }
    } catch {}
  }

  async function downloadAndStagePackage(targetVersion, pkg) {
    const stagingDir = join(installCtx.installDir, '_staging');
    const safeVer = targetVersion.replace(/[^0-9A-Za-z._-]/g, '_');
    const finalZipPath = join(stagingDir, `T3Tools-v${safeVer}-${pkg.kind}.zip`);
    const partZipPath = `${finalZipPath}.part`;

    clearApplyTimeout();
    state.status = 'downloading';
    state.downloadedBytes = 0;
    state.progressPercent = 0;
    state.lastError = '';
    state.stagedZipPath = '';
    state.stagedSha256 = '';
    state.stagedVersion = '';
    state.applyRequestedAtMs = null;

    let writeStream = null;
    try {
      mkdirSync(stagingDir, { recursive: true });
      cleanStaleStagingFiles(stagingDir, `T3Tools-v${safeVer}`);

      const res = await fetchWithValidatedRedirects(fetchImpl, pkg.url, {
        headers: { 'User-Agent': `T3Tools/${currentVersion}` },
        timeoutMs: downloadTimeoutMs,
        allowLocalhost: allowLocalhostForTest,
        initialAllowAssetHost: false
      });
      if (!res.ok) {
        throw new Error(`下载更新包失败 (HTTP ${res.status})`);
      }

      const totalBytes = Number(res.headers?.get?.('content-length')) || pkg.size || 0;
      if (totalBytes > MAX_PACKAGE_BYTES) {
        throw new Error('更新包体积超出安全上限');
      }

      const hash = createHash('sha256');
      writeStream = createWriteStream(partZipPath);
      let streamError = null;
      const streamErrorPromise = new Promise((_, rejectStream) => {
        writeStream.once('error', err => {
          streamError = err;
          rejectStream(err);
        });
      });
      // Prevent unhandled rejection when stream closes without error
      streamErrorPromise.catch(() => {});

      const writeChunk = chunk => {
        if (streamError) return Promise.reject(streamError);
        return new Promise((resolveWrite, rejectWrite) => {
          if (!writeStream.write(chunk)) {
            const onDrain = () => { cleanup(); resolveWrite(); };
            const onErr = err => { cleanup(); rejectWrite(err); };
            const cleanup = () => {
              writeStream?.off('drain', onDrain);
              writeStream?.off('error', onErr);
            };
            writeStream.once('drain', onDrain);
            writeStream.once('error', onErr);
          } else {
            resolveWrite();
          }
        });
      };

      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await Promise.race([reader.read(), streamErrorPromise]);
          if (done) break;
          const buf = Buffer.from(value);
          state.downloadedBytes += buf.length;
          if (state.downloadedBytes > MAX_PACKAGE_BYTES) {
            try { await reader.cancel(); } catch {}
            throw new Error('更新包实际体积超出安全上限');
          }
          hash.update(buf);
          await writeChunk(buf);
          if (totalBytes > 0) {
            state.progressPercent = Math.min(99, Math.round((state.downloadedBytes / totalBytes) * 100));
          }
        }
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_PACKAGE_BYTES) {
          throw new Error('更新包实际体积超出安全上限');
        }
        state.downloadedBytes = buf.length;
        hash.update(buf);
        await writeChunk(buf);
        state.progressPercent = 99;
      }

      if (streamError) throw streamError;
      await new Promise((resolveEnd, rejectEnd) => {
        writeStream.once('finish', resolveEnd);
        writeStream.once('error', rejectEnd);
        writeStream.end();
      });
      writeStream = null;

      state.status = 'verifying';
      const actualSha = hash.digest('hex').toLowerCase();
      if (!safeHexEqual(actualSha, pkg.sha256)) {
        try { unlinkSync(partZipPath); } catch {}
        throw new Error('更新包 SHA-256 校验失败，已中止安装');
      }

      try { if (existsSync(finalZipPath)) unlinkSync(finalZipPath); } catch {}
      renameSync(partZipPath, finalZipPath);

      const requestedAtMs = Date.now();
      atomicWriteJson(join(stagingDir, 'pending-update.json'), {
        version: targetVersion,
        fromVersion: currentVersion,
        packageKind: pkg.kind,
        zipPath: finalZipPath,
        sha256: actualSha,
        installDir: installCtx.installDir,
        requestedAtMs
      });

      state.stagedZipPath = finalZipPath;
      state.stagedSha256 = actualSha;
      state.stagedVersion = targetVersion;
      state.progressPercent = 100;
      state.applyRequestedAtMs = requestedAtMs;
      state.status = 'ready';
      state.lastError = '';
      armApplyTimeout();
      return getStatus();
    } catch (err) {
      if (writeStream) {
        try { writeStream.destroy(); } catch {}
      }
      try { if (existsSync(partZipPath)) unlinkSync(partZipPath); } catch {}
      state.status = 'error';
      state.lastError = err?.message || '下载更新失败';
      state.applyRequestedAtMs = null;
      return getStatus();
    }
  }

  /**
   * Single-flight install entry: acquires `inFlightInstall` synchronously BEFORE any await
   * so concurrent callers can never race on the same staging file or crash the daemon.
   */
  function startInstall() {
    if (!installCtx.canAutoUpdate) {
      return Promise.resolve({
        ok: false,
        error: installCtx.cannotUpdateReason || '当前安装方式不支持自动更新',
        status: getStatus()
      });
    }

    if (inFlightInstall) {
      return Promise.resolve({ ok: true, alreadyInProgress: true, status: getStatus() });
    }

    if (state.status === 'ready' && state.stagedZipPath && existsSync(state.stagedZipPath)) {
      state.applyRequestedAtMs = Date.now();
      armApplyTimeout();
      return Promise.resolve({ ok: true, ready: true, status: getStatus() });
    }

    let resolveInitial;
    const initialReply = new Promise(r => { resolveInitial = r; });

    const run = (async () => {
      try {
        if (!state.hasUpdate || !state.selectedPackage) {
          await checkForUpdates({ force: true });
        }
        if (!state.hasUpdate) {
          const reply = { ok: false, error: '当前已是最新版本', status: getStatus() };
          resolveInitial(reply);
          return reply.status;
        }
        if (!state.selectedPackage) {
          const reply = {
            ok: false,
            error: '该版本缺少有效的校验信息或更新包，请手动前往 GitHub Releases 下载',
            status: getStatus()
          };
          resolveInitial(reply);
          return reply.status;
        }

        const targetVersion = state.latestVersion;
        const pkg = state.selectedPackage;
        if (readUpdateSettings().skippedVersion) {
          try { settings?.update?.({ appUpdates: { skippedVersion: '' } }); } catch {}
        }

        state.status = 'downloading';
        state.lastError = '';
        state.progressPercent = 0;
        resolveInitial({ ok: true, started: true, status: getStatus() });

        return await downloadAndStagePackage(targetVersion, pkg);
      } catch (err) {
        state.status = 'error';
        state.lastError = err?.message || '启动更新失败';
        state.applyRequestedAtMs = null;
        resolveInitial({ ok: false, error: state.lastError, status: getStatus() });
        return getStatus();
      } finally {
        if (inFlightInstall === run) inFlightInstall = null;
      }
    })();

    inFlightInstall = run;
    return initialReply;
  }

  function skipVersion(version = '') {
    const clean = String(version || state.latestVersion || '').trim().replace(/^v/i, '');
    if (settings?.update) {
      settings.update({ appUpdates: { skippedVersion: clean } });
    }
    return getStatus();
  }

  /**
   * Magpie-style freshness check: when the user opens the dashboard or settings
   * and the cached update result is older than freshAfterMs (default 5 min),
   * trigger a non-blocking background recheck so recent releases surface right away.
   */
  function refreshIfStale({ freshAfterMs: overrideFreshMs } = {}) {
    if (stopped || inFlightCheck || typeof fetchImpl !== 'function') return false;
    const updateCfg = readUpdateSettings();
    if (!updateCfg.autoCheck) return false;
    if (['checking', 'downloading', 'verifying', 'ready', 'applying'].includes(state.status)) {
      return false;
    }
    const threshold = Number.isFinite(overrideFreshMs) && overrideFreshMs >= 0
      ? overrideFreshMs
      : freshAfterMs;
    const stale = state.lastAttemptAtMs === 0 || (Date.now() - state.lastAttemptAtMs >= threshold);
    if (!stale) return false;
    checkForUpdates({ force: true }).catch(() => {});
    return true;
  }

  function start() {
    if (!enableBackgroundCheck || stopped) return;
    if (initialTimer || intervalTimer) return;

    initialTimer = setTimeout(() => {
      initialTimer = null;
      if (stopped) return;
      if (readUpdateSettings().autoCheck) {
        checkForUpdates({ force: false }).catch(() => {});
      }
    }, initialDelayMs);
    initialTimer.unref?.();

    // Magpie-style 1-minute scheduler loop: dynamically honors settings changes immediately
    const effectiveTickMs = Number.isFinite(checkIntervalMs) && checkIntervalMs > 0
      ? Math.min(tickIntervalMs, checkIntervalMs)
      : tickIntervalMs;
    intervalTimer = setInterval(() => {
      if (stopped) return;
      const updateCfg = readUpdateSettings();
      if (!updateCfg.autoCheck) return;
      const waitMs = state.lastError ? errorBackoffMs : getEffectiveCheckIntervalMs(updateCfg);
      if (state.lastAttemptAtMs === 0 || (Date.now() - state.lastAttemptAtMs >= waitMs)) {
        checkForUpdates({ force: false }).catch(() => {});
      }
    }, Math.max(10, effectiveTickMs));
    intervalTimer.unref?.();
  }

  function stop() {
    stopped = true;
    clearApplyTimeout();
    if (initialTimer) {
      clearTimeout(initialTimer);
      initialTimer = null;
    }
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
  }

  return {
    getStatus,
    checkForUpdates,
    refreshIfStale,
    startInstall,
    skipVersion,
    waitForInstall: () => inFlightInstall || Promise.resolve(getStatus()),
    start,
    stop
  };
}
