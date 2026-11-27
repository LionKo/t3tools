import { existsSync, openSync, readSync, closeSync, readFileSync, statSync, unlinkSync, promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { atomicWriteJson } from '../core/settings.mjs';

export const PRIVACY_ENV_KEYS = Object.freeze([
  'T3CODE_TELEMETRY_ENABLED'
]);

export const LEGACY_PRIVACY_ENV_KEYS = Object.freeze([
  'T3CODE_TELEMETRY_ENABLED',
  'DO_NOT_TRACK'
]);

export const TELEMETRY_ENV_OVERRIDES = Object.freeze({
  T3CODE_TELEMETRY_ENABLED: 'false'
});

const LEGACY_ENV_OVERRIDES = Object.freeze({
  T3CODE_TELEMETRY_ENABLED: 'false',
  DO_NOT_TRACK: '1'
});

export const CDP_TELEMETRY_BLOCK_URLS = Object.freeze([
  'https://ingest.t3.codes/*',
  'https://us-east-1.aws.edge.axiom.co/*'
]);

export const CDP_FAVICON_BLOCK_URLS = Object.freeze([
  'https://www.google.com/s2/favicons*'
]);

const TRACE_READ_TAIL_BYTES = 512 * 1024;
const TRACE_CACHE_TTL_MS = 10000;

function isPlainObject(v) {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v));
}

function defaultRunPowerShell(script, envVars = {}) {
  if (process.platform !== 'win32') {
    return { ok: false, stdout: '', stderr: '仅支持 Windows', status: -1 };
  }
  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 12000,
      env: { ...process.env, ...envVars }
    }
  );
  return {
    ok: !res.error && res.status === 0,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || res.error?.message || '').trim(),
    status: res.status ?? -1
  };
}

function defaultRunPowerShellAsync(script, envVars = {}) {
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, stdout: '', stderr: '仅支持 Windows', status: -1 });
  }
  return new Promise(resolve => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 12000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, ...envVars }
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout || '').trim(),
          stderr: String(stderr || err?.message || '').trim(),
          status: err ? (typeof err.code === 'number' ? err.code : -1) : 0
        });
      }
    );
  });
}

export function normalizePrivacyGuardConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  return {
    blockTelemetryAndTracing: Boolean(cfg.blockTelemetryAndTracing),
    blockGoogleFavicons: Boolean(cfg.blockGoogleFavicons)
  };
}

export function computeBlockedCdpUrls(privacyCfg) {
  const cfg = normalizePrivacyGuardConfig(privacyCfg);
  const urls = [];
  if (cfg.blockTelemetryAndTracing) {
    urls.push(...CDP_TELEMETRY_BLOCK_URLS);
  }
  if (cfg.blockGoogleFavicons) {
    urls.push(...CDP_FAVICON_BLOCK_URLS);
  }
  return urls;
}

/**
 * Strictly validate backup file structure (version + plain-object entries with valid shapes).
 * Never treats corrupt or invalid backups as missing so recovery data is never overwritten.
 */
export function inspectPrivacyEnvBackup(backupPath) {
  if (!backupPath || !existsSync(backupPath)) {
    return { exists: false, corrupt: false, backup: null, error: '' };
  }
  try {
    const parsed = JSON.parse(readFileSync(backupPath, 'utf8'));
    if (!isPlainObject(parsed)) {
      return { exists: true, corrupt: true, backup: null, error: '隐私环境变量备份文件根节点无效' };
    }
    if (parsed.version !== 1 && parsed.version !== 2) {
      return { exists: true, corrupt: true, backup: null, error: `不支持的隐私环境变量备份版本: ${parsed.version}` };
    }
    if (!isPlainObject(parsed.entries)) {
      return { exists: true, corrupt: true, backup: null, error: '隐私环境变量备份 entries 字段无效' };
    }
    const keys = Object.keys(parsed.entries);
    if (keys.length === 0) {
      return { exists: true, corrupt: true, backup: null, error: '隐私环境变量备份 entries 为空' };
    }
    if (!Object.hasOwn(parsed.entries, 'T3CODE_TELEMETRY_ENABLED')) {
      return { exists: true, corrupt: true, backup: null, error: '隐私环境变量备份缺少 T3CODE_TELEMETRY_ENABLED 原始记录' };
    }
    for (const k of keys) {
      if (!LEGACY_PRIVACY_ENV_KEYS.includes(k)) {
        return { exists: true, corrupt: true, backup: null, error: `隐私环境变量备份包含未知键: ${k}` };
      }
      const entry = parsed.entries[k];
      if (!isPlainObject(entry) || typeof entry.existed !== 'boolean') {
        return { exists: true, corrupt: true, backup: null, error: `隐私环境变量备份项 ${k} 格式无效` };
      }
      if (entry.existed && typeof entry.value !== 'string') {
        return { exists: true, corrupt: true, backup: null, error: `隐私环境变量备份项 ${k} 缺少原始字符串值` };
      }
      if (!entry.existed && entry.value !== null && entry.value !== undefined) {
        return { exists: true, corrupt: true, backup: null, error: `隐私环境变量备份项 ${k} 状态不一致` };
      }
    }
    return { exists: true, corrupt: false, backup: parsed, error: '' };
  } catch (err) {
    return { exists: true, corrupt: true, backup: null, error: `读取隐私环境变量备份失败: ${err?.message || err}` };
  }
}

