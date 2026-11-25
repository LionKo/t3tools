import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const TELEMETRY_SCHEMA_VERSION = 3;

/**
 * Own persistent SQLite cache & history store (~/.t3tools/telemetry.sqlite).
 * Versioned schema ensures older indexed rows are cleanly rebuilt when parser
 * logic improves, and provides indexed lookups for fast live polling & analytics.
 */
export function createTelemetryStore(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    const store = initializeStore(db);
    db.exec('COMMIT');
    return store;
  } catch (err) {
    db.close(); // Rolls back schema changes if DDL or statement preparation fails.
    throw err;
  }
}

function initializeStore(db) {
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
  if (curSchemaVersion !== TELEMETRY_SCHEMA_VERSION) {
    db.exec(`
      DROP TABLE IF EXISTS requests;
      DROP TABLE IF EXISTS source_files;
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

    CREATE INDEX IF NOT EXISTS idx_requests_status_ts ON requests(status, timestamp_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_requests_errcode_ts ON requests(error_code, timestamp_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(timestamp_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_requests_source ON requests(source_key);
    CREATE INDEX IF NOT EXISTS idx_requests_thread_ts ON requests(t3_thread_id, timestamp_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_requests_session_ts ON requests(native_session_id, timestamp_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_requests_account_ts ON requests(account_id, timestamp_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_requests_dedupe ON requests(dedupe_key);

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

  const getFileStmt = db.prepare('SELECT stamp FROM source_files WHERE source_key = ?');
  const upsertFileStmt = db.prepare(`
    INSERT INTO source_files (source_key, stamp, updated_at_ms)
    VALUES (?, ?, ?)
    ON CONFLICT(source_key) DO UPDATE SET stamp = excluded.stamp, updated_at_ms = excluded.updated_at_ms
  `);
  const deleteBySourceStmt = db.prepare('DELETE FROM requests WHERE source_key = ?');
  const deleteSourceStmt = db.prepare('DELETE FROM source_files WHERE source_key = ?');
  const listSourcesStmt = db.prepare('SELECT source_key FROM source_files');

  const upsertRequestStmt = db.prepare(`
    INSERT INTO requests (
      id, dedupe_key, source_key, provider_driver, account_id, t3_thread_id, t3_thread_title,
      native_session_id, model_id, model_raw, effort, role, timestamp_ms, billing_ts_ms,
      input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, thinking_tokens,
      context_used_tokens, context_max_tokens, ttft_ms, streaming_ms, duration_ms,
      tps, tps_kind, tps_estimated, cost_usd, saved_usd, status, outcome_known,
      retries, error_code, error_text, compaction_before
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      dedupe_key = COALESCE(excluded.dedupe_key, requests.dedupe_key),
      -- Keep originating rollout as owner so deleting a fork never erases parent rows (fixes P1 #6)
      source_key = CASE
        WHEN excluded.source_key LIKE '%' || excluded.native_session_id || '%' THEN excluded.source_key
        ELSE requests.source_key
      END,
      t3_thread_id = COALESCE(excluded.t3_thread_id, requests.t3_thread_id),
      t3_thread_title = CASE WHEN excluded.t3_thread_title != '' THEN excluded.t3_thread_title ELSE requests.t3_thread_title END,
      billing_ts_ms = excluded.billing_ts_ms,
      input_tokens = excluded.input_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_write_tokens = excluded.cache_write_tokens,
      output_tokens = excluded.output_tokens,
      thinking_tokens = excluded.thinking_tokens,
      context_used_tokens = COALESCE(excluded.context_used_tokens, requests.context_used_tokens),
      context_max_tokens = COALESCE(excluded.context_max_tokens, requests.context_max_tokens),
      ttft_ms = COALESCE(excluded.ttft_ms, requests.ttft_ms),
      streaming_ms = COALESCE(excluded.streaming_ms, requests.streaming_ms),
      duration_ms = COALESCE(excluded.duration_ms, requests.duration_ms),
      tps = COALESCE(excluded.tps, requests.tps),
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
    WHERE native_session_id = ?
      AND (
        t3_thread_id IS NULL OR t3_thread_id != ? OR t3_thread_title != ?
        OR (? != '' AND account_id != ?)
      )
  `);

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

  const allRequestsStmt = db.prepare('SELECT * FROM requests ORDER BY timestamp_ms DESC');
  const latestByThreadStmt = db.prepare('SELECT * FROM requests WHERE t3_thread_id = ? ORDER BY timestamp_ms DESC LIMIT 1');
  const latestBySessionStmt = db.prepare('SELECT * FROM requests WHERE native_session_id = ? ORDER BY timestamp_ms DESC LIMIT 1');
  const recentByThreadStmt = db.prepare('SELECT * FROM requests WHERE t3_thread_id = ? ORDER BY timestamp_ms DESC LIMIT ?');
  const recentBySessionStmt = db.prepare('SELECT * FROM requests WHERE native_session_id = ? ORDER BY timestamp_ms DESC LIMIT ?');
  const listRolloutDedupeStmt = db.prepare("SELECT dedupe_key FROM requests WHERE source_key LIKE 'codex-rollout:%' AND dedupe_key IS NOT NULL");
  const sourceUsageCountsStmt = db.prepare("SELECT source_key, COUNT(*) AS cnt FROM requests WHERE source_key LIKE ? AND status != 'error' GROUP BY source_key");
  const rangeUsageSummaryStmt = db.prepare(`
    SELECT
      COUNT(*) AS requests,
      COALESCE(SUM(COALESCE(cost_usd, 0)), 0) AS cost_usd,
      COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS total_tokens
    FROM requests
    WHERE billing_ts_ms >= ? AND billing_ts_ms <= ?
  `);
  const allQuotasStmt = db.prepare('SELECT * FROM quota_snapshots ORDER BY account_id, kind, window_id');

  function getRevision() {
    return revision;
  }

  function getSourceStamp(sourceKey) {
    return getFileStmt.get(sourceKey)?.stamp ?? null;
  }

  function replaceSourceRequests(sourceKey, stamp, rows) {
    db.exec('BEGIN IMMEDIATE');
    try {
      deleteBySourceStmt.run(sourceKey);
      for (const r of rows) {
        const ts = Math.trunc(r.timestampMs || 0);
        const billingTs = Math.trunc(r.billingTsMs ?? ts);
        upsertRequestStmt.run(
          r.id,
          r.dedupeKey || null,
          sourceKey,
          r.providerDriver,
          r.accountId,
          r.t3ThreadId ?? null,
          r.t3ThreadTitle ?? '',
          r.nativeSessionId,
          r.modelId,
          r.modelRaw || r.modelId,
          r.effort || '',
          r.role || '',
          ts,
          billingTs,
          Math.trunc(r.inputTokens || 0),
          Math.trunc(r.cacheReadTokens || 0),
          Math.trunc(r.cacheWriteTokens || 0),
          Math.trunc(r.outputTokens || 0),
          Math.trunc(r.thinkingTokens || 0),
          r.contextUsedTokens != null ? Math.trunc(r.contextUsedTokens) : null,
          r.contextMaxTokens != null ? Math.trunc(r.contextMaxTokens) : null,
          r.ttftMs != null ? Math.trunc(r.ttftMs) : null,
          r.streamingMs != null ? Math.trunc(r.streamingMs) : null,
          r.durationMs != null ? Math.trunc(r.durationMs) : null,
          r.tps != null ? Number(r.tps) : null,
          r.tpsKind || (r.tps != null ? (r.tpsEstimated ? 'e2e-estimate' : 'generation') : 'none'),
          r.tpsEstimated ? 1 : 0,
          r.costUsd != null ? Number(r.costUsd) : null,
          r.savedUsd != null ? Number(r.savedUsd) : null,
          r.status || 'success',
          r.outcomeKnown === false ? 0 : 1,
          Math.trunc(r.retries || 0),
          r.errorCode || '',
          r.errorText || '',
          r.compactionBefore ? 1 : 0
        );
      }
      upsertFileStmt.run(sourceKey, stamp, Date.now());
      db.exec('COMMIT');
      revision++;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Reconcile stored requests when T3 Code's nativeSessionId -> t3ThreadId mapping
   * resolves after a provider file was already indexed.
   */
  function syncThreadLinks(nativeToThreadMap) {
    if (!nativeToThreadMap || nativeToThreadMap.size === 0) return 0;
    let changed = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const [nativeId, info] of nativeToThreadMap.entries()) {
        if (!info?.threadId) continue;
        const title = info.title || '';
        const acct = info.accountId || '';
        const res = updateLinkStmt.run(info.threadId, title, acct, acct, nativeId, info.threadId, title, acct, acct);
        if (res.changes > 0) changed += res.changes;
      }
      db.exec('COMMIT');
      if (changed > 0) revision++;
      return changed;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function pruneMissingSources(prefix, activeKeys) {
    const all = listSourcesStmt.all().map(r => r.source_key);
    const stale = all.filter(k => k.startsWith(prefix) && !activeKeys.has(k));
    if (!stale.length) return;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const k of stale) {
        deleteBySourceStmt.run(k);
        deleteSourceStmt.run(k);
      }
      db.exec('COMMIT');
      revision++;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
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
      providerDriver: row.provider_driver,
      accountId: row.account_id,
      t3ThreadId: row.t3_thread_id || null,
      t3ThreadTitle: row.t3_thread_title || '',
      nativeSessionId: row.native_session_id,
      modelId: row.model_id,
      modelRaw: row.model_raw,
      effort: row.effort || '',
      role: row.role || '',
      timestampMs: row.timestamp_ms,
      billingTsMs: row.billing_ts_ms ?? row.timestamp_ms,
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

  function getLatestRequestForThread(threadId, nativeSessionIds = []) {
    if (threadId) {
      const hit = latestByThreadStmt.get(threadId);
      if (hit) return mapRow(hit);
    }
    let best = null;
    for (const sid of nativeSessionIds) {
      if (!sid) continue;
      const hit = latestBySessionStmt.get(sid);
      if (hit && (!best || hit.timestamp_ms > best.timestamp_ms)) {
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
      .sort((a, b) => (b.timestamp_ms || 0) - (a.timestamp_ms || 0))
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

  function getRangeUsageSummary(startMs, endMs) {
    const row = rangeUsageSummaryStmt.get(Math.trunc(startMs || 0), Math.trunc(endMs || Date.now()));
    return {
      requests: Number(row?.requests) || 0,
      costUsd: Number((Number(row?.cost_usd) || 0).toFixed(6)),
      totalTokens: Number(row?.total_tokens) || 0
    };
  }

  function close() {
    try { db.close(); } catch {}
  }

  return {
    getMeta: key => db.prepare('SELECT value FROM store_meta WHERE key=?').get(key)?.value,
    setMeta: (key, value) => db.prepare('INSERT OR REPLACE INTO store_meta(key,value) VALUES (?,?)').run(key, String(value)),
    getRevision,
    getSourceStamp,
    replaceSourceRequests,
    syncThreadLinks,
    pruneMissingSources,
    getIngestedCodexDedupeKeys,
    getSourceUsageCounts,
    saveQuotaSnapshots,
    listAllRequests,
    getLatestRequestForThread,
    countThreadUnread: (id, ts) => db.prepare("SELECT COUNT(*) AS n FROM requests WHERE t3_thread_id=? AND status='error' AND timestamp_ms>?").get(id, ts).n,
    listThreadIncidents(id, natives, since) {
      const ids = [...new Set(natives.filter(Boolean))];
      const native = ids.length ? ' OR native_session_id IN (' + ids.map(() => '?').join(',') + ')' : '';
      return db.prepare("SELECT * FROM requests WHERE (t3_thread_id=?" + native + ") AND timestamp_ms>=? AND (status='error' OR retries>0) ORDER BY timestamp_ms DESC LIMIT 50")
        .all(id,...ids,since).map(mapRow);
    },
    listRecentRequestsForThread,
    listQuotaSnapshots,
    getRangeUsageSummary,
    close
  };
}
