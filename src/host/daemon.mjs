import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolvePaths } from '../core/paths.mjs';
import { createSettingsStore, atomicWriteJson } from '../core/settings.mjs';
import { createPricingResolver } from '../core/pricing.mjs';
import { createTelemetryStore } from '../core/telemetry-store.mjs';
import { createT3StateAdapter } from '../adapters/t3-state.mjs';
import { createAntigravityAdapter } from '../adapters/antigravity.mjs';
import { createCodexAdapter } from '../adapters/codex.mjs';
import { createQuotaAdapter } from '../adapters/quota.mjs';
import { createRuntimeUpdatesAdapter } from '../adapters/runtime-updates.mjs';
import { createAnalyticsEngine } from '../analytics/engine.mjs';
import { createCdpHost, readT3ServerOrigin } from './cdp-host.mjs';
import { createHttpServer } from './http-server.mjs';
import {
  inspectShortcuts,
  isT3ProcessRunning,
  patchT3Launchers,
  patchT3ShortcutsDebugArg,
  launchT3WithDebugPort,
  relaunchT3WithDebugPort
} from './windows-launcher.mjs';
import { buildClientBundle } from '../ui/bundle.mjs';
import { buildFallbackHtml } from '../ui/fallback-page.mjs';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
export const PLUGIN_VERSION = pkg.version;

/**
 * Check if a T3Tools daemon is already running and responsive (single-instance guard).
 */
