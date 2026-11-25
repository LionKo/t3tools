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

const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const DEFAULT_INITIAL_DELAY_MS = 15 * 1000; // 15 seconds after startup
const DEFAULT_ERROR_BACKOFF_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_REQUEST_TIMEOUT_MS = 12000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 180000;
const MAX_PACKAGE_BYTES = 160 * 1024 * 1024; // 160 MB safety cap

const DEFAULT_APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readJsonSafe(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

export function isAllowedUpdateUrl(rawUrl, { allowLocalhost = false } = {}) {
  try {
    const u = new URL(String(rawUrl || '').trim());
    if (allowLocalhost && (u.protocol === 'http:' || u.protocol === 'https:')) {
      if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return true;
    }
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return (
      host === 'github.com' ||
      host === 'objects.githubusercontent.com' ||
      host === 'release-assets.githubusercontent.com' ||
      host.endsWith('.githubusercontent.com')
    );
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
 * Inspect where T3Tools is running from:
 * - Installed/portable layout: <installDir>/T3Tools.exe + <installDir>/release.json + <installDir>/app/...
 * - Dev checkout layout: contains .git or lacks release.json/T3Tools.exe -> auto-update disabled to protect source tree.
 */
export function detectInstallContext({
  appRoot = DEFAULT_APP_ROOT,
  nodeVersion = process.versions.node
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
 * Pick lightweight appPackage (~200KB) for normal updates, and fall back to
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
    if (!url || !isAllowedUpdateUrl(url, { allowLocalhost }) || !isValidSha256(sha256)) return null;
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

  if (needsNodeUpgrade && fullPkg) return fullPkg;
  if (appPkg) return appPkg;
  if (fullPkg) return fullPkg;
  return null;
}

function normalizeReleaseUrl(manifest) {
  const candidate = String(manifest?.releaseUrl || '').trim();
  if (candidate && isAllowedUpdateUrl(candidate)) return candidate;
  const ver = String(manifest?.version || '').trim().replace(/^v/i, '');
  return ver ? `${APP_RELEASES_URL}/tag/v${encodeURIComponent(ver)}` : APP_RELEASES_URL;
}

function consumeJsonMarker(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  const parsed = readJsonSafe(filePath);
  try { unlinkSync(filePath); } catch {}
  return parsed && typeof parsed === 'object' ? parsed : null;
}

export function createAppUpdater({
  currentVersion = '0.1.0',
  settings,
  paths,
  appRoot = DEFAULT_APP_ROOT,
  manifestUrl = APP_UPDATE_MANIFEST_URL,
  fetchImpl = globalThis.fetch,
  enableBackgroundCheck = true,
  checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
  initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
  errorBackoffMs = DEFAULT_ERROR_BACKOFF_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  downloadTimeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
  nodeVersion = process.versions.node,
  allowLocalhostForTest = false
} = {}) {
  const installCtx = detectInstallContext({ appRoot, nodeVersion });
  const justUpdatedPath = paths?.pluginDataDir ? join(paths.pluginDataDir, 'just-updated.json') : '';
  const lastUpdateErrorPath = paths?.pluginDataDir ? join(paths.pluginDataDir, 'last-update-error.json') : '';

  const justUpdated = consumeJsonMarker(justUpdatedPath);
  const previousSwapError = consumeJsonMarker(lastUpdateErrorPath);

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
  let inFlightDownload = null;
  let initialTimer = null;
  let intervalTimer = null;
  let stopped = false;

  function readUpdateSettings() {
    const cfg = settings?.get?.() || {};
    const au = cfg.appUpdates && typeof cfg.appUpdates === 'object' ? cfg.appUpdates : {};
    return {
      autoCheck: au.autoCheck !== false,
      skippedVersion: String(au.skippedVersion || '').trim()
    };
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
      const waitMs = state.lastError ? errorBackoffMs : checkIntervalMs;
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
        if (!isAllowedUpdateUrl(manifestUrl, { allowLocalhost: allowLocalhostForTest })) {
          throw new Error('更新清单地址不受信任');
        }
        const res = await fetchImpl(manifestUrl, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'Cache-Control': 'no-cache',
            'User-Agent': `T3Tools/${currentVersion}`
          },
          signal: AbortSignal.timeout(requestTimeoutMs)
        });
        if (!res || !res.ok) {
          throw new Error(`检查更新失败 (HTTP ${res?.status ?? 'network'})`);
        }
        if (res.url && !isAllowedUpdateUrl(res.url, { allowLocalhost: allowLocalhostForTest })) {
          throw new Error('更新清单重定向到不受信任的域名');
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
        state.selectedPackage = pkg;
        state.hasUpdate = hasUpdate;
        state.lastError = '';

        if (!busyInstall || state.stagedVersion !== latestVer) {
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
        if (!busyInstall) {
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
    mkdirSync(stagingDir, { recursive: true });
    cleanStaleStagingFiles(stagingDir, `T3Tools-v${targetVersion}`);

    const safeVer = targetVersion.replace(/[^0-9A-Za-z._-]/g, '_');
    const finalZipPath = join(stagingDir, `T3Tools-v${safeVer}-${pkg.kind}.zip`);
    const partZipPath = `${finalZipPath}.part`;

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
      if (!isAllowedUpdateUrl(pkg.url, { allowLocalhost: allowLocalhostForTest })) {
        throw new Error('更新包下载地址不在白名单内');
      }

      const res = await fetchImpl(pkg.url, {
        method: 'GET',
        headers: { 'User-Agent': `T3Tools/${currentVersion}` },
        signal: AbortSignal.timeout(downloadTimeoutMs)
      });
      if (!res || !res.ok) {
        throw new Error(`下载更新包失败 (HTTP ${res?.status ?? 'network'})`);
      }
      if (res.url && !isAllowedUpdateUrl(res.url, { allowLocalhost: allowLocalhostForTest })) {
        throw new Error('更新包下载重定向到不受信任的域名');
      }

      const totalBytes = Number(res.headers?.get?.('content-length')) || pkg.size || 0;
      if (totalBytes > MAX_PACKAGE_BYTES) {
        throw new Error('更新包体积超出安全上限');
      }

      const hash = createHash('sha256');
      writeStream = createWriteStream(partZipPath);

      const writeChunk = chunk => new Promise((resolveWrite, rejectWrite) => {
        if (!writeStream.write(chunk)) {
          writeStream.once('drain', resolveWrite);
          writeStream.once('error', rejectWrite);
        } else {
          resolveWrite();
        }
      });

      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const buf = Buffer.from(value);
          state.downloadedBytes += buf.length;
          if (state.downloadedBytes > MAX_PACKAGE_BYTES) {
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

  async function startInstall() {
    if (!installCtx.canAutoUpdate) {
      return {
        ok: false,
        error: installCtx.cannotUpdateReason || '当前安装方式不支持自动更新',
        status: getStatus()
      };
    }

    if (inFlightDownload) {
      return { ok: true, alreadyInProgress: true, status: getStatus() };
    }

    if (state.status === 'ready' && state.stagedZipPath && existsSync(state.stagedZipPath)) {
      state.applyRequestedAtMs = Date.now();
      return { ok: true, ready: true, status: getStatus() };
    }

    if (!state.hasUpdate || !state.selectedPackage) {
      await checkForUpdates({ force: true });
    }
    if (!state.hasUpdate) {
      return { ok: false, error: '当前已是最新版本', status: getStatus() };
    }
    if (!state.selectedPackage) {
      return {
        ok: false,
        error: '该版本缺少有效的校验信息或更新包，请手动前往 GitHub Releases 下载',
        status: getStatus()
      };
    }

    const targetVersion = state.latestVersion;
    const pkg = state.selectedPackage;
    // Clear skippedVersion when user explicitly initiates update
    if (readUpdateSettings().skippedVersion) {
      try { settings?.update?.({ appUpdates: { skippedVersion: '' } }); } catch {}
    }

    inFlightDownload = downloadAndStagePackage(targetVersion, pkg).finally(() => {
      inFlightDownload = null;
    });

    return { ok: true, started: true, status: getStatus() };
  }

  function skipVersion(version = '') {
    const clean = String(version || state.latestVersion || '').trim().replace(/^v/i, '');
    if (settings?.update) {
      settings.update({ appUpdates: { skippedVersion: clean } });
    }
    return getStatus();
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

    intervalTimer = setInterval(() => {
      if (stopped) return;
      if (readUpdateSettings().autoCheck) {
        checkForUpdates({ force: false }).catch(() => {});
      }
    }, checkIntervalMs);
    intervalTimer.unref?.();
  }

  function stop() {
    stopped = true;
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
    startInstall,
    skipVersion,
    waitForInstall: () => inFlightDownload || Promise.resolve(getStatus()),
    start,
    stop
  };
}
