import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { atomicWriteJson } from '../core/settings.mjs';

export const DEBUG_FLAG = '--remote-debugging-port=0';
const HAS_DEBUG_RE = /(?:^|\s)--remote-debugging-port(?:=(\d+)|\s+(\d+)|\b)/i;
const DEFAULT_CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 't3tools.mjs');

export function injectDebugArg(args = '') {
  const trimmed = String(args || '').trim();
  if (HAS_DEBUG_RE.test(trimmed)) return trimmed;
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

  let out = '';
  let i = 0;
  while (i < src.length) {
    if (/\s/.test(src[i])) {
      let wsEnd = i;
      while (wsEnd < src.length && /\s/.test(src[wsEnd])) wsEnd++;
      const ws = src.slice(i, wsEnd);
      if (wsEnd < src.length && src[wsEnd] !== '"') {
        let tokEnd = wsEnd;
        while (tokEnd < src.length && !/\s/.test(src[tokEnd])) tokEnd++;
        if (src.slice(wsEnd, tokEnd).toLowerCase() === target) {
          i = tokEnd;
          continue;
        }
      }
      out += ws;
      i = wsEnd;
      continue;
    }

    if (src[i] === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\' && j + 1 < src.length) { j += 2; continue; }
        if (src[j] === '"') { j++; break; }
        j++;
      }
      out += src.slice(i, j);
      i = j;
      continue;
    }

    let tokEnd = i;
    while (tokEnd < src.length && !/\s/.test(src[tokEnd])) {
      if (src[tokEnd] === '"') {
        tokEnd++;
        while (tokEnd < src.length && src[tokEnd] !== '"') {
          if (src[tokEnd] === '\\' && tokEnd + 1 < src.length) tokEnd += 2;
          else tokEnd++;
        }
        if (tokEnd < src.length) tokEnd++;
      } else {
        tokEnd++;
      }
    }
    const tok = src.slice(i, tokEnd);
    if (tok.toLowerCase() === target) {
      i = tokEnd;
      if (i < src.length && src[i] === ' ') i++;
      continue;
    }
    out += tok;
    i = tokEnd;
  }

  return out.replace(/^\s+|\s+$/g, '');
}

export function hasDebugArg(args = '') {
  return HAS_DEBUG_RE.test(String(args || ''));
}

export function parseDebugPortFromArgs(args = '') {
  const m = String(args || '').match(HAS_DEBUG_RE);
  if (!m) return null;
  const n = Number(m[1] || m[2]);
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
export function isAnyWrapperShortcut(targetPath = '', args = '') {
  const exeName = basename(String(targetPath || '').trim()).toLowerCase();
  if (exeName !== 'wscript.exe') return false;
  return String(args || '').toLowerCase().includes('launch-t3.vbs');
}

/**
 * Check whether a shortcut is already configured to use our silent wrapper launcher.
 */
export function isWrapperShortcut(targetPath = '', args = '', vbsPath = '') {
  if (!isAnyWrapperShortcut(targetPath, args)) return false;
  const normArgs = String(args || '').toLowerCase();
  if (vbsPath) {
    return normArgs.includes(String(vbsPath).toLowerCase());
  }
  return true;
}

/**
 * Extract any extra user arguments appended after our wrapper VBS path in a shortcut's Arguments.
 */
export function extractExtraArgsFromWrapper(args = '', vbsPath = '') {
  const raw = String(args || '');
  const needle = vbsPath ? `"${vbsPath}"` : 'launch-t3.vbs"';
  const idx = raw.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return '';
  return raw.slice(idx + needle.length).replace(/^\s+/, '');
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
    '  arg = Replace(WScript.Arguments(i), """", """""")',
    '  cmd = cmd & " """ & arg & """"',
    'Next',
    'shell.Run cmd, 0, False',
    ''
  ].join('\r\n');
}

