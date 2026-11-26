import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { promises as fsp } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, hostname, platform as osPlatform, arch as osArch } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

export const FOLDER_SYNC_SCHEMA_VERSION = 1;
const REMOTE_IMPORT_STAMP_VERSION = 'v2';
const MAX_SHARD_COMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_SHARD_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_VALID_TS_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
const SHARD_FILE_RE = /^(\d{4}-\d{2})\.ndjson\.gz$/;
const SAFE_MACHINE_DIR_RE = /^[A-Za-z0-9._-]{4,80}$/;
const PENDING_SHARDS_KEY_PREFIX = 'folder_sync_pending:';
const ASYNC_ROW_YIELD_BATCH = 1000;
const MAX_AUTO_EXPORT_FOLLOWUPS = 1;
const inProcessFallbackLocks = new Set();

function yieldToEventLoop() {
  return new Promise(resolveImmediate => setImmediate(resolveImmediate));
}

function sha256Hex(bufOrStr) {
  return createHash('sha256').update(bufOrStr).digest('hex');
}

function monthKeyUtc(tsMs) {
  const n = Number(tsMs);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_VALID_TS_MS) return '1970-01';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '1970-01';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function atomicWriteBuffer(filePath, buf) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, buf);
    renameSync(tempPath, filePath);
  } finally {
    try { unlinkSync(tempPath); } catch {}
  }
}

async function atomicWriteBufferAsync(filePath, buf, { signal, beforeRename = null } = {}) {
  await fsp.mkdir(dirname(filePath), { recursive: true });
  if (signal?.aborted) throw Object.assign(new Error('同步已取消'), { code: 'ABORT_ERR' });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(tempPath, buf, signal ? { signal } : undefined);
    if (signal?.aborted || (typeof beforeRename === 'function' && beforeRename() === false)) {
      throw Object.assign(new Error('同步已取消'), { code: 'ABORT_ERR' });
    }
    await fsp.rename(tempPath, filePath);
  } finally {
    try { await fsp.unlink(tempPath); } catch {}
  }
}