export async function probeRunningDaemon(runtimeFilePath, { fetchImpl = globalThis.fetch } = {}) {
  if (!runtimeFilePath || !existsSync(runtimeFilePath)) return null;
  let rt;
  try {
    rt = JSON.parse(readFileSync(runtimeFilePath, 'utf8'));
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(rt?.startedAtMs) || !Number.isSafeInteger(rt?.pid) || rt.pid <= 0 || !Number.isInteger(rt.port) ||
      rt.port < 1 || rt.port > 65535 || rt.url !== `http://127.0.0.1:${rt.port}`) return null;
  try {
    process.kill(rt.pid, 0);
  } catch (err) {
    if (err?.code === 'ESRCH') return null;
  }
  try {
    const res = await fetchImpl(`${rt.url}/api/status`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
    if (res.ok) {
      const json = await res.json();
      if (json?.ok && json.data?.pid === rt.pid && json.data?.startedAtMs === rt.startedAtMs) return { ...rt, status: json.data };
    }
  } catch {}
  return null;
}

export function createRuntimeContext(pathOverrides = {}, options = {}) {
  const paths = resolvePaths(pathOverrides);
  const settings = createSettingsStore(paths.pluginSettingsPath);
  const pricing = createPricingResolver(paths.modelRatesPath);
  const store = createTelemetryStore(paths.telemetryDbPath);
  const t3State = createT3StateAdapter(paths);
  const antigravityAdapter = createAntigravityAdapter({ paths, store, pricing, t3State });
  const codexAdapter = createCodexAdapter({ paths, store, pricing, t3State });
  const quotaAdapter = createQuotaAdapter({ paths, store, t3State, codexAdapter });
  const runtimeUpdatesAdapter = createRuntimeUpdatesAdapter({
    paths,
    t3State,
    fetchImpl: options.fetchImpl,
    enableRemoteCheck: options.enableRemoteUpdateCheck !== false
  });
  const engine = createAnalyticsEngine({
    store,
    settings,
    t3State,
    antigravityAdapter,
    codexAdapter,
    quotaAdapter,
    runtimeUpdatesAdapter
  });

  return {
    version: PLUGIN_VERSION,
    paths,
    settings,
    pricing,
    store,
    t3State,
    antigravityAdapter,
    codexAdapter,
    quotaAdapter,
    runtimeUpdatesAdapter,
    engine,
    close() {
      store.close();
    }
  };
}

export async function startDaemon({
  pathOverrides = {},
  portOverride = null,
  authTokenOverride = '',
  enableCdp = true,
  autoPatchLauncher = false,
  autoPatchDebugArg = false,
  autoExitWhenT3Gone = false,
  autoExitGraceMs = 45000,
  autoExitPollMs = 15000,
  checkT3Running = isT3ProcessRunning,
  fetchImpl = undefined,
  enableRemoteUpdateCheck = true,
  onAutoExit = null,
  onShutdownRequest = null
} = {}) {
  const ctx = createRuntimeContext(pathOverrides, { fetchImpl, enableRemoteUpdateCheck });
  const cfg = ctx.settings.get();
  const port = Number.isInteger(portOverride) ? portOverride : (cfg.port || 17373);
  const candidateToken = String(authTokenOverride || process.env.T3TOOLS_AUTH_TOKEN || '').trim();
  const authToken = /^[a-f0-9]{32,128}$/i.test(candidateToken)
    ? candidateToken
    : randomBytes(24).toString('hex');

  if (process.platform === 'win32') {
    if (autoPatchLauncher) {
      try { patchT3Launchers(ctx.paths); } catch {}
    } else if (autoPatchDebugArg && cfg.autoPatchLauncher !== false) {
      try { patchT3ShortcutsDebugArg(ctx.paths); } catch {}
    }
  }

  ctx.engine.syncAll({ force: true });

  const startedAtMs = Date.now();
  let cdpHost = null;
  let boundPort = port;
  let activeCdpThreadId = '';
  let activeCdpThreadAtMs = 0;
  const ACTIVE_CDP_THREAD_TTL_MS = 30000;

  function getActiveCdpThreadId(now = Date.now()) {
    if (!activeCdpThreadId) return '';
    if (now - activeCdpThreadAtMs > ACTIVE_CDP_THREAD_TTL_MS) return '';
    return activeCdpThreadId;
  }

  // Discover any fixed debugging ports already set on T3 Code shortcuts (fixes P2 #19)
  let fixedShortcutPorts = [];
  function refreshFixedShortcutPorts() {
    if (process.platform !== 'win32' || !enableCdp) return fixedShortcutPorts;
    try {
      const inspected = inspectShortcuts(ctx.paths);
      fixedShortcutPorts = inspected.shortcuts.map(s => s.fixedPort).filter(p => Number.isInteger(p) && p > 0);
    } catch {}
    return fixedShortcutPorts;
  }
  refreshFixedShortcutPorts();

  function getDaemonStatus() {
    return {
      version: PLUGIN_VERSION,
      pid: process.pid,
      startedAtMs,
      httpUrl: `http://127.0.0.1:${boundPort}`,
      cdp: cdpHost ? cdpHost.getStatus() : { connected: false, message: 'CDP 未启用', lastError: '' },
      alerts: ctx.engine.getAlerts(),
      runtimeUpdates: ctx.engine.getRuntimeUpdates(),
      todayUsage: ctx.engine.getTodayUsageSummary(),
      settings: ctx.settings.get(),
      diagnostics: {
        antigravity: ctx.antigravityAdapter.getDiagnostics(),
        codex: ctx.codexAdapter.getDiagnostics()
      },
      paths: {
        t3Root: ctx.paths.t3Root,
        electronUserData: ctx.paths.electronUserData,
        pluginDataDir: ctx.paths.pluginDataDir
      }
    };
  }

  async function handleRpc(action, params = {}) {
    switch (action) {
      case 'ackErrors': return ctx.engine.acknowledgeErrors();
      case 'testAlert': return ctx.engine.testAlert();
      case 'focusThread': return cdpHost?.focusThread({ threadId: params.threadId, environmentId: ctx.t3State.readThreadIndex().threadsById.get(params.threadId)?.environmentId }) || { ok: false, focused: false, reason: 'T3 Code 未处于吸附状态' };
      case 'getStatus':
        return getDaemonStatus();
      case 'getLive': {
        // Desktop CDP client passes allowFallback: false so unresolved routes never display another thread (fixes P1 #2)
        const reqThreadId = String(params.threadId || '').trim();
        activeCdpThreadId = reqThreadId;
        activeCdpThreadAtMs = Date.now();
        return ctx.engine.getLiveThreadSnapshot(reqThreadId, { allowFallback: false });
      }
      case 'exportRequestsCsv':
        return ctx.engine.exportRequestsCsv(params || {});
      case 'getDashboard':
        return ctx.engine.getDashboardData(params || {}, { forceSync: Boolean(params.force) });
      case 'getSettings':
        return ctx.settings.get();
      case 'updateSettings':
        return ctx.settings.update(params || {});
      case 'forceSync':
        ctx.engine.syncAll({ force: true });
        return { syncedAtMs: Date.now() };
      case 'checkRuntimeUpdates':
        return ctx.engine.checkRuntimeUpdates();
      case 'getLauncherStatus':
        return inspectShortcuts(ctx.paths);
      default:
        throw new Error(`不支持的 RPC 操作: ${action}`);
    }
  }

  const httpServer = createHttpServer({
    port,
    authToken,
    getAllowedOrigins: () => {
      const t3Origin = readT3ServerOrigin(ctx.paths.serverRuntimePath);
      return t3Origin ? [t3Origin] : [];
    },
    getActiveThreadId: () => getActiveCdpThreadId(),
    handleRpc,
    engine: ctx.engine,
    settings: ctx.settings,
    getDaemonStatus,
    buildClientBundle: opts => buildClientBundle({ ...opts, version: PLUGIN_VERSION }),
    buildFallbackHtml: opts => buildFallbackHtml({ ...opts, version: PLUGIN_VERSION }),
    onSettingsUpdated: async (updated, patch) => {
      if (cdpHost && Object.prototype.hasOwnProperty.call(patch || {}, 'autoAttachT3')) {
        await cdpHost.setEnabled(Boolean(updated.autoAttachT3));
      }
      if (process.platform === 'win32' && patch?.autoPatchLauncher === true && autoPatchDebugArg) {
        try { patchT3ShortcutsDebugArg(ctx.paths); } catch {}
      }
    },
    onReattachCdp: async () => {
      refreshFixedShortcutPorts();
      if (!cdpHost) return { enabled: false, connected: false, message: 'CDP 未启用', lastError: '' };
      return cdpHost.reattachNow();
    },
    onToggleCdp: async nextEnabled => {
      ctx.settings.update({ autoAttachT3: Boolean(nextEnabled) });
      if (!cdpHost) return { enabled: Boolean(nextEnabled), connected: false, message: 'CDP 未启用', lastError: '' };
      return cdpHost.setEnabled(Boolean(nextEnabled));
    },
    onPatchDebugShortcuts: async () => {
      if (process.platform !== 'win32') return { ok: false, error: '仅支持 Windows' };
      const res = patchT3ShortcutsDebugArg(ctx.paths);
      refreshFixedShortcutPorts();
      return res;
    },
    onLaunchT3: async () => {
      const res = await launchT3WithDebugPort(ctx.paths);
      if (res.ok && cdpHost) {
        setTimeout(() => { cdpHost.reattachNow().catch(() => {}); }, 2000);
      }
      return res;
    },
    onRelaunchT3: async () => {
      const res = await relaunchT3WithDebugPort(ctx.paths);
      if (res.ok && cdpHost) {
        setTimeout(() => { cdpHost.reattachNow().catch(() => {}); }, 2500);
      }
      return res;
    },
    onShutdown: async () => {
      await stop();
      if (typeof onShutdownRequest === 'function') onShutdownRequest();
    }
  });

  let alertTimer = null;
  let watchdogTimer = null;
  let stopped = false;
  let stopPromise;
  try {
    const bound = await httpServer.listen();
    boundPort = bound.port;

    if (enableCdp) {
      cdpHost = createCdpHost({
        paths: ctx.paths,
        getFixedPorts: () => fixedShortcutPorts,
        initialEnabled: cfg.autoAttachT3 !== false,
        buildClientBundle: opts => buildClientBundle({
          ...opts,
          version: PLUGIN_VERSION,
          apiBase: `http://127.0.0.1:${boundPort}`
        }),
        handleRpc,
        version: PLUGIN_VERSION
      });
      cdpHost.start();
    }

    atomicWriteJson(ctx.paths.runtimeFilePath, {
      version: PLUGIN_VERSION,
      pid: process.pid,
      port: boundPort,
      url: `http://127.0.0.1:${boundPort}`,
      autoExitWhenT3Gone: Boolean(autoExitWhenT3Gone),
      startedAtMs
    });

    // Scheme A lifecycle watchdog: exit cleanly once T3 Code has completely exited
    // (after startup grace period + 2 consecutive misses so T3 restarts/updates survive smoothly)
    ctx.engine.tickAlerts();
  } catch (err) {
    await stop();
    throw err;
  }
  alertTimer = setInterval(() => {
    try { ctx.engine.tickAlerts(); } catch (err) { console.warn('告警同步失败', err.message); }
  }, 5000);
  alertTimer.unref();
  let consecutiveGone = 0;

  function stop() {
    return stopPromise ??= closeResources();
  }

  async function closeResources() {
    stopped = true;
    clearInterval(alertTimer);
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    try { await cdpHost?.stop(); } catch {}
    try { await httpServer.close(); } catch {}
    try { ctx.close(); } catch {}
    try {
      const current = JSON.parse(readFileSync(ctx.paths.runtimeFilePath, 'utf8'));
      if (current.pid === process.pid && current.port === boundPort && current.startedAtMs === startedAtMs) unlinkSync(ctx.paths.runtimeFilePath);
    } catch {}
  }

  if (autoExitWhenT3Gone) {
    watchdogTimer = setInterval(async () => {
      if (stopped) return;
      if (Date.now() - startedAtMs < autoExitGraceMs) return;
      const cdpSt = cdpHost?.getStatus?.();
      if (cdpSt?.connected) {
        consecutiveGone = 0;
        return;
      }
      const running = Boolean(checkT3Running());
      if (running) {
        consecutiveGone = 0;
        return;
      }
      consecutiveGone++;
      if (consecutiveGone >= 2) {
        await stop();
        if (typeof onAutoExit === 'function') onAutoExit();
      }
    }, autoExitPollMs);
    watchdogTimer.unref?.();
  }

  return {
    version: PLUGIN_VERSION,
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}`,
    authToken,
    ctx,
    cdpHost,
    httpServer,
    getStatus: getDaemonStatus,
    stop
  };
}
