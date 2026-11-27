import { existsSync, mkdirSync, promises as fsp, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn, execFile } from 'node:child_process';
import { atomicWriteJson } from '../core/settings.mjs';

export const DEBUG_FLAG = '--remote-debugging-port=0';
const DEBUG_TOKEN = /^--remote-debugging-port(?:=(\d+))?$/i;
function shortcutTokens(args) {
  const tokens = [];
  for (let pos = 0; pos < args.length;) {
    if (/\s/.test(args[pos])) { pos++; continue; }
    const start = pos;
    let quoted = false, slashes = 0;
    while (pos < args.length && (quoted || !/\s/.test(args[pos]))) {
      const ch = args[pos++];
      if (ch === '"' && slashes % 2 === 0) quoted = !quoted;
      slashes = ch === '\\' ? slashes + 1 : 0;
    }
    tokens.push(args.slice(start, pos));
  }
  return tokens;
}
const DEFAULT_CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 't3tools.mjs');

export function injectDebugArg(args = '') {
  const trimmed = String(args || '').trim();
  if (hasDebugArg(trimmed)) return trimmed;
  return trimmed ? `${trimmed} ${DEBUG_FLAG}` : DEBUG_FLAG;
}

/**
 * Remove ONLY unquoted occurrences of the owned debug flag token and one adjacent separator space,
 * preserving whitespace AND literal flag strings inside quoted user arguments.
 */
export function removeDebugArg(args = '', flag = DEBUG_FLAG) {
  const src = String(args || '');
  const target = String(flag || '').toLowerCase();
  if (!target) return src.trim();

  let from = 0;
  for (const token of shortcutTokens(src)) {
    const start = src.indexOf(token, from);
    from = start + token.length;
    if (token.toLowerCase() === target) {
      return (src.slice(0, start).trimEnd() + src.slice(from)).trim();
    }
  }
  return src.trim();
}

export function hasDebugArg(args = '') {
  return parseDebugPortFromArgs(args) !== null;
}

export function parseDebugPortFromArgs(args = '') {
  const tokens = shortcutTokens(args);
  const i = tokens.findIndex(t => DEBUG_TOKEN.test(t));
  if (i < 0) return null;
  const n = Number(DEBUG_TOKEN.exec(tokens[i])[1] ?? tokens[i + 1]);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 0;
}

function runPowerShell(script, extraEnv = {}) {
  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 12000,
      env: { ...process.env, ...extraEnv }
    }
  );
  if (res.error || res.status !== 0) {
    return { ok: false, stdout: (res.stdout || '').trim(), stderr: (res.stderr || res.error?.message || '').trim() };
  }
  return { ok: true, stdout: (res.stdout || '').trim(), stderr: '' };
}

function runPowerShellAsync(script, extraEnv = {}, { signal, timeoutMs = 12000 } = {}) {
  return new Promise(resolveResult => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: timeoutMs,
        signal,
        env: { ...process.env, ...extraEnv }
      },
      (err, stdout, stderr) => {
        if (err) {
          resolveResult({ ok: false, stdout: String(stdout || '').trim(), stderr: String(stderr || err.message || '').trim() });
          return;
        }
        resolveResult({ ok: true, stdout: String(stdout || '').trim(), stderr: '' });
      }
    );
  });
}

async function resolveShortcutSearchDirsAsync(paths, { runner = runPowerShellAsync, sandbox = false, signal } = {}) {
  const dirs = new Set([
    join(paths.home, 'Desktop'),
    join(paths.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    join(paths.appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar')
  ]);

  if (!sandbox && process.platform === 'win32') {
    const ps = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('StartMenu')) | Where-Object { $_ } | ConvertTo-Json -Compress`;
    const res = await runner(ps, {}, { signal });
    if (res.ok && res.stdout) {
      try {
        const parsed = JSON.parse(res.stdout);
        for (const d of Array.isArray(parsed) ? parsed : [parsed]) {
          if (typeof d === 'string' && d.trim()) dirs.add(d.trim());
        }
      } catch {}
    }
  }
  return [...dirs];
}

async function findT3ShortcutCandidatesAsync(paths, opts = {}) {
  const dirs = await resolveShortcutSearchDirsAsync(paths, opts);
  const results = new Set();
  const signal = opts?.signal;

  async function walk(dir, depth = 0) {
    if (!dir || depth > 2 || signal?.aborted) return;
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (signal?.aborted) return;
      const full = join(dir, e.name);
      if (e.isDirectory() && (/t3/i.test(e.name) || depth === 0)) {
        await walk(full, depth + 1);
      } else if (e.isFile() && /\.lnk$/i.test(e.name) && /t3\s*code|t3code/i.test(e.name)) {
        results.add(full);
      }
    }
  }

  for (const d of dirs) {
    if (signal?.aborted) break;
    await walk(d, 0);
  }
  return [...results];
}

export function resolveShortcutSearchDirs(paths, { runner = runPowerShell, sandbox = false } = {}) {
  const dirs = new Set([
    join(paths.home, 'Desktop'),
    join(paths.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    join(paths.appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar')
  ]);

  if (!sandbox && process.platform === 'win32') {
    const ps = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('StartMenu')) | Where-Object { $_ } | ConvertTo-Json -Compress`;
    const res = runner(ps, {});
    if (res.ok && res.stdout) {
      try {
        const parsed = JSON.parse(res.stdout);
        for (const d of Array.isArray(parsed) ? parsed : [parsed]) {
          if (typeof d === 'string' && d.trim()) dirs.add(d.trim());
        }
      } catch {}
    }
  }
  return [...dirs];
}

export function findT3ShortcutCandidates(paths, opts = {}) {
  const dirs = resolveShortcutSearchDirs(paths, opts);
  const results = new Set();

  function walk(dir, depth = 0) {
    if (!dir || !existsSync(dir) || depth > 2) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory() && (/t3/i.test(e.name) || depth === 0)) {
        walk(full, depth + 1);
      } else if (e.isFile() && /\.lnk$/i.test(e.name) && /t3\s*code|t3code/i.test(e.name)) {
        results.add(full);
      }
    }
  }

  for (const d of dirs) walk(d, 0);
  return [...results];
}

/**
 * Verify shortcut target points to the T3 Code application executable itself.
 */
export function isVerifiedT3Target(targetPath = '') {
  const raw = String(targetPath || '').trim();
  if (!raw || !/\.exe$/i.test(raw)) return false;
  const exeName = basename(raw);
  if (/uninstall|helper|monitor|elevate|update/i.test(exeName)) return false;
  return /^t3(?:\s|-|_)?code(?:\s*\([^)]+\))?\.exe$/i.test(exeName);
}

