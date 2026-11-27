#!/usr/bin/env node
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolvePaths, findLatestUsageScanCache } from '../src/core/paths.mjs';
import { createSettingsStore } from '../src/core/settings.mjs';
import { createRuntimeContext, probeRunningDaemon, startDaemon, PLUGIN_VERSION } from '../src/host/daemon.mjs';
import { createPrivacyGuard, restorePrivacyEnvBackup } from '../src/host/privacy-guard.mjs';
import {
  inspectShortcuts,
  patchT3Launchers,
  patchT3ShortcutsDebugArg,
  restoreT3Launchers,
  findT3Executable,
  launchT3WithDebugPort,
  relaunchT3WithDebugPort,
  inspectT3ProcessState,
  getTrayAutoStartStatus,
  setTrayAutoStart,
  removeT3ToolsTrayShortcuts
} from '../src/host/windows-launcher.mjs';
import { collectDevToolsPortCandidates } from '../src/host/cdp-host.mjs';
import { HAS_NATIVE_ZSTD } from '../src/adapters/codex.mjs';

const args = process.argv.slice(2);
const command = args[0] || 'start';

function getArgValue(prefix) {
  const found = args.find(a => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

async function cmdStart() {
  const paths = resolvePaths();
  const existing = await probeRunningDaemon(paths.runtimeFilePath);
  if (existing) {
    console.log(`[T3Tools v${existing.version}] 守护进程已在运行中 (PID ${existing.pid}, ${existing.url})，跳过重复启动。`);
    return;
  }

  const portRaw = getArgValue('--port=');
  const portOverride = portRaw ? Number(portRaw) : null;
  const enableCdp = !args.includes('--no-cdp');
  const autoPatchLauncher = args.includes('--patch-launcher');
  const autoPatchDebugArg = args.includes('--patch-debug-arg') || args.includes('--tray-host');
  const autoExitWhenT3Gone = args.includes('--auto-exit');

  function exitAfterFlush(code) {
    const deadline = setTimeout(() => process.exit(code), 100);
    process.stdout.write('', () => process.stderr.write('', () => {
      clearTimeout(deadline);
      process.exit(code);
    }));
  }

  process.on('uncaughtException', err => {
    console.error(`[${new Date().toISOString()}] [uncaughtException]`, err?.stack || err);
    exitAfterFlush(1);
  });
  process.on('unhandledRejection', err => {
    console.error(`[${new Date().toISOString()}] [unhandledRejection]`, err?.stack || err);
  });

  const daemon = await startDaemon({
    portOverride,
    enableCdp,
    autoPatchLauncher,
    autoPatchDebugArg,
    autoExitWhenT3Gone,
    deferInitialSync: true,
    onAutoExit: () => {
      console.log('[T3Tools] 检测到 T3 Code 已关闭，守护进程自动退出。');
      exitAfterFlush(0);
    },
    onShutdownRequest: () => {
      console.log('[T3Tools] 收到托盘退出指令，守护进程已优雅停止。');
      exitAfterFlush(0);
    }
  });
  console.log(`[${new Date().toISOString()}] [T3Tools v${daemon.version}] 守护进程已启动 (PID ${process.pid})`);
  console.log(`  - 独立 Web 看板（Fallback）: ${daemon.url}`);
  console.log(`  - CDP 自动挂载: ${enableCdp ? '已启用（轮询 DevToolsActivePort）' : '已关闭'}`);
  if (autoExitWhenT3Gone) {
    console.log('  - 联动生命周期: 已启用（T3 Code 关闭后自动退出，零常驻）');
  }

  let shuttingDown = false;
  const shutdown = async signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[${new Date().toISOString()}] [T3Tools] 正在停止...`);
    await daemon.stop(signal);
    exitAfterFlush(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Linked launcher entry invoked silently by ~/.t3tools/launch-t3.vbs:
 * 1. Ensures single-instance daemon is running in background with --auto-exit.
 * 2. Launches T3 Code with --remote-debugging-port=0 and any extra args.
 */
async function cmdLaunch() {
  const paths = resolvePaths();
  const extraArgs = args.slice(1);

  const existing = await probeRunningDaemon(paths.runtimeFilePath);
  if (!existing) {
    mkdirSync(paths.pluginDataDir, { recursive: true });
    const logFds = [];
    try {
      logFds.push(openSync(join(paths.pluginDataDir, 'daemon.out.log'), 'a'));
      logFds.push(openSync(join(paths.pluginDataDir, 'daemon.err.log'), 'a'));
      const selfPath = fileURLToPath(import.meta.url);
      const child = spawn(process.execPath, [selfPath, 'start', '--auto-exit'], {
        detached: true,
        windowsHide: true,
        stdio: ['ignore', ...logFds]
      });
      child.unref();
    } finally {
      for (const fd of logFds) closeSync(fd);
    }
  }

  const settingsStore = createSettingsStore(paths.pluginSettingsPath);
  const privacyGuard = createPrivacyGuard({ paths, settings: settingsStore });
  const launched = await launchT3WithDebugPort(paths, extraArgs, { env: privacyGuard.getLaunchEnv() });
  if (!launched.ok) {
    console.error('启动 T3 Code 失败：', launched.error);
    process.exitCode = 1;
  }
}

async function cmdStop() {
  const paths = resolvePaths();
  const existing = await probeRunningDaemon(paths.runtimeFilePath);
  if (!existing) {
    console.log('守护进程未运行。');
    return;
  }
  try {
    process.kill(existing.pid, 'SIGTERM');
    console.log(`已停止守护进程 (PID ${existing.pid})。`);
  } catch (err) {
    console.error('停止守护进程失败：', err?.message || err);
    process.exitCode = 1;
  }
}

async function cmdInstall() {
  const paths = resolvePaths();
  const res = patchT3Launchers(paths);
  if (!res.ok) {
    console.error('快捷方式配置失败：', res.error);
    process.exitCode = 1;
    return;
  }
  console.log(`[T3Tools v${PLUGIN_VERSION}] 方案 A（图标联动启停）配置完成`);
  console.log(`  - 无黑框静默启动器: ${res.vbsPath}`);
  console.log(`  - 新配置快捷方式: ${res.patched}`);
  console.log(`  - 已配置快捷方式: ${res.alreadyPatched}`);
  for (const sc of res.shortcuts) {
    console.log(`  - ${sc.path} [${sc.isWrapper ? '联动模式 OK' : '未生效'}]`);
  }
  console.log('提示：以后直接双击桌面或开始菜单的 T3 Code 图标即可自动启动并挂载插件，关闭 T3 Code 后守护进程自动退出（零后台常驻）。');
}

async function cmdPatchDebug() {
  const paths = resolvePaths();
  const res = patchT3ShortcutsDebugArg(paths);
  if (!res.ok) {
    console.error('快捷方式调试参数配置失败：', res.error);
    process.exitCode = 1;
    return;
  }
  console.log(`[T3Tools v${PLUGIN_VERSION}] 已为 T3 Code 快捷方式配置自动吸附调试参数 (--remote-debugging-port=0)`);
  console.log(`  - 新配置快捷方式: ${res.patched}`);
  console.log(`  - 已具备调试参数: ${res.alreadyPatched}`);
  for (const sc of res.shortcuts) {
    console.log(`  - ${sc.path} [${sc.hasDebugFlag ? '可自动吸附 OK' : '未生效'}]`);
  }
}

async function cmdTray() {
  const paths = resolvePaths();
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const candidates = [
    join(repoRoot, 'dist', 'T3Tools.exe'),
    paths.trayExePath
  ];
  const exePath = candidates.find(p => p && existsSync(p));
  if (!exePath) {
    console.error('未找到 T3Tools.exe，请先运行 powershell -ExecutionPolicy Bypass -File .\\scripts\\build-tray.ps1');
    process.exitCode = 1;
    return;
  }
  const passArgs = args.slice(1);
  const child = spawn(exePath, passArgs, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  console.log(`已启动 T3Tools 托盘程序: ${exePath}`);
}

async function cmdRelaunchT3() {
  const paths = resolvePaths();
  const settingsStore = createSettingsStore(paths.pluginSettingsPath);
  const privacyGuard = createPrivacyGuard({ paths, settings: settingsStore });
  const res = await relaunchT3WithDebugPort(paths, args.slice(1), { env: privacyGuard.getLaunchEnv() });
  if (!res.ok) {
    console.error('重启 T3 Code 失败：', res.error);
    process.exitCode = 1;
    return;
  }
  console.log(`已重新启动 T3 Code (PID ${res.pid}) 并开启本地调试端口，T3Tools 将自动吸附。`);
}

async function cmdUninstall() {
  const paths = resolvePaths();
  const res = restoreT3Launchers(paths);
  if (!res.ok) {
    console.error('快捷方式还原失败：', res.error);
    process.exitCode = 1;
    return;
  }
  const envRestore = restorePrivacyEnvBackup(paths);
  if (!envRestore.ok) {
    console.error('隐私环境变量还原失败：', envRestore.error || '未知错误');
    process.exitCode = 1;
    return;
  }
  if (process.platform === 'win32') {
    setTrayAutoStart(false, '');
    removeT3ToolsTrayShortcuts(paths);
  }
  const envNote = envRestore.restored ? '，并还原了 T3Tools 写入的隐私环境变量' : '';
  console.log(`[T3Tools] 已无损还原 ${res.restored} 个 T3 Code 快捷方式并清理托盘快捷方式与自启配置${envNote}。`);
}

async function cmdStatus() {
  const paths = resolvePaths();
  const existing = await probeRunningDaemon(paths.runtimeFilePath, { fullStatus: true });
  if (!existing) {
    console.log('守护进程未运行。');
    return;
  }
  console.log(JSON.stringify(existing.status, null, 2));
}

async function cmdDoctor() {
  const paths = resolvePaths();
  const [major, minor] = process.versions.node.split('.').map(Number);
  const scanCache = findLatestUsageScanCache(paths.t3UserData);
  const inspected = process.platform === 'win32' ? inspectShortcuts(paths) : { ok: true, shortcuts: [], error: '' };
  const fixedPorts = inspected.shortcuts.map(s => s.fixedPort).filter(p => Number.isInteger(p) && p > 0);
  const devPorts = collectDevToolsPortCandidates(paths, fixedPorts);
  const exe = findT3Executable(paths);
  const daemonRunning = await probeRunningDaemon(paths.runtimeFilePath);
  const t3Process = process.platform === 'win32' ? inspectT3ProcessState() : { running: false, mainPid: null, hasDebugFlag: false };
  const trayAutoStart = process.platform === 'win32' ? getTrayAutoStartStatus() : { enabled: false };
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const trayExeCandidates = [join(repoRoot, 'dist', 'T3Tools.exe'), paths.trayExePath];
  const trayExe = trayExeCandidates.find(p => existsSync(p)) || null;

  const report = {
    version: PLUGIN_VERSION,
    nodeVersion: process.version,
    nodeOk: major > 22 || (major === 22 && minor >= 13),
    hasNativeZstd: HAS_NATIVE_ZSTD,
    t3Executable: exe || null,
    trayExecutable: trayExe,
    trayAutoStartEnabled: Boolean(trayAutoStart.enabled),
    t3Process: {
      running: Boolean(t3Process.running),
      mainPid: t3Process.mainPid || null,
      hasDebugFlag: Boolean(t3Process.hasDebugFlag)
    },
    wrapperVbsExists: existsSync(paths.launcherVbsPath),
    daemonRunning: daemonRunning ? { pid: daemonRunning.pid, url: daemonRunning.url, autoExitWhenT3Gone: Boolean(daemonRunning.autoExitWhenT3Gone) } : null,
    stateDbExists: existsSync(paths.stateDbPath),
    settingsExists: existsSync(paths.settingsPath),
    antigravityProvidersExists: existsSync(paths.t3AntigravityProvidersDir),
    codexSessionsExists: existsSync(paths.codexSessionsDir),
    latestUsageScanCache: scanCache,
    modelRatesExists: existsSync(paths.modelRatesPath),
    devToolsPortCandidates: devPorts,
    shortcutsOk: inspected.ok,
    shortcutsError: inspected.error || '',
    shortcuts: inspected.shortcuts.map(s => ({
      path: s.path,
      target: s.target,
      isWrapper: s.isWrapper,
      hasDebugFlag: s.hasDebugFlag
    }))
  };

  console.log(JSON.stringify(report, null, 2));
}

async function cmdSnapshot() {
  const ctx = createRuntimeContext({}, { deferFolderSync: true });
  try {
    ctx.engine.syncAll({ force: true, includeFolderSync: false });
    try { await ctx.folderSync.syncAsync({ force: true }); } catch {}
    const live = ctx.engine.getLiveThreadSnapshot('');
    const dash = ctx.engine.getDashboardData({ preset: 'weeklyQuota', pageSize: 10 });
    console.log(JSON.stringify({
      activeThread: live.thread && !live.thread.unresolved ? {
        threadId: live.thread.threadId,
        title: live.thread.title,
        phase: live.thread.phaseLabel,
        steps: live.thread.totalSteps,
        queuedRuns: live.thread.queuedRuns
      } : live.thread,
      liveContext: live.context ? {
        model: live.context.modelId,
        usedTokens: live.context.usedTokens,
        maxTokens: live.context.maxTokens,
        usedPercent: live.context.usedPercent,
        cacheHitPercent: live.context.cacheHitPercent,
        ttftMs: live.context.ttftMs,
        decodeSpeed: live.context.decodeSpeed,
        outputThroughput: live.context.outputThroughput,
        tps: live.context.tps,
        tpsKind: live.context.tpsKind,
        stale: live.context.stale
      } : null,
      quotas: live.quotas.groups.map(g => ({
        accountId: g.accountId,
        windows: g.windows.map(w => ({ label: w.label, remainingPercent: w.remainingPercent, resetsAtMs: w.resetsAtMs, source: w.source }))
      })),
      weeklyRange: dash.range,
      kpis: dash.summary.kpis,
      modelsCount: dash.summary.models.length,
      anomalies: dash.anomalySummary,
      diagnostics: dash.diagnostics
    }, null, 2));
  } finally {
    ctx.folderSync.stop?.();
    ctx.close();
  }
}

try {
  if (command === 'start') await cmdStart();
  else if (command === 'launch') await cmdLaunch();
  else if (command === 'tray') await cmdTray();
  else if (command === 'patch-debug') await cmdPatchDebug();
  else if (command === 'relaunch-t3') await cmdRelaunchT3();
  else if (command === 'stop') await cmdStop();
  else if (command === 'install') await cmdInstall();
  else if (command === 'uninstall') await cmdUninstall();
  else if (command === 'status') await cmdStatus();
  else if (command === 'doctor') await cmdDoctor();
  else if (command === 'snapshot') await cmdSnapshot();
  else {
    console.log('用法: node bin/t3tools.mjs <tray|start|launch|patch-debug|relaunch-t3|stop|install|uninstall|status|doctor|snapshot>');
    process.exitCode = 1;
  }
} catch (err) {
  console.error('执行失败:', err?.message || err);
  process.exitCode = 1;
}