export function readPrivacyEnvBackup(backupPath) {
  const info = inspectPrivacyEnvBackup(backupPath);
  return info.backup;
}

function buildReadUserEnvScript(keys) {
  const cleanKeys = keys.filter(k => /^[A-Z0-9_]+$/i.test(String(k)));
  const ps = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$names = @(${cleanKeys.map(k => `'${k}'`).join(', ')})
$out = @{}
foreach ($n in $names) {
  $v = [Environment]::GetEnvironmentVariable($n, 'User')
  if ($null -eq $v) { $out[$n] = $null } else { $out[$n] = [string]$v }
}
$out | ConvertTo-Json -Compress
`;
  return { cleanKeys, ps };
}

function parseReadUserEnvResult(res, cleanKeys) {
  if (!res.ok) {
    return { ok: false, values: {}, error: res.stderr || '读取用户环境变量失败' };
  }
  try {
    const parsed = JSON.parse(res.stdout || '{}');
    const values = {};
    for (const k of cleanKeys) {
      values[k] = typeof parsed?.[k] === 'string' ? parsed[k] : null;
    }
    return { ok: true, values };
  } catch (err) {
    return { ok: false, values: {}, error: err?.message || '解析用户环境变量失败' };
  }
}

export function readWindowsUserEnvVars(keys = PRIVACY_ENV_KEYS, { runner = defaultRunPowerShell, platform = process.platform } = {}) {
  if (platform !== 'win32') {
    return { ok: true, values: Object.fromEntries(keys.map(k => [k, null])), skipped: true };
  }
  const { cleanKeys, ps } = buildReadUserEnvScript(keys);
  return parseReadUserEnvResult(runner(ps, {}), cleanKeys);
}

export async function readWindowsUserEnvVarsAsync(keys = PRIVACY_ENV_KEYS, { runnerAsync = defaultRunPowerShellAsync, platform = process.platform } = {}) {
  if (platform !== 'win32') {
    return { ok: true, values: Object.fromEntries(keys.map(k => [k, null])), skipped: true };
  }
  const { cleanKeys, ps } = buildReadUserEnvScript(keys);
  return parseReadUserEnvResult(await runnerAsync(ps, {}), cleanKeys);
}

/**
 * Write Windows HKCU:\Environment directly, verify readback FIRST, then send a
 * single WM_SETTINGCHANGE broadcast under an overall 1000ms wall-clock deadline
 * (preventing per-window SendMessageTimeout delays from timing out verification).
 */
function buildWriteUserEnvScript(updates) {
  const entries = Object.entries(updates || {}).filter(([k]) => /^[A-Z0-9_]+$/i.test(String(k)));
  if (!entries.length) return null;
  const envPayload = {};
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    "$regPath = 'HKCU:\\Environment'",
    'if (-not (Test-Path -LiteralPath $regPath)) { New-Item -Path $regPath -Force | Out-Null }'
  ];
  entries.forEach(([key, value], idx) => {
    if (value === null || value === undefined) {
      lines.push(`Remove-ItemProperty -LiteralPath $regPath -Name '${key}' -ErrorAction SilentlyContinue`);
    } else {
      const envName = `T3TOOLS_PRIV_VAL_${idx}`;
      envPayload[envName] = String(value);
      lines.push(`Set-ItemProperty -LiteralPath $regPath -Name '${key}' -Value $env:${envName} -Type String`);
    }
  });
  // Verify registry readback BEFORE broadcasting WM_SETTINGCHANGE
  lines.push('$verify = @{}');
  for (const [key] of entries) {
    lines.push(`$vv = [Environment]::GetEnvironmentVariable('${key}', 'User')`);
    lines.push(`if ($null -eq $vv) { $verify['${key}'] = $null } else { $verify['${key}'] = [string]$vv }`);
  }
  lines.push('$verifyJson = $verify | ConvertTo-Json -Compress');
  lines.push(`
try {
  Add-Type -Namespace T3ToolsWin32 -Name EnvBroadcast -MemberDefinition '
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
    public static void BroadcastBounded(int totalTimeoutMs) {
      try {
        var task = System.Threading.Tasks.Task.Run(() => {
          UIntPtr res;
          SendMessageTimeout((IntPtr)0xffff, 0x001A, UIntPtr.Zero, "Environment", 0x0002, 200, out res);
        });
        task.Wait(totalTimeoutMs);
      } catch {}
    }
  ' -ErrorAction SilentlyContinue
  [T3ToolsWin32.EnvBroadcast]::BroadcastBounded(1000)
} catch {}
Write-Output $verifyJson
`);
  return { entries, ps: lines.join('\n'), envPayload };
}

function verifyWriteUserEnvResult(res, entries) {
  if (!res.ok) {
    return { ok: false, error: res.stderr || '更新用户环境变量失败' };
  }
  const stdout = String(res.stdout || '').trim();
  if (stdout === 'OK') return { ok: true };
  if (!stdout) return { ok: false, error: '写入用户环境变量后未返回校验结果' };
  try {
    const parsed = JSON.parse(stdout);
    for (const [key, expected] of entries) {
      const actual = typeof parsed?.[key] === 'string' ? parsed[key] : null;
      const want = expected === null || expected === undefined ? null : String(expected);
      if (actual !== want) {
        return { ok: false, error: `环境变量 ${key} 回读校验失败（期望 ${want ?? 'null'}，实际 ${actual ?? 'null'}）` };
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `解析环境变量回读结果失败: ${err?.message || err}` };
  }
}

export function writeWindowsUserEnvVars(updates, { runner = defaultRunPowerShell, platform = process.platform } = {}) {
  if (platform !== 'win32') {
    return { ok: true, skipped: true };
  }
  const built = buildWriteUserEnvScript(updates);
  if (!built) return { ok: true };
  return verifyWriteUserEnvResult(runner(built.ps, built.envPayload), built.entries);
}

export async function writeWindowsUserEnvVarsAsync(updates, { runnerAsync = defaultRunPowerShellAsync, platform = process.platform } = {}) {
  if (platform !== 'win32') {
    return { ok: true, skipped: true };
  }
  const built = buildWriteUserEnvScript(updates);
  if (!built) return { ok: true };
  return verifyWriteUserEnvResult(await runnerAsync(built.ps, built.envPayload), built.entries);
}

/**
 * Compute child process environment when T3Tools launches or relaunches T3 Code.
 * - When enabled: sets T3CODE_TELEMETRY_ENABLED=false (and cleans legacy DO_NOT_TRACK if backed up).
 * - When disabled: applies effective post-restore entries (preserving manual user overrides!),
 *   and ONLY removes inherited T3CODE_TELEMETRY_ENABLED=false when T3Tools owns the override.
 */
export function buildT3LaunchEnv(privacyCfg, { baseEnv = process.env, restoreEntries = null, ownedOverride = false } = {}) {
  const cfg = normalizePrivacyGuardConfig(privacyCfg);
  const env = { ...baseEnv };
  if (cfg.blockTelemetryAndTracing) {
    for (const [k, v] of Object.entries(TELEMETRY_ENV_OVERRIDES)) {
      env[k] = v;
    }
    const legacyDnt = restoreEntries?.DO_NOT_TRACK;
    if (legacyDnt && env.DO_NOT_TRACK === LEGACY_ENV_OVERRIDES.DO_NOT_TRACK) {
      if (legacyDnt.existed && typeof legacyDnt.value === 'string') {
        env.DO_NOT_TRACK = legacyDnt.value;
      } else {
        delete env.DO_NOT_TRACK;
      }
    }
    return env;
  }
  for (const k of LEGACY_PRIVACY_ENV_KEYS) {
    const entry = restoreEntries?.[k];
    if (entry) {
      if (entry.existed && typeof entry.value === 'string') {
        env[k] = entry.value;
      } else {
        delete env[k];
      }
    } else if (ownedOverride && k === 'T3CODE_TELEMETRY_ENABLED' && env[k] === TELEMETRY_ENV_OVERRIDES[k]) {
      delete env[k];
    }
  }
  return env;
}

function readTailText(filePath, maxBytes = TRACE_READ_TAIL_BYTES) {
  if (!filePath || !existsSync(filePath)) return '';
  let fd;
  try {
    const st = statSync(filePath);
    if (!st.size) return '';
    const bytesToRead = Math.min(st.size, maxBytes);
    const offset = Math.max(0, st.size - bytesToRead);
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(bytesToRead);
    const read = readSync(fd, buf, 0, bytesToRead, offset);
    return buf.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

async function readTailTextAsync(filePath, maxBytes = TRACE_READ_TAIL_BYTES) {
  if (!filePath) return '';
  let handle;
  try {
    const st = await fsp.stat(filePath);
    if (!st.size) return '';
    const bytesToRead = Math.min(st.size, maxBytes);
    const offset = Math.max(0, st.size - bytesToRead);
    handle = await fsp.open(filePath, 'r');
    const buf = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buf, 0, bytesToRead, offset);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    if (handle) {
      try { await handle.close(); } catch {}
    }
  }
}

function parseTraceLineTimestampMs(line) {
  const nanoMatch = line.match(/"endTimeUnixNano":"(\d+)"/) || line.match(/"startTimeUnixNano":"(\d+)"/);
  if (nanoMatch) {
    const ms = Math.floor(Number(nanoMatch[1]) / 1e6);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  const isoMatch = line.match(/"timestamp":"([^"]+)"/);
  if (isoMatch) {
    const ms = Date.parse(isoMatch[1]);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return null;
}

export function inspectT3ServerRuntime(serverRuntimePath) {
  if (!serverRuntimePath || !existsSync(serverRuntimePath)) {
    return { running: false, pid: null, startedAtMs: null };
  }
  try {
    const st = statSync(serverRuntimePath);
    const parsed = JSON.parse(readFileSync(serverRuntimePath, 'utf8'));
    const pid = Number(parsed?.pid);
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (err) {
        alive = err?.code === 'EPERM';
      }
    }
    const isoMs = parsed?.startedAt ? Date.parse(String(parsed.startedAt)) : NaN;
    const startedAtMs = Number.isFinite(isoMs) ? isoMs : Math.round(st.mtimeMs);
    return {
      running: alive,
      pid: alive ? pid : null,
      startedAtMs: alive ? startedAtMs : null
    };
  } catch {
    return { running: false, pid: null, startedAtMs: null };
  }
}

function emptyTraceSignals() {
  return {
    recentTelemetryHits: 0,
    telemetryHitsSinceApply: 0,
    lastTelemetryAtMs: null,
    t3ConnectTunnelDetected: false,
    publishAgentActivityState: 'unknown'
  };
}

function scanTraceTextsIntoResult(result, texts, sinceMs) {
  for (const text of texts) {
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;
      if (line.includes('ingest.t3.codes/batch')) {
        result.recentTelemetryHits++;
        const ts = parseTraceLineTimestampMs(line);
        if (ts !== null) {
          if (result.lastTelemetryAtMs === null || ts > result.lastTelemetryAtMs) {
            result.lastTelemetryAtMs = ts;
          }
          if (sinceMs > 0 && ts >= sinceMs) {
            result.telemetryHitsSinceApply++;
          }
        }
      }
      if (line.includes('agent activity publishing disabled') || line.includes('publication disabled')) {
        result.publishAgentActivityState = 'disabled';
      } else if (
        line.includes('publishing agent activity for thread') ||
        line.includes('agent activity publishing enabled') ||
        line.includes('agent activity publish completed')
      ) {
        result.publishAgentActivityState = 'enabled';
      }
    }
  }
  return result;
}

export function inspectT3PrivacyTraceSignals(t3LogsDir, { sinceMs = 0 } = {}) {
  const result = emptyTraceSignals();
  if (!t3LogsDir || !existsSync(t3LogsDir)) return result;

  const relayLogPath = join(t3LogsDir, 'relay-client.ndjson');
  try {
    result.t3ConnectTunnelDetected = existsSync(relayLogPath) && statSync(relayLogPath).size > 0;
  } catch {}

  const texts = [
    readTailText(join(t3LogsDir, 'server.trace.ndjson.1'), 256 * 1024),
    readTailText(join(t3LogsDir, 'server.trace.ndjson'), TRACE_READ_TAIL_BYTES)
  ];
  return scanTraceTextsIntoResult(result, texts, sinceMs);
}

export async function inspectT3PrivacyTraceSignalsAsync(t3LogsDir, { sinceMs = 0 } = {}) {
  const result = emptyTraceSignals();
  if (!t3LogsDir) return result;

  const relayLogPath = join(t3LogsDir, 'relay-client.ndjson');
  try {
    const st = await fsp.stat(relayLogPath);
    result.t3ConnectTunnelDetected = st.size > 0;
  } catch {}

  const texts = await Promise.all([
    readTailTextAsync(join(t3LogsDir, 'server.trace.ndjson.1'), 256 * 1024),
    readTailTextAsync(join(t3LogsDir, 'server.trace.ndjson'), TRACE_READ_TAIL_BYTES)
  ]);
  return scanTraceTextsIntoResult(result, texts, sinceMs);
}

/**
 * Compute registry updates to restore backed-up keys AND compute the effective
 * post-restore entries (preserving manual user edits for subsequent launches).
 */
function computeRestorePlan(backupEntries, currentValues) {
  const updates = {};
  const effectiveEntries = {};
  for (const key of LEGACY_PRIVACY_ENV_KEYS) {
    const entry = backupEntries?.[key];
    if (!entry) continue;
    const expectedOverride = LEGACY_ENV_OVERRIDES[key];
    if (currentValues && currentValues[key] !== expectedOverride) {
      const cur = currentValues[key];
      effectiveEntries[key] = { existed: typeof cur === 'string', value: typeof cur === 'string' ? cur : null };
      continue;
    }
    updates[key] = entry.existed ? String(entry.value ?? '') : null;
    effectiveEntries[key] = { existed: Boolean(entry.existed), value: entry.existed ? String(entry.value ?? '') : null };
  }
  return { updates, effectiveEntries };
}

function removeBackupFileStrict(backupPath) {
  try {
    unlinkSync(backupPath);
    return { ok: true };
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true };
    return { ok: false, error: `删除隐私环境变量备份失败: ${err?.message || err}` };
  }
}

export function restorePrivacyEnvBackup(paths, { runner = defaultRunPowerShell, platform = process.platform } = {}) {
  const backupPath = paths?.privacyEnvBackupPath;
  const info = inspectPrivacyEnvBackup(backupPath);
  if (!info.exists) {
    return { ok: true, restored: false, entries: null, effectiveEntries: null };
  }
  if (info.corrupt || !info.backup) {
    return { ok: false, restored: false, error: info.error || '隐私环境变量备份损坏', entries: null, effectiveEntries: null };
  }
  const backup = info.backup;
  const keysInBackup = LEGACY_PRIVACY_ENV_KEYS.filter(k => Boolean(backup.entries?.[k]));
  let currentValues = null;
  if (platform === 'win32' && keysInBackup.length > 0) {
    const readRes = readWindowsUserEnvVars(keysInBackup, { runner, platform });
    if (!readRes.ok) {
      return { ok: false, restored: false, error: readRes.error || '读取当前用户环境变量失败', entries: backup.entries, effectiveEntries: null };
    }
    currentValues = readRes.values;
  }
  const { updates, effectiveEntries } = computeRestorePlan(backup.entries, currentValues);
  if (Object.keys(updates).length > 0) {
    const writeRes = writeWindowsUserEnvVars(updates, { runner, platform });
    if (!writeRes.ok) {
      return { ok: false, restored: false, error: writeRes.error || '还原环境变量失败', entries: backup.entries, effectiveEntries: null };
    }
  }
  const unlinkRes = removeBackupFileStrict(backupPath);
  if (!unlinkRes.ok) {
    return { ok: false, restored: Object.keys(updates).length > 0, error: unlinkRes.error, entries: backup.entries, effectiveEntries };
  }
  return { ok: true, restored: Object.keys(updates).length > 0, entries: backup.entries, effectiveEntries };
}

export async function restorePrivacyEnvBackupAsync(paths, { runnerAsync = defaultRunPowerShellAsync, platform = process.platform } = {}) {
  const backupPath = paths?.privacyEnvBackupPath;
  const info = inspectPrivacyEnvBackup(backupPath);
  if (!info.exists) {
    return { ok: true, restored: false, entries: null, effectiveEntries: null };
  }
  if (info.corrupt || !info.backup) {
    return { ok: false, restored: false, error: info.error || '隐私环境变量备份损坏', entries: null, effectiveEntries: null };
  }
  const backup = info.backup;
  const keysInBackup = LEGACY_PRIVACY_ENV_KEYS.filter(k => Boolean(backup.entries?.[k]));
  let currentValues = null;
  if (platform === 'win32' && keysInBackup.length > 0) {
    const readRes = await readWindowsUserEnvVarsAsync(keysInBackup, { runnerAsync, platform });
    if (!readRes.ok) {
      return { ok: false, restored: false, error: readRes.error || '读取当前用户环境变量失败', entries: backup.entries, effectiveEntries: null };
    }
    currentValues = readRes.values;
  }
  const { updates, effectiveEntries } = computeRestorePlan(backup.entries, currentValues);
  if (Object.keys(updates).length > 0) {
    const writeRes = await writeWindowsUserEnvVarsAsync(updates, { runnerAsync, platform });
    if (!writeRes.ok) {
      return { ok: false, restored: false, error: writeRes.error || '还原环境变量失败', entries: backup.entries, effectiveEntries: null };
    }
  }
  const unlinkRes = removeBackupFileStrict(backupPath);
  if (!unlinkRes.ok) {
    return { ok: false, restored: Object.keys(updates).length > 0, error: unlinkRes.error, entries: backup.entries, effectiveEntries };
  }
  return { ok: true, restored: Object.keys(updates).length > 0, entries: backup.entries, effectiveEntries };
}

export function createPrivacyGuard({
  paths,
  settings,
  runner = null,
  runnerAsync = null,
  platform = process.platform,
  nowFn = () => Date.now()
} = {}) {
  const syncRunner = runner || defaultRunPowerShell;
  const asyncRunner = runnerAsync || (runner ? (script, envVars) => Promise.resolve(runner(script, envVars)) : defaultRunPowerShellAsync);
  let lastError = '';
  let externalError = '';
  let envSynced = false;
  let applying = false;
  let stopping = false;
  let applyRevision = 0;
  let lastMutationAtMs = 0;
  let lastEffectiveRestoreEntries = null;
  let ownedOverrideInSession = false;
  let traceCache = { atMs: 0, sinceMs: 0, data: emptyTraceSignals(), initialized: false };
  let traceRefreshInFlight = null;
  let applyChain = Promise.resolve();

  const initialBackup = readPrivacyEnvBackup(paths?.privacyEnvBackupPath);
  if (initialBackup) {
    ownedOverrideInSession = true;
    if (Number.isFinite(Number(initialBackup.appliedAtMs))) {
      lastMutationAtMs = Number(initialBackup.appliedAtMs);
    }
  }

  function refreshTraceSignalsAsync(sinceMs) {
    if (traceRefreshInFlight) return traceRefreshInFlight;
    const targetSince = sinceMs;
    traceRefreshInFlight = inspectT3PrivacyTraceSignalsAsync(paths?.t3LogsDir, { sinceMs: targetSince })
      .then(data => {
        traceCache = { atMs: nowFn(), sinceMs: targetSince, data, initialized: true };
        return data;
      })
      .catch(() => traceCache.data)
      .finally(() => {
        traceRefreshInFlight = null;
      });
    return traceRefreshInFlight;
  }

  function applyEnableUpdates(currentRead, existingBackup, backupPath) {
    const updates = {};
    for (const k of PRIVACY_ENV_KEYS) {
      if (currentRead.values[k] !== TELEMETRY_ENV_OVERRIDES[k]) {
        updates[k] = TELEMETRY_ENV_OVERRIDES[k];
      }
    }
    if (existingBackup?.entries?.DO_NOT_TRACK && currentRead.values.DO_NOT_TRACK === LEGACY_ENV_OVERRIDES.DO_NOT_TRACK) {
      const legacyEntry = existingBackup.entries.DO_NOT_TRACK;
      updates.DO_NOT_TRACK = legacyEntry.existed ? String(legacyEntry.value ?? '') : null;
    }

    if (!existingBackup && backupPath) {
      const entries = {};
      for (const k of PRIVACY_ENV_KEYS) {
        const val = currentRead.values[k];
        entries[k] = { existed: typeof val === 'string', value: typeof val === 'string' ? val : null };
      }
      const savedAtMs = nowFn();
      atomicWriteJson(backupPath, {
        version: 2,
        savedAtMs,
        appliedAtMs: savedAtMs,
        entries
      });
    }
    return updates;
  }

  function finalizeBackupAfterEnable(backupPath, appliedAtMs) {
    if (!backupPath) return;
    const b = readPrivacyEnvBackup(backupPath);
    if (!b) return;
    const nextEntries = { ...(b.entries || {}) };
    delete nextEntries.DO_NOT_TRACK;
    atomicWriteJson(backupPath, { ...b, version: 2, appliedAtMs, entries: nextEntries });
  }

  function applySettings(nextCfg = null, { force = false } = {}) {
    if (stopping) return { ok: false, error: '守护进程正在停止' };
    const cfg = normalizePrivacyGuardConfig(nextCfg ?? settings?.get?.()?.privacyGuard);
    const backupPath = paths?.privacyEnvBackupPath;
    const backupInfo = inspectPrivacyEnvBackup(backupPath);
    lastError = '';
    externalError = '';

    // Never overwrite or delete a corrupt backup file; preserve it byte-for-byte
    if (backupInfo.corrupt) {
      lastError = backupInfo.error || '隐私环境变量备份损坏';
      envSynced = false;
      return { ok: false, error: lastError };
    }
    const existingBackup = backupInfo.backup;

    if (cfg.blockTelemetryAndTracing) {
      if (platform !== 'win32') {
        envSynced = true;
        ownedOverrideInSession = true;
        if (force || !lastMutationAtMs) lastMutationAtMs = nowFn();
        traceCache.atMs = 0;
        return { ok: true, applied: true, skipped: true };
      }

      const readKeys = existingBackup?.entries?.DO_NOT_TRACK ? LEGACY_PRIVACY_ENV_KEYS : PRIVACY_ENV_KEYS;
      const currentRead = readWindowsUserEnvVars(readKeys, { runner: syncRunner, platform });
      if (!currentRead.ok) {
        lastError = currentRead.error || '读取用户环境变量失败';
        envSynced = false;
        return { ok: false, error: lastError };
      }

      try {
        const updates = applyEnableUpdates(currentRead, existingBackup, backupPath);
        if (force && !Object.hasOwn(updates, 'T3CODE_TELEMETRY_ENABLED')) {
          updates.T3CODE_TELEMETRY_ENABLED = TELEMETRY_ENV_OVERRIDES.T3CODE_TELEMETRY_ENABLED;
        }

        if (Object.keys(updates).length > 0) {
          const writeRes = writeWindowsUserEnvVars(updates, { runner: syncRunner, platform });
          if (!writeRes.ok) {
            lastError = writeRes.error || '写入用户环境变量失败';
            envSynced = false;
            return { ok: false, error: lastError };
          }
          const appliedAtMs = nowFn();
          lastMutationAtMs = appliedAtMs;
          finalizeBackupAfterEnable(backupPath, appliedAtMs);
        } else if (existingBackup?.entries?.DO_NOT_TRACK && backupPath) {
          finalizeBackupAfterEnable(backupPath, Number(existingBackup.appliedAtMs) || nowFn());
        } else if (!lastMutationAtMs) {
          lastMutationAtMs = nowFn();
        }
        envSynced = true;
        ownedOverrideInSession = true;
        lastEffectiveRestoreEntries = null;
        traceCache.atMs = 0;
        return { ok: true, applied: true };
      } catch (err) {
        lastError = err?.message || String(err);
        envSynced = false;
        return { ok: false, error: lastError };
      }
    }

    if (backupInfo.exists) {
      const restoreRes = restorePrivacyEnvBackup(paths, { runner: syncRunner, platform });
      if (!restoreRes.ok) {
        lastError = restoreRes.error || '还原用户环境变量失败';
        envSynced = false;
        return { ok: false, error: lastError };
      }
      lastEffectiveRestoreEntries = restoreRes.effectiveEntries || null;
      lastMutationAtMs = nowFn();
      traceCache.atMs = 0;
    }
    envSynced = true;
    return { ok: true, applied: false };
  }

  async function applySettingsAsyncImpl(nextCfg = null, { force = false, revision = null } = {}) {
    if (stopping) return { ok: false, error: '守护进程正在停止' };
    if (revision !== null && revision !== applyRevision) {
      return { ok: true, superseded: true };
    }
    const cfg = normalizePrivacyGuardConfig(nextCfg ?? settings?.get?.()?.privacyGuard);
    const backupPath = paths?.privacyEnvBackupPath;
    const backupInfo = inspectPrivacyEnvBackup(backupPath);
    lastError = '';
    externalError = '';

    if (backupInfo.corrupt) {
      lastError = backupInfo.error || '隐私环境变量备份损坏';
      envSynced = false;
      return { ok: false, error: lastError };
    }
    const existingBackup = backupInfo.backup;

    if (cfg.blockTelemetryAndTracing) {
      if (platform !== 'win32') {
        envSynced = true;
        ownedOverrideInSession = true;
        if (force || !lastMutationAtMs) lastMutationAtMs = nowFn();
        traceCache.atMs = 0;
        return { ok: true, applied: true, skipped: true };
      }

      const readKeys = existingBackup?.entries?.DO_NOT_TRACK ? LEGACY_PRIVACY_ENV_KEYS : PRIVACY_ENV_KEYS;
      const currentRead = await readWindowsUserEnvVarsAsync(readKeys, { runnerAsync: asyncRunner, platform });
      if (revision !== null && revision !== applyRevision) {
        return { ok: true, superseded: true };
      }
      if (!currentRead.ok) {
        lastError = currentRead.error || '读取用户环境变量失败';
        envSynced = false;
        return { ok: false, error: lastError };
      }

      try {
        const updates = applyEnableUpdates(currentRead, existingBackup, backupPath);
        if (force && !Object.hasOwn(updates, 'T3CODE_TELEMETRY_ENABLED')) {
          updates.T3CODE_TELEMETRY_ENABLED = TELEMETRY_ENV_OVERRIDES.T3CODE_TELEMETRY_ENABLED;
        }

        if (Object.keys(updates).length > 0) {
          const writeRes = await writeWindowsUserEnvVarsAsync(updates, { runnerAsync: asyncRunner, platform });
          if (revision !== null && revision !== applyRevision) {
            return { ok: true, superseded: true };
          }
          if (!writeRes.ok) {
            lastError = writeRes.error || '写入用户环境变量失败';
            envSynced = false;
            return { ok: false, error: lastError };
          }
          const appliedAtMs = nowFn();
          lastMutationAtMs = appliedAtMs;
          finalizeBackupAfterEnable(backupPath, appliedAtMs);
        } else if (existingBackup?.entries?.DO_NOT_TRACK && backupPath) {
          finalizeBackupAfterEnable(backupPath, Number(existingBackup.appliedAtMs) || nowFn());
        } else if (!lastMutationAtMs) {
          lastMutationAtMs = nowFn();
        }
        envSynced = true;
        ownedOverrideInSession = true;
        lastEffectiveRestoreEntries = null;
        traceCache.atMs = 0;
        return { ok: true, applied: true };
      } catch (err) {
        lastError = err?.message || String(err);
        envSynced = false;
        return { ok: false, error: lastError };
      }
    }

    if (backupInfo.exists) {
      const restoreRes = await restorePrivacyEnvBackupAsync(paths, { runnerAsync: asyncRunner, platform });
      if (restoreRes.ok) {
        // Persist effective post-restore entries BEFORE checking supersession so a follow-up toggle
        // after backup deletion never loses preserved manual user overrides.
        lastEffectiveRestoreEntries = restoreRes.effectiveEntries || null;
        lastMutationAtMs = nowFn();
        traceCache.atMs = 0;
      }
      if (revision !== null && revision !== applyRevision) {
        return { ok: true, superseded: true };
      }
      if (!restoreRes.ok) {
        lastError = restoreRes.error || '还原用户环境变量失败';
        envSynced = false;
        return { ok: false, error: lastError };
      }
    }
    envSynced = true;
    return { ok: true, applied: false };
  }

  function applySettingsAsync(nextCfg = null, options = {}) {
    if (stopping) return Promise.resolve({ ok: false, error: '守护进程正在停止' });
    const rev = ++applyRevision;
    applying = true;
    const task = applyChain.then(() => applySettingsAsyncImpl(nextCfg, { ...options, revision: rev }));
    applyChain = task.catch(err => {
      lastError = err?.message || String(err);
      envSynced = false;
    }).finally(() => {
      if (rev === applyRevision) applying = false;
    });
    return task;
  }

  function stopAndDrain(timeoutMs = 3000) {
    stopping = true;
    return Promise.race([
      applyChain.catch(() => {}),
      new Promise(resolve => {
        const t = setTimeout(resolve, timeoutMs);
        t.unref?.();
      })
    ]);
  }

  function setExternalError(message = '') {
    externalError = String(message || '');
  }

  function getBlockedCdpUrls(overrideCfg = null) {
    return computeBlockedCdpUrls(overrideCfg ?? settings?.get?.()?.privacyGuard);
  }

  function getLaunchEnv(baseEnv = process.env) {
    const cfg = normalizePrivacyGuardConfig(settings?.get?.()?.privacyGuard);
    const backup = readPrivacyEnvBackup(paths?.privacyEnvBackupPath);
    return buildT3LaunchEnv(cfg, {
      baseEnv,
      restoreEntries: backup?.entries || lastEffectiveRestoreEntries,
      ownedOverride: Boolean(backup || ownedOverrideInSession)
    });
  }

  function getStatus({ cdpStatus = null, fresh = false, pendingApply = false } = {}) {
    const now = nowFn();
    const cfg = normalizePrivacyGuardConfig(settings?.get?.()?.privacyGuard);
    const blockedUrls = computeBlockedCdpUrls(cfg);
    const backupInfo = inspectPrivacyEnvBackup(paths?.privacyEnvBackupPath);
    const backup = backupInfo.backup;
    const appliedAtMs = Number(backup?.appliedAtMs) || lastMutationAtMs || 0;
    const serverRt = inspectT3ServerRuntime(paths?.serverRuntimePath);
    const cdpConnected = Boolean(cdpStatus?.connected);
    const t3Running = serverRt.running || cdpConnected;
    const cdpBlockError = String(cdpStatus?.blockedApplyError || '');
    const cdpBlockedTargets = Number(cdpStatus?.blockedTargets) || 0;
    const isApplying = Boolean(applying || pendingApply);

    const effectiveError = lastError || externalError || (backupInfo.corrupt ? backupInfo.error : '') || (blockedUrls.length > 0 ? cdpBlockError : '');

    const restartRequired = Boolean(
      cfg.blockTelemetryAndTracing &&
      envSynced &&
      !isApplying &&
      t3Running &&
      appliedAtMs > 0 &&
      (
        (serverRt.startedAtMs !== null && serverRt.startedAtMs < appliedAtMs) ||
        serverRt.startedAtMs === null
      )
    );

    const traceStale = !traceCache.initialized || (now - traceCache.atMs) > TRACE_CACHE_TTL_MS || traceCache.sinceMs !== appliedAtMs;
    if (fresh || traceStale) {
      refreshTraceSignalsAsync(appliedAtMs);
    }

    const signals = traceCache.data;
    const cdpBlockedActive = Boolean(
      cdpConnected &&
      blockedUrls.length > 0 &&
      cdpBlockedTargets > 0 &&
      !cdpBlockError
    );
    let state = 'off';
    if (isApplying) {
      state = 'applying';
    } else if (effectiveError) {
      state = 'error';
    } else if (cfg.blockTelemetryAndTracing || cfg.blockGoogleFavicons) {
      state = restartRequired ? 'needs-restart' : 'active';
    }

    return {
      state,
      applying: isApplying,
      blockTelemetryAndTracing: cfg.blockTelemetryAndTracing,
      blockGoogleFavicons: cfg.blockGoogleFavicons,
      envSynced: cfg.blockTelemetryAndTracing ? envSynced : !backupInfo.exists,
      hasEnvBackup: Boolean(backupInfo.exists),
      appliedAtMs: appliedAtMs || null,
      t3Running,
      t3ServerStartedAtMs: serverRt.startedAtMs,
      restartRequired,
      cdpConnected,
      cdpBlockedActive,
      cdpBlockedTargets,
      cdpBlockError,
      cdpBlockedUrls: blockedUrls,
      recentTelemetryHits: signals.recentTelemetryHits,
      telemetryHitsSinceApply: signals.telemetryHitsSinceApply,
      lastTelemetryAtMs: signals.lastTelemetryAtMs,
      t3ConnectTunnelDetected: signals.t3ConnectTunnelDetected,
      publishAgentActivityState: signals.publishAgentActivityState,
      lastError: effectiveError
    };
  }

  return {
    applySettings,
    applySettingsAsync,
    stopAndDrain,
    setExternalError,
    refreshTraceSignalsAsync,
    getBlockedCdpUrls,
    getLaunchEnv,
    getStatus
  };
}
