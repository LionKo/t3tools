import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

export const TELEMETRY_SCHEMA_VERSION = 4;
const MAX_SAFE_SQL_INT = Number.MAX_SAFE_INTEGER;
const MIN_SAFE_SQL_INT = -Number.MAX_SAFE_INTEGER;
const WORKER_REMOTE_REPLACE_THRESHOLD = 5000;
// Process-wide map of active OS-kernel export locks keyed by `<dbPath>|<scopeKey>`.
// Guarantees mutual exclusion for both same-process handles and cross-process writers
// until finally() settles any pending rename/unlink, with automatic OS release on crash.
const activeProcessExportLocks = new Map();

function sanitizeSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const t = Math.trunc(n);
  if (t > MAX_SAFE_SQL_INT || t < MIN_SAFE_SQL_INT) return fallback;
  return t;
}

const REMOTE_REPLACE_WORKER_CODE = `
import { workerData, parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

const { dbPath, items, machineId, machineLabel, isRemote, peer, peerPrefix, expectedPeerStamps, expectedPeerGen, pruneActiveKeys, cancelBuf } = workerData;
const cancelArr = new Int32Array(cancelBuf);
const db = new DatabaseSync(dbPath);
try {
  db.exec('PRAGMA busy_timeout = 3000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  const deleteBySourceStmt = db.prepare('DELETE FROM requests WHERE source_key = ?');
  const deleteSourceStmt = db.prepare('DELETE FROM source_files WHERE source_key = ?');
  const listStampsByPrefixStmt = db.prepare('SELECT source_key, stamp FROM source_files WHERE substr(source_key, 1, length(?)) = ? ORDER BY source_key ASC');
  const getMetaStmt = db.prepare('SELECT value FROM store_meta WHERE key = ?');
  const setMetaStmt = db.prepare(\`
    INSERT INTO store_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  \`);
  const upsertFileStmt = db.prepare(\`
    INSERT INTO source_files (source_key, stamp, updated_at_ms)
    VALUES (?, ?, ?)
    ON CONFLICT(source_key) DO UPDATE SET stamp = excluded.stamp, updated_at_ms = excluded.updated_at_ms
  \`);
  const upsertPeerStmt = db.prepare(\`
    INSERT INTO sync_peers (
      machine_id, machine_label, platform, app_version, request_count,
      last_exported_at_ms, last_imported_at_ms, status, last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(machine_id) DO UPDATE SET
      machine_label = excluded.machine_label,
      platform = excluded.platform,
      app_version = excluded.app_version,
      request_count = excluded.request_count,
      last_exported_at_ms = excluded.last_exported_at_ms,
      last_imported_at_ms = excluded.last_imported_at_ms,
      status = excluded.status,
      last_error = excluded.last_error
  \`);
  const upsertRequestStmt = db.prepare(\`
    INSERT INTO requests (
      id, dedupe_key, source_key, machine_id, machine_label, is_remote,
      provider_driver, account_id, t3_thread_id, t3_thread_title,
      native_session_id, model_id, model_raw, effort, role, timestamp_ms, billing_ts_ms,
      input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, thinking_tokens,
      context_used_tokens, context_max_tokens, ttft_ms, streaming_ms, duration_ms,
      tps, tps_kind, tps_estimated, cost_usd, saved_usd, status, outcome_known,
      retries, error_code, error_text, compaction_before
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      dedupe_key = CASE WHEN excluded.is_remote = 1 THEN excluded.dedupe_key ELSE COALESCE(excluded.dedupe_key, requests.dedupe_key) END,
      source_key = CASE
        WHEN excluded.source_key LIKE '%' || excluded.native_session_id || '%' THEN excluded.source_key
        WHEN excluded.is_remote = 1 THEN excluded.source_key
        ELSE requests.source_key
      END,
      machine_id = excluded.machine_id,
      machine_label = CASE WHEN excluded.is_remote = 1 THEN excluded.machine_label WHEN excluded.machine_label != '' THEN excluded.machine_label ELSE requests.machine_label END,
      is_remote = excluded.is_remote,
      provider_driver = CASE WHEN excluded.is_remote = 1 THEN excluded.provider_driver ELSE requests.provider_driver END,
      account_id = CASE WHEN excluded.is_remote = 1 THEN excluded.account_id ELSE requests.account_id END,
      t3_thread_id = CASE WHEN excluded.is_remote = 1 THEN excluded.t3_thread_id ELSE COALESCE(excluded.t3_thread_id, requests.t3_thread_id) END,
      t3_thread_title = CASE WHEN excluded.is_remote = 1 THEN excluded.t3_thread_title WHEN excluded.t3_thread_title != '' THEN excluded.t3_thread_title ELSE requests.t3_thread_title END,
      native_session_id = CASE WHEN excluded.is_remote = 1 THEN excluded.native_session_id ELSE requests.native_session_id END,
      model_id = CASE WHEN excluded.is_remote = 1 THEN excluded.model_id ELSE requests.model_id END,
      model_raw = CASE WHEN excluded.is_remote = 1 THEN excluded.model_raw ELSE requests.model_raw END,
      effort = CASE WHEN excluded.is_remote = 1 THEN excluded.effort ELSE requests.effort END,
      role = CASE WHEN excluded.is_remote = 1 THEN excluded.role ELSE requests.role END,
      timestamp_ms = CASE WHEN excluded.is_remote = 1 THEN excluded.timestamp_ms ELSE requests.timestamp_ms END,
      billing_ts_ms = excluded.billing_ts_ms,
      input_tokens = excluded.input_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_write_tokens = excluded.cache_write_tokens,
      output_tokens = excluded.output_tokens,
      thinking_tokens = excluded.thinking_tokens,
      context_used_tokens = CASE WHEN excluded.is_remote = 1 THEN excluded.context_used_tokens ELSE COALESCE(excluded.context_used_tokens, requests.context_used_tokens) END,
      context_max_tokens = CASE WHEN excluded.is_remote = 1 THEN excluded.context_max_tokens ELSE COALESCE(excluded.context_max_tokens, requests.context_max_tokens) END,
      ttft_ms = CASE WHEN excluded.is_remote = 1 THEN excluded.ttft_ms ELSE COALESCE(excluded.ttft_ms, requests.ttft_ms) END,
      streaming_ms = CASE WHEN excluded.is_remote = 1 THEN excluded.streaming_ms ELSE COALESCE(excluded.streaming_ms, requests.streaming_ms) END,
      duration_ms = CASE WHEN excluded.is_remote = 1 THEN excluded.duration_ms ELSE COALESCE(excluded.duration_ms, requests.duration_ms) END,
      tps = CASE WHEN excluded.is_remote = 1 THEN excluded.tps ELSE COALESCE(excluded.tps, requests.tps) END,
      tps_kind = excluded.tps_kind,
      tps_estimated = excluded.tps_estimated,
      cost_usd = excluded.cost_usd,
      saved_usd = excluded.saved_usd,
      status = excluded.status,
      outcome_known = excluded.outcome_known,
      retries = excluded.retries,
      error_code = excluded.error_code,
      error_text = excluded.error_text,
      compaction_before = excluded.compaction_before
  \`);

  const MAX_SAFE = Number.MAX_SAFE_INTEGER;
  const clamp = (v, fallback = 0) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    const t = Math.trunc(n);
    return (t > MAX_SAFE || t < -MAX_SAFE) ? fallback : t;
  };

  db.exec('BEGIN IMMEDIATE');
  let aborted = false;
  let conflict = false;
  const genKey = peerPrefix ? ('remote_import_gen:' + peerPrefix) : '';
  try {
    if (genKey && expectedPeerGen != null) {
      const curGen = Number(getMetaStmt.get(genKey)?.value) || 0;
      if (curGen !== Number(expectedPeerGen)) {
        conflict = true;
      }
    }
    if (!conflict && peerPrefix && Array.isArray(expectedPeerStamps)) {
      const curStamps = listStampsByPrefixStmt.all(peerPrefix, peerPrefix);
      if (curStamps.length !== expectedPeerStamps.length) {
        conflict = true;
      } else {
        for (let i = 0; i < curStamps.length; i++) {
          if (curStamps[i].source_key !== expectedPeerStamps[i][0] || curStamps[i].stamp !== expectedPeerStamps[i][1]) {
            conflict = true;
            break;
          }
        }
      }
    }
    if (conflict) {
      db.exec('ROLLBACK');
      parentPort.postMessage({ ok: false, conflict: true, error: '远端分片已被其他进程更新，需重新同步' });
    } else {
    let processed = 0;
    for (const item of items) {
      if (Atomics.load(cancelArr, 0) !== 0) {
        aborted = true;
        break;
      }
      const { sourceKey, stamp, rows } = item;
      deleteBySourceStmt.run(sourceKey);
      for (let i = 0; i < rows.length; i++) {
        if ((processed & 511) === 0 && Atomics.load(cancelArr, 0) !== 0) {
          aborted = true;
          break;
        }
        processed++;
        const r = rows[i];
        const ts = clamp(r.timestampMs || 0, 0);
        const billingTs = clamp(r.billingTsMs ?? ts, ts);
        const rowMachineId = String(r.machineId || machineId || 'local');
        const rowMachineLabel = String(r.machineLabel ?? machineLabel ?? '');
        const rowIsRemote = (r.isRemote != null ? Boolean(r.isRemote) : Boolean(isRemote)) ? 1 : 0;
        upsertRequestStmt.run(
          r.id,
          r.dedupeKey || null,
          sourceKey,
          rowMachineId,
          rowMachineLabel,
          rowIsRemote,
          r.providerDriver,
          r.accountId,
          r.t3ThreadId || null,
          r.t3ThreadTitle ?? '',
          r.nativeSessionId,
          r.modelId,
          r.modelRaw || r.modelId,
          r.effort || '',
          r.role || '',
          ts,
          billingTs,
          clamp(r.inputTokens || 0),
          clamp(r.cacheReadTokens || 0),
          clamp(r.cacheWriteTokens || 0),
          clamp(r.outputTokens || 0),
          clamp(r.thinkingTokens || 0),
          r.contextUsedTokens != null ? clamp(r.contextUsedTokens) : null,
          r.contextMaxTokens != null ? clamp(r.contextMaxTokens) : null,
          r.ttftMs != null ? clamp(r.ttftMs) : null,
          r.streamingMs != null ? clamp(r.streamingMs) : null,
          r.durationMs != null ? clamp(r.durationMs) : null,
          r.tps != null ? Number(r.tps) : null,
          r.tpsKind || (r.tps != null ? (r.tpsEstimated ? 'e2e-estimate' : 'generation') : 'none'),
          r.tpsEstimated ? 1 : 0,
          r.costUsd != null ? Number(r.costUsd) : null,
          r.savedUsd != null ? Number(r.savedUsd) : null,
          r.status || 'success',
          r.outcomeKnown === false ? 0 : 1,
          clamp(r.retries || 0),
          r.errorCode || '',
          r.errorText || '',
          r.compactionBefore ? 1 : 0
        );
      }
      if (aborted) break;
      upsertFileStmt.run(sourceKey, stamp, Date.now());
    }
    if (aborted || Atomics.load(cancelArr, 0) !== 0) {
      db.exec('ROLLBACK');
      parentPort.postMessage({ ok: false, aborted: true });
    } else {
      if (peerPrefix && Array.isArray(pruneActiveKeys)) {
        const activeSet = new Set(pruneActiveKeys);
        for (const row of listStampsByPrefixStmt.all(peerPrefix, peerPrefix)) {
          if (!activeSet.has(row.source_key)) {
            deleteBySourceStmt.run(row.source_key);
            deleteSourceStmt.run(row.source_key);
          }
        }
      }
      if (peer && peer.machineId) {
        const reqCount = Math.max(0, clamp(peer.requestCount || 0, 0));
        const exportedAt = peer.lastExportedAtMs != null && Number.isFinite(Number(peer.lastExportedAtMs))
          ? clamp(peer.lastExportedAtMs, null)
          : null;
        const importedAt = peer.lastImportedAtMs != null && Number.isFinite(Number(peer.lastImportedAtMs))
          ? clamp(peer.lastImportedAtMs, Date.now())
          : Date.now();
        upsertPeerStmt.run(
          String(peer.machineId),
          String(peer.machineLabel || peer.machineId),
          String(peer.platform || ''),
          String(peer.appVersion || ''),
          reqCount,
          exportedAt,
          importedAt,
          String(peer.status || 'ok'),
          String(peer.lastError || '')
        );
      }
      if (genKey) {
        const curGen = Number(getMetaStmt.get(genKey)?.value) || 0;
        setMetaStmt.run(genKey, String(curGen + 1));
      }
      db.exec('COMMIT');
      parentPort.postMessage({ ok: true, aborted: false });
    }
    }
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    parentPort.postMessage({ ok: false, error: err?.message || String(err) });
  }
} finally {
  try { db.close(); } catch {}
}
`;

