import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, hostname, platform as osPlatform, arch as osArch } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import zlib from 'node:zlib';

export const FOLDER_SYNC_SCHEMA_VERSION = 1;
const MAX_SHARD_COMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_SHARD_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
const SHARD_FILE_RE = /^(\d{4}-\d{2})\.ndjson\.gz$/;
const SAFE_MACHINE_DIR_RE = /^[A-Za-z0-9._-]{4,80}$/;

function sha256Hex(bufOrStr) {
  return createHash('sha256').update(bufOrStr).digest('hex');
}

function monthKeyUtc(tsMs) {
  const n = Number(tsMs);
  if (!Number.isFinite(n) || n <= 0) return '1970-01';
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

function safeReadJson(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
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
  let lastExportedRequests = 0;
  let lastState = 'disabled';
  let lastError = '';

  function getLocalMachineId() {
    if (cachedLocalMachineId) return cachedLocalMachineId;
    const saved = sanitizeMachineId(store.getMeta?.('local_machine_id'));
    if (saved) {
      cachedLocalMachineId = saved;
      return saved;
    }
    const generated = `m-${randomUUID()}`;
    store.setMeta?.('local_machine_id', generated);
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

  function exportLocalMachine(machinesRoot, syncCfg, now) {
    const machineId = getLocalMachineId();
    const machineLabel = getLocalMachineLabel(syncCfg);
    const machineDir = join(machinesRoot, machineId);
    const manifestPath = join(machineDir, 'manifest.json');

    const rev = typeof store.getLocalRevision === 'function' ? store.getLocalRevision() : store.getRevision();
    const privacySig = `${syncCfg.syncDir}|${machineLabel}|${Boolean(syncCfg.includeThreadTitle)}|${Boolean(syncCfg.includeErrorText)}`;
    const existingManifest = safeReadJson(manifestPath);
    if (existingManifest && lastExportRev === rev && lastExportSig === privacySig) {
      return { exported: false, totalRequests: lastExportedRequests, writtenShards: 0 };
    }

    mkdirSync(machineDir, { recursive: true });
    const localRows = store.listLocalRequests();
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

    const prevShards = existingManifest?.shards && typeof existingManifest.shards === 'object' ? existingManifest.shards : {};
    const nextShards = {};
    let writtenShards = 0;

    for (const [mKey, rows] of [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      rows.sort((a, b) => (a.timestampMs - b.timestampMs) || String(a.id).localeCompare(String(b.id)));
      const ndjson = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
      const contentHash = sha256Hex(ndjson);
      const fileName = `${mKey}.ndjson.gz`;
      const shardPath = join(machineDir, fileName);
      const prev = prevShards[mKey];

      let compressedBytes = Number(prev?.bytes) || 0;
      if (!prev || prev.sha256 !== contentHash || !existsSync(shardPath)) {
        const gz = zlib.gzipSync(Buffer.from(ndjson, 'utf8'), { level: 6 });
        atomicWriteBuffer(shardPath, gz);
        compressedBytes = gz.length;
        writtenShards++;
      }
      nextShards[mKey] = {
        file: fileName,
        sha256: contentHash,
        count: rows.length,
        bytes: compressedBytes
      };
    }

    // Remove obsolete local shard files if months disappeared
    try {
      for (const name of readdirSync(machineDir)) {
        const m = name.match(SHARD_FILE_RE);
        if (m && !nextShards[m[1]]) {
          try { unlinkSync(join(machineDir, name)); } catch {}
        }
      }
    } catch {}

    const manifestPayload = {
      schemaVersion: FOLDER_SYNC_SCHEMA_VERSION,
      machineId,
      machineLabel,
      platform: `${osPlatform()}-${osArch()}`,
      appVersion,
      exportedAtMs: now,
      totalRequests: localRows.length,
      shards: nextShards
    };
    const manifestChanged = !existingManifest ||
      writtenShards > 0 ||
      existingManifest.machineLabel !== machineLabel ||
      existingManifest.totalRequests !== localRows.length ||
      Object.keys(prevShards).length !== Object.keys(nextShards).length;

    if (manifestChanged) {
      atomicWriteBuffer(manifestPath, Buffer.from(JSON.stringify(manifestPayload, null, 2) + '\n', 'utf8'));
    }

    lastExportRev = rev;
    lastExportSig = privacySig;
    lastExportedRequests = localRows.length;
    return { exported: manifestChanged, totalRequests: localRows.length, writtenShards };
  }

  function importRemoteMachines(machinesRoot, now) {
    const localMachineId = getLocalMachineId();
    if (!existsSync(machinesRoot)) {
      return { discoveredPeers: 0, importedShards: 0, errors: [] };
    }

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
      const manifest = safeReadJson(join(peerDir, 'manifest.json'));
      if (!manifest || Number(manifest.schemaVersion) !== FOLDER_SYNC_SCHEMA_VERSION) continue;

      const peerId = sanitizeMachineId(manifest.machineId);
      if (!peerId || peerId === localMachineId || peerId !== entry.name) continue;

      const peerLabel = String(manifest.machineLabel || peerId).trim().slice(0, 64) || peerId;
      activePeerIds.add(peerId);

      const shards = manifest.shards && typeof manifest.shards === 'object' ? manifest.shards : {};
      const activeShardSources = new Set();
      let peerError = '';
      let peerRequestCount = 0;

      for (const [monthKey, meta] of Object.entries(shards)) {
        if (!meta || typeof meta !== 'object') continue;
        const fileName = String(meta.file || '');
        const fileMatch = fileName.match(SHARD_FILE_RE);
        if (!fileMatch || fileMatch[1] !== monthKey) continue;

        const expectedHash = String(meta.sha256 || '').trim().toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(expectedHash)) continue;

        const sourceKey = `remote:${peerId}:${monthKey}`;
        activeShardSources.add(sourceKey);
        const stamp = `${expectedHash}:${peerLabel}`;
        const existingStamp = store.getSourceStamp(sourceKey);

        if (existingStamp === stamp) {
          peerRequestCount += Math.max(0, Math.trunc(Number(meta.count) || 0));
          continue;
        }

        const shardPath = join(peerDir, fileName);
        try {
          if (!existsSync(shardPath)) {
            peerError = `分片尚未同步完成: ${fileName}`;
            continue;
          }
          const st = statSync(shardPath);
          if (st.size > MAX_SHARD_COMPRESSED_BYTES) {
            peerError = `分片超过体积上限: ${fileName}`;
            continue;
          }
          const rawBuf = readFileSync(shardPath);
          const ndjsonBuf = zlib.gunzipSync(rawBuf, { maxOutputLength: MAX_SHARD_UNCOMPRESSED_BYTES });
          const ndjson = ndjsonBuf.toString('utf8');
          const actualHash = sha256Hex(ndjson);
          if (actualHash !== expectedHash) {
            peerError = `分片校验未通过（可能仍在同步中）: ${fileName}`;
            continue;
          }

          const rows = [];
          for (const rawLine of ndjson.split('\n')) {
            const line = rawLine.trim();
            if (!line) continue;
            const parsed = parseRemoteRequestLine(line, peerId, peerLabel);
            if (parsed) rows.push(parsed);
          }

          store.replaceSourceRequests(sourceKey, stamp, rows, {
            machineId: peerId,
            machineLabel: peerLabel,
            isRemote: true
          });
          peerRequestCount += rows.length;
          importedShards++;
        } catch (err) {
          peerError = err?.message || `解析分片失败: ${fileName}`;
        }
      }

      // Only prune missing shards for this peer when no transient read/sync error occurred
      if (!peerError) {
        store.pruneMissingSources(`remote:${peerId}:`, activeShardSources);
      } else {
        errors.push(`${peerLabel}: ${peerError}`);
      }

      store.upsertSyncPeer({
        machineId: peerId,
        machineLabel: peerLabel,
        platform: String(manifest.platform || ''),
        appVersion: String(manifest.appVersion || ''),
        requestCount: peerRequestCount || Math.max(0, Math.trunc(Number(manifest.totalRequests) || 0)),
        lastExportedAtMs: Number.isFinite(Number(manifest.exportedAtMs)) ? Number(manifest.exportedAtMs) : null,
        lastImportedAtMs: now,
        status: peerError ? 'partial' : 'ok',
        lastError: peerError
      });
    }

    // Prune peers that were cleanly removed from the sync directory
    const removedPeers = store.pruneMissingSyncPeers(activePeerIds);
    for (const staleId of removedPeers) {
      store.deleteSourcesByPrefix(`remote:${staleId}:`);
    }

    return { discoveredPeers: activePeerIds.size, importedShards, errors };
  }

  function sync({ force = false, now = Date.now() } = {}) {
    const cfg = settings.get()?.multiMachineSync || {};
    const syncDir = String(cfg.syncDir || '').trim();
    if (!cfg.enabled || !syncDir) {
      lastState = 'disabled';
      lastError = '';
      return getStatus(now);
    }

    const minInterval = Math.max(10000, Number(cfg.syncIntervalMs) || 30000);
    if (!force && lastSyncAtMs > 0 && now - lastSyncAtMs < minInterval) {
      return getStatus(now);
    }

    lastState = 'syncing';
    lastError = '';
    try {
      const resolvedDir = resolve(syncDir);
      const machinesRoot = join(resolvedDir, 'machines');
      mkdirSync(machinesRoot, { recursive: true });

      exportLocalMachine(machinesRoot, cfg, now);
      const imported = importRemoteMachines(machinesRoot, now);
      lastSyncAtMs = now;
      if (imported.errors.length) {
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
    }
    return getStatus(now);
  }

  function clearRemoteData() {
    const res = store.clearRemoteData();
    lastExportRev = -1;
    return { ...res, status: getStatus() };
  }

  function getStatus(now = Date.now()) {
    const cfg = settings.get()?.multiMachineSync || {};
    const enabled = Boolean(cfg.enabled);
    const syncDir = String(cfg.syncDir || '').trim();
    const peers = store.listSyncPeers?.() || [];
    const remoteRequestsCount = peers.reduce((sum, p) => sum + (Number(p.requestCount) || 0), 0);
    return {
      enabled,
      syncDir,
      machineId: getLocalMachineId(),
      machineLabel: getLocalMachineLabel(cfg),
      defaultMachineLabel: getDefaultMachineLabel(),
      state: !enabled ? 'disabled' : (!syncDir ? 'unconfigured' : lastState),
      lastSyncAtMs: lastSyncAtMs || null,
      lastExportedRequests,
      remoteMachinesCount: peers.length,
      remoteRequestsCount,
      peers,
      suggestedDirs: detectSuggestedSyncDirs({ env, home: paths?.home }),
      lastError,
      checkedAtMs: now
    };
  }

  return {
    getLocalMachineId,
    getLocalMachineLabel,
    sync,
    clearRemoteData,
    getStatus
  };
}
