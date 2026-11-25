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
import { createAnalyticsEngine } from '../analytics/engine.mjs';
import { createCdpHost, readT3ServerOrigin } from './cdp-host.mjs';
import { createHttpServer } from './http-server.mjs';
import { inspectShortcuts, isT3ProcessRunning, patchT3Launchers } from './windows-launcher.mjs';
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
  if (!rt?.url || !rt?.pid) return null;
  try {
    process.kill(rt.pid, 0);
  } catch (err) {
    if (err?.code === 'ESRCH') return null;
  }
  try {
    const res = await fetchImpl(`${rt.url}/api/status`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const json = await res.json();
      if (json?.ok) return { ...rt, status: json.data };
    }
  } catch {}
  return null;
}

export function createRuntimeContext(pathOverrides = {}) {
  const paths = resolvePaths(pathOverrides);
  const settings = createSettingsStore(paths.pluginSettingsPath);
  const pricing = createPricingResolver(paths.modelRatesPath);
  const store = createTelemetryStore(paths.telemetryDbPath);
  const t3State = createT3StateAdapter(paths);
  const antigravityAdapter = createAntigravityAdapter({ paths, store, pricing, t3State });
  const codexAdapter = createCodexAdapter({ paths, store, pricing, t3State });
  const quotaAdapter = createQuotaAdapter({ paths, store, t3State, codexAdapter });
  const engine = createAnalyticsEngine({
    store,
    settings,
    t3State,
    antigravityAdapter,
    codexAdapter,
    quotaAdapter
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
    engine,
    close() {
      store.close();
    }
  };
}

export async function startDaemon({
  pathOverrides = {},
  portOverride = null,
  enableCdp = true,
  autoPatchLauncher = false,
  autoExitWhenT3Gone = false,
  autoExitGraceMs = 45000,
  autoExitPollMs = 15000,
  checkT3Running = isT3ProcessRunning,
  onAutoExit = null
} = {}) {
  const ctx = createRuntimeContext(pathOverrides);
  const cfg = ctx.settings.get();
  const port = Number.isInteger(portOverride) ? portOverride : (cfg.port || 17373);
  const authToken = randomBytes(24).toString('hex');

  if (autoPatchLauncher && process.platform === 'win32') {
    try { patchT3Launchers(ctx.paths); } catch {}
  }

  ctx.engine.syncAll({ force: true });

  const startedAtMs = Date.now();
  let cdpHost = null;
  let boundPort = port;

  // Discover any fixed debugging ports already set on T3 Code shortcuts (fixes P2 #19)
  let fixedShortcutPorts = [];
  if (process.platform === 'win32' && enableCdp) {
    try {
      const inspected = inspectShortcuts(ctx.paths);
      fixedShortcutPorts = inspected.shortcuts.map(s => s.fixedPort).filter(p => Number.isInteger(p) && p > 0);
    } catch {}
  }

  function getDaemonStatus() {
    return {
      version: PLUGIN_VERSION,
      pid: process.pid,
      startedAtMs,
      httpUrl: `http://127.0.0.1:${boundPort}`,
      cdp: cdpHost ? cdpHost.getStatus() : { connected: false, message: 'CDP 未启用', lastError: '' },
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
      case 'getStatus':
        return getDaemonStatus();
      case 'getLive':
        // Desktop CDP client passes allowFallback: false so unresolved routes never display another thread (fixes P1 #2)
        return ctx.engine.getLiveThreadSnapshot(params.threadId || '', { allowFallback: false });
      case 'getDashboard':
        return ctx.engine.getDashboardData(params || {}, { forceSync: Boolean(params.force) });
      case 'getSettings':
        return ctx.settings.get();
      case 'updateSettings':
        return ctx.settings.update(params || {});
      case 'forceSync':
        ctx.engine.syncAll({ force: true });
        return { syncedAtMs: Date.now() };
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
    engine: ctx.engine,
    settings: ctx.settings,
    getDaemonStatus,
    buildClientBundle: opts => buildClientBundle({ ...opts, version: PLUGIN_VERSION }),
    buildFallbackHtml: opts => buildFallbackHtml({ ...opts, version: PLUGIN_VERSION })
  });

  const bound = await httpServer.listen();
  boundPort = bound.port;

  if (enableCdp) {
    cdpHost = createCdpHost({
      paths: ctx.paths,
      getFixedPorts: () => fixedShortcutPorts,
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
  let watchdogTimer = null;
  let consecutiveGone = 0;
  let stopped = false;

  async function stop() {
    if (stopped) return;
    stopped = true;
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    try { await cdpHost?.stop(); } catch {}
    try { await httpServer.close(); } catch {}
    try { ctx.close(); } catch {}
    try { unlinkSync(ctx.paths.runtimeFilePath); } catch {}
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