/**
 * Check whether a shortcut points to any launch-t3.vbs silent wrapper (current or legacy path).
 */
function wrapperScriptPath(args) {
  const script = shortcutTokens(String(args || '')).find(t => !t.startsWith('//')) || '';
  return script.replace(/^"|"$/g, '');
}

export function isAnyWrapperShortcut(targetPath = '', args = '') {
  if (basename(String(targetPath || '').trim()).toLowerCase() !== 'wscript.exe') return false;
  return basename(wrapperScriptPath(args)).toLowerCase() === 'launch-t3.vbs';
}

/**
 * Check whether a shortcut is already configured to use our silent wrapper launcher.
 */
export function isWrapperShortcut(targetPath = '', args = '', vbsPath = '') {
  if (!isAnyWrapperShortcut(targetPath, args)) return false;
  const script = wrapperScriptPath(args).toLowerCase();
  if (vbsPath) {
    return script === String(vbsPath).toLowerCase();
  }
  return true;
}

/**
 * Extract any extra user arguments appended after our wrapper VBS path in a shortcut's Arguments.
 */
export function extractExtraArgsFromWrapper(args = '', vbsPath = '') {
  const raw = String(args || '');
  const token = shortcutTokens(raw).find(t => !t.startsWith('//'));
  if (!token || (vbsPath && wrapperScriptPath(raw).toLowerCase() !== vbsPath.toLowerCase())) return '';
  return raw.slice(raw.indexOf(token) + token.length).trimStart();
}

/**
 * Generate the silent VBScript wrapper (~/.t3tools/launch-t3.vbs) that runs
 * `node bin/t3tools.mjs launch ...` with window style 0 (zero console flash).
 */
export function buildWrapperVbsContent({ nodeExe = process.execPath, cliPath = DEFAULT_CLI_PATH } = {}) {
  const escVbs = s => String(s || '').replaceAll('"', '""');
  return [
    'Option Explicit',
    'Dim shell, cmd, i, arg',
    'Set shell = CreateObject("WScript.Shell")',
    `cmd = """${escVbs(nodeExe)}"" ""${escVbs(cliPath)}"" launch"`,
    'For i = 0 To WScript.Arguments.Count - 1',
    '  arg = WScript.Arguments(i)',
    '  cmd = cmd & " " & QuoteArg(arg)',
    'Next',
    'shell.Environment("Process")("T3TOOLS_WRAPPER_CMD") = cmd',
    'shell.Run "%T3TOOLS_WRAPPER_CMD%", 0, False',
    'Function QuoteArg(value)',
    '  Dim j, ch, slashes, result',
    '  result = Chr(34): slashes = 0',
    '  For j = 1 To Len(value)',
    '    ch = Mid(value, j, 1)',
    '    If ch = Chr(92) Then',
    '      slashes = slashes + 1',
    '    Else',
    '      If ch = Chr(34) Then slashes = 2 * slashes + 1',
    '      result = result & String(slashes, Chr(92)) & ch',
    '      slashes = 0',
    '    End If',
    '  Next',
    '  QuoteArg = result & String(2 * slashes, Chr(92)) & Chr(34)',
    'End Function',
    ''
  ].join('\r\n');
}

export function writeWrapperVbs(paths, opts = {}) {
  const vbsPath = paths.launcherVbsPath || join(paths.pluginDataDir, 'launch-t3.vbs');
  mkdirSync(dirname(vbsPath), { recursive: true });
  writeFileSync(vbsPath, '\uFEFF' + buildWrapperVbsContent(opts), 'utf16le');
  return vbsPath;
}

export function getWscriptPath() {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  return join(sysRoot, 'System32', 'wscript.exe');
}