export function writeWrapperVbs(paths, opts = {}) {
  const vbsPath = paths.launcherVbsPath || join(paths.pluginDataDir, 'launch-t3.vbs');
  mkdirSync(dirname(vbsPath), { recursive: true });
  writeFileSync(vbsPath, buildWrapperVbsContent(opts), 'utf8');
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
      originalIconLocation: prevEntry?.originalIconLocation || (sc.isLegacyWrapper ? `${originalTarget},0` : (sc.iconLocation || '')),
      originalWorkingDirectory: prevEntry?.originalWorkingDirectory || sc.workingDirectory || dirname(originalTarget)
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
  const res = runner(ps, { T3TOOLS_UPDATES: JSON.stringify(toUpdate) });
  if (!res.ok) {
    return { ok: false, patched: 0, alreadyPatched: 0, vbsPath, error: res.stderr || '写入快捷方式失败', shortcuts };
  }

  const verified = inspectShortcuts(paths, { runner, sandbox });
  const verifiedMap = new Map(verified.shortcuts.map(s => [s.path, s]));
  let verifiedPatched = 0;

  for (const item of toUpdate) {
    const after = verifiedMap.get(item.path);
    if (after?.isWrapper) {
      backup.managed[item.path] = {
        mode: 'wrapper',
        vbsPath,
        originalTarget: item.originalTarget,
        originalIconLocation: item.originalIconLocation,
        originalWorkingDirectory: item.originalWorkingDirectory,
        patchedAtMs: Date.now()
      };
      verifiedPatched++;
    }
  }
  atomicWriteJson(paths.launcherBackupPath, backup);

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

  for (const sc of inspected.shortcuts) {
    const entry = backup.managed[sc.path];
    if (sc.isWrapper || sc.isLegacyWrapper) {
      const targetExe = entry?.originalTarget || fallbackExe;
      if (!targetExe) continue;
      const preservedArgs = extractExtraArgsFromWrapper(sc.arguments || '', sc.isWrapper ? (entry?.vbsPath || vbsPath) : '');
      toRestore.push({
        path: sc.path,
        mode: 'wrapper',
        target: targetExe,
        arguments: preservedArgs,
        iconLocation: entry?.originalIconLocation || `${targetExe},0`,
        workingDirectory: entry?.originalWorkingDirectory || dirname(targetExe)
      });
    } else if (entry?.mode === 'arg') {
      const nextArgs = removeDebugArg(sc.arguments || '', entry.addedFlag || DEBUG_FLAG);
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
    }
  }

  if (!toRestore.length) {
    atomicWriteJson(paths.launcherBackupPath, backup);
    return { ok: true, restored: 0, error: '', shortcuts: inspected.shortcuts };
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
    if ($item.iconLocation) { $sc.IconLocation = $item.iconLocation }
    if ($item.workingDirectory) { $sc.WorkingDirectory = $item.workingDirectory }
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
      ? (after && !after.isWrapper && !after.isLegacyWrapper && isVerifiedT3Target(after.target))
      : (after && !after.arguments.includes(item.addedFlag));
    if (ok) {
      delete backup.managed[item.path];
      verifiedRestored++;
    }
  }
  atomicWriteJson(paths.launcherBackupPath, backup);

  if (Object.keys(backup.managed).length === 0) {
    try { unlinkSync(vbsPath); } catch {}
  }

  return {
    ok: verifiedRestored === toRestore.length,
    restored: verifiedRestored,
    error: verifiedRestored === toRestore.length ? '' : '部分快捷方式未通过还原校验',
    shortcuts: verified.shortcuts
  };
}

export function findT3Executable(paths) {
  if (!paths.t3InstallDir || !existsSync(paths.t3InstallDir)) return '';
  try {
    const exe = readdirSync(paths.t3InstallDir).find(
      name => isVerifiedT3Target(join(paths.t3InstallDir, name))
    );
    return exe ? join(paths.t3InstallDir, exe) : '';
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

export function launchT3WithDebugPort(paths, extraArgs = []) {
  const exe = findT3Executable(paths);
  if (!exe) return { ok: false, error: '未找到 T3 Code 可执行文件' };
  const cleanArgs = Array.isArray(extraArgs) ? extraArgs.filter(a => typeof a === 'string' && a.length > 0) : [];
  const hasFlag = cleanArgs.some(a => hasDebugArg(a));
  const finalArgs = hasFlag ? cleanArgs : [DEBUG_FLAG, ...cleanArgs];
  const child = spawn(exe, finalArgs, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return { ok: true, exe, pid: child.pid, args: finalArgs };
}
