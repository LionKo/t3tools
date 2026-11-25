#!/usr/bin/env node
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolvePaths, findLatestUsageScanCache } from '../src/core/paths.mjs';
import { createRuntimeContext, probeRunningDaemon, startDaemon, PLUGIN_VERSION } from '../src/host/daemon.mjs';
import {
  inspectShortcuts,
  patchT3Launchers,
  restoreT3Launchers,
  findT3Executable,
  launchT3WithDebugPort
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
  const autoExitWhenT3Gone = args.includes('--auto-exit');

  const daemon = await startDaemon({
    portOverride,
    enableCdp,
    autoPatchLauncher,
    autoExitWhenT3Gone,
    onAutoExit: () => {
      console.log('[T3Tools] 检测到 T3 Code 已关闭，守护进程自动退出。');
      process.exit(0);
    }
  });
  console.log(`[${new Date().toISOString()}] [T3Tools v${daemon.version}] 守护进程已启动 (PID ${process.pid})`);
  console.log(`  - 独立 Web 看板（Fallback）: ${daemon.url}`);
  console.log(`  - CDP 自动挂载: ${enableCdp ? '已启用（轮询 DevToolsActivePort）' : '已关闭'}`);
  if (autoExitWhenT3Gone) {
    console.log('  - 联动生命周期: 已启用（T3 Code 关闭后自动退出，零常驻）');
  }

  process.on('uncaughtException', err => {
    console.error(`[${new Date().toISOString()}] [uncaughtException]`, err?.stack || err);
  });
  process.on('unhandledRejection', err => {
    console.error(`[${new Date().toISOString()}] [unhandledRejection]`, err?.stack || err);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[${new Date().toISOString()}] [T3Tools] 正在停止...`);
    await daemon.stop();
    process.exit(0);
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
    const outFd = openSync(join(paths.pluginDataDir, 'daemon.out.log'), 'a');
    const errFd = openSync(join(paths.pluginDataDir, 'daemon.err.log'), 'a');
    const selfPath = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [selfPath, 'start', '--auto-exit'], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', outFd, errFd]
    });
    child.unref();
  }

  const launched = launchT3WithDebugPort(paths, extraArgs);
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

async function cmdUninstall() {
  const paths = resolvePaths();
  const res = restoreT3Launchers(paths);
  if (!res.ok) {
    console.error('快捷方式还原失败：', res.error);
    process.exitCode = 1;
    return;
  }
  console.log(`[T3Tools] 已无损还原 ${res.restored} 个 T3 Code 快捷方式并清理静默启动器。`);
}

async function cmdStatus() {
  const paths = resolvePaths();
  const existing = await probeRunningDaemon(paths.runtimeFilePath);
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

  const report = {
    version: PLUGIN_VERSION,
    nodeVersion: process.version,
    nodeOk: major > 22 || (major === 22 && minor >= 13),
    hasNativeZstd: HAS_NATIVE_ZSTD,
    t3Executable: exe || null,
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
  const ctx = createRuntimeContext();
  try {
    ctx.engine.syncAll({ force: true });
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
    ctx.close();
  }
}

try {
  if (command === 'start') await cmdStart();
  else if (command === 'launch') await cmdLaunch();
  else if (command === 'stop') await cmdStop();
  else if (command === 'install') await cmdInstall();
  else if (command === 'uninstall') await cmdUninstall();
  else if (command === 'status') await cmdStatus();
  else if (command === 'doctor') await cmdDoctor();
  else if (command === 'snapshot') await cmdSnapshot();
  else {
    console.log('用法: node bin/t3tools.mjs <start|launch|stop|install|uninstall|status|doctor|snapshot>');
    process.exitCode = 1;
  }
} catch (err) {
  console.error('执行失败:', err?.message || err);
  process.exitCode = 1;
}