export function inspectShortcuts(paths, { runner = runPowerShell, sandbox = false } = {}) {
  const candidates = findT3ShortcutCandidates(paths, { runner, sandbox });
  if (!candidates.length) return { ok: true, shortcuts: [], error: '' };
  const vbsPath = paths.launcherVbsPath || join(paths.pluginDataDir || '', 'launch-t3.vbs');

  const ps = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$paths = $env:T3TOOLS_SHORTCUTS | ConvertFrom-Json
$ws = New-Object -ComObject WScript.Shell
$out = @()
foreach ($p in $paths) {
  if (Test-Path -LiteralPath $p) {
    $sc = $ws.CreateShortcut($p)
    $out += [PSCustomObject]@{
      path = $p
      target = $sc.TargetPath
      arguments = $sc.Arguments
      workingDirectory = $sc.WorkingDirectory
      iconLocation = $sc.IconLocation
    }
  }
}
$out | ConvertTo-Json -Compress -Depth 4
`;
  const res = runner(ps, { T3TOOLS_SHORTCUTS: JSON.stringify(candidates) });
  if (!res.ok) {
    return { ok: false, shortcuts: [], error: res.stderr || '读取快捷方式失败' };
  }
  if (!res.stdout) return { ok: true, shortcuts: [], error: '' };

  try {
    const parsed = JSON.parse(res.stdout);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const shortcuts = arr
      .filter(item => item && item.path && (isVerifiedT3Target(item.target) || isAnyWrapperShortcut(item.target, item.arguments)))
      .map(item => {
        const isWrapper = isWrapperShortcut(item.target, item.arguments, vbsPath);
        const isLegacyWrapper = !isWrapper && isAnyWrapperShortcut(item.target, item.arguments);
        return {
          path: item.path,
          target: item.target || '',
          arguments: item.arguments || '',
          workingDirectory: item.workingDirectory || '',
          iconLocation: item.iconLocation || '',
          isWrapper,
          isLegacyWrapper,
          hasDebugFlag: isWrapper || isLegacyWrapper || hasDebugArg(item.arguments || ''),
          fixedPort: (isWrapper || isLegacyWrapper) ? 0 : parseDebugPortFromArgs(item.arguments || '')
        };
      });
    return { ok: true, shortcuts, error: '' };
  } catch (err) {
    return { ok: false, shortcuts: [], error: err?.message || '解析快捷方式输出失败' };
  }
}

function loadBackup(backupPath) {
  if (!backupPath || !existsSync(backupPath)) return { format: 3, managed: {} };
  try {
    const parsed = JSON.parse(readFileSync(backupPath, 'utf8'));
    if (parsed && parsed.format === 3 && typeof parsed.managed === 'object') return parsed;
    if (parsed && parsed.format === 2 && typeof parsed.managed === 'object') {
      const managed = {};
      for (const [p, entry] of Object.entries(parsed.managed)) {
        managed[p] = { mode: 'arg', addedFlag: entry.addedFlag || DEBUG_FLAG, patchedAtMs: entry.patchedAtMs || Date.now() };
      }
      return { format: 3, managed };
    }
    if (parsed && typeof parsed.shortcuts === 'object') {
      const managed = {};
      for (const p of Object.keys(parsed.shortcuts)) {
        managed[p] = { mode: 'arg', addedFlag: DEBUG_FLAG, patchedAtMs: Date.now() };
      }
      return { format: 3, managed };
    }
  } catch {}
  return { format: 3, managed: {} };
}

/**
 * Configure Windows T3 Code shortcuts in Linked Wrapper Mode (Scheme A):
 * - Clicking the T3 Code icon silently starts the single-instance daemon (with --auto-exit)
 *   AND launches T3 Code with --remote-debugging-port=0, with zero console flash.
 * - Preserves the original T3 Code icon and all user arguments.
 * - Never touches app.asar / server.asar or any T3 Code install file.
 */
export function patchT3Launchers(paths, { runner = runPowerShell, sandbox = false, nodeExe = process.execPath, cliPath = DEFAULT_CLI_PATH } = {}) {
  const inspected = inspectShortcuts(paths, { runner, sandbox });
  if (!inspected.ok) {
    return { ok: false, patched: 0, alreadyPatched: 0, error: inspected.error, shortcuts: [] };
  }
  const shortcuts = inspected.shortcuts;
  if (!shortcuts.length) {
    return {
      ok: false,
      patched: 0,
      alreadyPatched: 0,
      error: '未在桌面、开始菜单或任务栏找到指向 T3 Code 可执行文件的快捷方式',
      shortcuts: []
    };
  }

  const vbsPath = writeWrapperVbs(paths, { nodeExe, cliPath });
  const wscriptPath = getWscriptPath();
  const backup = loadBackup(paths.launcherBackupPath);
  const fallbackExe = findT3Executable(paths);
  const toUpdate = [];

  for (const sc of shortcuts) {
    if (sc.isWrapper) continue;
    const prevEntry = backup.managed[sc.path];
    const originalTarget = sc.isLegacyWrapper
      ? (prevEntry?.originalTarget || fallbackExe || '')
      : sc.target;
    if (!originalTarget) continue;
    // Strip our own legacy --remote-debugging-port=0 if upgrading from arg mode, or migrate from legacy wrapper path
    const cleanedArgs = sc.isLegacyWrapper
      ? extractExtraArgsFromWrapper(sc.arguments || '')
      : (prevEntry?.mode === 'arg'
          ? removeDebugArg(sc.arguments || '', prevEntry.addedFlag || DEBUG_FLAG)
          : (sc.arguments || '').trim());
    const wrapperArgs = cleanedArgs
      ? `//B //NoLogo "${vbsPath}" ${cleanedArgs}`
      : `//B //NoLogo "${vbsPath}"`;
    const iconLocation = (sc.iconLocation && !/^,\s*0$/.test(sc.iconLocation.trim()))
      ? sc.iconLocation
      : `${originalTarget},0`;

    toUpdate.push({
      path: sc.path,
      target: wscriptPath,
      arguments: wrapperArgs,
      iconLocation,
      workingDirectory: sc.workingDirectory || dirname(originalTarget),
      originalTarget,
      originalArguments: cleanedArgs,
      originalIconLocation: prevEntry?.originalIconLocation ?? (sc.isLegacyWrapper ? `${originalTarget},0` : (sc.iconLocation || '')),
      originalWorkingDirectory: prevEntry?.originalWorkingDirectory ?? sc.workingDirectory ?? dirname(originalTarget)
    });
  }

  if (toUpdate.length === 0) {
    return {
      ok: true,
      patched: 0,
      alreadyPatched: shortcuts.filter(s => s.isWrapper).length,
      vbsPath,
      error: '',
      shortcuts
    };
  }

  const ps = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$items = $env:T3TOOLS_UPDATES | ConvertFrom-Json