function safeReadJsonWithHash(filePath) {
  if (!filePath || !existsSync(filePath)) return { data: null, rawHash: '' };
  try {
    const rawBuf = readFileSync(filePath);
    const parsed = JSON.parse(rawBuf.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { data: null, rawHash: '' };
    return { data: parsed, rawHash: sha256Hex(rawBuf) };
  } catch {
    return { data: null, rawHash: '' };
  }
}

function safeReadJson(filePath) {
  return safeReadJsonWithHash(filePath).data;
}

async function safeReadJsonWithHashAsync(filePath, { signal } = {}) {
  if (!filePath) return { data: null, rawHash: '' };
  try {
    const rawBuf = await fsp.readFile(filePath, signal ? { signal } : undefined);
    const parsed = JSON.parse(rawBuf.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { data: null, rawHash: '' };
    return { data: parsed, rawHash: sha256Hex(rawBuf) };
  } catch (err) {
    if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') throw err;
    return { data: null, rawHash: '' };
  }
}

async function safeReadJsonAsync(filePath, { signal } = {}) {
  return (await safeReadJsonWithHashAsync(filePath, { signal })).data;
}

async function pathExistsAsync(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function readT3EnvironmentLabel(paths) {
  const candidates = [paths?.serverRuntimePath, paths?.settingsPath].filter(Boolean);
  for (const file of candidates) {
    const data = safeReadJson(file);
    const label = String(data?.environmentLabel || data?.label || data?.environment?.label || '').trim();
    if (label && label.length <= 64) return label;
  }
  return '';
}

function sanitizeMachineId(raw) {
  const cleaned = String(raw || '').trim().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
  return SAFE_MACHINE_DIR_RE.test(cleaned) ? cleaned : '';
}

/**
 * Pure read-only probe for optional local sync folders (OneDrive / Dropbox / iCloud / Syncthing).
 * Never creates folders, never requires any specific cloud drive, and returns [] cleanly if none exist.
 */
export function detectSuggestedSyncDirs({ env = process.env, home = '' } = {}) {
  const userHome = resolve(home || env?.USERPROFILE || homedir());
  const candidates = [
    { provider: 'OneDrive', root: env?.OneDriveCommercial || '' },
    { provider: 'OneDrive', root: env?.OneDriveConsumer || '' },
    { provider: 'OneDrive', root: env?.OneDrive || '' },
    { provider: 'OneDrive', root: join(userHome, 'OneDrive') },
    { provider: 'Dropbox', root: join(userHome, 'Dropbox') },
    { provider: 'iCloud Drive', root: join(userHome, 'iCloudDrive') },
    { provider: 'Syncthing', root: join(userHome, 'Syncthing') }
  ];

  const seen = new Set();
  const results = [];
  for (const item of candidates) {
    if (!item.root) continue;
    const rootResolved = resolve(item.root);
    const key = process.platform === 'win32' ? rootResolved.toLowerCase() : rootResolved;
    if (seen.has(key)) continue;
    try {
      if (!existsSync(rootResolved) || !statSync(rootResolved).isDirectory()) continue;
    } catch {
      continue;
    }
    seen.add(key);
    results.push({
      provider: item.provider,
      rootDir: rootResolved,
      suggestedPath: join(rootResolved, 'T3ToolsSync')
    });
  }
  return results;
}

async function detectSuggestedSyncDirsAsync({ env = process.env, home = '' } = {}) {
  const userHome = resolve(home || env?.USERPROFILE || homedir());
  const candidates = [
    { provider: 'OneDrive', root: env?.OneDriveCommercial || '' },
    { provider: 'OneDrive', root: env?.OneDriveConsumer || '' },
    { provider: 'OneDrive', root: env?.OneDrive || '' },
    { provider: 'OneDrive', root: join(userHome, 'OneDrive') },
    { provider: 'Dropbox', root: join(userHome, 'Dropbox') },
    { provider: 'iCloud Drive', root: join(userHome, 'iCloudDrive') },
    { provider: 'Syncthing', root: join(userHome, 'Syncthing') }
  ];

  const seen = new Set();
  const results = [];
  for (const item of candidates) {
    if (!item.root) continue;
    const rootResolved = resolve(item.root);
    const key = process.platform === 'win32' ? rootResolved.toLowerCase() : rootResolved;
    if (seen.has(key)) continue;
    try {
      const st = await fsp.stat(rootResolved);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    seen.add(key);
    results.push({
      provider: item.provider,
      rootDir: rootResolved,
      suggestedPath: join(rootResolved, 'T3ToolsSync')
    });
  }
  return results;
}

function serializeRequestForExport(r, { includeThreadTitle = true, includeErrorText = false } = {}) {
  return {
    id: r.id,
    dedupeKey: r.dedupeKey || null,
    providerDriver: r.providerDriver,
    accountId: r.accountId,
    t3ThreadId: r.t3ThreadId || null,
    t3ThreadTitle: includeThreadTitle ? (r.t3ThreadTitle || '') : '',
    nativeSessionId: r.nativeSessionId,
    modelId: r.modelId,
    modelRaw: r.modelRaw || r.modelId,
    effort: r.effort || '',
    role: r.role || '',
    timestampMs: r.timestampMs,
    billingTsMs: r.billingTsMs ?? r.timestampMs,
    inputTokens: r.inputTokens || 0,
    cacheReadTokens: r.cacheReadTokens || 0,
    cacheWriteTokens: r.cacheWriteTokens || 0,
    outputTokens: r.outputTokens || 0,
    thinkingTokens: r.thinkingTokens || 0,
    contextUsedTokens: r.contextUsedTokens ?? null,
    contextMaxTokens: r.contextMaxTokens ?? null,
    ttftMs: r.ttftMs ?? null,
    streamingMs: r.streamingMs ?? null,
    durationMs: r.durationMs ?? null,
    tps: r.tps ?? null,
    tpsKind: r.tpsKind || 'none',
    tpsEstimated: Boolean(r.tpsEstimated),
    costUsd: r.costUsd ?? null,
    savedUsd: r.savedUsd ?? null,
    status: r.status || 'success',
    outcomeKnown: r.outcomeKnown !== false,
    retries: r.retries || 0,
    errorCode: r.errorCode || '',
    errorText: includeErrorText ? (r.errorText || '') : '',
    compactionBefore: Boolean(r.compactionBefore)
  };
}

function parseRemoteRequestLine(line, peerMachineId, peerLabel) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const origId = String(obj.id || '').trim();
  const providerDriver = String(obj.providerDriver || '').trim();
  const accountId = String(obj.accountId || '').trim();
  const nativeSessionId = String(obj.nativeSessionId || '').trim();
  const modelId = String(obj.modelId || '').trim();
  const ts = Number(obj.timestampMs);
  if (!origId || !providerDriver || !accountId || !nativeSessionId || !modelId || !Number.isFinite(ts)) {
    return null;
  }
  const billingTs = Number.isFinite(Number(obj.billingTsMs)) ? Number(obj.billingTsMs) : ts;
  return {
    id: `remote:${peerMachineId}:${origId}`,
    dedupeKey: obj.dedupeKey ? `remote:${peerMachineId}:${obj.dedupeKey}` : null,
    machineId: peerMachineId,
    machineLabel: peerLabel,
    isRemote: true,
    providerDriver,
    accountId,
    t3ThreadId: obj.t3ThreadId ? `remote:${peerMachineId}:${obj.t3ThreadId}` : null,
    t3ThreadTitle: typeof obj.t3ThreadTitle === 'string' ? obj.t3ThreadTitle.slice(0, 240) : '',
    nativeSessionId,
    modelId,
    modelRaw: String(obj.modelRaw || modelId),
    effort: typeof obj.effort === 'string' ? obj.effort.slice(0, 40) : '',
    role: typeof obj.role === 'string' ? obj.role.slice(0, 40) : '',
    timestampMs: Math.trunc(ts),
    billingTsMs: Math.trunc(billingTs),
    inputTokens: Math.max(0, Math.trunc(Number(obj.inputTokens) || 0)),
    cacheReadTokens: Math.max(0, Math.trunc(Number(obj.cacheReadTokens) || 0)),
    cacheWriteTokens: Math.max(0, Math.trunc(Number(obj.cacheWriteTokens) || 0)),
    outputTokens: Math.max(0, Math.trunc(Number(obj.outputTokens) || 0)),
    thinkingTokens: Math.max(0, Math.trunc(Number(obj.thinkingTokens) || 0)),
    contextUsedTokens: obj.contextUsedTokens != null && Number.isFinite(Number(obj.contextUsedTokens)) ? Math.max(0, Math.trunc(Number(obj.contextUsedTokens))) : null,
    contextMaxTokens: obj.contextMaxTokens != null && Number.isFinite(Number(obj.contextMaxTokens)) ? Math.max(0, Math.trunc(Number(obj.contextMaxTokens))) : null,
    ttftMs: obj.ttftMs != null && Number.isFinite(Number(obj.ttftMs)) ? Math.max(0, Math.trunc(Number(obj.ttftMs))) : null,
    streamingMs: obj.streamingMs != null && Number.isFinite(Number(obj.streamingMs)) ? Math.max(0, Math.trunc(Number(obj.streamingMs))) : null,
    durationMs: obj.durationMs != null && Number.isFinite(Number(obj.durationMs)) ? Math.max(0, Math.trunc(Number(obj.durationMs))) : null,
    tps: obj.tps != null && Number.isFinite(Number(obj.tps)) ? Number(obj.tps) : null,
    tpsKind: typeof obj.tpsKind === 'string' ? obj.tpsKind.slice(0, 32) : 'none',
    tpsEstimated: Boolean(obj.tpsEstimated),
    costUsd: obj.costUsd != null && Number.isFinite(Number(obj.costUsd)) ? Number(obj.costUsd) : null,
    savedUsd: obj.savedUsd != null && Number.isFinite(Number(obj.savedUsd)) ? Number(obj.savedUsd) : null,
    status: typeof obj.status === 'string' && obj.status ? obj.status.slice(0, 32) : 'success',
    outcomeKnown: obj.outcomeKnown !== false,
    retries: Math.max(0, Math.trunc(Number(obj.retries) || 0)),
    errorCode: typeof obj.errorCode === 'string' ? obj.errorCode.slice(0, 48) : '',
    errorText: typeof obj.errorText === 'string' ? obj.errorText.slice(0, 2000) : '',
    compactionBefore: Boolean(obj.compactionBefore)
  };
}

/**
 * Single-writer-per-machine folder sync engine.
 * - Keeps ~/.t3tools/telemetry.sqlite strictly local (never places SQLite in a cloud drive).
 * - Exports ONLY local rows (is_remote = 0) into <syncDir>/machines/<machineId>/<YYYY-MM>.ndjson.gz.
 * - Imports other machines' shards read-only by SHA-256 stamp diff, writing with remote:<machineId>:* namespace.
 * - Opt-in (disabled by default); works with OneDrive, Dropbox, iCloud, Syncthing, NAS, or any shared folder.
 */
export function createFolderSync({
  paths,
  store,
  settings,
  appVersion = '0.1.0',
  env = process.env,
  hostnameFn = hostname
} = {}) {
  let cachedLocalMachineId = '';
  let lastSyncAtMs = 0;
  let lastExportRev = -1;
  let lastExportSig = '';
  let lastPublishedManifestHash = '';
  let lastExportedRequests = 0;
  let lastState = 'disabled';
  let lastError = '';
  let stopped = false;
  let syncEpoch = 0;
  let syncWriteActive = false;
  let inFlightSync = null;
  let activeAbortController = null;
  let pendingForce = false;
  let pendingForceNow;
  let pendingExportFollowup = false;
  let pendingExportFollowupNow;
  // Month-level export cache so unchanged historical months are never re-read or re-serialized
  const cachedLocalShards = new Map();
  // Tracks compressed-file fingerprint and compressed SHA-256 of shards we last wrote or verified
  const publishedShardMeta = new Map(); // monthKey -> { fp, compressedHash }
  let suggestedDirsCache = [];
  let suggestedDirsUpdatedAtMs = 0;
  let suggestedDirsPromise = null;
  const SUGGESTED_DIRS_CACHE_TTL_MS = 60_000;

  function refreshSuggestedDirsAsync() {
    if (stopped || suggestedDirsPromise) return;
    suggestedDirsPromise = detectSuggestedSyncDirsAsync({ env, home: paths?.home })
      .then(dirs => {
        suggestedDirsCache = dirs;
        suggestedDirsUpdatedAtMs = Date.now();
      })
      .catch(() => {})
      .finally(() => {
        suggestedDirsPromise = null;
      });
  }

  function buildScopeKeySync(machineDir, _syncDir, machineId) {
    // Use native realpath (matches fsp.realpath on Windows: expands 8.3 short paths, resolves junctions/symlinks,
    // AND survives replacing machineDir at the same pathname). Never swallow transient filesystem errors.
    const canonical = typeof realpathSync.native === 'function' ? realpathSync.native(machineDir) : realpathSync(machineDir);
    const norm = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    return `path:${norm}|${machineId}`;
  }

  async function buildScopeKeyAsync(machineDir, _syncDir, machineId) {
    const canonical = await fsp.realpath(machineDir);
    const norm = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    return `path:${norm}|${machineId}`;
  }

  function pendingPrefixForScope(scopeKey) {
    return `${PENDING_SHARDS_KEY_PREFIX}${sha256Hex(scopeKey).slice(0, 24)}:`;
  }

  function withNonBlockingStore(fn) {
    return typeof store.runNonBlockingWrite === 'function' ? store.runNonBlockingWrite(fn) : fn();
  }

  function acquireExportLock(scopeKey) {
    const token = randomUUID();
    if (typeof store.tryAcquireExportLock === 'function' && typeof store.releaseExportLock === 'function') {
      const ok = store.tryAcquireExportLock(scopeKey, token);
      if (!ok) {
        throw new Error('另一进程正在导出同步分片，已跳过本次写入');
      }
      return () => {
        try {
          store.releaseExportLock(scopeKey, token);
        } catch (err) {
          // File operations have settled in finally(); allow any replacement handle in this process to reclaim
          store.markExportLockSettled?.(scopeKey, token);
          throw err;
        }
      };
    }
    if (inProcessFallbackLocks.has(scopeKey)) {
      throw new Error('另一进程正在导出同步分片，已跳过本次写入');
    }
    inProcessFallbackLocks.add(scopeKey);
    return () => {
      inProcessFallbackLocks.delete(scopeKey);
    };
  }

  function isStoreAvailable() {
    return !stopped && !(typeof store.isClosed === 'function' && store.isClosed());
  }

  function getLocalMachineId({ nonBlocking = false, createIfMissing = true } = {}) {
    if (cachedLocalMachineId) return cachedLocalMachineId;
    const saved = sanitizeMachineId(store.getMeta?.('local_machine_id'));
    if (saved) {
      cachedLocalMachineId = saved;
      return saved;
    }
    if (!createIfMissing) return '';
    const generated = `m-${randomUUID()}`;
    if (nonBlocking) {
      withNonBlockingStore(() => store.setMeta?.('local_machine_id', generated));
    } else {
      store.setMeta?.('local_machine_id', generated);
    }
    cachedLocalMachineId = generated;
    return generated;
  }

  function getDefaultMachineLabel() {
    return readT3EnvironmentLabel(paths) || String(hostnameFn?.() || '').trim() || '本机';
  }

  function getLocalMachineLabel(cfg = null) {
    const syncCfg = cfg || settings.get()?.multiMachineSync || {};
    const custom = String(syncCfg.machineLabel || '').trim();
    return custom || getDefaultMachineLabel();
  }

  function computePrivacySig(syncCfg, machineLabel = null) {
    const cfg = syncCfg || settings.get()?.multiMachineSync || {};
    const label = machineLabel ?? getLocalMachineLabel(cfg);
    return `${String(cfg.syncDir || '').trim()}|${label}|${cfg.includeThreadTitle !== false}|${Boolean(cfg.includeErrorText)}`;
  }

  function isPassStale(myEpoch, expectedPrivacySig = null) {
    if (!isStoreAvailable() || myEpoch !== syncEpoch) return true;
    const curCfg = settings.get()?.multiMachineSync || {};
    if (!curCfg.enabled || !String(curCfg.syncDir || '').trim()) return true;
    if (expectedPrivacySig !== null && computePrivacySig(curCfg) !== expectedPrivacySig) return true;
    return false;
  }

  // Durable per-(scope, month) write-ahead tracking in store_meta so independent syncDirs
  // never overwrite each other's journal and SQLite errors abort shard publication cleanly.
  function getPendingShardsForScope(scopeKey) {
    if (!isStoreAvailable()) {
      throw new Error('本地索引库不可用，已中止分片发布');
    }
    const prefix = pendingPrefixForScope(scopeKey);
    if (typeof store.listMetaByPrefix === 'function') {
      const out = new Set();
      for (const entry of store.listMetaByPrefix(prefix)) {
        const mKey = String(entry.key || '').slice(prefix.length);
        if (mKey) out.add(mKey);
      }
      return out;
    }
    return new Set();
  }

  function recordPendingShard(scopeKey, monthKey, { nonBlocking = false } = {}) {
    if (!isStoreAvailable()) {
      throw new Error('本地索引库不可用，无法记录分片发布状态');
    }
    if (typeof store.setMeta !== 'function') return;
    const write = () => store.setMeta(`${pendingPrefixForScope(scopeKey)}${monthKey}`, '1');
    if (nonBlocking) withNonBlockingStore(write);
    else write();
  }

  function commitPendingShards(scopeKey, remainingMonths = null, { nonBlocking = false } = {}) {
    if (!isStoreAvailable()) {
      throw new Error('本地索引库不可用，无法提交分片发布状态');
    }
    const prefix = pendingPrefixForScope(scopeKey);
    const keep = remainingMonths instanceof Set ? remainingMonths : new Set();
    const apply = () => {
      if (keep.size === 0 && typeof store.deleteMetaByPrefix === 'function') {
        store.deleteMetaByPrefix(prefix);
        return;
      }
      if (typeof store.listMetaByPrefix === 'function' && typeof store.deleteMeta === 'function') {
        for (const entry of store.listMetaByPrefix(prefix)) {
          const mKey = String(entry.key || '').slice(prefix.length);
          if (!keep.has(mKey)) store.deleteMeta(entry.key);
        }
        for (const mKey of keep) {
          store.setMeta?.(`${prefix}${mKey}`, '1');
        }
      }
    };
    if (nonBlocking) withNonBlockingStore(apply);
    else apply();
  }

  function buildMonthExportPayloadSync(rawRows, syncCfg) {
    const rows = rawRows.map(r => serializeRequestForExport(r, {
      includeThreadTitle: syncCfg.includeThreadTitle !== false,
      includeErrorText: Boolean(syncCfg.includeErrorText)
    }));
    rows.sort((a, b) => (a.timestampMs - b.timestampMs) || String(a.id).localeCompare(String(b.id)));
    const ndjson = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
    const contentHash = sha256Hex(ndjson);
    return { rowsCount: rows.length, ndjson, contentHash };
  }

  async function buildMonthExportPayloadAsync(rawRows, syncCfg, myEpoch, expectedPrivacySig) {
    const rows = [];
    for (let i = 0; i < rawRows.length; i++) {
      if (i > 0 && i % ASYNC_ROW_YIELD_BATCH === 0) {
        await yieldToEventLoop();
        if (isPassStale(myEpoch, expectedPrivacySig)) return null;
      }
      rows.push(serializeRequestForExport(rawRows[i], {
        includeThreadTitle: syncCfg.includeThreadTitle !== false,
        includeErrorText: Boolean(syncCfg.includeErrorText)
      }));
    }
    rows.sort((a, b) => (a.timestampMs - b.timestampMs) || String(a.id).localeCompare(String(b.id)));
    const lines = [];
    for (let i = 0; i < rows.length; i++) {
      if (i > 0 && i % ASYNC_ROW_YIELD_BATCH === 0) {
        await yieldToEventLoop();
        if (isPassStale(myEpoch, expectedPrivacySig)) return null;
      }
      lines.push(JSON.stringify(rows[i]));
    }
    const ndjson = lines.join('\n') + '\n';
    const contentHash = sha256Hex(ndjson);
    return { rowsCount: rows.length, ndjson, contentHash };
  }

  function buildLegacyMonthBuckets(localRows, syncCfg) {
    const byMonth = new Map();
    for (const r of localRows) {
      const mKey = monthKeyUtc(r.billingTsMs ?? r.timestampMs);
      let list = byMonth.get(mKey);
      if (!list) {
        list = [];
        byMonth.set(mKey, list);
      }
      list.push(serializeRequestForExport(r, {
        includeThreadTitle: syncCfg.includeThreadTitle !== false,
        includeErrorText: Boolean(syncCfg.includeErrorText)
      }));
    }
    return byMonth;
  }

  function takeAtomicDirtySnapshot() {
    if (typeof store.takeDirtyLocalMonthsSnapshot === 'function') {
      return store.takeDirtyLocalMonthsSnapshot();
    }
    const rev = typeof store.getLocalRevision === 'function' ? store.getLocalRevision() : store.getRevision();
    const dirtyMonths = typeof store.takeDirtyLocalMonths === 'function' ? store.takeDirtyLocalMonths() : null;
    return { rev, dirtyMonths };
  }

  function isNonNegSafeInt(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
  }

  function isManifestEquivalent(existingManifest, manifestPayload) {
    if (!existingManifest || typeof existingManifest !== 'object' || Array.isArray(existingManifest)) return false;
    if (existingManifest.schemaVersion !== manifestPayload.schemaVersion) return false;
    if (existingManifest.machineId !== manifestPayload.machineId) return false;
    if (existingManifest.machineLabel !== manifestPayload.machineLabel) return false;
    if (existingManifest.totalRequests !== manifestPayload.totalRequests) return false;
    const prevShards = existingManifest.shards;
    const nextShards = manifestPayload.shards;
    if (!prevShards || typeof prevShards !== 'object' || Array.isArray(prevShards)) return false;
    const prevKeys = Object.keys(prevShards);
    const nextKeys = Object.keys(nextShards);
    if (prevKeys.length !== nextKeys.length) return false;
    for (const mKey of nextKeys) {
      const prevMeta = prevShards[mKey];
      const nextMeta = nextShards[mKey];
      if (!prevMeta || typeof prevMeta !== 'object' || Array.isArray(prevMeta)) return false;
      if (prevMeta.file !== nextMeta.file) return false;
      if (prevMeta.sha256 !== nextMeta.sha256) return false;
      if (prevMeta.count !== nextMeta.count) return false;
      if (prevMeta.bytes !== nextMeta.bytes) return false;
    }
    return true;
  }

  function shardStatFingerprint(st) {
    return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
  }

  function readAndStatFileSync(filePath, maxBytes = MAX_SHARD_COMPRESSED_BYTES) {
    const fd = openSync(filePath, 'r');
    try {
      const st = fstatSync(fd, { bigint: true });
      const size = Number(st.size);
      if (size > maxBytes) return { tooLarge: true, size };
      const chunks = [];
      let total = 0;
      const chunkSize = Math.min(Math.max(size || 4096, 4096), 256 * 1024);
      const buf = Buffer.allocUnsafe(chunkSize);
      while (true) {
        const remainingLimit = maxBytes - total + 1;
        const toRead = Math.min(buf.length, remainingLimit);
        const n = readSync(fd, buf, 0, toRead, null);
        if (n <= 0) break;
        total += n;
        if (total > maxBytes) return { tooLarge: true, size: total };
        chunks.push(Buffer.from(buf.subarray(0, n)));
      }
      const rawBuf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total);
      return { tooLarge: false, st, size: total, fp: shardStatFingerprint(st), rawBuf };
    } finally {
      try { closeSync(fd); } catch {}
    }
  }

  async function readAndStatFileAsync(filePath, { signal, maxBytes = MAX_SHARD_COMPRESSED_BYTES } = {}) {
    const fh = await fsp.open(filePath, 'r');
    try {
      const st = await fh.stat({ bigint: true });
      const size = Number(st.size);
      if (size > maxBytes) return { tooLarge: true, size };
      const chunks = [];
      let total = 0;
      const chunkSize = Math.min(Math.max(size || 4096, 4096), 256 * 1024);
      const buf = Buffer.allocUnsafe(chunkSize);
      while (true) {
        if (signal?.aborted) throw Object.assign(new Error('同步已取消'), { code: 'ABORT_ERR' });
        const remainingLimit = maxBytes - total + 1;
        const toRead = Math.min(buf.length, remainingLimit);
        const { bytesRead } = await fh.read(buf, 0, toRead, null);
        if (bytesRead <= 0) break;
        total += bytesRead;
        if (total > maxBytes) return { tooLarge: true, size: total };
        chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
      }
      const rawBuf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total);
      return { tooLarge: false, st, size: total, fp: shardStatFingerprint(st), rawBuf };
    } finally {
      try { await fh.close(); } catch {}
    }
  }

  function verifyShardFileMatchesHashSync(shardPath, expectedHash) {
    try {
      const snap = readAndStatFileSync(shardPath);
      if (!snap || snap.tooLarge) return null;
      const ndjsonBuf = zlib.gunzipSync(snap.rawBuf, { maxOutputLength: MAX_SHARD_UNCOMPRESSED_BYTES });
      if (sha256Hex(ndjsonBuf.toString('utf8')) !== expectedHash) return null;
      return { size: snap.size, fp: snap.fp, compressedHash: sha256Hex(snap.rawBuf), contentHash: expectedHash };
    } catch {
      return null;
    }
  }

  async function verifyShardFileMatchesHashAsync(shardPath, expectedHash, { signal } = {}) {
    try {
      const snap = await readAndStatFileAsync(shardPath, { signal });
      if (!snap || snap.tooLarge) return null;
      const ndjsonBuf = await gunzipAsync(snap.rawBuf, { maxOutputLength: MAX_SHARD_UNCOMPRESSED_BYTES });
      if (sha256Hex(ndjsonBuf.toString('utf8')) !== expectedHash) return null;
      return { size: snap.size, fp: snap.fp, compressedHash: sha256Hex(snap.rawBuf), contentHash: expectedHash };
    } catch (err) {
      if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') throw err;
      return null;
    }
  }

  function recordPublishedShardIfUnchangedSync(mKey, shardPath, expectedCompressedHash, contentHash) {
    try {
      const snap = readAndStatFileSync(shardPath);
      if (snap && !snap.tooLarge && sha256Hex(snap.rawBuf) === expectedCompressedHash) {
        publishedShardMeta.set(mKey, { fp: snap.fp, compressedHash: expectedCompressedHash, contentHash });
        return;
      }
    } catch {}
    publishedShardMeta.delete(mKey);
  }

  async function recordPublishedShardIfUnchangedAsync(mKey, shardPath, expectedCompressedHash, contentHash, { signal } = {}) {
    try {
      const snap = await readAndStatFileAsync(shardPath, { signal });
      if (snap && !snap.tooLarge && sha256Hex(snap.rawBuf) === expectedCompressedHash) {
        publishedShardMeta.set(mKey, { fp: snap.fp, compressedHash: expectedCompressedHash, contentHash });
        return;
      }
    } catch (err) {
      if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') throw err;
    }
    publishedShardMeta.delete(mKey);
  }

  function compressShardCheckedSync(ndjson, fileName) {
    const rawBuf = Buffer.from(ndjson, 'utf8');
    if (rawBuf.length > MAX_SHARD_UNCOMPRESSED_BYTES) {
      throw new Error(`分片原始体积超过上限: ${fileName}`);
    }
    let gz = zlib.gzipSync(rawBuf, { level: 6 });
    if (gz.length > MAX_SHARD_COMPRESSED_BYTES) {
      gz = zlib.gzipSync(rawBuf, { level: 9 });
    }
    if (gz.length > MAX_SHARD_COMPRESSED_BYTES) {
      throw new Error(`分片压缩体积超过上限: ${fileName}`);
    }
    return gz;
  }

  async function compressShardCheckedAsync(ndjson, fileName) {
    const rawBuf = Buffer.from(ndjson, 'utf8');
    if (rawBuf.length > MAX_SHARD_UNCOMPRESSED_BYTES) {
      throw new Error(`分片原始体积超过上限: ${fileName}`);
    }
    let gz = await gzipAsync(rawBuf, { level: 6 });
    if (gz.length > MAX_SHARD_COMPRESSED_BYTES) {
      gz = await gzipAsync(rawBuf, { level: 9 });
    }
    if (gz.length > MAX_SHARD_COMPRESSED_BYTES) {
      throw new Error(`分片压缩体积超过上限: ${fileName}`);
    }
    return gz;
  }

  function isExistingShardIntactSync(mKey, shardPath, expectedBytes, expectedUncompressedHash, { verifyBytes = false } = {}) {
    let st = null;
    try { st = statSync(shardPath, { bigint: true }); } catch { return null; }
    const size = Number(st.size);
    if (size > MAX_SHARD_COMPRESSED_BYTES) return null;
    const fp = shardStatFingerprint(st);
    const tracked = publishedShardMeta.get(mKey);
    if (tracked && tracked.contentHash === expectedUncompressedHash && size === expectedBytes && tracked.fp === fp) {
      if (!verifyBytes) return { size, fp, compressedHash: tracked.compressedHash };
      try {
        const snap = readAndStatFileSync(shardPath);
        if (snap && !snap.tooLarge && snap.fp === tracked.fp && sha256Hex(snap.rawBuf) === tracked.compressedHash) {
          return { size: snap.size, fp: snap.fp, compressedHash: tracked.compressedHash };
        }
      } catch {
        return null;
      }
    }
    const verified = verifyShardFileMatchesHashSync(shardPath, expectedUncompressedHash);
    if (verified) {
      publishedShardMeta.set(mKey, { fp: verified.fp, compressedHash: verified.compressedHash, contentHash: verified.contentHash });
    }
    return verified;
  }

  async function isExistingShardIntactAsync(mKey, shardPath, expectedBytes, expectedUncompressedHash, { signal, verifyBytes = false } = {}) {
    let st = null;
    try { st = await fsp.stat(shardPath, { bigint: true }); } catch { return null; }
    const size = Number(st.size);
    if (size > MAX_SHARD_COMPRESSED_BYTES) return null;
    const fp = shardStatFingerprint(st);
    const tracked = publishedShardMeta.get(mKey);
    if (tracked && tracked.contentHash === expectedUncompressedHash && size === expectedBytes && tracked.fp === fp) {
      if (!verifyBytes) return { size, fp, compressedHash: tracked.compressedHash };
      try {
        const snap = await readAndStatFileAsync(shardPath, { signal });
        if (snap && !snap.tooLarge && snap.fp === tracked.fp && sha256Hex(snap.rawBuf) === tracked.compressedHash) {
          return { size: snap.size, fp: snap.fp, compressedHash: tracked.compressedHash };
        }
      } catch (err) {
        if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') throw err;
        return null;
      }
    }
    const verified = await verifyShardFileMatchesHashAsync(shardPath, expectedUncompressedHash, { signal });
    if (verified) {
      publishedShardMeta.set(mKey, { fp: verified.fp, compressedHash: verified.compressedHash, contentHash: verified.contentHash });
    }
    return verified;
  }

  function allPublishedShardsIntactSync(machineDir, shards, { verifyBytes = false } = {}) {
    if (!shards || typeof shards !== 'object' || Array.isArray(shards)) return false;
    for (const [mKey, meta] of Object.entries(shards)) {
      if (!meta || typeof meta !== 'object' || !meta.file || !meta.sha256 || !isNonNegSafeInt(meta.bytes)) return false;
      if (meta.bytes > MAX_SHARD_COMPRESSED_BYTES) return false;
      const shardPath = join(machineDir, meta.file);
      const tracked = publishedShardMeta.get(mKey);
      if (!tracked || tracked.contentHash !== meta.sha256) return false;
      if (verifyBytes) {
        try {
          const snap = readAndStatFileSync(shardPath);
          if (!snap || snap.tooLarge || snap.size !== meta.bytes || snap.fp !== tracked.fp || sha256Hex(snap.rawBuf) !== tracked.compressedHash) {
            return false;
          }
        } catch {
          return false;
        }
      } else {
        let st = null;
        try { st = statSync(shardPath, { bigint: true }); } catch { return false; }
        const size = Number(st.size);
        if (size !== meta.bytes || size > MAX_SHARD_COMPRESSED_BYTES || tracked.fp !== shardStatFingerprint(st)) return false;
      }
    }
    return true;
  }

  async function allPublishedShardsIntactAsync(machineDir, shards, { signal, verifyBytes = false } = {}) {
    if (!shards || typeof shards !== 'object' || Array.isArray(shards)) return false;
    for (const [mKey, meta] of Object.entries(shards)) {
      if (!meta || typeof meta !== 'object' || !meta.file || !meta.sha256 || !isNonNegSafeInt(meta.bytes)) return false;
      if (meta.bytes > MAX_SHARD_COMPRESSED_BYTES) return false;
      const shardPath = join(machineDir, meta.file);
      const tracked = publishedShardMeta.get(mKey);
      if (!tracked || tracked.contentHash !== meta.sha256) return false;
      if (verifyBytes) {
        try {
          const snap = await readAndStatFileAsync(shardPath, { signal });
          if (!snap || snap.tooLarge || snap.size !== meta.bytes || snap.fp !== tracked.fp || sha256Hex(snap.rawBuf) !== tracked.compressedHash) {
            return false;
          }
        } catch (err) {
          if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') throw err;
          return false;
        }
      } else {
        let st = null;
        try { st = await fsp.stat(shardPath, { bigint: true }); } catch { return false; }
        const size = Number(st.size);
        if (size !== meta.bytes || size > MAX_SHARD_COMPRESSED_BYTES || tracked.fp !== shardStatFingerprint(st)) return false;
      }
    }
    return true;
  }

  function exportLocalMachine(machinesRoot, syncCfg, now, { force = false } = {}) {
    const machineId = getLocalMachineId();
    const machineLabel = getLocalMachineLabel(syncCfg);
    const machineDir = join(machinesRoot, machineId);
    const manifestPath = join(machineDir, 'manifest.json');
    const privacySig = computePrivacySig(syncCfg, machineLabel);

    mkdirSync(machineDir, { recursive: true });
    const scopeKey = buildScopeKeySync(machineDir, syncCfg.syncDir, machineId);
    const releaseLock = acquireExportLock(scopeKey);
    try {
      // Read pending journal, manifest, and revision strictly inside the export lock
      const pendingUncommitted = getPendingShardsForScope(scopeKey);
      const revCheck = typeof store.getLocalRevision === 'function' ? store.getLocalRevision() : store.getRevision();
      const { data: existingManifest, rawHash: existingManifestHash } = safeReadJsonWithHash(manifestPath);
      const manifestMatchesLastCommit = Boolean(existingManifest) &&
        lastPublishedManifestHash !== '' &&
        existingManifestHash === lastPublishedManifestHash;
      if (manifestMatchesLastCommit &&
          pendingUncommitted.size === 0 &&
          lastExportRev === revCheck &&
          lastExportSig === privacySig &&
          allPublishedShardsIntactSync(machineDir, existingManifest.shards, { verifyBytes: force })) {
        return { exported: false, totalRequests: lastExportedRequests, writtenShards: 0 };
      }

      const prevShards = existingManifest?.shards && typeof existingManifest.shards === 'object' ? existingManifest.shards : {};
      const nextShards = {};
      let writtenShards = 0;
      let totalRequests = 0;

      const canIncremental = typeof store.listLocalMonthCounts === 'function' &&
        typeof store.listLocalRequestsByMonth === 'function';

      let exportRev = revCheck;
      if (canIncremental) {
        const snap = takeAtomicDirtySnapshot();
        exportRev = snap.rev;
        const dirtyMonths = snap.dirtyMonths;
        try {
          const useCache = cachedLocalShards.size > 0 && lastExportSig === privacySig && manifestMatchesLastCommit && dirtyMonths !== null;
          if (!useCache) cachedLocalShards.clear();

          const monthCounts = store.listLocalMonthCounts();
          const activeMonths = new Set();
          const pendingWrites = [];

          for (const { monthKey: mKey, count } of monthCounts) {
            if (count <= 0) continue;
            activeMonths.add(mKey);
            totalRequests += count;
            const fileName = `${mKey}.ndjson.gz`;
            const shardPath = join(machineDir, fileName);
            const cached = useCache ? cachedLocalShards.get(mKey) : null;
            const prev = prevShards[mKey];
            const forceRewrite = pendingUncommitted.has(mKey);

            if (!forceRewrite &&
                cached &&
                !dirtyMonths.has(mKey) &&
                cached.count === count &&
                prev && prev.sha256 === cached.sha256) {
              const intact = isExistingShardIntactSync(mKey, shardPath, cached.bytes, cached.sha256, { verifyBytes: force });
              if (intact) {
                const freshMeta = cached.bytes === intact.size ? cached : { ...cached, bytes: intact.size };
                nextShards[mKey] = freshMeta;
                cachedLocalShards.set(mKey, freshMeta);
                continue;
              }
            }

            const monthRows = store.listLocalRequestsByMonth(mKey);
            if (!monthRows.length) continue;
            const { rowsCount, ndjson, contentHash } = buildMonthExportPayloadSync(monthRows, syncCfg);
            let compressedBytes = 0;
            const reused = (!forceRewrite && prev && prev.sha256 === contentHash)
              ? isExistingShardIntactSync(mKey, shardPath, prev.bytes, contentHash, { verifyBytes: force })
              : null;
            if (!reused) {
              // Compress and enforce size limits across ALL changed months BEFORE replacing any published shard
              const gz = compressShardCheckedSync(ndjson, fileName);
              compressedBytes = gz.length;
              pendingWrites.push({ mKey, shardPath, gz, contentHash });
            } else {
              compressedBytes = reused.size;
            }
            const shardMeta = {
              file: fileName,
              sha256: contentHash,
              count: rowsCount,
              bytes: compressedBytes
            };
            nextShards[mKey] = shardMeta;
          }

          for (const item of pendingWrites) {
            recordPendingShard(scopeKey, item.mKey);
            atomicWriteBuffer(item.shardPath, item.gz);
            recordPublishedShardIfUnchangedSync(item.mKey, item.shardPath, sha256Hex(item.gz), item.contentHash);
            writtenShards++;
          }
          for (const [mKey, shardMeta] of Object.entries(nextShards)) {
            cachedLocalShards.set(mKey, shardMeta);
          }

          for (const key of [...cachedLocalShards.keys()]) {
            if (!activeMonths.has(key)) cachedLocalShards.delete(key);
          }
        } catch (err) {
          store.markLocalMonthsDirty?.(dirtyMonths);
          throw err;
        }
      } else {
        const localRows = store.listLocalRequests();
        totalRequests = localRows.length;
        const byMonth = buildLegacyMonthBuckets(localRows, syncCfg);
        const pendingWrites = [];
        for (const [mKey, rows] of [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
          rows.sort((a, b) => (a.timestampMs - b.timestampMs) || String(a.id).localeCompare(String(b.id)));
          const ndjson = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
          const contentHash = sha256Hex(ndjson);
          const fileName = `${mKey}.ndjson.gz`;
          const shardPath = join(machineDir, fileName);
          const prev = prevShards[mKey];
          const forceRewrite = pendingUncommitted.has(mKey);

          let compressedBytes = 0;
          const reused = (!forceRewrite && prev && prev.sha256 === contentHash)
            ? isExistingShardIntactSync(mKey, shardPath, prev.bytes, contentHash, { verifyBytes: force })
            : null;
          if (!reused) {
            const gz = compressShardCheckedSync(ndjson, fileName);
            compressedBytes = gz.length;
            pendingWrites.push({ mKey, shardPath, gz, contentHash });
          } else {
            compressedBytes = reused.size;
          }
          nextShards[mKey] = {
            file: fileName,
            sha256: contentHash,
            count: rows.length,
            bytes: compressedBytes
          };
        }
        for (const item of pendingWrites) {
          recordPendingShard(scopeKey, item.mKey);
          atomicWriteBuffer(item.shardPath, item.gz);
          recordPublishedShardIfUnchangedSync(item.mKey, item.shardPath, sha256Hex(item.gz), item.contentHash);
          writtenShards++;
        }
      }

      // Remove obsolete local shard files; keep any failed deletion tracked as pending
      const failedCleanupMonths = new Set();
      let cleanupError = null;
      for (const name of readdirSync(machineDir)) {
        const m = name.match(SHARD_FILE_RE);
        if (m && !nextShards[m[1]]) {
          try {
            unlinkSync(join(machineDir, name));
          } catch (err) {
            if (err?.code !== 'ENOENT') {
              failedCleanupMonths.add(m[1]);
              recordPendingShard(scopeKey, m[1]);
              if (!cleanupError) cleanupError = err;
            }
          }
        }
      }

      // Always derive manifest totalRequests from the shards actually published
      totalRequests = Object.values(nextShards).reduce((sum, s) => sum + (Number(s?.count) || 0), 0);

      const manifestPayload = {
        schemaVersion: FOLDER_SYNC_SCHEMA_VERSION,
        machineId,
        machineLabel,
        platform: `${osPlatform()}-${osArch()}`,
        appVersion,
        exportedAtMs: now,
        totalRequests,
        shards: nextShards
      };
      const manifestChanged = writtenShards > 0 ||
        pendingUncommitted.size > 0 ||
        !isManifestEquivalent(existingManifest, manifestPayload);

      let publishedManifestHash = existingManifestHash;
      if (manifestChanged) {
        const manifestBuf = Buffer.from(JSON.stringify(manifestPayload, null, 2) + '\n', 'utf8');
        atomicWriteBuffer(manifestPath, manifestBuf);
        publishedManifestHash = sha256Hex(manifestBuf);
      }
      commitPendingShards(scopeKey, failedCleanupMonths);
      if (cleanupError) {
        throw cleanupError;
      }

      const afterRev = typeof store.getLocalRevision === 'function' ? store.getLocalRevision() : store.getRevision();
      if (afterRev === exportRev) {
        lastExportRev = exportRev;
        lastExportSig = privacySig;
        lastPublishedManifestHash = publishedManifestHash;
      } else {
        lastExportRev = -1;
        lastPublishedManifestHash = '';
      }
      lastExportedRequests = totalRequests;
      return { exported: manifestChanged, totalRequests, writtenShards };
    } finally {
      releaseLock();
    }
  }

  async function exportLocalMachineAsync(machinesRoot, syncCfg, now, { myEpoch, signal, force = false }) {
    const machineLabel = getLocalMachineLabel(syncCfg);
    const privacySig = computePrivacySig(syncCfg, machineLabel);
    if (isPassStale(myEpoch, privacySig)) {
      return { exported: false, totalRequests: lastExportedRequests, writtenShards: 0, stale: true };
    }
    const machineId = getLocalMachineId({ nonBlocking: true });
    const machineDir = join(machinesRoot, machineId);
    const manifestPath = join(machineDir, 'manifest.json');

    await fsp.mkdir(machineDir, { recursive: true });
    if (isPassStale(myEpoch, privacySig)) {
      return { exported: false, totalRequests: lastExportedRequests, writtenShards: 0, stale: true };
    }
    const scopeKey = await buildScopeKeyAsync(machineDir, syncCfg.syncDir, machineId);
    if (isPassStale(myEpoch, privacySig)) {
      return { exported: false, totalRequests: lastExportedRequests, writtenShards: 0, stale: true };
    }
    const releaseLock = acquireExportLock(scopeKey);
    try {
      if (isPassStale(myEpoch, privacySig)) {
        return { exported: false, totalRequests: lastExportedRequests, writtenShards: 0, stale: true };
      }

      // Read pending journal, manifest, and revision strictly inside the export lock
      const { data: existingManifest, rawHash: existingManifestHash } = await safeReadJsonWithHashAsync(manifestPath, { signal });
      if (isPassStale(myEpoch, privacySig)) {
        return { exported: false, totalRequests: lastExportedRequests, writtenShards: 0, stale: true };
      }
      const pendingUncommitted = getPendingShardsForScope(scopeKey);
      const revBeforeCheck = typeof store.getLocalRevision === 'function' ? store.getLocalRevision() : store.getRevision();
      const manifestMatchesLastCommit = Boolean(existingManifest) &&
        lastPublishedManifestHash !== '' &&
        existingManifestHash === lastPublishedManifestHash;
      if (manifestMatchesLastCommit &&
          pendingUncommitted.size === 0 &&
          lastExportRev === revBeforeCheck &&
          lastExportSig === privacySig &&
          await allPublishedShardsIntactAsync(machineDir, existingManifest.shards, { signal, verifyBytes: force })) {
        if (isPassStale(myEpoch, privacySig)) {
          return { exported: false, totalRequests: lastExportedRequests, writtenShards: 0, stale: true };
        }
        // Recheck local revision after awaiting disk stat so edits landed during the check are never missed
        const revAfterStat = typeof store.getLocalRevision === 'function' ? store.getLocalRevision() : store.getRevision();
        if (revAfterStat === revBeforeCheck) {
          return { exported: false, totalRequests: lastExportedRequests, writtenShards: 0, stale: false };
        }
      }

      const prevShards = existingManifest?.shards && typeof existingManifest.shards === 'object' ? existingManifest.shards : {};
      const nextShards = {};
      let writtenShards = 0;
      let totalRequests = 0;

      const canIncremental = typeof store.listLocalMonthCounts === 'function' &&
        typeof store.listLocalRequestsByMonth === 'function';

      let exportRev = revBeforeCheck;
      if (canIncremental) {
        // Single atomic observation of both localRevision and dirtyMonths after async directory prep
        const snap = takeAtomicDirtySnapshot();
        exportRev = snap.rev;
        const dirtyMonths = snap.dirtyMonths;
        try {
          const useCache = cachedLocalShards.size > 0 && lastExportSig === privacySig && manifestMatchesLastCommit && dirtyMonths !== null;
          if (!useCache) cachedLocalShards.clear();

          const monthCounts = store.listLocalMonthCounts();
          const activeMonths = new Set();
          const pendingWrites = [];

          for (const { monthKey: mKey, count } of monthCounts) {
            if (isPassStale(myEpoch, privacySig)) {
              store.markLocalMonthsDirty?.(dirtyMonths);
              return { exported: false, totalRequests: lastExportedRequests, writtenShards, stale: true };
            }
            if (count <= 0) continue;
            activeMonths.add(mKey);
            totalRequests += count;
            const fileName = `${mKey}.ndjson.gz`;
            const shardPath = join(machineDir, fileName);
            const cached = useCache ? cachedLocalShards.get(mKey) : null;
            const prev = prevShards[mKey];
            const forceRewrite = pendingUncommitted.has(mKey);

            if (!forceRewrite &&
                cached &&
                !dirtyMonths.has(mKey) &&
                cached.count === count &&
                prev && prev.sha256 === cached.sha256) {
              const intact = await isExistingShardIntactAsync(mKey, shardPath, cached.bytes, cached.sha256, { signal, verifyBytes: force });
              if (isPassStale(myEpoch, privacySig)) {
                store.markLocalMonthsDirty?.(dirtyMonths);
                return { exported: false, totalRequests: lastExportedRequests, writtenShards, stale: true };
              }
              if (intact) {
                const freshMeta = cached.bytes === intact.size ? cached : { ...cached, bytes: intact.size };
                nextShards[mKey] = freshMeta;
                cachedLocalShards.set(mKey, freshMeta);
                continue;
              }
            }

            if (isPassStale(myEpoch, privacySig)) {
              store.markLocalMonthsDirty?.(dirtyMonths);
              return { exported: false, totalRequests: lastExportedRequests, writtenShards, stale: true };
            }
            const monthRows = store.listLocalRequestsByMonth(mKey);
            if (!monthRows.length) continue;
            const payload = await buildMonthExportPayloadAsync(monthRows, syncCfg, myEpoch, privacySig);
            if (!payload) {
              store.markLocalMonthsDirty?.(dirtyMonths);
              return { exported: false, totalRequests: lastExportedRequests, writtenShards, stale: true };
            }
            const { rowsCount, ndjson, contentHash } = payload;
            let compressedBytes = 0;
            const reused = (!forceRewrite && prev && prev.sha256 === contentHash)
              ? await isExistingShardIntactAsync(mKey, shardPath, prev.bytes, contentHash, { signal, verifyBytes: force })
              : null;
            if (isPassStale(myEpoch, privacySig)) {
              store.markLocalMonthsDirty?.(dirtyMonths);
              return { exported: false, totalRequests: lastExportedRequests, writtenShards, stale: true };
            }
            if (!reused) {
              // Compress and enforce size limits across ALL changed months BEFORE replacing any published shard
              const gz = await compressShardCheckedAsync(ndjson, fileName);
              if (isPassStale(myEpoch, privacySig)) {
                store.markLocalMonthsDirty?.(dirtyMonths);
                return { exported: false, totalRequests: lastExportedRequests, writtenShards, stale: true };
              }
              compressedBytes = gz.length;
              pendingWrites.push({ mKey, shardPath, gz, contentHash });
            } else {
              compressedBytes = reused.size;
            }
            const shardMeta = {
              file: fileName,
              sha256: contentHash,
              count: rowsCount,
              bytes: compressedBytes
            };
            nextShards[mKey] = shardMeta;
            await yieldToEventLoop();
          }

          for (const item of pendingWrites) {
            if (isPassStale(myEpoch, privacySig)) {
              store.markLocalMonthsDirty?.(dirtyMonths);
              return { exported: false, totalRequests: lastExportedRequests, writtenShards, stale: true };
            }
            recordPendingShard(scopeKey, item.mKey, { nonBlocking: true });
            await atomicWriteBufferAsync(item.shardPath, item.gz, {
              signal,
              beforeRename: () => !isPassStale(myEpoch, privacySig)
            });
            await recordPublishedShardIfUnchangedAsync(item.mKey, item.shardPath, sha256Hex(item.gz), item.contentHash, { signal });
            writtenShards++;
          }
          for (const [mKey, shardMeta] of Object.entries(nextShards)) {
            cachedLocalShards.set(mKey, shardMeta);
          }

          for (const key of [...cachedLocalShards.keys()]) {
            if (!activeMonths.has(key)) cachedLocalShards.delete(key);
          }
        } catch (err) {
          store.markLocalMonthsDirty?.(dirtyMonths);
          throw err;
        }
      } else {
        exportRev = typeof store.getLocalRevision === 'function' ? store.getLocalRevision() : store.getRevision();
        const localRows = store.listLocalRequests();
        totalRequests = localRows.length;
        const byMonth = buildLegacyMonthBuckets(localRows, syncCfg);
        const pendingWrites = [];
        for (const [mKey, rows] of [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
          if (isPassStale(myEpoch, privacySig)) {
            return { exported: false, totalRequests: lastExportedRequests, writtenShards, stale: true };
          }
          rows.sort((a, b) => (a.timestampMs - b.timestampMs) || String(a.id).localeCompare(String(b.id)));
          const ndjson = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
          const contentHash = sha256Hex(ndjson);
          const fileName = `${mKey}.ndjson.gz`;
          const shardPath = join(machineDir, fileName);
          const prev = prevShards[mKey];
          const forceRewrite = pendingUncommitted.has(mKey);

          let compressedBytes = 0;
          const reused = (!forceRewrite && prev && prev.sha256 === contentHash)
            ? await isExistingShardIntactAsync(mKey, shardPath, prev.bytes, contentHash, { signal, verifyBytes: force })
            : null;
          if (isPassStale(myEpoch, privacySig)) {
            return { exported: false, totalRequests: lastExportedRequests, writtenShards, stale: true };
          }
          if (!reused) {
            const gz = await compressShardCheckedAsync(ndjson, fileName);
            if (isPassStale(myEpoch, privacySig)) {
              return { exported: false, totalRequests: lastExportedRequests, writtenShards, stale: true };
            }
            compressedBytes = gz.length;
            pendingWrites.push({ mKey, shardPath, gz, contentHash });
          } else {
            compressedBytes = reused.size;
          }
          nextShards[mKey] = {
            file: fileName,
            sha256: contentHash,
            count: rows.length,
            bytes: compressedBytes
          };
          await yieldToEventLoop();
        }
        for (const item of pendingWrites) {
          if (isPassStale(myEpoch, privacySig)) {
            return { exported: false, totalRequests: lastExportedRequests, writtenShards, stale: true };
          }
          recordPendingShard(scopeKey, item.mKey, { nonBlocking: true });
          await atomicWriteBufferAsync(item.shardPath, item.gz, {
            signal,
            beforeRename: () => !isPassStale(myEpoch, privacySig)
          });
          await recordPublishedShardIfUnchangedAsync(item.mKey, item.shardPath, sha256Hex(item.gz), item.contentHash, { signal });
          writtenShards++;
        }
      }

      if (isPassStale(myEpoch, privacySig)) {
        return { exported: false, totalRequests: lastExportedRequests, writtenShards, stale: true };
      }
      const failedCleanupMonths = new Set();
      let cleanupError = null;
      const names = await fsp.readdir(machineDir);
      if (isPassStale(myEpoch, privacySig)) {
        return { exported: false, totalRequests: lastExportedRequests, writtenShards, stale: true };
      }
      for (const name of names) {
        if (isPassStale(myEpoch, privacySig)) {
          return { exported: false, totalRequests: lastExportedRequests, writtenShards, stale: true };
        }
        const m = name.match(SHARD_FILE_RE);
        if (m && !nextShards[m[1]]) {
          try {
            await fsp.unlink(join(machineDir, name));
          } catch (err) {
            if (err?.code !== 'ENOENT') {
              failedCleanupMonths.add(m[1]);
              if (!isPassStale(myEpoch, privacySig)) {
                recordPendingShard(scopeKey, m[1], { nonBlocking: true });
              }
              if (!cleanupError) cleanupError = err;
            }
          }
        }
      }

      // Always derive manifest totalRequests from the shards actually published
      totalRequests = Object.values(nextShards).reduce((sum, s) => sum + (Number(s?.count) || 0), 0);

      const manifestPayload = {
        schemaVersion: FOLDER_SYNC_SCHEMA_VERSION,
        machineId,
        machineLabel,
        platform: `${osPlatform()}-${osArch()}`,
        appVersion,
        exportedAtMs: now,
        totalRequests,
        shards: nextShards
      };
      const manifestChanged = writtenShards > 0 ||
        pendingUncommitted.size > 0 ||
        !isManifestEquivalent(existingManifest, manifestPayload);

      let publishedManifestHash = existingManifestHash;
      if (manifestChanged) {
        if (isPassStale(myEpoch, privacySig)) {
          return { exported: false, totalRequests: lastExportedRequests, writtenShards, stale: true };
        }
        const manifestBuf = Buffer.from(JSON.stringify(manifestPayload, null, 2) + '\n', 'utf8');
        await atomicWriteBufferAsync(manifestPath, manifestBuf, {
          signal,
          beforeRename: () => !isPassStale(myEpoch, privacySig)
        });
        publishedManifestHash = sha256Hex(manifestBuf);
      }
      if (isPassStale(myEpoch, privacySig)) {
        return { exported: false, totalRequests: lastExportedRequests, writtenShards, stale: true };
      }
      commitPendingShards(scopeKey, failedCleanupMonths, { nonBlocking: true });
      if (cleanupError) {
        throw cleanupError;
      }

      const afterRev = typeof store.getLocalRevision === 'function' ? store.getLocalRevision() : store.getRevision();
      let changedDuringExport = false;
      if (afterRev === exportRev) {
        lastExportRev = exportRev;
        lastExportSig = privacySig;
        lastPublishedManifestHash = publishedManifestHash;
      } else {
        // Local or external writes landed while async export was running; ensure next pass reconciles
        lastExportRev = -1;
        lastPublishedManifestHash = '';
        changedDuringExport = true;
      }
      lastExportedRequests = totalRequests;
      return { exported: manifestChanged, totalRequests, writtenShards, stale: false, changedDuringExport };
    } finally {
      releaseLock();
    }
  }

  function isExistingDirSync(dirPath) {
    try {
      return statSync(dirPath).isDirectory();
    } catch (err) {
      return err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR';
    }
  }

  async function isExistingDirAsync(dirPath) {
    try {
      return (await fsp.stat(dirPath)).isDirectory();
    } catch (err) {
      return err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR';
    }
  }

  function snapshotInitialRemotePeers() {
    if (typeof store.listRemotePeerStates === 'function') {
      return new Map(store.listRemotePeerStates().map(s => [s.peerId, { stamps: s.stamps, gen: s.gen }]));
    }
    return new Map((store.listSyncPeers?.() || []).map(p => [p.machineId, null]));
  }

  function snapshotPeerImportState(peerPrefix) {
    if (typeof store.getRemotePeerImportState === 'function') {
      return store.getRemotePeerImportState(peerPrefix);
    }
    if (typeof store.listSourceStampsByPrefix === 'function') {
      return { stamps: store.listSourceStampsByPrefix(peerPrefix), gen: null };
    }
    return null;
  }

  function importRemoteMachines(machinesRoot, now) {
    const localMachineId = getLocalMachineId();
    if (!existsSync(machinesRoot)) {
      return { discoveredPeers: 0, importedShards: 0, errors: [] };
    }

    // Snapshot known remote peers BEFORE listing the directory so an older scan can never delete newly imported peers
    const initialRemotePeerStates = snapshotInitialRemotePeers();
    const existingPeersById = new Map((store.listSyncPeers?.() || []).map(p => [p.machineId, p]));

    let entries = [];
    try {
      entries = readdirSync(machinesRoot, { withFileTypes: true });
    } catch (err) {
      return { discoveredPeers: 0, importedShards: 0, errors: [err?.message || '读取同步目录失败'] };
    }

    const activePeerIds = new Set();
    let importedShards = 0;
    const errors = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!SAFE_MACHINE_DIR_RE.test(entry.name)) continue;
      if (entry.name === localMachineId) continue;

      const peerDir = join(machinesRoot, entry.name);
      const manifestPath = join(peerDir, 'manifest.json');
      const peerPrefix = `remote:${entry.name}:`;
      for (let peerAttempt = 0; peerAttempt < 3; peerAttempt++) {
        const expectedPeerState = snapshotPeerImportState(peerPrefix);
        const expectedPeerStamps = expectedPeerState?.stamps ?? null;
        const expectedPeerGen = expectedPeerState?.gen ?? null;
        const manifest = safeReadJson(manifestPath);
        const hasValidShards = Boolean(manifest?.shards && typeof manifest.shards === 'object' && !Array.isArray(manifest.shards));
        // Validate raw machineId strictly without sanitizing invalid characters into a colliding ID
        const rawPeerId = typeof manifest?.machineId === 'string' ? manifest.machineId : '';
        const validPeerIdentity = Boolean(rawPeerId && SAFE_MACHINE_DIR_RE.test(rawPeerId) && rawPeerId !== localMachineId && rawPeerId === entry.name);
        const hasDeclaredTotal = manifest != null && Object.prototype.hasOwnProperty.call(manifest, 'totalRequests');
        const validDeclaredTotal = hasDeclaredTotal && isNonNegSafeInt(manifest.totalRequests);
        const declaredTotal = validDeclaredTotal ? manifest.totalRequests : -1;
        let shardCountSum = 0;
        let invalidShardCount = false;
        if (hasValidShards) {
          for (const meta of Object.values(manifest.shards)) {
            if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
              invalidShardCount = true;
              continue;
            }
            if (!isNonNegSafeInt(meta.count)) {
              invalidShardCount = true;
            } else {
              shardCountSum += meta.count;
            }
          }
        }
        const inconsistentCounts = hasValidShards && (
          !validDeclaredTotal ||
          invalidShardCount ||
          shardCountSum !== declaredTotal
        );
        if (!manifest || Number(manifest.schemaVersion) !== FOLDER_SYNC_SCHEMA_VERSION || !hasValidShards || !validPeerIdentity || inconsistentCounts) {
          const knownPeer = existingPeersById.get(entry.name);
          const hasExistingRows = typeof store.getRemotePeerRowCount === 'function' && store.getRemotePeerRowCount(entry.name) > 0;
          if (knownPeer || hasExistingRows || existsSync(manifestPath)) {
            activePeerIds.add(entry.name);
            const peerLabel = knownPeer?.machineLabel || entry.name;
            const peerError = '分片清单暂不可读或结构不完整（可能仍在同步中）: manifest.json';
            errors.push(`${peerLabel}: ${peerError}`);
            if (knownPeer) {
              store.upsertSyncPeer({ ...knownPeer, status: 'partial', lastError: peerError });
            }
          }
          break;
        }

        const peerId = rawPeerId;
        const peerLabel = String(manifest.machineLabel || peerId).trim().slice(0, 64) || peerId;
        const knownPeer = peerAttempt > 0
          ? (store.listSyncPeers?.() || []).find(p => p.machineId === peerId)
          : existingPeersById.get(peerId);
        const shards = manifest.shards;
        const activeShardSources = new Set();
        const expectedShardCounts = new Map();
        const cachedShardSources = new Set();
        const protectedShardSources = new Set();
        const shardsToLoad = [];
        let peerError = '';
        let peerRequestCount = 0;
        let peerRegistered = Boolean(knownPeer);
        let anyValidShard = false;

        // Phase 1a: Validate metadata and classify ALL shards into cache hits vs to-load BEFORE parsing/writing any shard
        for (const [monthKey, meta] of Object.entries(shards)) {
          const sourceKey = `${peerPrefix}${monthKey}`;
          if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
            peerError = `分片元数据无效: ${monthKey}`;
            protectedShardSources.add(sourceKey);
            continue;
          }
          const fileName = String(meta.file || '');
          const fileMatch = fileName.match(SHARD_FILE_RE);
          if (!fileMatch || fileMatch[1] !== monthKey) {
            peerError = `分片文件名无效: ${monthKey}`;
            protectedShardSources.add(sourceKey);
            continue;
          }
          const expectedHash = String(meta.sha256 || '').trim().toLowerCase();
          if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
            peerError = `分片校验摘要无效: ${fileName}`;
            protectedShardSources.add(sourceKey);
            continue;
          }
          activeShardSources.add(sourceKey);
          const declaredShardCount = meta.count;
          expectedShardCounts.set(sourceKey, declaredShardCount);
          const stamp = `${REMOTE_IMPORT_STAMP_VERSION}:${expectedHash}:${peerLabel}`;
          const existingStamp = store.getSourceStamp(sourceKey);
          if (existingStamp === stamp) {
            const storedCount = typeof store.getSourceRowCount === 'function'
              ? store.getSourceRowCount(sourceKey)
              : declaredShardCount;
            if (storedCount === declaredShardCount) {
              cachedShardSources.add(sourceKey);
              protectedShardSources.add(sourceKey);
              peerRequestCount += storedCount;
              if (storedCount > 0) anyValidShard = true;
              continue;
            }
          }
          shardsToLoad.push({ monthKey, fileName, expectedHash, sourceKey, declaredShardCount, stamp });
        }

        // Phase 1b: Parse ALL changed shards completely first so multi-month conflict chains (e.g., Aug-Sep-Oct)
        // collect every shard's full ID set before deciding which months conflict.
        const conflictingSourceKeys = new Set();
        const validatedWrites = [];
        for (const item of shardsToLoad) {
          const { fileName, expectedHash, sourceKey, declaredShardCount, stamp } = item;
          const shardPath = join(peerDir, fileName);
          try {
            let snap;
            try {
              snap = readAndStatFileSync(shardPath, MAX_SHARD_COMPRESSED_BYTES);
            } catch (readErr) {
              if (readErr?.code === 'ENOENT') {
                peerError = `分片尚未同步完成: ${fileName}`;
                protectedShardSources.add(sourceKey);
                continue;
              }
              throw readErr;
            }
            if (snap.tooLarge) {
              peerError = `分片超过体积上限: ${fileName}`;
              protectedShardSources.add(sourceKey);
              continue;
            }
            const ndjsonBuf = zlib.gunzipSync(snap.rawBuf, { maxOutputLength: MAX_SHARD_UNCOMPRESSED_BYTES });
            const ndjson = ndjsonBuf.toString('utf8');
            const actualHash = sha256Hex(ndjson);
            if (actualHash !== expectedHash) {
              peerError = `分片校验未通过（可能仍在同步中）: ${fileName}`;
              protectedShardSources.add(sourceKey);
              continue;
            }

            const rows = [];
            const seenIds = new Set();
            let hasMalformedLine = false;
            let hasDuplicateId = false;
            for (const rawLine of ndjson.split('\n')) {
              const line = rawLine.trim();
              if (!line) continue;
              const parsed = parseRemoteRequestLine(line, peerId, peerLabel);
              if (!parsed) {
                hasMalformedLine = true;
                break;
              }
              if (seenIds.has(parsed.id)) {
                hasDuplicateId = true;
                break;
              }
              seenIds.add(parsed.id);
              rows.push(parsed);
            }
            if (hasMalformedLine || hasDuplicateId || rows.length !== declaredShardCount) {
              protectedShardSources.add(sourceKey);
              peerError = `分片行数或记录结构与清单声明不一致: ${fileName}`;
              continue;
            }
            validatedWrites.push({ fileName, sourceKey, stamp, rows, seenIds, declaredShardCount });
          } catch (err) {
            protectedShardSources.add(sourceKey);
            peerError = err?.message || `解析分片失败: ${fileName}`;
          }
        }

        const idToOwners = new Map();
        for (const item of validatedWrites) {
          for (const id of item.seenIds) {
            let owners = idToOwners.get(id);
            if (!owners) {
              owners = new Set();
              idToOwners.set(id, owners);
            }
            owners.add(item.sourceKey);
          }
        }
        for (const owners of idToOwners.values()) {
          if (owners.size > 1) {
            for (const ownerKey of owners) {
              conflictingSourceKeys.add(ownerKey);
              protectedShardSources.add(ownerKey);
            }
            peerError = '分片包含跨月重复记录标识';
          }
        }

        // Fixed-point exclusion: any shard skipped for conflict or row-removal keeps its cached rows in DB,
        // so add it to protectedShardSources and re-check remaining shards to prevent chained row theft.
        const skippedSourceKeys = new Set(conflictingSourceKeys);
        let changedProtection = true;
        while (changedProtection) {
          changedProtection = false;
          if (typeof store.hasRowOwnedBySources === 'function' && protectedShardSources.size > 0) {
            for (const item of validatedWrites) {
              if (skippedSourceKeys.has(item.sourceKey)) continue;
              if (store.hasRowOwnedBySources(item.seenIds, protectedShardSources)) {
                skippedSourceKeys.add(item.sourceKey);
                protectedShardSources.add(item.sourceKey);
                peerError = `分片包含跨月重复记录标识: ${item.fileName}`;
                changedProtection = true;
              }
            }
          }
          if (peerError && typeof store.getSourceRowIds === 'function') {
            for (const item of validatedWrites) {
              if (skippedSourceKeys.has(item.sourceKey)) continue;
              const existingIds = store.getSourceRowIds(item.sourceKey);
              for (const oldId of existingIds) {
                if (!item.seenIds.has(oldId)) {
                  skippedSourceKeys.add(item.sourceKey);
                  protectedShardSources.add(item.sourceKey);
                  changedProtection = true;
                  break;
                }
              }
            }
          }
        }

        // Phase 2: Commit non-conflicting validated shards (and prune when !peerError) in ONE CAS-checked atomic transaction.
        const batchToCommit = validatedWrites.filter(item => !skippedSourceKeys.has(item.sourceKey));

        const shouldPrune = !peerError;
        let prunedAtomically = false;
        let staleConflict = false;
        if (batchToCommit.length > 0 || (shouldPrune && typeof store.replaceRemoteSourcesBatch === 'function')) {
          const batchTotalRows = batchToCommit.reduce((sum, it) => sum + it.rows.length, 0);
          const atomicPeer = (!peerRegistered && batchTotalRows > 0) ? {
            machineId: peerId,
            machineLabel: peerLabel,
            platform: String(manifest.platform || ''),
            appVersion: String(manifest.appVersion || ''),
            requestCount: batchTotalRows,
            lastExportedAtMs: Number.isFinite(Number(manifest.exportedAtMs)) ? Number(manifest.exportedAtMs) : null,
            lastImportedAtMs: now,
            status: 'partial',
            lastError: ''
          } : null;
          try {
            if (typeof store.replaceRemoteSourcesBatch === 'function') {
              store.replaceRemoteSourcesBatch(batchToCommit, {
                machineId: peerId,
                machineLabel: peerLabel,
                peer: atomicPeer,
                peerPrefix,
                expectedPeerStamps,
                expectedPeerGen,
                pruneActiveKeys: shouldPrune ? activeShardSources : null
              });
              if (shouldPrune) prunedAtomically = true;
            } else if (batchToCommit.length === 1) {
              const onlyItem = batchToCommit[0];
              store.replaceSourceRequests(onlyItem.sourceKey, onlyItem.stamp, onlyItem.rows, {
                machineId: peerId,
                machineLabel: peerLabel,
                isRemote: true,
                peer: onlyItem.rows.length > 0 ? atomicPeer : null
              });
            } else if (batchToCommit.length > 1) {
              throw new Error('当前存储不支持多月原子批量提交，已跳过本次多月写入');
            }
            if (atomicPeer) peerRegistered = true;
            for (const item of batchToCommit) {
              if (typeof store.getSourceRowCount === 'function' && store.getSourceRowCount(item.sourceKey) !== item.declaredShardCount) {
                peerError = `分片写入后行数与清单声明不一致: ${item.fileName}`;
              } else {
                peerRequestCount += item.rows.length;
                if (item.rows.length > 0) anyValidShard = true;
                importedShards++;
              }
            }
          } catch (err) {
            if (err?.code === 'STALE_IMPORT_CONFLICT' && peerAttempt < 2) {
              staleConflict = true;
            } else {
              peerError = err?.message || '写入远端分片失败';
            }
          }
        }
        if (staleConflict) continue;

        if (!peerError && typeof store.getSourceRowCount === 'function') {
          let verifiedTotal = 0;
          for (const [srcKey, expCount] of expectedShardCounts.entries()) {
            const actual = store.getSourceRowCount(srcKey);
            if (actual !== expCount) {
              peerError = `分片跨月归属或行数与清单声明不一致: ${srcKey}`;
              break;
            }
            verifiedTotal += actual;
          }
          if (!peerError && verifiedTotal !== declaredTotal) {
            peerError = '远端分片总行数与清单声明不一致';
          }
        }

        if (!peerError) {
          activePeerIds.add(peerId);
          // For legacy stores without an atomic batch API, defer stale-shard deletion rather than
          // running an unguarded separate-transaction prune that could delete another importer's month.
        } else {
          errors.push(`${peerLabel}: ${peerError}`);
          const storedRowsForPeer = typeof store.getRemotePeerRowCount === 'function'
            ? store.getRemotePeerRowCount(peerId)
            : (anyValidShard ? peerRequestCount : 0);
          if (!knownPeer && !peerRegistered && !anyValidShard && storedRowsForPeer === 0) {
            break;
          }
          activePeerIds.add(peerId);
        }

        const actualPeerRows = typeof store.getRemotePeerRowCount === 'function'
          ? store.getRemotePeerRowCount(peerId)
          : peerRequestCount;
        store.upsertSyncPeer({
          machineId: peerId,
          machineLabel: peerLabel,
          platform: String(manifest.platform || ''),
          appVersion: String(manifest.appVersion || ''),
          requestCount: actualPeerRows,
          lastExportedAtMs: Number.isFinite(Number(manifest.exportedAtMs)) ? Number(manifest.exportedAtMs) : null,
          lastImportedAtMs: now,
          status: peerError ? 'partial' : 'ok',
          lastError: peerError
        });
        break;
      }
    }

    for (const [staleId, expectedState] of initialRemotePeerStates.entries()) {
      if (activePeerIds.has(staleId)) continue;
      if (isExistingDirSync(join(machinesRoot, staleId))) continue;
      if (typeof store.pruneRemotePeerIfUnchanged === 'function') {
        store.pruneRemotePeerIfUnchanged(staleId, expectedState);
      } else {
        store.deleteSourcesByPrefix?.(`remote:${staleId}:`);
        store.deleteSyncPeer?.(staleId);
      }
    }

    return { discoveredPeers: activePeerIds.size, importedShards, errors };
  }

  async function importRemoteMachinesAsync(machinesRoot, now, { myEpoch, signal, privacySig }) {
    if (isPassStale(myEpoch, privacySig)) {
      return { discoveredPeers: 0, importedShards: 0, errors: [], stale: true };
    }
    const localMachineId = getLocalMachineId({ nonBlocking: true });
    if (!(await pathExistsAsync(machinesRoot))) {
      return { discoveredPeers: 0, importedShards: 0, errors: [], stale: false };
    }

    // Snapshot known remote peers BEFORE listing the directory so an older scan can never delete newly imported peers
    const initialRemotePeerStates = snapshotInitialRemotePeers();
    const existingPeersById = new Map((store.listSyncPeers?.() || []).map(p => [p.machineId, p]));

    let entries = [];
    try {
      entries = await fsp.readdir(machinesRoot, { withFileTypes: true });
    } catch (err) {
      return { discoveredPeers: 0, importedShards: 0, errors: [err?.message || '读取同步目录失败'], stale: false };
    }
    if (isPassStale(myEpoch, privacySig)) {
      return { discoveredPeers: 0, importedShards: 0, errors: [], stale: true };
    }

    const activePeerIds = new Set();
    let importedShards = 0;
    const errors = [];

    for (const entry of entries) {
      if (isPassStale(myEpoch, privacySig)) {
        return { discoveredPeers: activePeerIds.size, importedShards, errors, stale: true };
      }
      if (!entry.isDirectory()) continue;
      if (!SAFE_MACHINE_DIR_RE.test(entry.name)) continue;
      if (entry.name === localMachineId) continue;

      const peerDir = join(machinesRoot, entry.name);
      const manifestPath = join(peerDir, 'manifest.json');
      const peerPrefix = `remote:${entry.name}:`;
      for (let peerAttempt = 0; peerAttempt < 3; peerAttempt++) {
        if (isPassStale(myEpoch, privacySig)) {
          return { discoveredPeers: activePeerIds.size, importedShards, errors, stale: true };
        }
        const expectedPeerState = snapshotPeerImportState(peerPrefix);
        const expectedPeerStamps = expectedPeerState?.stamps ?? null;
        const expectedPeerGen = expectedPeerState?.gen ?? null;
        const manifest = await safeReadJsonAsync(manifestPath, { signal });
        if (isPassStale(myEpoch, privacySig)) {
          return { discoveredPeers: activePeerIds.size, importedShards, errors, stale: true };
        }
        const hasValidShards = Boolean(manifest?.shards && typeof manifest.shards === 'object' && !Array.isArray(manifest.shards));
        // Validate raw machineId strictly without sanitizing invalid characters into a colliding ID
        const rawPeerId = typeof manifest?.machineId === 'string' ? manifest.machineId : '';
        const validPeerIdentity = Boolean(rawPeerId && SAFE_MACHINE_DIR_RE.test(rawPeerId) && rawPeerId !== localMachineId && rawPeerId === entry.name);
        const hasDeclaredTotal = manifest != null && Object.prototype.hasOwnProperty.call(manifest, 'totalRequests');
        const validDeclaredTotal = hasDeclaredTotal && isNonNegSafeInt(manifest.totalRequests);
        const declaredTotal = validDeclaredTotal ? manifest.totalRequests : -1;
        let shardCountSum = 0;
        let invalidShardCount = false;
        if (hasValidShards) {
          for (const meta of Object.values(manifest.shards)) {
            if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
              invalidShardCount = true;
              continue;
            }
            if (!isNonNegSafeInt(meta.count)) {
              invalidShardCount = true;
            } else {
              shardCountSum += meta.count;
            }
          }
        }
        const inconsistentCounts = hasValidShards && (
          !validDeclaredTotal ||
          invalidShardCount ||
          shardCountSum !== declaredTotal
        );
        if (!manifest || Number(manifest.schemaVersion) !== FOLDER_SYNC_SCHEMA_VERSION || !hasValidShards || !validPeerIdentity || inconsistentCounts) {
          // Retain cached peer rows when a peer directory is still present (even without sync_peers row from an interrupted legacy import)
          const knownPeer = existingPeersById.get(entry.name);
          const hasExistingRows = typeof store.getRemotePeerRowCount === 'function' && store.getRemotePeerRowCount(entry.name) > 0;
          if (knownPeer || hasExistingRows || await pathExistsAsync(manifestPath)) {
            if (isPassStale(myEpoch, privacySig)) {
              return { discoveredPeers: activePeerIds.size, importedShards, errors, stale: true };
            }
            activePeerIds.add(entry.name);
            const peerLabel = knownPeer?.machineLabel || entry.name;
            const peerError = '分片清单暂不可读或结构不完整（可能仍在同步中）: manifest.json';
            errors.push(`${peerLabel}: ${peerError}`);
            if (knownPeer) {
              withNonBlockingStore(() => store.upsertSyncPeer({ ...knownPeer, status: 'partial', lastError: peerError }));
            }
          }
          break;
        }

        const peerId = rawPeerId;
        const peerLabel = String(manifest.machineLabel || peerId).trim().slice(0, 64) || peerId;
        const knownPeer = peerAttempt > 0
          ? (store.listSyncPeers?.() || []).find(p => p.machineId === peerId)
          : existingPeersById.get(peerId);
        const shards = manifest.shards;
        const activeShardSources = new Set();
        const expectedShardCounts = new Map();
        const cachedShardSources = new Set();
        const protectedShardSources = new Set();
        const shardsToLoad = [];
        let peerError = '';
        let peerRequestCount = 0;
        let peerRegistered = Boolean(knownPeer);
        let anyValidShard = false;

        // Phase 1a: Validate metadata and classify ALL shards into cache hits vs to-load BEFORE parsing/writing any shard
        for (const [monthKey, meta] of Object.entries(shards)) {
          if (isPassStale(myEpoch, privacySig)) {
            return { discoveredPeers: activePeerIds.size, importedShards, errors, stale: true };
          }
          const sourceKey = `${peerPrefix}${monthKey}`;
          if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
            peerError = `分片元数据无效: ${monthKey}`;
            protectedShardSources.add(sourceKey);
            continue;
          }
          const fileName = String(meta.file || '');
          const fileMatch = fileName.match(SHARD_FILE_RE);
          if (!fileMatch || fileMatch[1] !== monthKey) {
            peerError = `分片文件名无效: ${monthKey}`;
            protectedShardSources.add(sourceKey);
            continue;
          }
          const expectedHash = String(meta.sha256 || '').trim().toLowerCase();
          if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
            peerError = `分片校验摘要无效: ${fileName}`;
            protectedShardSources.add(sourceKey);
            continue;
          }
          activeShardSources.add(sourceKey);
          const declaredShardCount = meta.count;
          expectedShardCounts.set(sourceKey, declaredShardCount);
          const stamp = `${REMOTE_IMPORT_STAMP_VERSION}:${expectedHash}:${peerLabel}`;
          const existingStamp = store.getSourceStamp(sourceKey);
          if (existingStamp === stamp) {
            const storedCount = typeof store.getSourceRowCount === 'function'
              ? store.getSourceRowCount(sourceKey)
              : declaredShardCount;
            if (storedCount === declaredShardCount) {
              cachedShardSources.add(sourceKey);
              protectedShardSources.add(sourceKey);
              peerRequestCount += storedCount;
              if (storedCount > 0) anyValidShard = true;
              continue;
            }
          }
          shardsToLoad.push({ monthKey, fileName, expectedHash, sourceKey, declaredShardCount, stamp });
        }

        // Phase 1b: Parse ALL changed shards completely first so multi-month conflict chains (e.g., Aug-Sep-Oct)
        // collect every shard's full ID set before deciding which months conflict.
        const conflictingSourceKeys = new Set();
        const validatedWrites = [];
        for (const item of shardsToLoad) {
          if (isPassStale(myEpoch, privacySig)) {
            return { discoveredPeers: activePeerIds.size, importedShards, errors, stale: true };
          }
          const { fileName, expectedHash, sourceKey, declaredShardCount, stamp } = item;
          const shardPath = join(peerDir, fileName);
          try {
            // Bounded single-handle fstat + read runs on libuv worker threads so OneDrive cloud recall never stalls /api/health
            let snap;
            try {
              snap = await readAndStatFileAsync(shardPath, { signal, maxBytes: MAX_SHARD_COMPRESSED_BYTES });
            } catch (readErr) {
              if (readErr?.code === 'ENOENT') {
                peerError = `分片尚未同步完成: ${fileName}`;
                protectedShardSources.add(sourceKey);
                continue;
              }
              throw readErr;
            }
            if (isPassStale(myEpoch, privacySig)) {
              return { discoveredPeers: activePeerIds.size, importedShards, errors, stale: true };
            }
            if (snap.tooLarge) {
              peerError = `分片超过体积上限: ${fileName}`;
              protectedShardSources.add(sourceKey);
              continue;
            }
            const ndjsonBuf = await gunzipAsync(snap.rawBuf, { maxOutputLength: MAX_SHARD_UNCOMPRESSED_BYTES });
            if (isPassStale(myEpoch, privacySig)) {
              return { discoveredPeers: activePeerIds.size, importedShards, errors, stale: true };
            }
            const ndjson = ndjsonBuf.toString('utf8');
            const actualHash = sha256Hex(ndjson);
            if (actualHash !== expectedHash) {
              peerError = `分片校验未通过（可能仍在同步中）: ${fileName}`;
              protectedShardSources.add(sourceKey);
              continue;
            }

            await yieldToEventLoop();
            if (isPassStale(myEpoch, privacySig)) {
              return { discoveredPeers: activePeerIds.size, importedShards, errors, stale: true };
            }

            const rawLines = ndjson.split('\n');
            const rows = [];
            const seenIds = new Set();
            let hasMalformedLine = false;
            let hasDuplicateId = false;
            for (let i = 0; i < rawLines.length; i++) {
              if (i > 0 && i % ASYNC_ROW_YIELD_BATCH === 0) {
                await yieldToEventLoop();
                if (isPassStale(myEpoch, privacySig)) {
                  return { discoveredPeers: activePeerIds.size, importedShards, errors, stale: true };
                }
              }
              const line = rawLines[i].trim();
              if (!line) continue;
              const parsed = parseRemoteRequestLine(line, peerId, peerLabel);
              if (!parsed) {
                hasMalformedLine = true;
                break;
              }
              if (seenIds.has(parsed.id)) {
                hasDuplicateId = true;
                break;
              }
              seenIds.add(parsed.id);
              rows.push(parsed);
            }
            if (hasMalformedLine || hasDuplicateId || rows.length !== declaredShardCount) {
              protectedShardSources.add(sourceKey);
              peerError = `分片行数或记录结构与清单声明不一致: ${fileName}`;
              continue;
            }
            validatedWrites.push({ fileName, sourceKey, stamp, rows, seenIds, declaredShardCount });
          } catch (err) {
            if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
              return { discoveredPeers: activePeerIds.size, importedShards, errors, stale: true };
            }
            protectedShardSources.add(sourceKey);
            peerError = err?.message || `解析分片失败: ${fileName}`;
          }
        }

        const idToOwners = new Map();
        for (const item of validatedWrites) {
          for (const id of item.seenIds) {
            let owners = idToOwners.get(id);
            if (!owners) {
              owners = new Set();
              idToOwners.set(id, owners);
            }
            owners.add(item.sourceKey);
          }
        }
        for (const owners of idToOwners.values()) {
          if (owners.size > 1) {
            for (const ownerKey of owners) {
              conflictingSourceKeys.add(ownerKey);
              protectedShardSources.add(ownerKey);
            }
            peerError = '分片包含跨月重复记录标识';
          }
        }

        // Fixed-point exclusion: any shard skipped for conflict or row-removal keeps its cached rows in DB,
        // so add it to protectedShardSources and re-check remaining shards to prevent chained row theft.
        const skippedSourceKeys = new Set(conflictingSourceKeys);
        let changedProtection = true;
        while (changedProtection) {
          changedProtection = false;
          if (typeof store.hasRowOwnedBySources === 'function' && protectedShardSources.size > 0) {
            for (const item of validatedWrites) {
              if (skippedSourceKeys.has(item.sourceKey)) continue;
              if (store.hasRowOwnedBySources(item.seenIds, protectedShardSources)) {
                skippedSourceKeys.add(item.sourceKey);
                protectedShardSources.add(item.sourceKey);
                peerError = `分片包含跨月重复记录标识: ${item.fileName}`;
                changedProtection = true;
              }
            }
          }
          if (peerError && typeof store.getSourceRowIds === 'function') {
            for (const item of validatedWrites) {
              if (skippedSourceKeys.has(item.sourceKey)) continue;
              const existingIds = store.getSourceRowIds(item.sourceKey);
              for (const oldId of existingIds) {
                if (!item.seenIds.has(oldId)) {
                  skippedSourceKeys.add(item.sourceKey);
                  protectedShardSources.add(item.sourceKey);
                  changedProtection = true;
                  break;
                }
              }
            }
          }
        }

        // Phase 2: Commit non-conflicting validated shards (and prune when !peerError) in ONE CAS-checked atomic transaction.
        const batchToCommit = validatedWrites.filter(item => !skippedSourceKeys.has(item.sourceKey));

        const shouldPrune = !peerError;
        let prunedAtomically = false;
        let staleConflict = false;
        const hasBatchApi = typeof store.replaceRemoteSourcesBatchAsync === 'function' || typeof store.replaceRemoteSourcesBatch === 'function';
        if (batchToCommit.length > 0 || (shouldPrune && hasBatchApi)) {
          if (isPassStale(myEpoch, privacySig)) {
            return { discoveredPeers: activePeerIds.size, importedShards, errors, stale: true };
          }
          const batchTotalRows = batchToCommit.reduce((sum, it) => sum + it.rows.length, 0);
          const atomicPeer = (!peerRegistered && batchTotalRows > 0) ? {
            machineId: peerId,
            machineLabel: peerLabel,
            platform: String(manifest.platform || ''),
            appVersion: String(manifest.appVersion || ''),
            requestCount: batchTotalRows,
            lastExportedAtMs: Number.isFinite(Number(manifest.exportedAtMs)) ? Number(manifest.exportedAtMs) : null,
            lastImportedAtMs: now,
            status: 'partial',
            lastError: ''
          } : null;
          try {
            if (typeof store.replaceRemoteSourcesBatchAsync === 'function') {
              await store.replaceRemoteSourcesBatchAsync(batchToCommit, {
                machineId: peerId,
                machineLabel: peerLabel,
                signal,
                nonBlocking: true,
                peer: atomicPeer,
                peerPrefix,
                expectedPeerStamps,
                expectedPeerGen,
                pruneActiveKeys: shouldPrune ? activeShardSources : null
              });
              if (shouldPrune) prunedAtomically = true;
            } else if (typeof store.replaceRemoteSourcesBatch === 'function') {
              withNonBlockingStore(() => store.replaceRemoteSourcesBatch(batchToCommit, {
                machineId: peerId,
                machineLabel: peerLabel,
                nonBlocking: true,
                peer: atomicPeer,
                peerPrefix,
                expectedPeerStamps,
                expectedPeerGen,
                pruneActiveKeys: shouldPrune ? activeShardSources : null
              }));
              if (shouldPrune) prunedAtomically = true;
            } else if (batchToCommit.length === 1) {
              const onlyItem = batchToCommit[0];
              if (typeof store.replaceRemoteSourceRequestsAsync === 'function') {
                await store.replaceRemoteSourceRequestsAsync(onlyItem.sourceKey, onlyItem.stamp, onlyItem.rows, {
                  machineId: peerId,
                  machineLabel: peerLabel,
                  signal,
                  nonBlocking: true,
                  peer: onlyItem.rows.length > 0 ? atomicPeer : null
                });
              } else {
                withNonBlockingStore(() => store.replaceSourceRequests(onlyItem.sourceKey, onlyItem.stamp, onlyItem.rows, {
                  machineId: peerId,
                  machineLabel: peerLabel,
                  isRemote: true,
                  peer: onlyItem.rows.length > 0 ? atomicPeer : null
                }));
              }
            } else if (batchToCommit.length > 1) {
              throw new Error('当前存储不支持多月原子批量提交，已跳过本次多月写入');
            }
            if (atomicPeer) peerRegistered = true;
            if (isPassStale(myEpoch, privacySig)) {
              return { discoveredPeers: activePeerIds.size, importedShards, errors, stale: true };
            }
            for (const item of batchToCommit) {
              if (typeof store.getSourceRowCount === 'function' && store.getSourceRowCount(item.sourceKey) !== item.declaredShardCount) {
                peerError = `分片写入后行数与清单声明不一致: ${item.fileName}`;
              } else {
                peerRequestCount += item.rows.length;
                if (item.rows.length > 0) anyValidShard = true;
                importedShards++;
              }
            }
            await yieldToEventLoop();
          } catch (err) {
            if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
              return { discoveredPeers: activePeerIds.size, importedShards, errors, stale: true };
            }
            if (err?.code === 'STALE_IMPORT_CONFLICT' && peerAttempt < 2) {
              staleConflict = true;
            } else {
              peerError = err?.message || '写入远端分片失败';
            }
          }
        }
        if (staleConflict) continue;

        if (isPassStale(myEpoch, privacySig)) {
          return { discoveredPeers: activePeerIds.size, importedShards, errors, stale: true };
        }

        if (!peerError && typeof store.getSourceRowCount === 'function') {
          let verifiedTotal = 0;
          for (const [srcKey, expCount] of expectedShardCounts.entries()) {
            const actual = store.getSourceRowCount(srcKey);
            if (actual !== expCount) {
              peerError = `分片跨月归属或行数与清单声明不一致: ${srcKey}`;
              break;
            }
            verifiedTotal += actual;
          }
          if (!peerError && verifiedTotal !== declaredTotal) {
            peerError = '远端分片总行数与清单声明不一致';
          }
        }

        if (!peerError) {
          activePeerIds.add(peerId);
          // For legacy stores without an atomic batch API, defer stale-shard deletion rather than
          // running an unguarded separate-transaction prune that could delete another importer's month.
        } else {
          errors.push(`${peerLabel}: ${peerError}`);
          const storedRowsForPeer = typeof store.getRemotePeerRowCount === 'function'
            ? store.getRemotePeerRowCount(peerId)
            : (anyValidShard ? peerRequestCount : 0);
          if (!knownPeer && !peerRegistered && !anyValidShard && storedRowsForPeer === 0) {
            break;
          }
          activePeerIds.add(peerId);
        }

        const actualPeerRows = typeof store.getRemotePeerRowCount === 'function'
          ? store.getRemotePeerRowCount(peerId)
          : peerRequestCount;
        withNonBlockingStore(() => store.upsertSyncPeer({
          machineId: peerId,
          machineLabel: peerLabel,
          platform: String(manifest.platform || ''),
          appVersion: String(manifest.appVersion || ''),
          requestCount: actualPeerRows,
          lastExportedAtMs: Number.isFinite(Number(manifest.exportedAtMs)) ? Number(manifest.exportedAtMs) : null,
          lastImportedAtMs: now,
          status: peerError ? 'partial' : 'ok',
          lastError: peerError
        }));
        break;
      }
    }

    if (isPassStale(myEpoch, privacySig)) {
      return { discoveredPeers: activePeerIds.size, importedShards, errors, stale: true };
    }
    for (const [staleId, expectedState] of initialRemotePeerStates.entries()) {
      if (isPassStale(myEpoch, privacySig)) {
        return { discoveredPeers: activePeerIds.size, importedShards, errors, stale: true };
      }
      if (activePeerIds.has(staleId)) continue;
      if (await isExistingDirAsync(join(machinesRoot, staleId))) continue;
      if (isPassStale(myEpoch, privacySig)) {
        return { discoveredPeers: activePeerIds.size, importedShards, errors, stale: true };
      }
      if (typeof store.pruneRemotePeerIfUnchanged === 'function') {
        withNonBlockingStore(() => store.pruneRemotePeerIfUnchanged(staleId, expectedState));
      } else {
        withNonBlockingStore(() => store.deleteSourcesByPrefix?.(`remote:${staleId}:`));
        withNonBlockingStore(() => store.deleteSyncPeer?.(staleId));
      }
    }

    return { discoveredPeers: activePeerIds.size, importedShards, errors, stale: false };
  }

  function sync({ force = false, now = Date.now() } = {}) {
    if (!isStoreAvailable()) return getStatus(now, { refreshSuggested: false });
    // Never run synchronous export/import concurrently with an in-flight async pass sharing state
    if (inFlightSync || syncWriteActive) {
      return getStatus(now, { refreshSuggested: false });
    }
    const cfg = settings.get()?.multiMachineSync || {};
    const syncDir = String(cfg.syncDir || '').trim();
    if (!cfg.enabled || !syncDir) {
      lastState = 'disabled';
      lastError = '';
      return getStatus(now, { refreshSuggested: false });
    }

    const minInterval = Math.max(10000, Number(cfg.syncIntervalMs) || 30000);
    if (!force && lastSyncAtMs > 0 && now - lastSyncAtMs < minInterval) {
      return getStatus(now, { refreshSuggested: false });
    }

    syncWriteActive = true;
    lastState = 'syncing';
    lastError = '';
    try {
      const resolvedDir = resolve(syncDir);
      const machinesRoot = join(resolvedDir, 'machines');
      mkdirSync(machinesRoot, { recursive: true });

      let exportError = null;
      try {
        exportLocalMachine(machinesRoot, cfg, now, { force });
      } catch (err) {
        exportError = err;
      }
      const imported = importRemoteMachines(machinesRoot, now);
      lastSyncAtMs = now;
      if (exportError) {
        lastState = 'error';
        lastError = exportError?.message || '同步目录不可用';
      } else if (imported.errors.length) {
        lastState = 'partial';
        lastError = imported.errors[0];
      } else {
        lastState = 'ok';
        lastError = '';
      }
    } catch (err) {
      lastSyncAtMs = now;
      lastState = 'error';
      lastError = err?.message || '同步目录不可用';
    } finally {
      syncWriteActive = false;
    }
    return getStatus(now, { refreshSuggested: false });
  }

  async function runSyncOnceAsync({ force = false, now } = {}) {
    const useFixedClock = Number.isFinite(now);
    const currentNow = () => (useFixedClock ? now : Date.now());
    const startNow = currentNow();
    if (!isStoreAvailable()) return getStatus(startNow, { refreshSuggested: false });
    const cfg = settings.get()?.multiMachineSync || {};
    const syncDir = String(cfg.syncDir || '').trim();
    if (!cfg.enabled || !syncDir) {
      lastState = 'disabled';
      lastError = '';
      return getStatus(startNow, { refreshSuggested: false });
    }

    const minInterval = Math.max(10000, Number(cfg.syncIntervalMs) || 30000);
    if (!force && lastSyncAtMs > 0 && startNow - lastSyncAtMs < minInterval) {
      return getStatus(startNow, { refreshSuggested: false });
    }

    const myEpoch = syncEpoch;
    const privacySig = computePrivacySig(cfg);
    const ac = new AbortController();
    activeAbortController = ac;
    lastState = 'syncing';
    lastError = '';
    try {
      const resolvedDir = resolve(syncDir);
      const machinesRoot = join(resolvedDir, 'machines');
      await fsp.mkdir(machinesRoot, { recursive: true });
      if (isPassStale(myEpoch, privacySig)) return getStatus(currentNow(), { refreshSuggested: false });

      let exportError = null;
      let exported = { exported: false, totalRequests: lastExportedRequests, writtenShards: 0, stale: false, changedDuringExport: false };
      try {
        exported = await exportLocalMachineAsync(machinesRoot, cfg, startNow, { myEpoch, signal: ac.signal, force });
      } catch (err) {
        if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') throw err;
        exportError = err;
      }
      if (exported.stale || isPassStale(myEpoch, privacySig)) return getStatus(currentNow(), { refreshSuggested: false });

      const imported = await importRemoteMachinesAsync(machinesRoot, startNow, { myEpoch, signal: ac.signal, privacySig });
      if (imported.stale || isPassStale(myEpoch, privacySig)) return getStatus(currentNow(), { refreshSuggested: false });

      if (exported.changedDuringExport) {
        pendingExportFollowup = true;
        pendingExportFollowupNow = useFixedClock ? now : undefined;
      }

      lastSyncAtMs = currentNow();
      if (exportError) {
        lastState = 'error';
        lastError = exportError?.message || '同步目录不可用';
      } else if (imported.errors.length) {
        lastState = 'partial';
        lastError = imported.errors[0];
      } else {
        lastState = 'ok';
        lastError = '';
      }
    } catch (err) {
      if (!isPassStale(myEpoch, privacySig) && err?.name !== 'AbortError' && err?.code !== 'ABORT_ERR') {
        lastSyncAtMs = currentNow();
        lastState = 'error';
        lastError = err?.message || '同步目录不可用';
      }
    } finally {
      if (activeAbortController === ac) activeAbortController = null;
    }
    return getStatus(currentNow(), { refreshSuggested: false });
  }

  async function syncAsync({ force = false, now } = {}) {
    const startNow = Number.isFinite(now) ? now : Date.now();
    if (!isStoreAvailable()) return getStatus(startNow, { refreshSuggested: false });
    if (inFlightSync) {
      if (force) {
        pendingForce = true;
        pendingForceNow = now;
      }
      await inFlightSync;
      if (!force || !isStoreAvailable() || !pendingForce) {
        return getStatus(Number.isFinite(now) ? now : Date.now(), { refreshSuggested: false });
      }
    }
    pendingForce = false;
    pendingForceNow = undefined;
    pendingExportFollowup = false;
    pendingExportFollowupNow = undefined;
    const task = (async () => {
      let status = await runSyncOnceAsync({ force, now });
      let autoFollowups = 0;
      while (isStoreAvailable() && (pendingForce || (pendingExportFollowup && autoFollowups < MAX_AUTO_EXPORT_FOLLOWUPS))) {
        if (pendingForce) {
          const nextNow = pendingForceNow;
          pendingForce = false;
          pendingForceNow = undefined;
          pendingExportFollowup = false;
          pendingExportFollowupNow = undefined;
          status = await runSyncOnceAsync({ force: true, now: nextNow });
        } else {
          const nextNow = pendingExportFollowupNow;
          pendingExportFollowup = false;
          pendingExportFollowupNow = undefined;
          autoFollowups++;
          status = await runSyncOnceAsync({ force: true, now: nextNow });
        }
      }
      return status;
    })().finally(() => {
      if (inFlightSync === task) inFlightSync = null;
    });
    inFlightSync = task;
    return task;
  }

  function invalidate() {
    syncEpoch++;
    pendingForce = false;
    pendingForceNow = undefined;
    pendingExportFollowup = false;
    pendingExportFollowupNow = undefined;
    lastExportRev = -1;
    lastPublishedManifestHash = '';
    cachedLocalShards.clear();
    publishedShardMeta.clear();
    try { activeAbortController?.abort(); } catch {}
    const cfg = settings.get()?.multiMachineSync || {};
    if (!cfg.enabled || !String(cfg.syncDir || '').trim()) {
      lastState = 'disabled';
      lastError = '';
    } else if (lastState === 'syncing') {
      lastState = 'ok';
      lastError = '';
    }
  }

  function stop() {
    stopped = true;
    syncEpoch++;
    pendingForce = false;
    pendingForceNow = undefined;
    pendingExportFollowup = false;
    pendingExportFollowupNow = undefined;
    try { activeAbortController?.abort(); } catch {}
  }

  async function whenIdle(timeoutMs = 1500) {
    const active = inFlightSync;
    if (!active) return;
    const cap = Number(timeoutMs);
    if (!Number.isFinite(cap) || cap <= 0) {
      try { await active; } catch {}
      return;
    }
    let timer;
    try {
      await Promise.race([
        active.catch(() => {}),
        new Promise(res => {
          timer = setTimeout(res, cap);
          timer.unref?.();
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function clearRemoteData() {
    invalidate();
    const res = store.clearRemoteData();
    return { ...res, status: getStatus() };
  }

  async function clearRemoteDataAsync() {
    invalidate();
    await whenIdle(1500);
    if (!isStoreAvailable()) {
      return { removedSources: 0, removedPeers: 0, status: getStatus() };
    }
    const res = store.clearRemoteData();
    const cfg = settings.get()?.multiMachineSync || {};
    if (lastState === 'syncing') {
      lastState = (cfg.enabled && String(cfg.syncDir || '').trim()) ? 'ok' : 'disabled';
      lastError = '';
    }
    return { ...res, status: getStatus() };
  }

  function getStatus(now = Date.now(), { refreshSuggested = true } = {}) {
    const cfg = settings.get()?.multiMachineSync || {};
    const enabled = Boolean(cfg.enabled);
    const syncDir = String(cfg.syncDir || '').trim();
    const peers = isStoreAvailable() ? (store.listSyncPeers?.() || []) : [];
    const remoteRequestsCount = peers.reduce((sum, p) => sum + (Number(p.requestCount) || 0), 0);
    if (refreshSuggested && !stopped && (!suggestedDirsUpdatedAtMs || Date.now() - suggestedDirsUpdatedAtMs > SUGGESTED_DIRS_CACHE_TTL_MS)) {
      refreshSuggestedDirsAsync();
    }
    return {
      enabled,
      syncDir,
      machineId: cachedLocalMachineId || (isStoreAvailable() ? getLocalMachineId({ createIfMissing: false }) : ''),
      machineLabel: getLocalMachineLabel(cfg),
      defaultMachineLabel: getDefaultMachineLabel(),
      state: !enabled ? 'disabled' : (!syncDir ? 'unconfigured' : lastState),
      lastSyncAtMs: lastSyncAtMs || null,
      lastExportedRequests,
      remoteMachinesCount: peers.length,
      remoteRequestsCount,
      peers,
      suggestedDirs: suggestedDirsCache,
      lastError,
      checkedAtMs: now
    };
  }

  return {
    getLocalMachineId,
    getLocalMachineLabel,
    sync,
    syncAsync,
    invalidate,
    stop,
    whenIdle,
    clearRemoteData,
    clearRemoteDataAsync,
    getStatus
  };
}
