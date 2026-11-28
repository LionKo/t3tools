import { createRemoteBridge } from './remote-bridge.mjs';
import { isValidEnvironmentId } from './remote-bridge-protocol.mjs';
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
import { createFolderSync } from '../sync/folder-sync.mjs';
import { createAnalyticsEngine } from '../analytics/engine.mjs';
import { createCdpHost, readT3ServerOrigin } from './cdp-host.mjs';
import { createHttpServer } from './http-server.mjs';
import { createAppUpdater } from './app-updater.mjs';
import { createPrivacyGuard } from './privacy-guard.mjs';
import {
  inspectShortcuts,
  inspectShortcutsAsync,
  isT3ProcessRunning,
  patchT3Launchers,
  patchT3LaunchersAsync,
  patchT3ShortcutsDebugArg,
  patchT3ShortcutsDebugArgAsync,
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
export async function probeRunningDaemon(runtimeFilePath, { fetchImpl = globalThis.fetch, fullStatus = false } = {}) {
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
    const res = await fetchImpl(`${rt.url}/api/${fullStatus ? 'status' : 'health'}`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
    if (res.ok) {
      const json = await res.json();
      if (json?.ok && (fullStatus || json.data?.state === 'running') && json.data?.pid === rt.pid && json.data?.startedAtMs === rt.startedAtMs) return { ...rt, status: json.data };
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
  const folderSync = createFolderSync({
    paths,
    store,
    settings,
    appVersion: PLUGIN_VERSION
  });
  const engine = createAnalyticsEngine({
    store,
    settings,
    t3State,
    antigravityAdapter,
    codexAdapter,
    quotaAdapter,
    runtimeUpdatesAdapter,
    folderSync,
    deferFolderSync: Boolean(options.deferFolderSync)
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
    folderSync,
    engine,
    close() {
      try { t3State.close?.(); } catch {}
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
  enableAppUpdateCheck = enableRemoteUpdateCheck,
  appUpdateOptions = {},
  privacyGuardOptions = {},
  deferInitialSync = false,
  onAutoExit = null,
  onShutdownRequest = null
} = {}) {
  const ctx = createRuntimeContext(pathOverrides, {
    fetchImpl,
    enableRemoteUpdateCheck,
    deferFolderSync: true
  });
  const appUpdater = createAppUpdater({
    currentVersion: PLUGIN_VERSION,
    settings: ctx.settings,
    paths: ctx.paths,
    fetchImpl,
    enableBackgroundCheck: Boolean(enableAppUpdateCheck),
    ...appUpdateOptions
  });
  const privacyGuard = createPrivacyGuard({
    paths: ctx.paths,
    settings: ctx.settings,
    ...privacyGuardOptions
  });
  const cfg = ctx.settings.get();
  const port = Number.isInteger(portOverride) ? portOverride : (cfg.port || 17373);
  const candidateToken = String(authTokenOverride || process.env.T3TOOLS_AUTH_TOKEN || '').trim();
  const authToken = /^[a-f0-9]{32,128}$/i.test(candidateToken)
    ? candidateToken
    : randomBytes(24).toString('hex');

  let fixedShortcutPorts = [];
  function applyInspectedShortcutPorts(inspected) {
    if (Array.isArray(inspected?.shortcuts)) {
      fixedShortcutPorts = inspected.shortcuts.map(s => s.fixedPort).filter(p => Number.isInteger(p) && p > 0);
    }
    return fixedShortcutPorts;
  }

  function runStartupShortcutSetup() {
    if (process.platform !== 'win32') return;
    let patchedResult = null;
    if (autoPatchLauncher) {
      try { patchedResult = patchT3Launchers(ctx.paths); } catch {}
    } else if (autoPatchDebugArg && cfg.autoPatchLauncher !== false) {
      try { patchedResult = patchT3ShortcutsDebugArg(ctx.paths); } catch {}
    }
    if (Array.isArray(patchedResult?.shortcuts)) {
      applyInspectedShortcutPorts(patchedResult);
    } else if (enableCdp) {
      refreshFixedShortcutPorts();
    }
  }

  let shortcutSetupAbort = null;

  async function runStartupShortcutSetupAsync() {
    if (process.platform !== 'win32' || stopped) return;
    shortcutSetupAbort = new AbortController();
    const signal = shortcutSetupAbort.signal;
    try {
      const latestCfg = ctx.settings.get();
      let patchedResult = null;
      if (autoPatchLauncher) {
        try {
          patchedResult = await patchT3LaunchersAsync(ctx.paths, {
            signal,
            shouldProceed: () => !stopped
          });
        } catch {}
      } else if (autoPatchDebugArg && latestCfg.autoPatchLauncher !== false) {
        try {
          patchedResult = await patchT3ShortcutsDebugArgAsync(ctx.paths, {
            signal,
            shouldProceed: () => !stopped && ctx.settings.get().autoPatchLauncher !== false
          });
        } catch {}
      }
      if (stopped) return;
      if (Array.isArray(patchedResult?.shortcuts)) {
        applyInspectedShortcutPorts(patchedResult);
      } else if (enableCdp) {
        try {
          const inspected = await inspectShortcutsAsync(ctx.paths, { signal });
          if (!stopped) applyInspectedShortcutPorts(inspected);
        } catch {}
      }
    } finally {
      shortcutSetupAbort = null;
    }
  }

  function refreshFixedShortcutPorts() {
    if (process.platform !== 'win32' || !enableCdp) return fixedShortcutPorts;
    try {
      const inspected = inspectShortcuts(ctx.paths);
      applyInspectedShortcutPorts(inspected);
    } catch {}
    return fixedShortcutPorts;
  }

  async function refreshFixedShortcutPortsAsync() {
    if (process.platform !== 'win32' || !enableCdp) return fixedShortcutPorts;
    try {
      const inspected = await inspectShortcutsAsync(ctx.paths);
      if (!stopped) applyInspectedShortcutPorts(inspected);
    } catch {}
    return fixedShortcutPorts;
  }

  if (!deferInitialSync) {
    runStartupShortcutSetup();
    ctx.engine.syncAll({ force: true, includeFolderSync: false });
  }

  const startedAtMs = Date.now();
  let cdpHost = null;
  let boundPort = port;
  let activeTarget = null;
  const remoteBridge = createRemoteBridge({paths:ctx.paths, settings:ctx.settings, engine:ctx.engine,
    version:PLUGIN_VERSION, getLocalPort:()=>boundPort});
  const ACTIVE_CDP_THREAD_TTL_MS = 30000;
  let privacyApplySeq = 0;
  let privacyApplyPending = false;
  let cdpBlockChain = Promise.resolve();
  let activeRelaunchPromise = null;

  function schedulePrivacyApply(nextPrivacyCfg, { waitBudgetMs = 1500 } = {}) {
    const seq = ++privacyApplySeq;
    privacyApplyPending = true;
    privacyGuard.setExternalError('');
    const envTask = privacyGuard.applySettingsAsync(nextPrivacyCfg);
    const cdpTask = cdpHost
      ? (cdpBlockChain = cdpBlockChain.catch(() => {}).then(() => {
          if (seq !== privacyApplySeq) {
            return { appliedTargets: 0, failedTargets: 0, error: '', superseded: true };
          }
          return cdpHost.setBlockedUrls(privacyGuard.getBlockedCdpUrls(ctx.settings.get()?.privacyGuard));
        }))
      : Promise.resolve({ appliedTargets: 0, failedTargets: 0, error: '' });
    const combined = Promise.allSettled([envTask, cdpTask])
      .then(results => {
        if (seq !== privacyApplySeq) return;
        const rejected = results.find(r => r.status === 'rejected');
        if (rejected) {
          privacyGuard.setExternalError(rejected.reason?.message || String(rejected.reason));
        }
      })
      .finally(() => {
        if (seq === privacyApplySeq) privacyApplyPending = false;
      });
    if (waitBudgetMs <= 0) return Promise.resolve();
    return Promise.race([
      combined,
      new Promise(resolve => {
        const t = setTimeout(resolve, waitBudgetMs);
        t.unref?.();
      })
    ]);
  }

  function runRelaunchT3Async() {
    if (activeRelaunchPromise) return activeRelaunchPromise;
    privacyGuard.setExternalError('');
    activeRelaunchPromise = Promise.resolve()
      .then(() => relaunchT3WithDebugPort(ctx.paths, [], { env: privacyGuard.getLaunchEnv() }))
      .then(res => {
        if (res?.ok === false) {
          privacyGuard.setExternalError(res.error || '重启 T3 Code 失败');
        } else if (res?.ok && cdpHost && ctx.settings.get()?.autoAttachT3 !== false) {
          const t = setTimeout(() => {
            if (!stopped && ctx.settings.get()?.autoAttachT3 !== false) {
              cdpHost.reattachNow({ preserveDisabled: true }).catch(() => {});
            }
          }, 2500);
          t.unref?.();
        }
        return res;
      })
      .catch(err => {
        const msg = err?.message || String(err);
        privacyGuard.setExternalError(`重启 T3 Code 失败: ${msg}`);
        return { ok: false, error: msg };
      })
      .finally(() => {
        activeRelaunchPromise = null;
      });
    return activeRelaunchPromise;
  }

  async function resolveLiveTargetSnapshot({environmentId = '', threadId = '', allowFallback = true, cdp = false}) {
    if (cdp) activeTarget = {environmentId,threadId,updatedAtMs:Date.now()};
    else if (!threadId && !environmentId && allowFallback && activeTarget?.threadId && Date.now()-activeTarget.updatedAtMs <= ACTIVE_CDP_THREAD_TTL_MS) {
      ({environmentId,threadId} = activeTarget);
      allowFallback = false;
    }
    const local = remoteBridge.localEnvironmentId();
    if (environmentId && environmentId !== local) {
      if (local) return remoteBridge.fetchRemoteLive(environmentId,threadId);
      const record = ctx.t3State.readThreadIndex().threadsById.get(threadId);
      if (!isValidEnvironmentId(environmentId) || !record || record.hasEnvironmentIdColumn !== true || record.environmentId !== environmentId) return remoteBridge.fetchRemoteLive(environmentId,threadId,'localEnvUnknown');
      allowFallback = false;
    }
    const snapshot = ctx.engine.getLiveThreadSnapshot(threadId,{allowFallback});
    return {...snapshot,target:{environmentId:environmentId || local,threadId:snapshot.thread?.threadId || threadId},remote:null};
  }

  function getDaemonStatus({ fresh = false } = {}) {
    const now = Date.now();
    if (fresh && enableAppUpdateCheck) {
      appUpdater.refreshIfStale();
    }
    const settings = ctx.settings.get();
    const cdpStatus = cdpHost ? cdpHost.getStatus() : { connected: false, message: 'CDP 未启用', lastError: '' };
    return {
      version: PLUGIN_VERSION,
      pid: process.pid,
      startedAtMs,
      httpUrl: `http://127.0.0.1:${boundPort}`,
      cdp: cdpStatus,
      alerts: ctx.engine.getAlerts(),
      runtimeUpdates: ctx.engine.getRuntimeUpdates(now),
      appUpdate: appUpdater.getStatus(),
      privacyGuard: privacyGuard.getStatus({ cdpStatus, fresh, pendingApply: privacyApplyPending }),
      multiMachineSync: ctx.folderSync.getStatus(now),
      todayUsage: ctx.engine.getTodayUsageSummary(now),
      sidebarUsage: ctx.engine.getSidebarUsageSummary(now, { preset: settings.sidebarUsageRange }),
      settings,
      remoteBridge: remoteBridge.getStatus(),
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
    const result = await dispatchRpc(action, params);
    if (action === 'getRemoteBridgePairingCode') return result;
    return remoteBridge.publicData(result);
  }

  async function dispatchRpc(action, params = {}) {
    if (['focusThread','resolveErrors','ackErrors'].includes(action) && params.environmentId && params.environmentId !== remoteBridge.localEnvironmentId()) {
      return {ok:false,reason:'Remote target is read-only'};
    }
    switch (action) {
      case 'getRemoteBridgePairingCode':
      case 'rotateRemoteBridgeToken':
      case 'parseRemoteBridgePairingCode':
      case 'testRemoteBridgePeer':
      case 'upsertRemoteBridgePeer':
      case 'renameRemoteBridgePeer':
      case 'removeRemoteBridgePeer':
      case 'toggleRemoteBridgePeer':
        return remoteBridge.manage(action,params);
      case 'ackErrors': return ctx.engine.acknowledgeErrors();
      case 'resolveErrors': return ctx.engine.resolveErrors(params || {});
      case 'testAlert': return ctx.engine.testAlert();
      case 'focusThread': return cdpHost?.focusThread({ threadId: params.threadId, environmentId: ctx.t3State.readThreadIndex().threadsById.get(params.threadId)?.environmentId }) || { ok: false, focused: false, reason: 'T3 Code 未处于吸附状态' };
      case 'getStatus':
        return getDaemonStatus({ fresh: Boolean(params?.fresh) });
      case 'getLive': {
        // Desktop CDP client passes allowFallback: false so unresolved routes never display another thread (fixes P1 #2)
        const reqThreadId = String(params.threadId || '').trim();
        return {
          ...await resolveLiveTargetSnapshot({environmentId:params.environmentId,threadId:reqThreadId,allowFallback:false,cdp:true}),
          appUpdate: appUpdater.getStatus()
        };
      }
      case 'exportRequestsCsv':
        return ctx.engine.exportRequestsCsv(params || {});
      case 'getDashboard':
        if (params?.force) {
          ctx.engine.syncAll({ force: true, includeFolderSync: false });
          await ctx.folderSync.syncAsync({ force: true });
        }
        return ctx.engine.getDashboardData(params || {}, { forceSync: false });
      case 'getSettings':
        return ctx.settings.get();
      case 'updateSettings': {
        remoteBridge.validatePublicSettings(params || {});
        const updated = ctx.settings.update(params || {});
        if (params?.remoteBridge) await remoteBridge.configure();
        if (params?.multiMachineSync) {
          ctx.folderSync.invalidate?.();
          if (updated?.multiMachineSync?.enabled && String(updated?.multiMachineSync?.syncDir || '').trim()) {
            ctx.folderSync.syncAsync({ force: true }).catch(() => {});
          }
        }
        if (enableAppUpdateCheck && params?.appUpdates && updated?.appUpdates?.autoCheck !== false) {
          appUpdater.checkForUpdates({ force: false }).catch(() => {});
        }
        if (params?.privacyGuard) {
          await schedulePrivacyApply(updated.privacyGuard, { waitBudgetMs: 1500 });
        }
        return updated;
      }
      case 'relaunchT3': {
        // When invoked from inside the T3 Code window that is about to close, acknowledge
        // immediately before triggering the async relaunch so the closing window never hangs.
        const t = setTimeout(() => {
          if (!stopped) runRelaunchT3Async().catch(() => {});
        }, 40);
        t.unref?.();
        return { ok: true, accepted: true, message: '已开始异步重启 T3 Code' };
      }
      case 'forceSync':
        ctx.engine.syncAll({ force: true, includeFolderSync: false });
        await ctx.folderSync.syncAsync({ force: true });
        return { syncedAtMs: Date.now(), multiMachineSync: ctx.folderSync.getStatus() };
      case 'triggerMultiMachineSync':
        ctx.engine.syncAll({ force: true, includeFolderSync: false });
        return ctx.folderSync.syncAsync({ force: true });
      case 'clearRemoteSyncData':
        return ctx.folderSync.clearRemoteDataAsync();
      case 'checkRuntimeUpdates':
        return ctx.engine.checkRuntimeUpdates();
      case 'checkAppUpdate':
        return appUpdater.checkForUpdates({ force: true });
      case 'installAppUpdate':
        return appUpdater.startInstall(params || {});
      case 'skipAppUpdate':
        return appUpdater.skipVersion(params?.version || '');
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
    resolveLiveTargetSnapshot,
    redactBridgeText: remoteBridge.redactText,
    validatePublicSettings: remoteBridge.validatePublicSettings,
    handleRpc,
    engine: ctx.engine,
    settings: ctx.settings,
    getDaemonStatus,
    getAppUpdate: () => appUpdater.getStatus(),
    getHealth: () => ({ version: PLUGIN_VERSION, pid: process.pid, startedAtMs, state: stopped ? 'stopping' : 'running' }),
    buildClientBundle: opts => buildClientBundle({ ...opts, version: PLUGIN_VERSION }),
    buildFallbackHtml: opts => buildFallbackHtml({ ...opts, version: PLUGIN_VERSION }),
    onSettingsUpdated: async (updated, patch) => {
      if (patch?.remoteBridge) await remoteBridge.configure();
      if (cdpHost && Object.prototype.hasOwnProperty.call(patch || {}, 'autoAttachT3')) {
        await cdpHost.setEnabled(Boolean(updated.autoAttachT3));
      }
      if (process.platform === 'win32' && patch?.autoPatchLauncher === true && autoPatchDebugArg) {
        try { patchT3ShortcutsDebugArg(ctx.paths); } catch {}
      }
      if (patch?.multiMachineSync) {
        ctx.folderSync.invalidate?.();
        if (updated?.multiMachineSync?.enabled && String(updated?.multiMachineSync?.syncDir || '').trim()) {
          ctx.folderSync.syncAsync({ force: true }).catch(() => {});
        }
      }
      if (enableAppUpdateCheck && patch?.appUpdates && updated?.appUpdates?.autoCheck !== false) {
        appUpdater.checkForUpdates({ force: false }).catch(() => {});
      }
      if (patch?.privacyGuard) {
        await schedulePrivacyApply(updated.privacyGuard, { waitBudgetMs: 1500 });
      }
    },
    onReattachCdp: async () => {
      await refreshFixedShortcutPortsAsync();
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
      const res = await launchT3WithDebugPort(ctx.paths, [], { env: privacyGuard.getLaunchEnv() });
      if (res.ok && cdpHost && ctx.settings.get()?.autoAttachT3 !== false) {
        const t = setTimeout(() => {
          if (!stopped && ctx.settings.get()?.autoAttachT3 !== false) {
            cdpHost.reattachNow({ preserveDisabled: true }).catch(() => {});
          }
        }, 2000);
        t.unref?.();
      }
      return res;
    },
    onRelaunchT3: async () => runRelaunchT3Async(),
    onShutdown: async () => {
      await stop('HTTP shutdown request');
      if (typeof onShutdownRequest === 'function') onShutdownRequest();
    }
  });

  let initialSyncTimer = null;
  let initialShortcutTimer = null;
  let folderSyncTimer = null;
  let alertTimer = null;
  let watchdogTimer = null;
  let stopped = false;
  let stopPromise;
  try {
    const bound = await httpServer.listen();
    boundPort = bound.port;
    await remoteBridge.configure();

    if (enableCdp) {
      cdpHost = createCdpHost({
        paths: ctx.paths,
        getFixedPorts: () => fixedShortcutPorts,
        initialEnabled: cfg.autoAttachT3 !== false,
        initialBlockedUrls: privacyGuard.getBlockedCdpUrls(cfg.privacyGuard),
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
    if (!deferInitialSync) {
      ctx.engine.tickAlerts();
    }
    appUpdater.start();
  } catch (err) {
    await stop('startup failure');
    throw err;
  }
  if (deferInitialSync) {
    // Let HTTP /api/health respond immediately before background sync & shortcut checks run
    initialSyncTimer = setTimeout(() => {
      initialSyncTimer = null;
      if (stopped) return;
      try {
        ctx.engine.syncAll({ force: true, includeFolderSync: false, nonBlocking: true });
        ctx.engine.tickAlerts();
      } catch (err) {
        console.warn('首次后台同步失败', err?.message || err);
      }
      if (!stopped) {
        ctx.folderSync.syncAsync({ force: true }).catch(() => {});
      }
    }, 50);
    initialSyncTimer.unref?.();

    initialShortcutTimer = setTimeout(() => {
      initialShortcutTimer = null;
      if (stopped) return;
      runStartupShortcutSetupAsync().catch(() => {});
      const latestPrivacy = ctx.settings.get()?.privacyGuard;
      if (latestPrivacy?.blockTelemetryAndTracing || existsSync(ctx.paths.privacyEnvBackupPath)) {
        privacyGuard.applySettingsAsync(latestPrivacy).catch(() => {});
      }
    }, 300);
    initialShortcutTimer.unref?.();
  } else {
    if (cfg?.privacyGuard?.blockTelemetryAndTracing || existsSync(ctx.paths.privacyEnvBackupPath)) {
      await privacyGuard.applySettingsAsync(cfg.privacyGuard).catch(() => {});
    }
    try {
      await ctx.folderSync.syncAsync({ force: true });
    } catch {}
  }
  if (!stopped) {
    folderSyncTimer = setInterval(() => {
      if (stopped) return;
      const syncCfg = ctx.settings.get()?.multiMachineSync;
      if (!syncCfg?.enabled || !String(syncCfg.syncDir || '').trim()) return;
      ctx.folderSync.syncAsync().catch(() => {});
    }, 15000);
    folderSyncTimer.unref?.();
    alertTimer = setInterval(() => {
      if (stopped) return;
      try { ctx.engine.tickAlerts(); } catch (err) { console.warn('告警同步失败', err.message); }
    }, 5000);
    alertTimer.unref();
  }
  let consecutiveGone = 0;

  function stop(reason = 'requested') {
    if (!stopPromise) {
      stopped = true;
      console.log(`[${new Date().toISOString()}] [daemon] stopping: ${reason}`);
      stopPromise = closeResources();
    }
    return stopPromise;
  }

  async function closeResources() {
    appUpdater.stop();
    ctx.folderSync.stop?.();
    try { shortcutSetupAbort?.abort(); } catch {}
    if (initialSyncTimer) {
      clearTimeout(initialSyncTimer);
      initialSyncTimer = null;
    }
    if (initialShortcutTimer) {
      clearTimeout(initialShortcutTimer);
      initialShortcutTimer = null;
    }
    if (folderSyncTimer) {
      clearInterval(folderSyncTimer);
      folderSyncTimer = null;
    }
    clearInterval(alertTimer);
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    try { await privacyGuard.stopAndDrain(3000); } catch (err) { console.error('[daemon] privacyGuard drain failed', err); }
    try { await cdpHost?.stop(); } catch (err) { console.error('[daemon] CDP shutdown failed', err); }
    await remoteBridge.stop();
    try { await httpServer.close(); } catch (err) { console.error('[daemon] HTTP shutdown failed', err); }
    try { await ctx.folderSync.whenIdle?.(1500); } catch (err) { console.error('[daemon] folderSync shutdown failed', err); }
    try { ctx.close(); } catch (err) { console.error('[daemon] store shutdown failed', err); }
    try {
      const current = JSON.parse(readFileSync(ctx.paths.runtimeFilePath, 'utf8'));
      if (current.pid === process.pid && current.port === boundPort && current.startedAtMs === startedAtMs) unlinkSync(ctx.paths.runtimeFilePath);
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[daemon] runtime cleanup failed', err);
    }
  }

  if (autoExitWhenT3Gone && !stopped) {
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
        await stop('T3 exited');
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
    appUpdater,
    privacyGuard,
    handleRpc,
    getStatus: getDaemonStatus,
    stop
  };
}