$ws = New-Object -ComObject WScript.Shell
$count = 0
foreach ($item in $items) {
  if (Test-Path -LiteralPath $item.path) {
    $sc = $ws.CreateShortcut($item.path)
    $sc.TargetPath = $item.target
    $sc.Arguments = $item.arguments
    $sc.IconLocation = $item.iconLocation
    if ($item.workingDirectory) { $sc.WorkingDirectory = $item.workingDirectory }
    $sc.Save()
    $count++
  }
}
Write-Output $count
`;
  for (const item of toUpdate) {
    backup.managed[item.path] = {
      mode: 'wrapper',
      previousArg: backup.managed[item.path]?.mode === 'arg' ? backup.managed[item.path].addedFlag : backup.managed[item.path]?.previousArg,
      vbsPath,
      originalTarget: item.originalTarget,
      originalIconLocation: item.originalIconLocation,
      originalWorkingDirectory: item.originalWorkingDirectory,
      patchedAtMs: Date.now()
    };
  }
  atomicWriteJson(paths.launcherBackupPath, backup);
  const res = runner(ps, { T3TOOLS_UPDATES: JSON.stringify(toUpdate) });
  if (!res.ok) {
    return { ok: false, patched: 0, alreadyPatched: 0, vbsPath, error: res.stderr || '写入快捷方式失败', shortcuts };
  }

  const verified = inspectShortcuts(paths, { runner, sandbox });
  const verifiedMap = new Map(verified.shortcuts.map(s => [s.path, s]));
  let verifiedPatched = 0;

  for (const item of toUpdate) {
    const after = verifiedMap.get(item.path);
    if (after?.isWrapper) verifiedPatched++;
  }

  return {
    ok: verifiedPatched === toUpdate.length,
    patched: verifiedPatched,
    alreadyPatched: shortcuts.filter(s => s.isWrapper).length,
    vbsPath,
    error: verifiedPatched === toUpdate.length ? '' : '部分快捷方式未通过写入校验',
    shortcuts: verified.shortcuts
  };
}

/**
 * Restore all shortcuts managed by this plugin cleanly back to the original T3 Code .exe,
 * preserving any extra arguments added after installation, and clean up launch-t3.vbs.
 */
export function restoreT3Launchers(paths, { runner = runPowerShell, sandbox = false } = {}) {
  const inspected = inspectShortcuts(paths, { runner, sandbox });
  if (!inspected.ok) {
    return { ok: false, restored: 0, error: inspected.error, shortcuts: [] };
  }

  const backup = loadBackup(paths.launcherBackupPath);
  const vbsPath = paths.launcherVbsPath || join(paths.pluginDataDir || '', 'launch-t3.vbs');
  const fallbackExe = findT3Executable(paths);
  const toRestore = [];
  let missingTarget = false;

  for (const sc of inspected.shortcuts) {
    const entry = backup.managed[sc.path];
    if (sc.isWrapper || sc.isLegacyWrapper) {
      const targetExe = entry?.originalTarget || fallbackExe;
      if (!targetExe || !isVerifiedT3Target(targetExe)) { missingTarget = true; continue; }
      const preservedArgs = extractExtraArgsFromWrapper(sc.arguments || '', sc.isWrapper ? (entry?.vbsPath || vbsPath) : '');
      toRestore.push({
        path: sc.path,
        mode: 'wrapper',
        target: targetExe,
        arguments: preservedArgs,
        iconLocation: entry?.originalIconLocation ?? `${targetExe},0`,
        workingDirectory: entry?.originalWorkingDirectory ?? dirname(targetExe)
      });
    } else if (entry?.mode === 'arg' || entry?.previousArg) {
      const nextArgs = removeDebugArg(sc.arguments || '', entry.addedFlag || entry.previousArg || DEBUG_FLAG);
      if (nextArgs !== (sc.arguments || '').trim()) {
        toRestore.push({
          path: sc.path,
          mode: 'arg',
          target: sc.target,
          arguments: nextArgs,
          iconLocation: sc.iconLocation || '',
          workingDirectory: sc.workingDirectory || '',
          addedFlag: entry.addedFlag || DEBUG_FLAG
        });
      } else {
        delete backup.managed[sc.path];
      }
    } else if (entry?.mode === 'wrapper' && sc.target === entry.originalTarget) {
      delete backup.managed[sc.path];
    }
  }

  if (!toRestore.length) {
    atomicWriteJson(paths.launcherBackupPath, backup);
    return { ok: !missingTarget, restored: 0, error: missingTarget ? '无法确定原始快捷方式目标' : '', shortcuts: inspected.shortcuts };
  }

  const ps = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$items = $env:T3TOOLS_RESTORE | ConvertFrom-Json
$ws = New-Object -ComObject WScript.Shell
$count = 0
foreach ($item in $items) {
  if (Test-Path -LiteralPath $item.path) {
    $sc = $ws.CreateShortcut($item.path)
    $sc.TargetPath = $item.target
    $sc.Arguments = $item.arguments
    $sc.IconLocation = $item.iconLocation
    $sc.WorkingDirectory = $item.workingDirectory
    $sc.Save()
    $count++
  }
}
Write-Output $count
`;
  const res = runner(ps, { T3TOOLS_RESTORE: JSON.stringify(toRestore) });
  if (!res.ok) {
    return { ok: false, restored: 0, error: res.stderr || '还原快捷方式失败', shortcuts: inspected.shortcuts };
  }

  const verified = inspectShortcuts(paths, { runner, sandbox });
  const verifiedMap = new Map(verified.shortcuts.map(s => [s.path, s]));
  let verifiedRestored = 0;

  for (const item of toRestore) {
    const after = verifiedMap.get(item.path);
    const ok = item.mode === 'wrapper'
      ? (after && isVerifiedT3Target(after.target) && after.target.toLowerCase() === item.target.toLowerCase() && after.arguments === item.arguments)
      : (after && after.arguments === item.arguments);
    if (ok) {
      delete backup.managed[item.path];
      verifiedRestored++;
    }
  }
  atomicWriteJson(paths.launcherBackupPath, backup);

  if (!missingTarget && Object.keys(backup.managed).length === 0) {
    try { unlinkSync(vbsPath); } catch {}
  }

  return {
    ok: !missingTarget && verifiedRestored === toRestore.length,
    restored: verifiedRestored,
    error: !missingTarget && verifiedRestored === toRestore.length ? '' : '部分快捷方式未通过还原校验',
    shortcuts: verified.shortcuts
  };
}

export function findT3Executable(paths) {
  if (!paths.t3InstallDir || !existsSync(paths.t3InstallDir)) return '';
  try {
    const exe = readdirSync(paths.t3InstallDir, { withFileTypes: true }).find(
      entry => entry.isFile() && isVerifiedT3Target(entry.name)
    );
    return exe ? join(paths.t3InstallDir, exe.name) : '';
  } catch {
    return '';
  }
}

export function isT3ProcessRunning({ runner = spawnSync } = {}) {
  if (process.platform !== 'win32') return false;
  try {
    const res = runner('tasklist.exe', ['/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000
    });
    if (res.error || res.status !== 0) return true; // conservative: assume running on failure
    return /^"t3(?:\s|-|_)?code(?:\s*\([^)]+\))?\.exe"/im.test(res.stdout || '');
  } catch {
    return true;
  }
}

export async function launchT3WithDebugPort(paths, extraArgs = [], { env = undefined } = {}) {
  const exe = findT3Executable(paths);
  if (!exe) return { ok: false, error: '未找到 T3 Code 可执行文件' };
  const cleanArgs = Array.isArray(extraArgs) ? extraArgs.filter(a => typeof a === 'string') : [];
  const hasFlag = cleanArgs.some(a => DEBUG_TOKEN.test(a));
  const finalArgs = hasFlag ? cleanArgs : [DEBUG_FLAG, ...cleanArgs];
  const spawnOpts = { detached: true, stdio: 'ignore', windowsHide: false };
  if (env && typeof env === 'object') spawnOpts.env = env;
  const child = spawn(exe, finalArgs, spawnOpts);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', resolve);
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  child.unref();
  return { ok: true, exe, pid: child.pid, args: finalArgs };
}

/**
 * Clean Debug-Arg Shortcut Mode (for standalone Magpie-style Tray App):
 * Appends `--remote-debugging-port=0` directly to T3 Code shortcuts without replacing
 * `TargetPath` with wscript.exe, preserving native Windows taskbar pinning & icons.
 * Fully reversible via `restoreT3Launchers`.
 */