/**
 * Own persistent SQLite cache & history store (~/.t3tools/telemetry.sqlite).
 * Versioned schema ensures older indexed rows are cleanly rebuilt when parser
 * logic improves, and provides indexed lookups for fast live polling & analytics.
 */
export function createTelemetryStore(dbPath) {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  try {
    const store = initializeStore(db, dbPath);
    db.exec('COMMIT');
    return store;
  } catch (err) {
    db.close(); // Rolls back schema changes if DDL or statement preparation fails.
    throw err;
  }
}

function initializeStore(db, dbPath = '') {
  db.exec(`
    PRAGMA busy_timeout = 3000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    BEGIN IMMEDIATE;

    CREATE TABLE IF NOT EXISTS store_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const curSchemaRow = db.prepare("SELECT value FROM store_meta WHERE key = 'schema_version'").get();
  const curSchemaVersion = curSchemaRow ? Number(curSchemaRow.value) : 0;
  if (curSchemaVersion > TELEMETRY_SCHEMA_VERSION) throw new Error('Unsupported newer telemetry schema');
  if (curSchemaVersion === 3) {
    // Lossless in-place migration v3 -> v4: preserve indexed local requests & source_files
    // so upgrading never forces a 30s+ full rescan on startup.
    const existingCols = new Set(db.prepare('PRAGMA table_info(requests)').all().map(c => c.name));
    if (existingCols.size > 0) {
      if (!existingCols.has('machine_id')) db.exec("ALTER TABLE requests ADD COLUMN machine_id TEXT NOT NULL DEFAULT 'local'");
      if (!existingCols.has('machine_label')) db.exec("ALTER TABLE requests ADD COLUMN machine_label TEXT NOT NULL DEFAULT ''");
      if (!existingCols.has('is_remote')) db.exec('ALTER TABLE requests ADD COLUMN is_remote INTEGER NOT NULL DEFAULT 0');
    }
    db.prepare("INSERT INTO store_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(TELEMETRY_SCHEMA_VERSION));
  } else if (curSchemaVersion !== TELEMETRY_SCHEMA_VERSION) {
    db.exec(`
      DROP TABLE IF EXISTS requests;
      DROP TABLE IF EXISTS source_files;
      DROP TABLE IF EXISTS sync_peers;
    `);
    db.prepare("INSERT INTO store_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(TELEMETRY_SCHEMA_VERSION));
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS source_files (
      source_key TEXT PRIMARY KEY,
      stamp TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      dedupe_key TEXT,
      source_key TEXT NOT NULL,
      machine_id TEXT NOT NULL DEFAULT 'local',
      machine_label TEXT NOT NULL DEFAULT '',
      is_remote INTEGER NOT NULL DEFAULT 0,
      provider_driver TEXT NOT NULL,
      account_id TEXT NOT NULL,
      t3_thread_id TEXT,
      t3_thread_title TEXT,
      native_session_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model_raw TEXT NOT NULL,
      effort TEXT,
      role TEXT,
      timestamp_ms INTEGER NOT NULL,
      billing_ts_ms INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      thinking_tokens INTEGER NOT NULL DEFAULT 0,
      context_used_tokens INTEGER,
      context_max_tokens INTEGER,
      ttft_ms INTEGER,
      streaming_ms INTEGER,
      duration_ms INTEGER,
      tps REAL,
      tps_kind TEXT NOT NULL DEFAULT 'none',
      tps_estimated INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL,
      saved_usd REAL,
      status TEXT NOT NULL,
      outcome_known INTEGER NOT NULL DEFAULT 1,
      retries INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_text TEXT,
      compaction_before INTEGER NOT NULL DEFAULT 0
    );

    DROP INDEX IF EXISTS idx_requests_remote_ts;
    DROP INDEX IF EXISTS idx_requests_local_incidents_ts;
    CREATE INDEX IF NOT EXISTS idx_requests_status_ts ON requests(status, timestamp_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_requests_errcode_ts ON requests(error_code, timestamp_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(timestamp_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_requests_billing_ts ON requests(billing_ts_ms);
    CREATE INDEX IF NOT EXISTS idx_requests_source ON requests(source_key);
    CREATE INDEX IF NOT EXISTS idx_requests_machine_ts ON requests(machine_id, timestamp_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_requests_remote_billing ON requests(is_remote, billing_ts_ms);
    CREATE INDEX IF NOT EXISTS idx_requests_local_incidents_v2_ts ON requests(is_remote, timestamp_ms DESC) WHERE is_remote = 0 AND (status = 'error' OR retries > 0);
    CREATE INDEX IF NOT EXISTS idx_requests_local_session_ts ON requests(native_session_id, timestamp_ms DESC) WHERE is_remote = 0;
    CREATE INDEX IF NOT EXISTS idx_requests_local_thread_ts ON requests(t3_thread_id, timestamp_ms DESC) WHERE is_remote = 0;
    CREATE INDEX IF NOT EXISTS idx_requests_thread_ts ON requests(t3_thread_id, timestamp_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_requests_session_ts ON requests(native_session_id, timestamp_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_requests_account_ts ON requests(account_id, timestamp_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_requests_dedupe ON requests(dedupe_key);

    CREATE TABLE IF NOT EXISTS sync_peers (
      machine_id TEXT PRIMARY KEY,
      machine_label TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL DEFAULT '',
      app_version TEXT NOT NULL DEFAULT '',
      request_count INTEGER NOT NULL DEFAULT 0,
      last_exported_at_ms INTEGER,
      last_imported_at_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'ok',
      last_error TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS local_change_counter (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      seq INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO local_change_counter (id, seq) VALUES (1, 0);

    CREATE TRIGGER IF NOT EXISTS trg_requests_local_ins
    AFTER INSERT ON requests
    WHEN NEW.is_remote = 0
    BEGIN
      UPDATE local_change_counter SET seq = seq + 1 WHERE id = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_requests_local_upd
    AFTER UPDATE ON requests
    WHEN NEW.is_remote = 0 OR OLD.is_remote = 0
    BEGIN
      UPDATE local_change_counter SET seq = seq + 1 WHERE id = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_requests_local_del
    AFTER DELETE ON requests
    WHEN OLD.is_remote = 0
    BEGIN
      UPDATE local_change_counter SET seq = seq + 1 WHERE id = 1;
    END;

    CREATE TABLE IF NOT EXISTS quota_snapshots (
      window_key TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      driver TEXT NOT NULL,
      window_id TEXT NOT NULL,
      label TEXT NOT NULL,
      kind TEXT NOT NULL,
      used_percent REAL,
      resets_at_ms INTEGER,
      window_duration_mins INTEGER,
      observed_at_ms INTEGER NOT NULL
    );
  `);

  let revision = 1;
  let localRevision = 1;
  let closed = false;
  let activeRemoteWorkerCount = 0;
  let nonBlockingDepth = 0;
  // null means full-month verification is required (initial boot or external DB write)
  let dirtyLocalMonths = null;
  const MAX_VALID_TS_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

  function monthKeyFromTs(tsMs) {
    const n = Number(tsMs);
    if (!Number.isFinite(n) || n <= 0 || n > MAX_VALID_TS_MS) return '1970-01';
    const d = new Date(n);
    if (Number.isNaN(d.getTime())) return '1970-01';
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  function markDirtyMonth(monthKey) {
    if (dirtyLocalMonths !== null && monthKey) {
      dirtyLocalMonths.add(monthKey);
    }
  }

  const getMetaStmt = db.prepare('SELECT value FROM store_meta WHERE key = ?');
  const setMetaStmt = db.prepare('INSERT OR REPLACE INTO store_meta(key, value) VALUES (?, ?)');
  const deleteMetaStmt = db.prepare('DELETE FROM store_meta WHERE key = ?');
  const listMetaByPrefixStmt = db.prepare('SELECT key, value FROM store_meta WHERE key LIKE ?');
  const deleteMetaByPrefixStmt = db.prepare('DELETE FROM store_meta WHERE key LIKE ?');
  const getLocalChangeSeqStmt = db.prepare('SELECT seq FROM local_change_counter WHERE id = 1');
  const getFileStmt = db.prepare('SELECT stamp FROM source_files WHERE source_key = ?');
  const upsertFileStmt = db.prepare(`
    INSERT INTO source_files (source_key, stamp, updated_at_ms)
    VALUES (?, ?, ?)
    ON CONFLICT(source_key) DO UPDATE SET stamp = excluded.stamp, updated_at_ms = excluded.updated_at_ms
  `);
  const deleteBySourceStmt = db.prepare('DELETE FROM requests WHERE source_key = ?');
  const countBySourceStmt = db.prepare('SELECT COUNT(*) AS n FROM requests WHERE source_key = ?');
  const listIdsBySourceStmt = db.prepare('SELECT id FROM requests WHERE source_key = ?');
  const countByRemotePeerStmt = db.prepare('SELECT COUNT(*) AS n FROM requests WHERE is_remote = 1 AND machine_id = ?');
  const getSourceByIdStmt = db.prepare('SELECT source_key FROM requests WHERE id = ?');
  const deleteSourceStmt = db.prepare('DELETE FROM source_files WHERE source_key = ?');
  const listSourcesStmt = db.prepare('SELECT source_key FROM source_files');
  const listSourceStampsByPrefixStmt = db.prepare('SELECT source_key, stamp FROM source_files WHERE substr(source_key, 1, length(?)) = ? ORDER BY source_key ASC');
  const listRemoteRequestPeersStmt = db.prepare('SELECT DISTINCT machine_id FROM requests WHERE is_remote = 1');
  const deleteRemoteRequestsByPeerStmt = db.prepare('DELETE FROM requests WHERE is_remote = 1 AND machine_id = ?');
  const bumpAllRemoteImportGensStmt = db.prepare(`
    UPDATE store_meta
    SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
    WHERE substr(key, 1, 18) = 'remote_import_gen:'
  `);

  const upsertRequestStmt = db.prepare(`
    INSERT INTO requests (
      id, dedupe_key, source_key, machine_id, machine_label, is_remote,
      provider_driver, account_id, t3_thread_id, t3_thread_title,
      native_session_id, model_id, model_raw, effort, role, timestamp_ms, billing_ts_ms,
      input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, thinking_tokens,
      context_used_tokens, context_max_tokens, ttft_ms, streaming_ms, duration_ms,
      tps, tps_kind, tps_estimated, cost_usd, saved_usd, status, outcome_known,
      retries, error_code, error_text, compaction_before
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      dedupe_key = CASE WHEN excluded.is_remote = 1 THEN excluded.dedupe_key ELSE COALESCE(excluded.dedupe_key, requests.dedupe_key) END,
      -- Keep originating rollout as owner so deleting a fork never erases parent rows (fixes P1 #6)
      source_key = CASE
        WHEN excluded.source_key LIKE '%' || excluded.native_session_id || '%' THEN excluded.source_key
        WHEN excluded.is_remote = 1 THEN excluded.source_key
        ELSE requests.source_key
      END,
      machine_id = excluded.machine_id,
      machine_label = CASE WHEN excluded.is_remote = 1 THEN excluded.machine_label WHEN excluded.machine_label != '' THEN excluded.machine_label ELSE requests.machine_label END,
      is_remote = excluded.is_remote,
      provider_driver = CASE WHEN excluded.is_remote = 1 THEN excluded.provider_driver ELSE requests.provider_driver END,
      account_id = CASE WHEN excluded.is_remote = 1 THEN excluded.account_id ELSE requests.account_id END,
      t3_thread_id = CASE WHEN excluded.is_remote = 1 THEN excluded.t3_thread_id ELSE COALESCE(excluded.t3_thread_id, requests.t3_thread_id) END,
      t3_thread_title = CASE WHEN excluded.is_remote = 1 THEN excluded.t3_thread_title WHEN excluded.t3_thread_title != '' THEN excluded.t3_thread_title ELSE requests.t3_thread_title END,
      native_session_id = CASE WHEN excluded.is_remote = 1 THEN excluded.native_session_id ELSE requests.native_session_id END,
      model_id = CASE WHEN excluded.is_remote = 1 THEN excluded.model_id ELSE requests.model_id END,
      model_raw = CASE WHEN excluded.is_remote = 1 THEN excluded.model_raw ELSE requests.model_raw END,
      effort = CASE WHEN excluded.is_remote = 1 THEN excluded.effort ELSE requests.effort END,
      role = CASE WHEN excluded.is_remote = 1 THEN excluded.role ELSE requests.role END,
      timestamp_ms = CASE WHEN excluded.is_remote = 1 THEN excluded.timestamp_ms ELSE requests.timestamp_ms END,
      billing_ts_ms = excluded.billing_ts_ms,
      input_tokens = excluded.input_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_write_tokens = excluded.cache_write_tokens,
      output_tokens = excluded.output_tokens,
      thinking_tokens = excluded.thinking_tokens,
      context_used_tokens = CASE WHEN excluded.is_remote = 1 THEN excluded.context_used_tokens ELSE COALESCE(excluded.context_used_tokens, requests.context_used_tokens) END,
      context_max_tokens = CASE WHEN excluded.is_remote = 1 THEN excluded.context_max_tokens ELSE COALESCE(excluded.context_max_tokens, requests.context_max_tokens) END,
      ttft_ms = CASE WHEN excluded.is_remote = 1 THEN excluded.ttft_ms ELSE COALESCE(excluded.ttft_ms, requests.ttft_ms) END,
      streaming_ms = CASE WHEN excluded.is_remote = 1 THEN excluded.streaming_ms ELSE COALESCE(excluded.streaming_ms, requests.streaming_ms) END,
      duration_ms = CASE WHEN excluded.is_remote = 1 THEN excluded.duration_ms ELSE COALESCE(excluded.duration_ms, requests.duration_ms) END,
      tps = CASE WHEN excluded.is_remote = 1 THEN excluded.tps ELSE COALESCE(excluded.tps, requests.tps) END,
      tps_kind = excluded.tps_kind,
      tps_estimated = excluded.tps_estimated,
      cost_usd = excluded.cost_usd,
      saved_usd = excluded.saved_usd,
      status = excluded.status,
      outcome_known = excluded.outcome_known,
      retries = excluded.retries,
      error_code = excluded.error_code,
      error_text = excluded.error_text,
      compaction_before = excluded.compaction_before
  `);

  const updateLinkStmt = db.prepare(`
    UPDATE requests
    SET t3_thread_id = ?, t3_thread_title = ?, account_id = CASE WHEN ? != '' THEN ? ELSE account_id END
    WHERE is_remote = 0
      AND native_session_id = ?
      AND (
        t3_thread_id IS NULL OR t3_thread_id != ? OR t3_thread_title != ?
        OR (? != '' AND account_id != ?)
      )
  `);

  const upsertPeerStmt = db.prepare(`
    INSERT INTO sync_peers (
      machine_id, machine_label, platform, app_version, request_count,
      last_exported_at_ms, last_imported_at_ms, status, last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(machine_id) DO UPDATE SET
      machine_label = excluded.machine_label,
      platform = excluded.platform,
      app_version = excluded.app_version,
      request_count = excluded.request_count,
      last_exported_at_ms = excluded.last_exported_at_ms,
      last_imported_at_ms = excluded.last_imported_at_ms,
      status = excluded.status,
      last_error = excluded.last_error
  `);
  const listPeersStmt = db.prepare(`
    SELECT
      machine_id,
      machine_label,
      platform,
      app_version,
      CASE WHEN request_count > ${MAX_SAFE_SQL_INT} OR request_count < 0 THEN 0 ELSE request_count END AS request_count,
      CASE WHEN last_exported_at_ms > ${MAX_SAFE_SQL_INT} OR last_exported_at_ms < ${MIN_SAFE_SQL_INT} THEN NULL ELSE last_exported_at_ms END AS last_exported_at_ms,
      CASE WHEN last_imported_at_ms > ${MAX_SAFE_SQL_INT} OR last_imported_at_ms < ${MIN_SAFE_SQL_INT} THEN NULL ELSE last_imported_at_ms END AS last_imported_at_ms,
      status,
      last_error
    FROM sync_peers
    ORDER BY last_exported_at_ms DESC, machine_label ASC
  `);
  const deletePeerStmt = db.prepare('DELETE FROM sync_peers WHERE machine_id = ?');
  const clearPeersStmt = db.prepare('DELETE FROM sync_peers');

  const upsertQuotaStmt = db.prepare(`
    INSERT INTO quota_snapshots (
      window_key, account_id, driver, window_id, label, kind,
      used_percent, resets_at_ms, window_duration_mins, observed_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(window_key) DO UPDATE SET
      label = excluded.label,
      kind = excluded.kind,
      used_percent = excluded.used_percent,
      resets_at_ms = COALESCE(excluded.resets_at_ms, quota_snapshots.resets_at_ms),
      window_duration_mins = COALESCE(excluded.window_duration_mins, quota_snapshots.window_duration_mins),
      observed_at_ms = excluded.observed_at_ms
  `);

  // Use distinct output aliases (safe_timestamp_ms / safe_billing_ts_ms) so SQLite ORDER BY timestamp_ms
  // always resolves to the indexed table column rather than the computed expression (zero TEMP B-TREE).
  const SAFE_ROW_COLUMNS = `
    id, dedupe_key, source_key, machine_id, machine_label, is_remote,
    provider_driver, account_id, t3_thread_id, t3_thread_title,
    native_session_id, model_id, model_raw, effort, role,
    CASE WHEN timestamp_ms > ${MAX_SAFE_SQL_INT} OR timestamp_ms < ${MIN_SAFE_SQL_INT} THEN 0 ELSE timestamp_ms END AS safe_timestamp_ms,
    CASE WHEN billing_ts_ms > ${MAX_SAFE_SQL_INT} OR billing_ts_ms < ${MIN_SAFE_SQL_INT} THEN 0 ELSE billing_ts_ms END AS safe_billing_ts_ms,
    input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, thinking_tokens,
    context_used_tokens, context_max_tokens, ttft_ms, streaming_ms, duration_ms,
    tps, tps_kind, tps_estimated, cost_usd, saved_usd, status, outcome_known,
    retries, error_code, error_text, compaction_before
  `;
  const allRequestsStmt = db.prepare(`SELECT ${SAFE_ROW_COLUMNS} FROM requests ORDER BY timestamp_ms DESC`);
  const localRequestsStmt = db.prepare(`SELECT ${SAFE_ROW_COLUMNS} FROM requests WHERE is_remote = 0 ORDER BY timestamp_ms ASC, id ASC`);
  const localMonthCountsStmt = db.prepare(`
    SELECT
      CASE WHEN billing_ts_ms > 0 AND billing_ts_ms <= ${MAX_VALID_TS_MS}
        THEN strftime('%Y-%m', billing_ts_ms / 1000, 'unixepoch')
        ELSE '1970-01' END AS month_key,
      COUNT(*) AS cnt
    FROM requests
    WHERE is_remote = 0
    GROUP BY month_key
    ORDER BY month_key ASC
  `);
  const localRequestsByBillingRangeStmt = db.prepare(
    `SELECT ${SAFE_ROW_COLUMNS} FROM requests WHERE is_remote = 0 AND billing_ts_ms >= ? AND billing_ts_ms < ? ORDER BY timestamp_ms ASC, id ASC`
  );
  const localRequestsFallbackMonthStmt = db.prepare(
    `SELECT ${SAFE_ROW_COLUMNS} FROM requests WHERE is_remote = 0 AND (billing_ts_ms < ? OR billing_ts_ms > ${MAX_VALID_TS_MS}) ORDER BY timestamp_ms ASC, id ASC`
  );
  // Use unary +is_remote so SQLite always uses idx_requests_source (source_key=?) instead of scanning idx_requests_remote_billing
  const sourceLocalMonthsStmt = db.prepare(`
    SELECT DISTINCT
      CASE WHEN billing_ts_ms > 0 AND billing_ts_ms <= ${MAX_VALID_TS_MS}
        THEN strftime('%Y-%m', billing_ts_ms / 1000, 'unixepoch')
        ELSE '1970-01' END AS month_key
    FROM requests
    WHERE source_key = ? AND +is_remote = 0
  `);
  const sessionLocalMonthsStmt = db.prepare(`
    SELECT DISTINCT
      CASE WHEN billing_ts_ms > 0 AND billing_ts_ms <= ${MAX_VALID_TS_MS}
        THEN strftime('%Y-%m', billing_ts_ms / 1000, 'unixepoch')
        ELSE '1970-01' END AS month_key
    FROM requests
    WHERE native_session_id = ? AND +is_remote = 0
  `);
  const latestByThreadStmt = db.prepare(`SELECT ${SAFE_ROW_COLUMNS} FROM requests WHERE is_remote = 0 AND t3_thread_id = ? AND timestamp_ms <= ${MAX_SAFE_SQL_INT} ORDER BY timestamp_ms DESC LIMIT 1`);
  const latestBySessionStmt = db.prepare(`SELECT ${SAFE_ROW_COLUMNS} FROM requests WHERE is_remote = 0 AND native_session_id = ? AND timestamp_ms <= ${MAX_SAFE_SQL_INT} ORDER BY timestamp_ms DESC LIMIT 1`);
  const latestSuccessByThreadStmt = db.prepare(`SELECT ${SAFE_ROW_COLUMNS} FROM requests WHERE is_remote = 0 AND t3_thread_id = ? AND status = 'success' AND timestamp_ms <= ${MAX_SAFE_SQL_INT} ORDER BY timestamp_ms DESC LIMIT 1`);
  // Matches error-insights effective session key (t3ThreadId || nativeSessionId) for unlinked native rows (NULL or empty string)
  const latestSuccessByUnlinkedSessionStmt = db.prepare(`SELECT ${SAFE_ROW_COLUMNS} FROM requests WHERE is_remote = 0 AND (t3_thread_id IS NULL OR t3_thread_id = '') AND native_session_id = ? AND status = 'success' AND timestamp_ms <= ${MAX_SAFE_SQL_INT} ORDER BY timestamp_ms DESC LIMIT 1`);
  const recentByThreadStmt = db.prepare(`SELECT ${SAFE_ROW_COLUMNS} FROM requests WHERE is_remote = 0 AND t3_thread_id = ? AND timestamp_ms <= ${MAX_SAFE_SQL_INT} ORDER BY timestamp_ms DESC LIMIT ?`);
  const recentBySessionStmt = db.prepare(`SELECT ${SAFE_ROW_COLUMNS} FROM requests WHERE is_remote = 0 AND native_session_id = ? AND timestamp_ms <= ${MAX_SAFE_SQL_INT} ORDER BY timestamp_ms DESC LIMIT ?`);
  const countThreadUnreadStmt = db.prepare(`SELECT COUNT(*) AS n FROM requests WHERE is_remote = 0 AND t3_thread_id = ? AND status = 'error' AND timestamp_ms > ? AND timestamp_ms <= ${MAX_SAFE_SQL_INT}`);
  const threadIncidentsByThreadStmt = db.prepare(`SELECT ${SAFE_ROW_COLUMNS} FROM requests WHERE is_remote = 0 AND t3_thread_id = ? AND timestamp_ms >= ? AND timestamp_ms <= ${MAX_SAFE_SQL_INT} AND (status = 'error' OR retries > 0) ORDER BY timestamp_ms DESC LIMIT 50`);
  const threadIncidentsBySessionStmt = db.prepare(`SELECT ${SAFE_ROW_COLUMNS} FROM requests WHERE is_remote = 0 AND native_session_id = ? AND timestamp_ms >= ? AND timestamp_ms <= ${MAX_SAFE_SQL_INT} AND (status = 'error' OR retries > 0) ORDER BY timestamp_ms DESC LIMIT 50`);
  const localErrorRowsSinceStmt = db.prepare(`SELECT ${SAFE_ROW_COLUMNS} FROM requests WHERE is_remote = 0 AND timestamp_ms >= ? AND timestamp_ms <= ${MAX_SAFE_SQL_INT} AND (status = 'error' OR retries > 0) ORDER BY timestamp_ms DESC`);
  const listRolloutDedupeStmt = db.prepare("SELECT dedupe_key FROM requests WHERE is_remote = 0 AND source_key LIKE 'codex-rollout:%' AND dedupe_key IS NOT NULL");
  const sourceUsageCountsStmt = db.prepare("SELECT source_key, COUNT(*) AS cnt FROM requests WHERE is_remote = 0 AND source_key LIKE ? AND status != 'error' GROUP BY source_key");
  const rangeUsageSummaryStmt = db.prepare(`
    SELECT
      COUNT(*) AS requests,
      COALESCE(SUM(COALESCE(cost_usd, 0)), 0) AS cost_usd,
      COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS total_tokens
    FROM requests
    WHERE billing_ts_ms >= ? AND billing_ts_ms <= ?
  `);
  const rangeLocalUsageSummaryStmt = db.prepare(`
    SELECT
      COUNT(*) AS requests,
      COALESCE(SUM(COALESCE(cost_usd, 0)), 0) AS cost_usd,
      COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS total_tokens
    FROM requests
    WHERE is_remote = 0 AND billing_ts_ms >= ? AND billing_ts_ms <= ?
  `);
  const allQuotasStmt = db.prepare('SELECT * FROM quota_snapshots ORDER BY account_id, kind, window_id');

  const dataVersion = db.prepare('PRAGMA data_version');
  const nextBilling = db.prepare(`SELECT MIN(billing_ts_ms) AS ts FROM requests WHERE billing_ts_ms > ? AND billing_ts_ms <= ${MAX_SAFE_SQL_INT}`);
  let lastVersion = dataVersion.get().data_version;
  let lastLocalChangeSeq = Number(getLocalChangeSeqStmt.get()?.seq) || 0;
  function getRevision() {
    const version = dataVersion.get().data_version;
    if (version !== lastVersion) {
      lastVersion = version;
      revision++;
      // Only invalidate localRevision & dirtyLocalMonths when an external connection actually modified local rows
      const curLocalSeq = Number(getLocalChangeSeqStmt.get()?.seq) || 0;
      if (curLocalSeq !== lastLocalChangeSeq) {
        lastLocalChangeSeq = curLocalSeq;
        localRevision++;
        dirtyLocalMonths = null;
      }
    }
    return revision;
  }

  function getLocalRevision() {
    getRevision();
    return localRevision;
  }

  function takeDirtyLocalMonthsSnapshot() {
    getRevision();
    const rev = localRevision;
    if (dirtyLocalMonths === null) {
      dirtyLocalMonths = new Set();
      return { rev, dirtyMonths: null };
    }
    const taken = dirtyLocalMonths;
    dirtyLocalMonths = new Set();
    return { rev, dirtyMonths: taken };
  }

  function takeDirtyLocalMonths() {
    return takeDirtyLocalMonthsSnapshot().dirtyMonths;
  }

  function markLocalMonthsDirty(months) {
    if (months === null) {
      dirtyLocalMonths = null;
      return;
    }
    if (dirtyLocalMonths === null || !months) return;
    for (const m of months) {
      if (m) dirtyLocalMonths.add(m);
    }
  }

  function getSourceStamp(sourceKey) {
    return getFileStmt.get(sourceKey)?.stamp ?? null;
  }

  function replaceSourceRequests(sourceKey, stamp, rows, { machineId = 'local', machineLabel = '', isRemote = false, nonBlocking = false, peer = null } = {}) {
    let txStarted = false;
    if (nonBlocking) {
      withBusyTimeout(0, () => {
        db.exec('BEGIN IMMEDIATE');
        txStarted = true;
      });
    } else {
      db.exec('BEGIN IMMEDIATE');
      txStarted = true;
    }
    try {
      // Observe any prior external local writes BEFORE our commit advances local_change_counter
      if (!isRemote) getRevision();
      if (!isRemote && dirtyLocalMonths !== null) {
        for (const mRow of sourceLocalMonthsStmt.all(sourceKey)) {
          markDirtyMonth(mRow.month_key);
        }
      }
      deleteBySourceStmt.run(sourceKey);
      for (const r of rows) {
        const ts = sanitizeSafeInt(r.timestampMs || 0);
        const billingTs = sanitizeSafeInt(r.billingTsMs ?? ts, ts);
        const rowMachineId = String(r.machineId || machineId || 'local');
        const rowMachineLabel = String(r.machineLabel ?? machineLabel ?? '');
        const rowIsRemote = (r.isRemote != null ? Boolean(r.isRemote) : Boolean(isRemote)) ? 1 : 0;
        if (!rowIsRemote && dirtyLocalMonths !== null) {
          markDirtyMonth(monthKeyFromTs(billingTs));
        }
        upsertRequestStmt.run(
          r.id,
          r.dedupeKey || null,
          sourceKey,
          rowMachineId,
          rowMachineLabel,
          rowIsRemote,
          r.providerDriver,
          r.accountId,
          r.t3ThreadId || null,
          r.t3ThreadTitle ?? '',
          r.nativeSessionId,
          r.modelId,
          r.modelRaw || r.modelId,
          r.effort || '',
          r.role || '',
          ts,
          billingTs,
          sanitizeSafeInt(r.inputTokens || 0),
          sanitizeSafeInt(r.cacheReadTokens || 0),
          sanitizeSafeInt(r.cacheWriteTokens || 0),
          sanitizeSafeInt(r.outputTokens || 0),
          sanitizeSafeInt(r.thinkingTokens || 0),
          r.contextUsedTokens != null ? sanitizeSafeInt(r.contextUsedTokens) : null,
          r.contextMaxTokens != null ? sanitizeSafeInt(r.contextMaxTokens) : null,
          r.ttftMs != null ? sanitizeSafeInt(r.ttftMs) : null,
          r.streamingMs != null ? sanitizeSafeInt(r.streamingMs) : null,
          r.durationMs != null ? sanitizeSafeInt(r.durationMs) : null,
          r.tps != null ? Number(r.tps) : null,
          r.tpsKind || (r.tps != null ? (r.tpsEstimated ? 'e2e-estimate' : 'generation') : 'none'),
          r.tpsEstimated ? 1 : 0,
          r.costUsd != null ? Number(r.costUsd) : null,
          r.savedUsd != null ? Number(r.savedUsd) : null,
          r.status || 'success',
          r.outcomeKnown === false ? 0 : 1,
          sanitizeSafeInt(r.retries || 0),
          r.errorCode || '',
          r.errorText || '',
          r.compactionBefore ? 1 : 0
        );
      }
      upsertFileStmt.run(sourceKey, stamp, Date.now());
      if (peer && peer.machineId) {
        upsertSyncPeer(peer);
      }
      // Capture local_change_counter INSIDE the write transaction before COMMIT releases the lock
      const committedLocalSeq = !isRemote ? (Number(getLocalChangeSeqStmt.get()?.seq) || 0) : lastLocalChangeSeq;
      db.exec('COMMIT');
      txStarted = false;
      revision++;
      if (!isRemote) {
        lastLocalChangeSeq = committedLocalSeq;
        localRevision++;
      }
    } catch (err) {
      if (txStarted) {
        try { db.exec('ROLLBACK'); } catch {}
      }
      throw err;
    }
  }

  function remoteImportGenKey(prefix) {
    return `remote_import_gen:${prefix}`;
  }

  function listSourceStampsByPrefix(prefix) {
    return listSourceStampsByPrefixStmt.all(prefix, prefix).map(r => [r.source_key, r.stamp]);
  }

  function getRemotePeerImportState(prefix) {
    const stamps = listSourceStampsByPrefix(prefix);
    const gen = Number(getMetaStmt.get(remoteImportGenKey(prefix))?.value) || 0;
    return { stamps, gen };
  }

  function listRemotePeerStates() {
    const peerIds = new Set();
    for (const row of listPeersStmt.all()) {
      if (row.machine_id) peerIds.add(String(row.machine_id));
    }
    for (const row of listSourcesStmt.all()) {
      const key = String(row.source_key || '');
      if (!key.startsWith('remote:')) continue;
      const rest = key.slice('remote:'.length);
      const colonIdx = rest.indexOf(':');
      const peerId = colonIdx >= 0 ? rest.slice(0, colonIdx) : rest;
      if (peerId) peerIds.add(peerId);
    }
    for (const row of listRemoteRequestPeersStmt.all()) {
      if (row.machine_id) peerIds.add(String(row.machine_id));
    }
    const out = [];
    for (const peerId of peerIds) {
      const prefix = `remote:${peerId}:`;
      const state = getRemotePeerImportState(prefix);
      out.push({ peerId, stamps: state.stamps, gen: state.gen });
    }
    return out;
  }

  function bumpRemoteImportGen(prefix) {
    if (!prefix) return;
    const key = remoteImportGenKey(prefix);
    const curGen = Number(getMetaStmt.get(key)?.value) || 0;
    setMetaStmt.run(key, String(curGen + 1));
  }

  function peerStateMatches(prefix, expectedPeerStamps, expectedPeerGen) {
    if (prefix && expectedPeerGen != null) {
      const curGen = Number(getMetaStmt.get(remoteImportGenKey(prefix))?.value) || 0;
      if (curGen !== Number(expectedPeerGen)) return false;
    }
    if (!prefix || !Array.isArray(expectedPeerStamps)) return true;
    const cur = listSourceStampsByPrefixStmt.all(prefix, prefix);
    if (cur.length !== expectedPeerStamps.length) return false;
    for (let i = 0; i < cur.length; i++) {
      if (cur[i].source_key !== expectedPeerStamps[i][0] || cur[i].stamp !== expectedPeerStamps[i][1]) return false;
    }
    return true;
  }

  /**
   * Atomically replace one or more remote shard sources (with optional CAS stamp + generation check,
   * stale-source pruning, and peer registration) inside a single SQLite transaction so
   * cross-month moves and overlapping importers never drop rows or restore redacted data.
   */
  function replaceRemoteSourcesBatch(items, {
    machineId = 'remote',
    machineLabel = '',
    nonBlocking = false,
    peer = null,
    peerPrefix = '',
    expectedPeerStamps = null,
    expectedPeerGen = null,
    pruneActiveKeys = null
  } = {}) {
    const batchItems = Array.isArray(items) ? items : [];
    const activeKeysArr = pruneActiveKeys ? [...pruneActiveKeys] : null;
    if (!batchItems.length && !activeKeysArr && !peerPrefix) return;
    let txStarted = false;
    if (nonBlocking) {
      withBusyTimeout(0, () => {
        db.exec('BEGIN IMMEDIATE');
        txStarted = true;
      });
    } else {
      db.exec('BEGIN IMMEDIATE');
      txStarted = true;
    }
    try {
      if (!peerStateMatches(peerPrefix, expectedPeerStamps, expectedPeerGen)) {
        throw Object.assign(new Error('远端分片已被其他进程更新，需重新同步'), { code: 'STALE_IMPORT_CONFLICT' });
      }
      const nowMs = Date.now();
      for (const item of batchItems) {
        const { sourceKey, stamp, rows } = item;
        deleteBySourceStmt.run(sourceKey);
        for (const r of rows) {
          const ts = sanitizeSafeInt(r.timestampMs || 0);
          const billingTs = sanitizeSafeInt(r.billingTsMs ?? ts, ts);
          const rowMachineId = String(r.machineId || machineId || 'remote');
          const rowMachineLabel = String(r.machineLabel ?? machineLabel ?? '');
          upsertRequestStmt.run(
            r.id,
            r.dedupeKey || null,
            sourceKey,
            rowMachineId,
            rowMachineLabel,
            1,
            r.providerDriver,
            r.accountId,
            r.t3ThreadId || null,
            r.t3ThreadTitle ?? '',
            r.nativeSessionId,
            r.modelId,
            r.modelRaw || r.modelId,
            r.effort || '',
            r.role || '',
            ts,
            billingTs,
            sanitizeSafeInt(r.inputTokens || 0),
            sanitizeSafeInt(r.cacheReadTokens || 0),
            sanitizeSafeInt(r.cacheWriteTokens || 0),
            sanitizeSafeInt(r.outputTokens || 0),
            sanitizeSafeInt(r.thinkingTokens || 0),
            r.contextUsedTokens != null ? sanitizeSafeInt(r.contextUsedTokens) : null,
            r.contextMaxTokens != null ? sanitizeSafeInt(r.contextMaxTokens) : null,
            r.ttftMs != null ? sanitizeSafeInt(r.ttftMs) : null,
            r.streamingMs != null ? sanitizeSafeInt(r.streamingMs) : null,
            r.durationMs != null ? sanitizeSafeInt(r.durationMs) : null,
            r.tps != null ? Number(r.tps) : null,
            r.tpsKind || (r.tps != null ? (r.tpsEstimated ? 'e2e-estimate' : 'generation') : 'none'),
            r.tpsEstimated ? 1 : 0,
            r.costUsd != null ? Number(r.costUsd) : null,
            r.savedUsd != null ? Number(r.savedUsd) : null,
            r.status || 'success',
            r.outcomeKnown === false ? 0 : 1,
            sanitizeSafeInt(r.retries || 0),
            r.errorCode || '',
            r.errorText || '',
            r.compactionBefore ? 1 : 0
          );
        }
        upsertFileStmt.run(sourceKey, stamp, nowMs);
      }
      if (peerPrefix && activeKeysArr) {
        const activeSet = new Set(activeKeysArr);
        for (const row of listSourceStampsByPrefixStmt.all(peerPrefix, peerPrefix)) {
          if (!activeSet.has(row.source_key)) {
            deleteBySourceStmt.run(row.source_key);
            deleteSourceStmt.run(row.source_key);
          }
        }
      }
      if (peer && peer.machineId) {
        upsertSyncPeer(peer);
      }
      if (peerPrefix) {
        bumpRemoteImportGen(peerPrefix);
      }
      db.exec('COMMIT');
      txStarted = false;
      revision++;
    } catch (err) {
      if (txStarted) {
        try { db.exec('ROLLBACK'); } catch {}
      }
      throw err;
    }
  }

  /**
   * Offload very large remote shard batch replacements onto a cancellable worker thread
   * so the daemon's HTTP event loop (/api/health) stays responsive while preserving
   * single-transaction SQLite atomicity and CAS stamp validation across all shards in the batch.
   */
  async function replaceRemoteSourcesBatchAsync(items, {
    machineId = 'remote',
    machineLabel = '',
    signal = null,
    nonBlocking = true,
    peer = null,
    peerPrefix = '',
    expectedPeerStamps = null,
    expectedPeerGen = null,
    pruneActiveKeys = null
  } = {}) {
    const batchItems = Array.isArray(items) ? items : [];
    const activeKeysArr = pruneActiveKeys ? [...pruneActiveKeys] : null;
    if (!batchItems.length && !activeKeysArr && !peerPrefix) return;
    if (closed) throw new Error('telemetry store is closed');
    if (signal?.aborted) throw Object.assign(new Error('同步已取消'), { code: 'ABORT_ERR' });
    const totalRows = batchItems.reduce((sum, it) => sum + (it.rows?.length || 0), 0);
    if (!dbPath || dbPath === ':memory:' || totalRows <= WORKER_REMOTE_REPLACE_THRESHOLD) {
      replaceRemoteSourcesBatch(batchItems, {
        machineId,
        machineLabel,
        nonBlocking,
        peer,
        peerPrefix,
        expectedPeerStamps,
        expectedPeerGen,
        pruneActiveKeys: activeKeysArr
      });
      return;
    }

    const cancelBuf = new SharedArrayBuffer(4);
    const cancelArr = new Int32Array(cancelBuf);
    const onAbort = () => { Atomics.store(cancelArr, 0, 1); };
    if (signal) {
      if (signal.aborted) {
        throw Object.assign(new Error('同步已取消'), { code: 'ABORT_ERR' });
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    activeRemoteWorkerCount++;
    try {
      const result = await new Promise((resolveWorker, rejectWorker) => {
        const worker = new Worker(REMOTE_REPLACE_WORKER_CODE, {
          eval: true,
          workerData: {
            dbPath,
            items: batchItems,
            machineId,
            machineLabel,
            isRemote: true,
            peer,
            peerPrefix,
            expectedPeerStamps,
            expectedPeerGen,
            pruneActiveKeys: activeKeysArr,
            cancelBuf
          }
        });
        let settled = false;
        worker.once('message', msg => {
          if (settled) return;
          settled = true;
          resolveWorker(msg);
        });
        worker.once('error', err => {
          if (settled) return;
          settled = true;
          rejectWorker(err);
        });
        worker.once('exit', code => {
          if (settled) return;
          settled = true;
          if (code === 0) resolveWorker({ ok: false, aborted: Atomics.load(cancelArr, 0) !== 0 });
          else rejectWorker(new Error(`remote import worker exited with code ${code}`));
        });
      });

      if (result?.aborted) {
        throw Object.assign(new Error('同步已取消'), { code: 'ABORT_ERR' });
      }
      if (result?.conflict) {
        throw Object.assign(new Error(result?.error || '远端分片已被其他进程更新，需重新同步'), { code: 'STALE_IMPORT_CONFLICT' });
      }
      if (!result?.ok) {
        throw new Error(result?.error || '远端分片写入失败');
      }
      if (!closed) {
        // Always refresh via getRevision() because SQLite PRAGMA data_version coalesces
        // multiple external commits into a single increment; never suppress external write detection.
        const prevRev = revision;
        getRevision();
        if (revision === prevRev) revision++;
      }
    } finally {
      activeRemoteWorkerCount = Math.max(0, activeRemoteWorkerCount - 1);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async function replaceRemoteSourceRequestsAsync(sourceKey, stamp, rows, { machineId = 'remote', machineLabel = '', signal = null, nonBlocking = true, peer = null } = {}) {
    return replaceRemoteSourcesBatchAsync([{ sourceKey, stamp, rows }], { machineId, machineLabel, signal, nonBlocking, peer });
  }

  function isSqliteBusyError(err) {
    return err?.errcode === 5 || err?.errcode === 6 || /database is locked|database table is locked|SQLITE_BUSY/i.test(String(err?.message || ''));
  }

  function withBusyTimeout(ms, fn) {
    if (ms === 0) {
      if (nonBlockingDepth > 0) return fn();
      nonBlockingDepth++;
      db.exec('PRAGMA busy_timeout = 0');
      try {
        return fn();
      } finally {
        nonBlockingDepth = Math.max(0, nonBlockingDepth - 1);
        if (nonBlockingDepth === 0) {
          try { db.exec('PRAGMA busy_timeout = 3000'); } catch {}
        }
      }
    }
    db.exec(`PRAGMA busy_timeout = ${ms}`);
    try {
      return fn();
    } finally {
      try { db.exec(`PRAGMA busy_timeout = ${nonBlockingDepth > 0 ? 0 : 3000}`); } catch {}
    }
  }

  /**
   * Reconcile stored requests when T3 Code's nativeSessionId -> t3ThreadId mapping
   * resolves after a provider file was already indexed.
   * Non-blocking when SQLite's write lock is held by a remote import worker or external writer
   * so the daemon HTTP event loop (/api/health) never stalls.
   */
  function syncThreadLinks(nativeToThreadMap) {
    if (!nativeToThreadMap || nativeToThreadMap.size === 0) return 0;
    if (activeRemoteWorkerCount > 0) return 0;
    let changed = 0;
    let txStarted = false;
    try {
      withBusyTimeout(0, () => {
        db.exec('BEGIN IMMEDIATE');
        txStarted = true;
      });
    } catch (err) {
      if (isSqliteBusyError(err)) return 0;
      throw err;
    }
    try {
      getRevision();
      for (const [nativeId, info] of nativeToThreadMap.entries()) {
        if (!info?.threadId) continue;
        const title = info.title || '';
        const acct = info.accountId || '';
        const res = updateLinkStmt.run(info.threadId, title, acct, acct, nativeId, info.threadId, title, acct, acct);
        if (res.changes > 0) {
          changed += res.changes;
          if (dirtyLocalMonths !== null) {
            for (const mRow of sessionLocalMonthsStmt.all(nativeId)) {
              markDirtyMonth(mRow.month_key);
            }
          }
        }
      }
      const committedLocalSeq = changed > 0 ? (Number(getLocalChangeSeqStmt.get()?.seq) || 0) : lastLocalChangeSeq;
      db.exec('COMMIT');
      txStarted = false;
      if (changed > 0) {
        lastLocalChangeSeq = committedLocalSeq;
        revision++;
        localRevision++;
      }
      return changed;
    } catch (err) {
      if (txStarted) {
        try { db.exec('ROLLBACK'); } catch {}
      }
      throw err;
    }
  }

  function pruneMissingSources(prefix, activeKeys) {
    const all = listSourcesStmt.all().map(r => r.source_key);
    const allowRemote = String(prefix || '').startsWith('remote:');
    const stale = all.filter(k => k.startsWith(prefix) && (allowRemote || !k.startsWith('remote:')) && !activeKeys.has(k));
    if (!stale.length) return;
    let txStarted = false;
    db.exec('BEGIN IMMEDIATE');
    txStarted = true;
    try {
      if (!allowRemote) getRevision();
      for (const k of stale) {
        if (!allowRemote && dirtyLocalMonths !== null) {
          for (const mRow of sourceLocalMonthsStmt.all(k)) {
            markDirtyMonth(mRow.month_key);
          }
        }
        deleteBySourceStmt.run(k);
        deleteSourceStmt.run(k);
      }
      const committedLocalSeq = !allowRemote ? (Number(getLocalChangeSeqStmt.get()?.seq) || 0) : lastLocalChangeSeq;
      db.exec('COMMIT');
      txStarted = false;
      revision++;
      if (!allowRemote) {
        lastLocalChangeSeq = committedLocalSeq;
        localRevision++;
      }
    } catch (err) {
      if (txStarted) {
        try { db.exec('ROLLBACK'); } catch {}
      }
      throw err;
    }
  }

  function deleteSourcesByPrefix(prefix) {
    if (!prefix) return 0;
    const all = listSourcesStmt.all().map(r => r.source_key);
    const targets = all.filter(k => k.startsWith(prefix));
    if (!targets.length) return 0;
    const isRemotePrefix = String(prefix).startsWith('remote:');
    let txStarted = false;
    db.exec('BEGIN IMMEDIATE');
    txStarted = true;
    try {
      if (!isRemotePrefix) getRevision();
      for (const k of targets) {
        if (!isRemotePrefix && dirtyLocalMonths !== null) {
          for (const mRow of sourceLocalMonthsStmt.all(k)) {
            markDirtyMonth(mRow.month_key);
          }
        }
        deleteBySourceStmt.run(k);
        deleteSourceStmt.run(k);
      }
      const committedLocalSeq = !isRemotePrefix ? (Number(getLocalChangeSeqStmt.get()?.seq) || 0) : lastLocalChangeSeq;
      if (isRemotePrefix && String(prefix).endsWith(':')) {
        bumpRemoteImportGen(String(prefix));
      }
      db.exec('COMMIT');
      txStarted = false;
      revision++;
      if (!isRemotePrefix) {
        lastLocalChangeSeq = committedLocalSeq;
        localRevision++;
      }
      return targets.length;
    } catch (err) {
      if (txStarted) {
        try { db.exec('ROLLBACK'); } catch {}
      }
      throw err;
    }
  }

  function upsertSyncPeer(peer) {
    if (!peer?.machineId) return;
    const reqCount = Math.max(0, sanitizeSafeInt(peer.requestCount || 0, 0));
    const exportedAt = peer.lastExportedAtMs != null && Number.isFinite(Number(peer.lastExportedAtMs))
      ? sanitizeSafeInt(peer.lastExportedAtMs, null)
      : null;
    const importedAt = peer.lastImportedAtMs != null && Number.isFinite(Number(peer.lastImportedAtMs))
      ? sanitizeSafeInt(peer.lastImportedAtMs, Date.now())
      : Date.now();
    upsertPeerStmt.run(
      String(peer.machineId),
      String(peer.machineLabel || peer.machineId),
      String(peer.platform || ''),
      String(peer.appVersion || ''),
      reqCount,
      exportedAt,
      importedAt,
      String(peer.status || 'ok'),
      String(peer.lastError || '')
    );
  }

  function listSyncPeers() {
    return listPeersStmt.all().map(r => ({
      machineId: r.machine_id,
      machineLabel: r.machine_label || r.machine_id,
      platform: r.platform || '',
      appVersion: r.app_version || '',
      requestCount: Number(r.request_count) || 0,
      lastExportedAtMs: r.last_exported_at_ms ?? null,
      lastImportedAtMs: r.last_imported_at_ms ?? null,
      status: r.status || 'ok',
      lastError: r.last_error || ''
    }));
  }

  function pruneMissingSyncPeers(activeMachineIds) {
    const existing = listPeersStmt.all().map(r => r.machine_id);
    const stale = existing.filter(id => !activeMachineIds.has(id));
    if (!stale.length) return [];
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of stale) {
        deletePeerStmt.run(id);
      }
      db.exec('COMMIT');
      return stale;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function pruneOrphanRemoteSources(activeMachineIds) {
    const all = listSourcesStmt.all().map(r => r.source_key);
    const staleSources = [];
    for (const key of all) {
      if (!key.startsWith('remote:')) continue;
      const rest = key.slice('remote:'.length);
      const colonIdx = rest.indexOf(':');
      const peerId = colonIdx >= 0 ? rest.slice(0, colonIdx) : rest;
      if (!activeMachineIds.has(peerId)) staleSources.push(key);
    }
    if (!staleSources.length) return 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const k of staleSources) {
        deleteBySourceStmt.run(k);
        deleteSourceStmt.run(k);
      }
      db.exec('COMMIT');
      revision++;
      return staleSources.length;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Atomically remove a disappeared remote peer (sync_peers, requests, and source_files)
   * ONLY if its stored stamps and import generation are unchanged since the directory scan began.
   */
  function pruneRemotePeerIfUnchanged(peerId, expectedState = null) {
    if (!peerId) return false;
    const id = String(peerId);
    const prefix = `remote:${id}:`;
    let txStarted = false;
    db.exec('BEGIN IMMEDIATE');
    txStarted = true;
    try {
      if (expectedState && !peerStateMatches(prefix, expectedState.stamps ?? null, expectedState.gen ?? null)) {
        db.exec('ROLLBACK');
        txStarted = false;
        return false;
      }
      for (const row of listSourceStampsByPrefixStmt.all(prefix, prefix)) {
        deleteBySourceStmt.run(row.source_key);
        deleteSourceStmt.run(row.source_key);
      }
      deleteRemoteRequestsByPeerStmt.run(id);
      deletePeerStmt.run(id);
      bumpRemoteImportGen(prefix);
      db.exec('COMMIT');
      txStarted = false;
      revision++;
      return true;
    } catch (err) {
      if (txStarted) {
        try { db.exec('ROLLBACK'); } catch {}
      }
      throw err;
    }
  }

  function clearRemoteData() {
    const removedSources = deleteSourcesByPrefix('remote:');
    let removedPeers = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      const res = clearPeersStmt.run();
      removedPeers = Number(res?.changes) || 0;
      db.exec("DELETE FROM requests WHERE is_remote = 1");
      bumpAllRemoteImportGensStmt.run();
      db.exec('COMMIT');
      revision++;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { removedSources, removedPeers };
  }

  function getIngestedCodexDedupeKeys() {
    const out = new Set();
    for (const row of listRolloutDedupeStmt.all()) {
      if (row.dedupe_key) out.add(row.dedupe_key);
    }
    return out;
  }

  function getSourceUsageCounts(prefix = '') {
    const out = new Map();
    for (const row of sourceUsageCountsStmt.all(`${prefix}%`)) {
      out.set(row.source_key, Number(row.cnt) || 0);
    }
    return out;
  }

  function saveQuotaSnapshots(windows) {
    if (!Array.isArray(windows) || !windows.length) return;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const w of windows) {
        const key = `${w.accountId}::${w.windowId}`;
        upsertQuotaStmt.run(
          key,
          w.accountId,
          w.driver || '',
          w.windowId,
          w.label || w.windowId,
          w.kind || 'weekly',
          Number.isFinite(w.usedPercent) ? w.usedPercent : null,
          Number.isFinite(w.resetsAtMs) ? Math.trunc(w.resetsAtMs) : null,
          Number.isFinite(w.windowDurationMins) ? Math.trunc(w.windowDurationMins) : null,
          Math.trunc(w.observedAtMs || Date.now())
        );
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function mapRow(row) {
    if (!row) return null;
    const totalIn = (row.input_tokens || 0) + (row.cache_read_tokens || 0) + (row.cache_write_tokens || 0);
    return {
      id: row.id,
      dedupeKey: row.dedupe_key || null,
      sourceKey: row.source_key,
      machineId: row.machine_id || 'local',
      machineLabel: row.machine_label || '',
      isRemote: Boolean(row.is_remote),
      providerDriver: row.provider_driver,
      accountId: row.account_id,
      t3ThreadId: row.t3_thread_id || null,
      t3ThreadTitle: row.t3_thread_title || '',
      nativeSessionId: row.native_session_id,
      modelId: row.model_id,
      modelRaw: row.model_raw,
      effort: row.effort || '',
      role: row.role || '',
      timestampMs: row.safe_timestamp_ms ?? row.timestamp_ms ?? 0,
      billingTsMs: row.safe_billing_ts_ms ?? row.billing_ts_ms ?? row.safe_timestamp_ms ?? row.timestamp_ms ?? 0,
      inputTokens: row.input_tokens || 0,
      cacheReadTokens: row.cache_read_tokens || 0,
      cacheWriteTokens: row.cache_write_tokens || 0,
      outputTokens: row.output_tokens || 0,
      thinkingTokens: row.thinking_tokens || 0,
      cacheHitPercent: totalIn > 0 ? Number(((row.cache_read_tokens / totalIn) * 100).toFixed(1)) : null,
      contextUsedTokens: row.context_used_tokens ?? null,
      contextMaxTokens: row.context_max_tokens ?? null,
      ttftMs: row.ttft_ms ?? null,
      streamingMs: row.streaming_ms ?? null,
      durationMs: row.duration_ms ?? null,
      tps: row.tps ?? null,
      tpsKind: row.tps_kind || 'none',
      tpsEstimated: Boolean(row.tps_estimated),
      costUsd: row.cost_usd ?? null,
      savedUsd: row.saved_usd ?? null,
      status: row.status,
      outcomeKnown: row.outcome_known !== 0,
      retries: row.retries || 0,
      errorCode: row.error_code || '',
      errorText: row.error_text || '',
      compactionBefore: Boolean(row.compaction_before)
    };
  }

  function listAllRequests() {
    return allRequestsStmt.all().map(mapRow);
  }

  function listLocalRequests() {
    return localRequestsStmt.all().map(mapRow);
  }

  function listLocalMonthCounts() {
    return localMonthCountsStmt.all().map(r => ({
      monthKey: String(r.month_key || '1970-01'),
      count: Number(r.cnt) || 0
    }));
  }

  function listLocalRequestsByMonth(monthKey) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(monthKey || ''));
    if (!m) return [];
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return [];
    const startMs = Date.UTC(year, month - 1, 1);
    const endMs = Date.UTC(year, month, 1);
    const rows = monthKey === '1970-01'
      ? localRequestsFallbackMonthStmt.all(endMs)
      : localRequestsByBillingRangeStmt.all(startMs, endMs);
    return rows.map(mapRow);
  }

  function listLocalAlertCandidates(sinceMs) {
    return localErrorRowsSinceStmt.all(Math.trunc(Number(sinceMs) || 0)).map(mapRow);
  }

  function listLocalTodayIncidentsWithRecovery(startOfTodayMs) {
    const incidentRows = localErrorRowsSinceStmt.all(Math.trunc(Number(startOfTodayMs) || 0));
    if (!incidentRows.length) return [];
    const byId = new Map();
    const seenThreads = new Set();
    const seenUnlinkedSessions = new Set();
    for (const row of incidentRows) {
      byId.set(row.id, row);
      if (row.t3_thread_id) seenThreads.add(row.t3_thread_id);
      else if (row.native_session_id) seenUnlinkedSessions.add(row.native_session_id);
    }
    for (const tid of seenThreads) {
      const okRow = latestSuccessByThreadStmt.get(tid);
      if (okRow && !byId.has(okRow.id)) byId.set(okRow.id, okRow);
    }
    for (const sid of seenUnlinkedSessions) {
      const okRow = latestSuccessByUnlinkedSessionStmt.get(sid);
      if (okRow && !byId.has(okRow.id)) byId.set(okRow.id, okRow);
    }
    const sorted = [...byId.values()]
      .sort((a, b) => ((b.safe_timestamp_ms ?? b.timestamp_ms ?? 0) - (a.safe_timestamp_ms ?? a.timestamp_ms ?? 0)))
      .map(mapRow);
    return sorted;
  }

  function listThreadIncidents(id, natives, since) {
    const sinceInt = Math.trunc(Number(since) || 0);
    const byId = new Map();
    if (id) {
      for (const row of threadIncidentsByThreadStmt.all(id, sinceInt)) {
        byId.set(row.id, row);
      }
    }
    const ids = [...new Set((natives || []).filter(Boolean))];
    for (const sid of ids) {
      for (const row of threadIncidentsBySessionStmt.all(sid, sinceInt)) {
        if (!byId.has(row.id)) byId.set(row.id, row);
      }
    }
    return [...byId.values()]
      .sort((a, b) => ((b.safe_timestamp_ms ?? b.timestamp_ms ?? 0) - (a.safe_timestamp_ms ?? a.timestamp_ms ?? 0)))
      .slice(0, 50)
      .map(mapRow);
  }

  function getLatestRequestForThread(threadId, nativeSessionIds = []) {
    if (threadId) {
      const hit = latestByThreadStmt.get(threadId);
      if (hit) return mapRow(hit);
    }
    let best = null;
    for (const sid of nativeSessionIds) {
      if (!sid) continue;
      const hit = latestBySessionStmt.get(sid);
      const hitTs = hit ? (hit.safe_timestamp_ms ?? hit.timestamp_ms ?? 0) : 0;
      const bestTs = best ? (best.safe_timestamp_ms ?? best.timestamp_ms ?? 0) : 0;
      if (hit && (!best || hitTs > bestTs)) {
        best = hit;
      }
    }
    return mapRow(best);
  }

  function listRecentRequestsForThread(threadId, nativeSessionIds = [], limit = 24) {
    const cap = Math.max(1, Math.min(100, Number(limit) || 24));
    const byId = new Map();
    if (threadId) {
      for (const row of recentByThreadStmt.all(threadId, cap)) {
        byId.set(row.id, row);
      }
    }
    for (const sid of nativeSessionIds) {
      if (!sid) continue;
      for (const row of recentBySessionStmt.all(sid, cap)) {
        if (!byId.has(row.id)) byId.set(row.id, row);
      }
    }
    return [...byId.values()]
      .sort((a, b) => ((b.safe_timestamp_ms ?? b.timestamp_ms ?? 0) - (a.safe_timestamp_ms ?? a.timestamp_ms ?? 0)))
      .slice(0, cap)
      .map(mapRow);
  }

  function listQuotaSnapshots() {
    return allQuotasStmt.all().map(r => ({
      accountId: r.account_id,
      driver: r.driver,
      windowId: r.window_id,
      label: r.label,
      kind: r.kind,
      usedPercent: r.used_percent,
      remainingPercent: Number.isFinite(r.used_percent) ? Math.max(0, Number((100 - r.used_percent).toFixed(1))) : null,
      resetsAtMs: r.resets_at_ms,
      windowDurationMins: r.window_duration_mins,
      observedAtMs: r.observed_at_ms
    }));
  }

  function getRangeUsageSummary(startMs, endMs, { localOnly = false } = {}) {
    const stmt = localOnly ? rangeLocalUsageSummaryStmt : rangeUsageSummaryStmt;
    const row = stmt.get(Math.trunc(startMs || 0), Math.trunc(endMs || Date.now()));
    return {
      requests: Number(row?.requests) || 0,
      costUsd: Number((Number(row?.cost_usd) || 0).toFixed(6)),
      totalTokens: Number(row?.total_tokens) || 0
    };
  }

  function exportLockKey(scopeKey) {
    const base = dbPath && dbPath !== ':memory:' ? resolve(dbPath) : ':memory:';
    const normBase = process.platform === 'win32' ? base.toLowerCase() : base;
    return `${normBase}|${scopeKey}`;
  }

  function exportLockFilePath(scopeKey) {
    if (!dbPath || dbPath === ':memory:') return '';
    const lockDir = join(dirname(resolve(dbPath)), '.export-locks');
    const hash = createHash('sha256').update(scopeKey).digest('hex').slice(0, 24);
    return join(lockDir, `${hash}.lock.sqlite`);
  }

  /**
   * OS-kernel exclusive export lock using a dedicated local lock database (`BEGIN EXCLUSIVE`)
   * plus a process-wide live map:
   * - Never expires on wall-clock timeout while any file rename/unlink is still in flight (even across store.close()).
   * - Automatically released by the OS kernel if the owning process crashes (zero PID-reuse hazard).
   * - Never touches `telemetry.sqlite` (zero contention with main-thread DB writes or `/api/health`).
   * - Never places lock files inside OneDrive or other shared cloud folders.
   */
  function tryAcquireExportLock(scopeKey, token) {
    const mapKey = exportLockKey(scopeKey);
    const existing = activeProcessExportLocks.get(mapKey);
    if (existing) {
      if (!existing.settled) return false;
      // Previous owner's file I/O has settled (release threw); close its handle before reacquiring
      if (existing.lockDb) {
        try { existing.lockDb.exec('COMMIT'); } catch {}
        existing.lockDb.close();
        existing.lockDb = null;
      }
      activeProcessExportLocks.delete(mapKey);
    }

    const lockFile = exportLockFilePath(scopeKey);
    let lockDb = null;
    if (lockFile) {
      mkdirSync(dirname(lockFile), { recursive: true });
      try {
        lockDb = new DatabaseSync(lockFile);
        lockDb.exec('PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;');
      } catch (err) {
        try { lockDb?.close(); } catch {}
        if (isSqliteBusyError(err)) return false;
        throw err;
      }
    }

    activeProcessExportLocks.set(mapKey, { token, lockDb, settled: false });
    return true;
  }

  function releaseExportLock(scopeKey, token) {
    const mapKey = exportLockKey(scopeKey);
    const entry = activeProcessExportLocks.get(mapKey);
    if (!entry || entry.token !== token) return;
    if (entry.lockDb) {
      try { entry.lockDb.exec('COMMIT'); } catch {}
      // Propagate close() failure so the handle stays tracked and caller enters markExportLockSettled()
      entry.lockDb.close();
      entry.lockDb = null;
    }
    activeProcessExportLocks.delete(mapKey);
  }

  function markExportLockSettled(scopeKey, token) {
    const mapKey = exportLockKey(scopeKey);
    const entry = activeProcessExportLocks.get(mapKey);
    if (!entry || entry.token !== token) return;
    entry.settled = true;
    if (entry.lockDb) {
      try {
        try { entry.lockDb.exec('COMMIT'); } catch {}
        entry.lockDb.close();
        entry.lockDb = null;
      } catch {
        // Keep entry.lockDb so the next tryAcquireExportLock() retries close() cleanly
      }
    }
  }

  function close() {
    // Do NOT release activeProcessExportLocks here: if an async file rename/unlink is still in flight
    // after shutdown timeout, the OS exclusive lock must remain held until its finally() calls releaseExportLock()
    // (or until this process exits and the OS kernel releases the handle).
    closed = true;
    try { db.close(); } catch {}
  }

  return {
    getMeta: key => getMetaStmt.get(key)?.value,
    setMeta: (key, value) => setMetaStmt.run(key, String(value)),
    deleteMeta: key => deleteMetaStmt.run(key),
    listMetaByPrefix: prefix => listMetaByPrefixStmt.all(`${prefix}%`).map(r => ({ key: r.key, value: r.value })),
    deleteMetaByPrefix: prefix => deleteMetaByPrefixStmt.run(`${prefix}%`),
    runNonBlockingWrite: fn => withBusyTimeout(0, fn),
    tryAcquireExportLock,
    releaseExportLock,
    markExportLockSettled,
    isWriteBusy: () => activeRemoteWorkerCount > 0,
    getSourceRowCount: sourceKey => Number(countBySourceStmt.get(sourceKey)?.n) || 0,
    getSourceRowIds: sourceKey => listIdsBySourceStmt.all(sourceKey).map(r => r.id),
    getRemotePeerRowCount: machineId => Number(countByRemotePeerStmt.get(machineId)?.n) || 0,
    hasRowOwnedBySources: (ids, ownedSources) => {
      if (!ownedSources || ownedSources.size === 0) return false;
      for (const id of ids) {
        const row = getSourceByIdStmt.get(id);
        if (row && ownedSources.has(row.source_key)) return true;
      }
      return false;
    },
    getRevision,
    getLocalRevision,
    takeDirtyLocalMonths,
    takeDirtyLocalMonthsSnapshot,
    markLocalMonthsDirty,
    isClosed: () => closed,
    nextBillingAfter: ms => nextBilling.get(ms).ts ?? Infinity,
    getSourceStamp,
    listSourceStampsByPrefix,
    getRemotePeerImportState,
    listRemotePeerStates,
    replaceSourceRequests,
    replaceRemoteSourcesBatch,
    replaceRemoteSourcesBatchAsync,
    replaceRemoteSourceRequestsAsync,
    syncThreadLinks,
    pruneMissingSources,
    pruneOrphanRemoteSources,
    pruneRemotePeerIfUnchanged,
    deleteSourcesByPrefix,
    upsertSyncPeer,
    deleteSyncPeer: machineId => deletePeerStmt.run(String(machineId)),
    listSyncPeers,
    pruneMissingSyncPeers,
    clearRemoteData,
    getIngestedCodexDedupeKeys,
    getSourceUsageCounts,
    saveQuotaSnapshots,
    listAllRequests,
    listLocalRequests,
    listLocalMonthCounts,
    listLocalRequestsByMonth,
    listLocalAlertCandidates,
    listLocalTodayIncidentsWithRecovery,
    getLatestRequestForThread,
    countThreadUnread: (id, ts) => countThreadUnreadStmt.get(id, Math.trunc(Number(ts) || 0)).n,
    listThreadIncidents,
    listRecentRequestsForThread,
    listQuotaSnapshots,
    getRangeUsageSummary,
    close
  };
}