export function patchT3ShortcutsDebugArg(paths, { runner = runPowerShell, sandbox = false } = {}) {
  const inspected = inspectShortcuts(paths, { runner, sandbox });
  if (!inspected.ok) {
    return { ok: false, patched: 0, alreadyPatched: 0, error: inspected.error, shortcuts: [] };
  }
  const shortcuts = inspected.shortcuts;
  if (!shortcuts.length) {
    return {
      ok: false,
      patched: 0,
      alreadyPatched: 0,
      error: '未在桌面、开始菜单或任务栏找到指向 T3 Code 可执行文件的快捷方式',
      shortcuts: []
    };
  }

  const backup = loadBackup(paths.launcherBackupPath);
  const toUpdate = [];
  let alreadyPatched = 0;

  for (const sc of shortcuts) {
    if (sc.isWrapper || sc.isLegacyWrapper || sc.hasDebugFlag) {
      alreadyPatched++;
      continue;
    }
    const nextArgs = injectDebugArg(sc.arguments || '');
    toUpdate.push({
      path: sc.path,
      target: sc.target,
      arguments: nextArgs,
      iconLocation: sc.iconLocation || '',
      workingDirectory: sc.workingDirectory || dirname(sc.target)
    });
  }

  if (toUpdate.length === 0) {
    return { ok: true, patched: 0, alreadyPatched, error: '', shortcuts };
  }

  const ps = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$items = $env:T3TOOLS_UPDATES | ConvertFrom-Json
$ws = New-Object -ComObject WScript.Shell
$count = 0
foreach ($item in $items) {
  if (Test-Path -LiteralPath $item.path) {
    $sc = $ws.CreateShortcut($item.path)
    $sc.Arguments = $item.arguments
    if ($item.workingDirectory) { $sc.WorkingDirectory = $item.workingDirectory }
    $sc.Save()
    $count++
  }
}
Write-Output $count
`;
  for (const item of toUpdate) {
    backup.managed[item.path] = {
      mode: 'arg',
      addedFlag: DEBUG_FLAG,
      patchedAtMs: Date.now()
    };
  }
  atomicWriteJson(paths.launcherBackupPath, backup);
  const res = runner(ps, { T3TOOLS_UPDATES: JSON.stringify(toUpdate) });
  if (!res.ok) {
    return { ok: false, patched: 0, alreadyPatched, error: res.stderr || '写入快捷方式失败', shortcuts };
  }

  const verified = inspectShortcuts(paths, { runner, sandbox });
  const verifiedMap = new Map(verified.shortcuts.map(s => [s.path, s]));
  let verifiedPatched = 0;

  for (const item of toUpdate) {
    const after = verifiedMap.get(item.path);
    if (after?.hasDebugFlag) verifiedPatched++;
  }

  return {
    ok: verifiedPatched === toUpdate.length,
    patched: verifiedPatched,
    alreadyPatched,
    error: verifiedPatched === toUpdate.length ? '' : '部分快捷方式未通过写入校验',
    shortcuts: verified.shortcuts
  };
}

export async function inspectShortcutsAsync(paths, { runner = runPowerShellAsync, sandbox = false, signal } = {}) {
  const candidates = await findT3ShortcutCandidatesAsync(paths, { runner, sandbox, signal });
  if (!candidates.length) return { ok: true, shortcuts: [], error: '' };
  const vbsPath = paths.launcherVbsPath || join(paths.pluginDataDir || '', 'launch-t3.vbs');

  const ps = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$paths = $env:T3TOOLS_SHORTCUTS | ConvertFrom-Json
$ws = New-Object -ComObject WScript.Shell
$out = @()
foreach ($p in $paths) {
  if (Test-Path -LiteralPath $p) {
    $sc = $ws.CreateShortcut($p)
    $out += [PSCustomObject]@{
      path = $p
      target = $sc.TargetPath
      arguments = $sc.Arguments
      workingDirectory = $sc.WorkingDirectory
      iconLocation = $sc.IconLocation
    }
  }
}
$out | ConvertTo-Json -Compress -Depth 4
`;
  const res = await runner(ps, { T3TOOLS_SHORTCUTS: JSON.stringify(candidates) }, { signal });
  if (!res.ok) {
    return { ok: false, shortcuts: [], error: res.stderr || '读取快捷方式失败' };
  }
  if (!res.stdout) return { ok: true, shortcuts: [], error: '' };

  try {
    const parsed = JSON.parse(res.stdout);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const shortcuts = arr
      .filter(item => item && item.path && (isVerifiedT3Target(item.target) || isAnyWrapperShortcut(item.target, item.arguments)))
      .map(item => {
        const isWrapper = isWrapperShortcut(item.target, item.arguments, vbsPath);
        const isLegacyWrapper = !isWrapper && isAnyWrapperShortcut(item.target, item.arguments);
        const fixedPort = parseDebugPortFromArgs(item.arguments || '');
        return {
          path: item.path,
          target: item.target || '',
          arguments: item.arguments || '',
          workingDirectory: item.workingDirectory || '',
          iconLocation: item.iconLocation || '',
          isWrapper,
          isLegacyWrapper,
          hasDebugFlag: fixedPort !== null,
          fixedPort: fixedPort && fixedPort > 0 ? fixedPort : null
        };
      });
    return { ok: true, shortcuts, error: '' };
  } catch {
    return { ok: false, shortcuts: [], error: '解析快捷方式信息失败' };
  }
}

export async function patchT3LaunchersAsync(paths, {
  runner = runPowerShellAsync,
  sandbox = false,
  nodeExe = process.execPath,
  cliPath = DEFAULT_CLI_PATH,
  signal,
  shouldProceed = null
} = {}) {
  const inspected = await inspectShortcutsAsync(paths, { runner, sandbox, signal });
  if (!inspected.ok) {
    return { ok: false, patched: 0, alreadyPatched: 0, error: inspected.error, shortcuts: [] };
  }
  const shortcuts = inspected.shortcuts;
  if (!shortcuts.length) {
    return {
      ok: false,
      patched: 0,
      alreadyPatched: 0,
      error: '未在桌面、开始菜单或任务栏找到指向 T3 Code 可执行文件的快捷方式',
      shortcuts: []
    };
  }
  if (signal?.aborted || (typeof shouldProceed === 'function' && shouldProceed() === false)) {
    return { ok: true, patched: 0, alreadyPatched: shortcuts.filter(s => s.isWrapper).length, error: '', shortcuts };
  }

  const vbsPath = writeWrapperVbs(paths, { nodeExe, cliPath });
  const wscriptPath = getWscriptPath();
  const backup = loadBackup(paths.launcherBackupPath);
  const fallbackExe = findT3Executable(paths);
  const toUpdate = [];

  for (const sc of shortcuts) {
    if (sc.isWrapper) continue;
    const prevEntry = backup.managed[sc.path];
    const originalTarget = sc.isLegacyWrapper
      ? (prevEntry?.originalTarget || fallbackExe || '')
      : sc.target;
    if (!originalTarget) continue;
    const cleanedArgs = sc.isLegacyWrapper
      ? extractExtraArgsFromWrapper(sc.arguments || '')
      : (prevEntry?.mode === 'arg'
          ? removeDebugArg(sc.arguments || '', prevEntry.addedFlag || DEBUG_FLAG)
          : (sc.arguments || '').trim());
    const wrapperArgs = cleanedArgs
      ? `//B //NoLogo "${vbsPath}" ${cleanedArgs}`
      : `//B //NoLogo "${vbsPath}"`;
    const iconLocation = (sc.iconLocation && !/^,\s*0$/.test(sc.iconLocation.trim()))
      ? sc.iconLocation
      : `${originalTarget},0`;

    toUpdate.push({
      path: sc.path,
      target: wscriptPath,
      arguments: wrapperArgs,
      iconLocation,
      workingDirectory: sc.workingDirectory || dirname(originalTarget),
      originalTarget,
      originalArguments: cleanedArgs,
      originalIconLocation: prevEntry?.originalIconLocation ?? (sc.isLegacyWrapper ? `${originalTarget},0` : (sc.iconLocation || '')),
      originalWorkingDirectory: prevEntry?.originalWorkingDirectory ?? sc.workingDirectory ?? dirname(originalTarget)
    });
  }

  if (toUpdate.length === 0) {
    return {
      ok: true,
      patched: 0,
      alreadyPatched: shortcuts.filter(s => s.isWrapper).length,
      vbsPath,
      error: '',
      shortcuts
    };
  }

  const ps = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$items = $env:T3TOOLS_UPDATES | ConvertFrom-Json
$ws = New-Object -ComObject WScript.Shell
$count = 0
foreach ($item in $items) {
  if (Test-Path -LiteralPath $item.path) {
    $sc = $ws.CreateShortcut($item.path)
    $sc.TargetPath = $item.target
    $sc.Arguments = $item.arguments
    $sc.IconLocation = $item.iconLocation
    if ($item.workingDirectory) { $sc.WorkingDirectory = $item.workingDirectory }
    $sc.Save()
    $count++
  }
}
Write-Output $count
`;
  for (const item of toUpdate) {
    backup.managed[item.path] = {
      mode: 'wrapper',
      previousArg: backup.managed[item.path]?.mode === 'arg' ? backup.managed[item.path].addedFlag : backup.managed[item.path]?.previousArg,
      vbsPath,
      originalTarget: item.originalTarget,
      originalIconLocation: item.originalIconLocation,
      originalWorkingDirectory: item.originalWorkingDirectory,
      patchedAtMs: Date.now()
    };
  }
  atomicWriteJson(paths.launcherBackupPath, backup);
  const res = await runner(ps, { T3TOOLS_UPDATES: JSON.stringify(toUpdate) }, { signal });
  if (!res.ok) {
    return { ok: false, patched: 0, alreadyPatched: 0, vbsPath, error: res.stderr || '写入快捷方式失败', shortcuts };
  }

  const verified = await inspectShortcutsAsync(paths, { runner, sandbox, signal });
  const verifiedMap = new Map(verified.shortcuts.map(s => [s.path, s]));
  let verifiedPatched = 0;
  for (const item of toUpdate) {
    const after = verifiedMap.get(item.path);
    if (after?.isWrapper) verifiedPatched++;
  }
  return {
    ok: verifiedPatched === toUpdate.length,
    patched: verifiedPatched,
    alreadyPatched: shortcuts.filter(s => s.isWrapper).length,
    vbsPath,
    error: verifiedPatched === toUpdate.length ? '' : '部分快捷方式未通过写入校验',
    shortcuts: verified.shortcuts
  };
}

export async function patchT3ShortcutsDebugArgAsync(paths, { runner = runPowerShellAsync, sandbox = false, signal, shouldProceed = null } = {}) {
  const inspected = await inspectShortcutsAsync(paths, { runner, sandbox, signal });
  if (!inspected.ok) {
    return { ok: false, patched: 0, alreadyPatched: 0, error: inspected.error, shortcuts: [] };
  }
  const shortcuts = inspected.shortcuts;
  if (!shortcuts.length) {
    return {
      ok: false,
      patched: 0,
      alreadyPatched: 0,
      error: '未在桌面、开始菜单或任务栏找到指向 T3 Code 可执行文件的快捷方式',
      shortcuts: []
    };
  }
  // Re-check preference/shutdown state AFTER async inspection before mutating shortcuts
  if (signal?.aborted || (typeof shouldProceed === 'function' && shouldProceed() === false)) {
    return { ok: true, patched: 0, alreadyPatched: shortcuts.filter(s => s.isWrapper || s.isLegacyWrapper || s.hasDebugFlag).length, error: '', shortcuts };
  }

  const backup = loadBackup(paths.launcherBackupPath);
  const toUpdate = [];
  let alreadyPatched = 0;

  for (const sc of shortcuts) {
    if (sc.isWrapper || sc.isLegacyWrapper || sc.hasDebugFlag) {
      alreadyPatched++;
      continue;
    }
    const nextArgs = injectDebugArg(sc.arguments || '');
    toUpdate.push({
      path: sc.path,
      target: sc.target,
      arguments: nextArgs,
      iconLocation: sc.iconLocation || '',
      workingDirectory: sc.workingDirectory || dirname(sc.target)
    });
  }

  if (toUpdate.length === 0) {
    return { ok: true, patched: 0, alreadyPatched, error: '', shortcuts };
  }

  const ps = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$items = $env:T3TOOLS_UPDATES | ConvertFrom-Json
$ws = New-Object -ComObject WScript.Shell
$count = 0
foreach ($item in $items) {
  if (Test-Path -LiteralPath $item.path) {
    $sc = $ws.CreateShortcut($item.path)
    $sc.Arguments = $item.arguments
    if ($item.workingDirectory) { $sc.WorkingDirectory = $item.workingDirectory }
    $sc.Save()
    $count++
  }
}
Write-Output $count
`;
  for (const item of toUpdate) {
    backup.managed[item.path] = {
      mode: 'arg',
      addedFlag: DEBUG_FLAG,
      patchedAtMs: Date.now()
    };
  }
  atomicWriteJson(paths.launcherBackupPath, backup);
  const res = await runner(ps, { T3TOOLS_UPDATES: JSON.stringify(toUpdate) }, { signal });
  if (!res.ok) {
    return { ok: false, patched: 0, alreadyPatched, error: res.stderr || '写入快捷方式失败', shortcuts };
  }

  const verified = await inspectShortcutsAsync(paths, { runner, sandbox, signal });
  const verifiedMap = new Map(verified.shortcuts.map(s => [s.path, s]));
  let verifiedPatched = 0;

  for (const item of toUpdate) {
    const after = verifiedMap.get(item.path);
    if (after?.hasDebugFlag) verifiedPatched++;
  }

  return {
    ok: verifiedPatched === toUpdate.length,
    patched: verifiedPatched,
    alreadyPatched,
    error: verifiedPatched === toUpdate.length ? '' : '部分快捷方式未通过写入校验',
    shortcuts: verified.shortcuts
  };
}

/**
 * Inspect whether the T3 Code desktop UI main process is running and whether it has
 * a CDP remote debugging port flag. Excludes renderer/gpu/utility children and acp-mcp-bridge helpers.
 */
export function inspectT3ProcessState({ runner = runPowerShell } = {}) {
  if (process.platform !== 'win32') {
    return { ok: true, running: false, mainPid: null, hasDebugFlag: false, exePath: '', debugPort: null };
  }
  const ps = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$procs = Get-CimInstance Win32_Process -Filter "Name LIKE 'T3%Code%.exe' OR Name LIKE 't3code%.exe'" -ErrorAction SilentlyContinue
$mains = @()
foreach ($p in $procs) {
  $cmd = [string]$p.CommandLine
  if ($cmd -match '--type=' -or $cmd -match 'acp-mcp-bridge' -or $cmd -match 'server\\.asar') { continue }
  $mains += [PSCustomObject]@{
    pid = [int]$p.ProcessId
    exe = [string]$p.ExecutablePath
    cmd = $cmd
  }
}
$mains | ConvertTo-Json -Compress -Depth 3
`;
  const res = runner(ps, {});
  if (!res.ok) {
    return { ok: false, running: isT3ProcessRunning(), mainPid: null, hasDebugFlag: false, exePath: '', debugPort: null, error: res.stderr };
  }
  if (!res.stdout) {
    return { ok: true, running: false, mainPid: null, hasDebugFlag: false, exePath: '', debugPort: null };
  }
  try {
    const parsed = JSON.parse(res.stdout);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const first = list.find(item => item && item.pid);
    if (!first) {
      return { ok: true, running: false, mainPid: null, hasDebugFlag: false, exePath: '', debugPort: null };
    }
    const hasFlag = list.some(item => hasDebugArg(item.cmd || ''));
    const port = list.map(item => parseDebugPortFromArgs(item.cmd || '')).find(p => p !== null) ?? null;
    return {
      ok: true,
      running: true,
      mainPid: Number(first.pid),
      hasDebugFlag: hasFlag,
      exePath: first.exe || '',
      debugPort: port
    };
  } catch (err) {
    return { ok: false, running: isT3ProcessRunning(), mainPid: null, hasDebugFlag: false, exePath: '', debugPort: null, error: err?.message };
  }
}

/**
 * Gracefully close the main T3 Code Electron UI window (and ONLY its own child
 * server.asar backend verified by parent PID ancestry and exact bin.mjs script path,
 * leaving unrelated instances and acp-mcp-bridge helpers untouched), then relaunch
 * T3 Code with `--remote-debugging-port=0`.
 * Fully asynchronous so the T3Tools daemon event loop and tray health probes never block.
 */
export async function relaunchT3WithDebugPort(
  paths,
  extraArgs = [],
  { runner = null, runnerAsync = null, launchImpl = launchT3WithDebugPort, env = undefined } = {}
) {
  const exe = findT3Executable(paths);
  if (!exe) return { ok: false, error: '未找到 T3 Code 可执行文件' };

  if (process.platform === 'win32') {
    const ps = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$targetExe = $env:T3TOOLS_TARGET_EXE
$procs = @(Get-CimInstance Win32_Process -Filter "Name LIKE 'T3%Code%.exe' OR Name LIKE 't3code%.exe'" -ErrorAction SilentlyContinue)
$mainEntries = @()
$mainPidSet = New-Object 'System.Collections.Generic.HashSet[int]'
foreach ($p in $procs) {
  if ($p.ExecutablePath -ne $targetExe) { continue }
  $cmd = [string]$p.CommandLine
  if ($cmd -match '--type=' -or $cmd -match 'acp-mcp-bridge' -or $cmd -match 'server\\.asar') { continue }
  $pidInt = [int]$p.ProcessId
  $mainEntries += [PSCustomObject]@{ pid = $pidInt; created = $p.CreationDate }
  [void]$mainPidSet.Add($pidInt)
}
# Identify ONLY server.asar backends whose direct parent is one of the main UI PIDs being closed
$ownedServerEntries = @()
$ambiguousServerPids = @()
foreach ($p in $procs) {
  if ($p.ExecutablePath -ne $targetExe) { continue }
  $cmd = [string]$p.CommandLine
  if ($cmd -match '--type=' -or $cmd -match 'acp-mcp-bridge') { continue }
  if ($cmd -notmatch 'resources[\\\\/]server\\.asar[\\\\/]apps[\\\\/]server[\\\\/]dist[\\\\/]bin\\.mjs') { continue }
  $pidInt = [int]$p.ProcessId
  $ppidInt = [int]$p.ParentProcessId
  if ($mainPidSet.Contains($ppidInt)) {
    $ownedServerEntries += [PSCustomObject]@{ pid = $pidInt; created = $p.CreationDate }
  } else {
    $ambiguousServerPids += $pidInt
  }
}
foreach ($m in $mainEntries) {
  try {
    $gp = Get-Process -Id $m.pid -ErrorAction SilentlyContinue
    if ($gp -and $gp.Path -eq $targetExe) {
      [void]$gp.CloseMainWindow()
    }
  } catch {}
}
$deadline = [DateTime]::UtcNow.AddSeconds(8)
while ([DateTime]::UtcNow -lt $deadline) {
  $aliveMain = 0
  foreach ($m in $mainEntries) {
    if (Get-Process -Id $m.pid -ErrorAction SilentlyContinue) { $aliveMain++ }
  }
  $aliveServer = 0
  foreach ($s in $ownedServerEntries) {
    if (Get-Process -Id $s.pid -ErrorAction SilentlyContinue) { $aliveServer++ }
  }
  if ($aliveMain -eq 0 -and $aliveServer -eq 0) { break }
  Start-Sleep -Milliseconds 250
}
foreach ($m in $mainEntries) {
  try {
    $cur = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $m.pid) -ErrorAction SilentlyContinue
    if ($cur -and $cur.ExecutablePath -eq $targetExe -and $cur.CreationDate -eq $m.created) {
      Stop-Process -Id $m.pid -Force -ErrorAction SilentlyContinue
    }
  } catch {}
}
if ($ownedServerEntries.Count -gt 0) {
  $srvDeadline = [DateTime]::UtcNow.AddSeconds(2)
  while ([DateTime]::UtcNow -lt $srvDeadline) {
    $aliveServer = 0
    foreach ($s in $ownedServerEntries) {
      if (Get-Process -Id $s.pid -ErrorAction SilentlyContinue) { $aliveServer++ }
    }
    if ($aliveServer -eq 0) { break }
    Start-Sleep -Milliseconds 200
  }
  foreach ($s in $ownedServerEntries) {
    try {
      $cur = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $s.pid) -ErrorAction SilentlyContinue
      if ($cur -and $cur.ExecutablePath -eq $targetExe -and $cur.CreationDate -eq $s.created -and ([string]$cur.CommandLine -match 'resources[\\\\/]server\\.asar[\\\\/]apps[\\\\/]server[\\\\/]dist[\\\\/]bin\\.mjs')) {
        Stop-Process -Id $s.pid -Force -ErrorAction SilentlyContinue
      }
    } catch {}
  }
}
Start-Sleep -Milliseconds 300
[PSCustomObject]@{
  closedMainPids = @($mainEntries | ForEach-Object { $_.pid })
  closedServerPids = @($ownedServerEntries | ForEach-Object { $_.pid })
  ambiguousServerPids = @($ambiguousServerPids)
} | ConvertTo-Json -Compress
`;
    const execAsync = runnerAsync
      || (runner ? (script, extraEnv) => Promise.resolve(runner(script, extraEnv)) : (script, extraEnv) => runPowerShellAsync(script, extraEnv, { timeoutMs: 16000 }));
    const closeRes = await execAsync(ps, { T3TOOLS_TARGET_EXE: exe });
    if (!closeRes.ok) {
      return { ok: false, error: closeRes.stderr || '关闭 T3 Code 主窗口失败' };
    }
    let closeMeta = null;
    try {
      if (closeRes.stdout && closeRes.stdout.trim().startsWith('{')) {
        closeMeta = JSON.parse(closeRes.stdout.trim());
      }
    } catch {}
    const launched = env ? await launchImpl(paths, extraArgs, { env }) : await launchImpl(paths, extraArgs);
    if (closeMeta && launched && typeof launched === 'object') {
      return {
        ...launched,
        ambiguousServerPids: Array.isArray(closeMeta.ambiguousServerPids) ? closeMeta.ambiguousServerPids : []
      };
    }
    return launched;
  }

  return env ? await launchImpl(paths, extraArgs, { env }) : await launchImpl(paths, extraArgs);
}

const AUTOSTART_REG_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const AUTOSTART_REG_NAME = 'T3Tools';

export function getTrayAutoStartStatus({ runner = runPowerShell } = {}) {
  if (process.platform !== 'win32') return { ok: true, enabled: false, command: '' };
  const ps = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$val = (Get-ItemProperty -Path '${AUTOSTART_REG_KEY}' -Name '${AUTOSTART_REG_NAME}' -ErrorAction SilentlyContinue).'${AUTOSTART_REG_NAME}'
if ($null -eq $val) { Write-Output '' } else { Write-Output ([string]$val) }
`;
  const res = runner(ps, {});
  if (!res.ok) return { ok: false, enabled: false, command: '', error: res.stderr };
  const cmd = (res.stdout || '').trim();
  return { ok: true, enabled: cmd.length > 0, command: cmd };
}

export function setTrayAutoStart(enabled, exePath, { runner = runPowerShell } = {}) {
  if (process.platform !== 'win32') return { ok: false, enabled: false, error: '仅支持 Windows' };
  const want = Boolean(enabled);
  if (want && !exePath) {
    return { ok: false, enabled: false, error: '缺少 T3Tools.exe 路径' };
  }
  const ps = want
    ? `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
if (-not (Test-Path '${AUTOSTART_REG_KEY}')) { New-Item -Path '${AUTOSTART_REG_KEY}' -Force | Out-Null }
Set-ItemProperty -Path '${AUTOSTART_REG_KEY}' -Name '${AUTOSTART_REG_NAME}' -Value $env:T3TOOLS_RUN_CMD
Write-Output 'OK'
`
    : `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Remove-ItemProperty -Path '${AUTOSTART_REG_KEY}' -Name '${AUTOSTART_REG_NAME}' -ErrorAction SilentlyContinue
Write-Output 'OK'
`;
  const res = runner(ps, want ? { T3TOOLS_RUN_CMD: `"${exePath}" --tray` } : {});
  if (!res.ok) return { ok: false, enabled: !want, error: res.stderr || '更新开机自启失败' };
  return { ok: true, enabled: want, command: want ? `"${exePath}" --tray` : '' };
}

export function createT3ToolsTrayShortcuts(paths, { exePath, runner = runPowerShell, sandbox = false } = {}) {
  if (!exePath) return { ok: false, created: [], error: '缺少 T3Tools.exe 路径' };
  const dirs = resolveShortcutSearchDirs(paths, { runner, sandbox });
  const targetDirs = [];
  const seen = new Set();
  for (const d of dirs) {
    if (!d || !existsSync(d)) continue;
    // Only Desktop and Start Menu Programs (not TaskBar pinned)
    if (/User Pinned\\TaskBar/i.test(d)) continue;
    const norm = d.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (/desktop$/i.test(d) || /Start Menu\\Programs$/i.test(d)) {
      targetDirs.push(d);
    }
  }
  if (!targetDirs.length) return { ok: true, created: [], error: '' };

  const items = targetDirs.map(d => ({
    path: join(d, 'T3Tools.lnk'),
    target: exePath,
    workingDirectory: dirname(exePath),
    iconLocation: `${exePath},0`,
    description: 'T3Tools - T3 Code 自动吸附与系统托盘增强工具'
  }));

  const ps = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$items = $env:T3TOOLS_TRAY_SHORTCUTS | ConvertFrom-Json
$ws = New-Object -ComObject WScript.Shell
$created = @()
foreach ($item in $items) {
  $sc = $ws.CreateShortcut($item.path)
  $sc.TargetPath = $item.target
  $sc.Arguments = ''
  $sc.WorkingDirectory = $item.workingDirectory
  $sc.IconLocation = $item.iconLocation
  $sc.Description = $item.description
  $sc.Save()
  $created += $item.path
}
$created | ConvertTo-Json -Compress
`;
  const res = runner(ps, { T3TOOLS_TRAY_SHORTCUTS: JSON.stringify(items) });
  if (!res.ok) return { ok: false, created: [], error: res.stderr || '创建 T3Tools 快捷方式失败' };
  let created = [];
  try {
    const parsed = JSON.parse(res.stdout || '[]');
    created = Array.isArray(parsed) ? parsed : [parsed];
  } catch {}
  return { ok: true, created, error: '' };
}

export function removeT3ToolsTrayShortcuts(paths, { runner = runPowerShell, sandbox = false } = {}) {
  const dirs = resolveShortcutSearchDirs(paths, { runner, sandbox });
  const removed = [];
  for (const d of dirs) {
    if (!d) continue;
    const lnk = join(d, 'T3Tools.lnk');
    if (existsSync(lnk)) {
      try {
        unlinkSync(lnk);
        removed.push(lnk);
      } catch {}
    }
  }
  return { ok: true, removed };
}
