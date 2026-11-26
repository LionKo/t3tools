import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import { createTelemetryStore } from '../src/core/telemetry-store.mjs';
import { createSettingsStore } from '../src/core/settings.mjs';
import { createFolderSync, detectSuggestedSyncDirs } from '../src/sync/folder-sync.mjs';
import { createT3StateAdapter } from '../src/adapters/t3-state.mjs';
import { createAnalyticsEngine } from '../src/analytics/engine.mjs';
import { detectCacheAnomalies } from '../src/analytics/cache-anomalies.mjs';
import { startDaemon } from '../src/host/daemon.mjs';
import { buildClientBundle } from '../src/ui/bundle.mjs';
import { buildFallbackHtml } from '../src/ui/fallback-page.mjs';
import { runInNewContext } from 'node:vm';

function makeTempDir(prefix = 't3-mmsync-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function safeRmDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {}
}

function makeRow(overrides = {}) {
  const now = overrides.timestampMs ?? Date.now();
  return {
    id: overrides.id || 'req-1',
    dedupeKey: overrides.dedupeKey || null,
    providerDriver: overrides.providerDriver || 'antigravity',
    accountId: overrides.accountId || 'Ultra',
    t3ThreadId: overrides.t3ThreadId ?? 'thread-1',
    t3ThreadTitle: overrides.t3ThreadTitle ?? 'Secret Project Title',
    nativeSessionId: overrides.nativeSessionId || 'sess-1',
    modelId: overrides.modelId || 'gemini-4-neon',
    modelRaw: overrides.modelRaw || 'gemini-4-neon',
    effort: overrides.effort || 'high',
    role: overrides.role || 'planner',
    timestampMs: now,
    billingTsMs: overrides.billingTsMs ?? now,
    inputTokens: overrides.inputTokens ?? 1000,
    cacheReadTokens: overrides.cacheReadTokens ?? 4000,
    cacheWriteTokens: overrides.cacheWriteTokens ?? 0,
    outputTokens: overrides.outputTokens ?? 500,
    thinkingTokens: overrides.thinkingTokens ?? 200,
    contextUsedTokens: overrides.contextUsedTokens ?? 5000,
    contextMaxTokens: overrides.contextMaxTokens ?? 200000,
    ttftMs: overrides.ttftMs ?? 450,
    streamingMs: overrides.streamingMs ?? 2000,
    durationMs: overrides.durationMs ?? 2600,
    tps: overrides.tps ?? 250,
    tpsKind: overrides.tpsKind || 'generation',
    tpsEstimated: Boolean(overrides.tpsEstimated),
    costUsd: overrides.costUsd ?? 0.05,
    savedUsd: overrides.savedUsd ?? 0.02,
    status: overrides.status || 'success',
    outcomeKnown: overrides.outcomeKnown !== false,
    retries: overrides.retries ?? 0,
    errorCode: overrides.errorCode || '',
    errorText: overrides.errorText || '',
    compactionBefore: Boolean(overrides.compactionBefore)
  };
}

function createStubEngineDeps(store, settings, folderSync) {
  return {
    store,
    settings,
    folderSync,
    t3State: {
      readThreadIndex: () => ({ threadsById: new Map(), nativeToThread: new Map(), threadToNatives: new Map(), providerThreadToNative: new Map(), latestThreadId: null, recentThreads: [] }),
      readThreadExecution: () => null,
      readFailedRuns: () => []
    },
    antigravityAdapter: { syncAll() {}, getDiagnostics: () => ({}) },
    codexAdapter: { syncAll() {}, getDiagnostics: () => ({}) },
    quotaAdapter: { readAllQuotas: () => ({ groups: [], flatWindows: [], summary: {} }) }
  };
}

test('opt-in default: disabled sync never writes files and detectSuggestedSyncDirs works with no cloud drives', () => {
  const root = makeTempDir();
  const store = createTelemetryStore(join(root, 'telemetry.sqlite'));
  try {
    const settings = createSettingsStore(join(root, 'settings.json'));
    const emptyHome = join(root, 'empty-home');
    mkdirSync(emptyHome, { recursive: true });

    assert.equal(settings.get().multiMachineSync.enabled, false);
    assert.deepEqual(detectSuggestedSyncDirs({ env: {}, home: emptyHome }), []);

    const syncTarget = join(root, 'should-not-exist');
    const sync = createFolderSync({
      paths: { home: emptyHome },
      store,
      settings,
      env: {},
      hostnameFn: () => 'SoloPC'
    });
    const st = sync.sync({ force: true });
    assert.equal(st.state, 'disabled');
    assert.equal(existsSync(syncTarget), false);
  } finally {
    store.close();
    safeRmDir(root);
  }
});

test('two-machine folder sync merges tokens without collisions, prevents re-export loops, and enforces privacy & integrity', () => {
  const root = makeTempDir();
  const sharedDir = join(root, 'SharedSync');
  const now = Date.UTC(2026, 10, 26, 10, 0, 0);

  // Machine A: ReadyToWork
  const storeA = createTelemetryStore(join(root, 'a', 'telemetry.sqlite'));
  // Machine B: Knight (deliberately uses same original row id!)
  const storeB = createTelemetryStore(join(root, 'b', 'telemetry.sqlite'));
  try {
    const settingsA = createSettingsStore(join(root, 'a', 'settings.json'));
    settingsA.update({
      multiMachineSync: {
        enabled: true,
        syncDir: sharedDir,
        machineLabel: 'ReadyToWork',
        includeThreadTitle: false,
        includeErrorText: false
      }
    });
    storeA.replaceSourceRequests('agy:sess-a', 'v1', [
      makeRow({ id: 'same-id-1', timestampMs: now, inputTokens: 1000, cacheReadTokens: 0, outputTokens: 500, costUsd: 0.1, t3ThreadTitle: 'Private Title A', status: 'error', errorCode: 'timeout', errorText: 'secret stack trace A' })
    ]);
    const syncA = createFolderSync({ paths: { home: join(root, 'a') }, store: storeA, settings: settingsA, env: {}, hostnameFn: () => 'HostA' });

    const settingsB = createSettingsStore(join(root, 'b', 'settings.json'));
    settingsB.update({
      multiMachineSync: {
        enabled: true,
        syncDir: sharedDir,
        machineLabel: 'Knight',
        includeThreadTitle: true,
        includeErrorText: false
      }
    });
    storeB.replaceSourceRequests('codex-rollout:sess-b', 'v1', [
      makeRow({ id: 'same-id-1', providerDriver: 'codex', accountId: 'codex', timestampMs: now + 5000, inputTokens: 2000, cacheReadTokens: 1000, outputTokens: 1000, costUsd: 0.25, t3ThreadTitle: 'Knight Build Task' })
    ]);
    const syncB = createFolderSync({ paths: { home: join(root, 'b') }, store: storeB, settings: settingsB, env: {}, hostnameFn: () => 'HostB' });

    // Step 1: A exports, B exports & imports A, A imports B
    const stA1 = syncA.sync({ force: true, now });
    assert.equal(stA1.state, 'ok');
    assert.equal(stA1.lastExportedRequests, 1);

    const stB1 = syncB.sync({ force: true, now: now + 1000 });
    assert.equal(stB1.state, 'ok');
    assert.equal(stB1.remoteMachinesCount, 1);
    assert.equal(stB1.remoteRequestsCount, 1);

    const stA2 = syncA.sync({ force: true, now: now + 2000 });
    assert.equal(stA2.state, 'ok');
    assert.equal(stA2.remoteMachinesCount, 1);
    assert.equal(stA2.peers[0].machineLabel, 'Knight');

    // Verify A has both rows (1 local + 1 remote) with zero ID collision
    const rowsInA = storeA.listAllRequests();
    assert.equal(rowsInA.length, 2);
    const remoteInA = rowsInA.find(r => r.isRemote);
    assert.equal(remoteInA.machineLabel, 'Knight');
    assert.equal(remoteInA.t3ThreadTitle, 'Knight Build Task');

    // Verify privacy on A's exported row when imported into B
    const remoteInB = storeB.listAllRequests().find(r => r.isRemote);
    assert.equal(remoteInB.machineLabel, 'ReadyToWork');
    assert.equal(remoteInB.t3ThreadTitle, '');
    assert.equal(remoteInB.errorText, '');
    assert.equal(remoteInB.errorCode, 'timeout');

    // Re-running sync on A must NOT re-export B's rows back into A's manifest
    syncA.sync({ force: true, now: now + 3000 });
    const manifestA = JSON.parse(readFileSync(join(sharedDir, 'machines', syncA.getLocalMachineId(), 'manifest.json'), 'utf8'));
    assert.equal(manifestA.totalRequests, 1);

    // Verify local pruneMissingSources never deletes remote rows
    storeA.pruneMissingSources('agy:', new Set(['agy:sess-a']));
    assert.equal(storeA.listAllRequests().length, 2);

    // Verify analytics engine filters by machine & isolates sidebarScope and local alerts
    const engineA = createAnalyticsEngine(createStubEngineDeps(storeA, settingsA, syncA));
    const dashAll = engineA.getDashboardData({ preset: 'all', machine: 'all' }, { now: now + 10000 });
    assert.equal(dashAll.summary.kpis.totalRequests, 2);
    assert.equal(dashAll.summary.kpis.totalTokens, 5500);
    assert.equal(dashAll.facets.machines.length, 2);
    assert.equal(dashAll.requestsLedger.by.machine.length, 2);

    const dashLocal = engineA.getDashboardData({ preset: 'all', machine: 'local' }, { now: now + 10000 });
    assert.equal(dashLocal.summary.kpis.totalRequests, 1);
    assert.equal(dashLocal.summary.kpis.totalTokens, 1500);

    const dashKnight = engineA.getDashboardData({ preset: 'all', machine: syncB.getLocalMachineId() }, { now: now + 10000 });
    assert.equal(dashKnight.summary.kpis.totalRequests, 1);
    assert.equal(dashKnight.summary.kpis.totalTokens, 4000);

    // Sidebar scope: all vs local
    const todayAll = engineA.getTodayUsageSummary(now + 10000);
    assert.equal(todayAll.totalTokens, 5500);
    settingsA.update({ multiMachineSync: { sidebarScope: 'local' } });
    const todayLocal = engineA.getTodayUsageSummary(now + 10000);
    assert.equal(todayLocal.totalTokens, 1500);

    // Tampering with Knight's shard hash must be rejected cleanly without crashing or dropping cached data
    const knightShard = join(sharedDir, 'machines', syncB.getLocalMachineId(), '2026-11.ndjson.gz');
    const knightManifestPath = join(sharedDir, 'machines', syncB.getLocalMachineId(), 'manifest.json');
    const km = JSON.parse(readFileSync(knightManifestPath, 'utf8'));
    km.shards['2026-11'].sha256 = '0'.repeat(64);
    writeFileSync(knightManifestPath, JSON.stringify(km), 'utf8');
    writeFileSync(knightShard, zlib.gzipSync(Buffer.from('{"id":"tampered"}\n')), 'utf8');

    const stTampered = syncA.sync({ force: true, now: now + 20000 });
    assert.equal(stTampered.state, 'partial');
    assert.match(stTampered.lastError, /校验未通过/);
    // Previous valid remote row remains intact
    assert.equal(storeA.listAllRequests().length, 2);

    // Clear remote data preserves local data
    syncA.clearRemoteData();
    assert.equal(storeA.listAllRequests().length, 1);
    assert.equal(storeA.listAllRequests()[0].isRemote, false);
  } finally {
    storeA.close();
    storeB.close();
    safeRmDir(root);
  }
});

test('cache anomaly detection isolates identical session IDs across different machines', () => {
  const base = Date.now() - 60000;
  const res = detectCacheAnomalies([
    { ...makeRow({ id: 'a1', timestampMs: base, inputTokens: 1000, cacheReadTokens: 20000, nativeSessionId: 'shared-sid' }), machineId: 'local' },
    // Different machine cold start 10s later with same nativeSessionId must NOT trigger cache-cleared anomaly
    { ...makeRow({ id: 'b1', timestampMs: base + 10000, inputTokens: 21000, cacheReadTokens: 0, nativeSessionId: 'shared-sid' }), machineId: 'remote-knight' }
  ]);
  assert.equal(res.summary.total, 0);
});

test('daemon multi-machine sync endpoints enforce auth and UI hides machine picker on single machine', async () => {
  const root = makeTempDir();
  const daemon = await startDaemon({
    pathOverrides: {
      home: root,
      t3Root: join(root, '.t3'),
      pluginDataDir: join(root, '.t3tools'),
      codexHome: join(root, '.codex')
    },
    portOverride: 0,
    enableCdp: false,
    enableRemoteUpdateCheck: false
  });
  try {
    // Rejects unauthenticated POST
    const unauth = await fetch(`${daemon.url}/api/sync/multi-machine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(unauth.status, 401);
    await unauth.text();

    // Accepts authenticated POST
    const okRes = await fetch(`${daemon.url}/api/sync/multi-machine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-T3Tools-Token': daemon.authToken },
      body: '{}'
    });
    assert.equal(okRes.status, 200);
    const okJson = await okRes.json();
    assert.equal(okJson.ok, true);
    assert.equal(okJson.data.state, 'disabled');

    // Verify bundled UI syntax and single-machine vs multi-machine toolbar rendering
    const bundle = buildClientBundle({ version: '0.1.5', transport: 'http', apiBase: daemon.url });
    assert.doesNotThrow(() => new Function(bundle));
    const fallbackHtml = buildFallbackHtml({ version: '0.1.5', apiBase: daemon.url, authToken: daemon.authToken });
    assert.ok(fallbackHtml.includes('settings-multi-machine-sync-slot'));

    // Execute shared-views helper in VM to check toolbar hides machine button for 1 machine and shows for 2
    const sharedSrc = readFileSync(new URL('../src/ui/shared-views.js', import.meta.url), 'utf8');
    const sandbox = {};
    runInNewContext(`${sharedSrc}\nthis.__exports = { renderViewToolbarHtml, renderMultiMachineSyncCardHtml };`, sandbox);
    const singleHtml = sandbox.__exports.renderViewToolbarHtml(
      { range: { preset: 'weeklyQuota' }, facets: { accounts: ['Ultra'], machines: [{ id: 'local', label: 'ReadyToWork', isLocal: true }] } },
      { preset: 'weeklyQuota', account: 'all', machine: 'all' }
    );
    assert.equal(singleHtml.includes('data-pt-machine-trigger'), false);

    const multiHtml = sandbox.__exports.renderViewToolbarHtml(
      {
        range: { preset: 'weeklyQuota' },
        facets: {
          accounts: ['Ultra'],
          machines: [
            { id: 'local', label: 'ReadyToWork', isLocal: true },
            { id: 'm-knight', label: 'Knight', isLocal: false }
          ]
        }
      },
      { preset: 'weeklyQuota', account: 'all', machine: 'all' }
    );
    assert.equal(multiHtml.includes('data-pt-machine-trigger'), true);
  } finally {
    await daemon.stop('test done');
    safeRmDir(root);
  }
});

test('schema v3 migrates in-place to v4 preserving local rows and deferInitialSync binds HTTP immediately', async () => {
  const root = makeTempDir();
  const dbPath = join(root, 'v3.sqlite');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO store_meta (key, value) VALUES ('schema_version', '3');
    CREATE TABLE source_files (source_key TEXT PRIMARY KEY, stamp TEXT NOT NULL, updated_at_ms INTEGER NOT NULL);
    INSERT INTO source_files VALUES ('agy:legacy-1', 'stamp-1', 1700000000000);
    CREATE TABLE requests (
      id TEXT PRIMARY KEY, dedupe_key TEXT, source_key TEXT NOT NULL,
      provider_driver TEXT NOT NULL, account_id TEXT NOT NULL, t3_thread_id TEXT, t3_thread_title TEXT,
      native_session_id TEXT NOT NULL, model_id TEXT NOT NULL, model_raw TEXT NOT NULL,
      effort TEXT, role TEXT, timestamp_ms INTEGER NOT NULL, billing_ts_ms INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      thinking_tokens INTEGER NOT NULL DEFAULT 0, context_used_tokens INTEGER, context_max_tokens INTEGER,
      ttft_ms INTEGER, streaming_ms INTEGER, duration_ms INTEGER, tps REAL,
      tps_kind TEXT NOT NULL DEFAULT 'none', tps_estimated INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL, saved_usd REAL, status TEXT NOT NULL, outcome_known INTEGER NOT NULL DEFAULT 1,
      retries INTEGER NOT NULL DEFAULT 0, error_code TEXT, error_text TEXT,
      compaction_before INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO requests (id, source_key, provider_driver, account_id, native_session_id, model_id, model_raw, timestamp_ms, billing_ts_ms, input_tokens, output_tokens, status)
    VALUES ('legacy-row-1', 'agy:legacy-1', 'antigravity', 'Ultra', 'sess-legacy', 'gemini-4-neon', 'gemini-4-neon', 1700000000000, 1700000000000, 123, 45, 'success');
  `);
  legacyDb.close();

  const store = createTelemetryStore(dbPath);
  let daemon = null;
  try {
    assert.equal(store.getMeta('schema_version'), '4');
    assert.equal(store.getSourceStamp('agy:legacy-1'), 'stamp-1');
    const rows = store.listAllRequests();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'legacy-row-1');
    assert.equal(rows[0].machineId, 'local');
    assert.equal(rows[0].isRemote, false);

    daemon = await startDaemon({
      pathOverrides: {
        home: root,
        t3Root: join(root, '.t3'),
        pluginDataDir: join(root, '.t3tools'),
        codexHome: join(root, '.codex')
      },
      portOverride: 0,
      enableCdp: false,
      enableRemoteUpdateCheck: false,
      deferInitialSync: true
    });
    const health = await fetch(`${daemon.url}/api/health`).then(r => r.json());
    assert.equal(health.ok, true);
    assert.equal(health.data.state, 'running');
  } finally {
    store.close();
    if (daemon) await daemon.stop('test done');
    safeRmDir(root);
  }
});

test('syncAsync exports incrementally by dirty month without rewriting untouched history and stops cleanly', async () => {
  const root = makeTempDir();
  const sharedDir = join(root, 'SharedAsync');
  const octTs = Date.UTC(2026, 9, 15, 10, 0, 0);
  const novTs = Date.UTC(2026, 10, 20, 10, 0, 0);

  const storeA = createTelemetryStore(join(root, 'a', 'telemetry.sqlite'));
  const storeB = createTelemetryStore(join(root, 'b', 'telemetry.sqlite'));
  try {
    const settingsA = createSettingsStore(join(root, 'a', 'settings.json'));
    settingsA.update({ multiMachineSync: { enabled: true, syncDir: sharedDir, machineLabel: 'AsyncA' } });
    storeA.replaceSourceRequests('agy:oct', 'v1', [makeRow({ id: 'oct-1', timestampMs: octTs, billingTsMs: octTs })]);
    storeA.replaceSourceRequests('agy:nov', 'v1', [makeRow({ id: 'nov-1', timestampMs: novTs, billingTsMs: novTs })]);

    const syncA = createFolderSync({ paths: { home: join(root, 'a') }, store: storeA, settings: settingsA, env: {}, hostnameFn: () => 'HostA' });
    const st1 = await syncA.syncAsync({ force: true, now: novTs });
    assert.equal(st1.state, 'ok');
    assert.equal(st1.lastExportedRequests, 2);

    // Modify only November and verify October is not rewritten while November updates cleanly
    let listByMonthCalls = [];
    const origListByMonth = storeA.listLocalRequestsByMonth;
    storeA.listLocalRequestsByMonth = m => {
      listByMonthCalls.push(m);
      return origListByMonth(m);
    };
    storeA.replaceSourceRequests('agy:nov', 'v2', [
      makeRow({ id: 'nov-1', timestampMs: novTs, billingTsMs: novTs }),
      makeRow({ id: 'nov-2', timestampMs: novTs + 5000, billingTsMs: novTs + 5000 })
    ]);

    const st2 = await syncA.syncAsync({ force: true, now: novTs + 6000 });
    assert.equal(st2.state, 'ok');
    assert.equal(st2.lastExportedRequests, 3);
    assert.deepEqual(listByMonthCalls, ['2026-11']);

    // Machine B imports A asynchronously
    const settingsB = createSettingsStore(join(root, 'b', 'settings.json'));
    settingsB.update({ multiMachineSync: { enabled: true, syncDir: sharedDir, machineLabel: 'AsyncB' } });
    const syncB = createFolderSync({ paths: { home: join(root, 'b') }, store: storeB, settings: settingsB, env: {}, hostnameFn: () => 'HostB' });
    const stB = await syncB.syncAsync({ force: true, now: novTs + 7000 });
    assert.equal(stB.state, 'ok');
    assert.equal(stB.remoteRequestsCount, 3);
    assert.equal(storeB.listAllRequests().length, 3);

    syncA.stop();
    syncB.stop();
    await Promise.all([syncA.whenIdle(), syncB.whenIdle()]);
  } finally {
    storeA.close();
    storeB.close();
    safeRmDir(root);
  }
});

test('failed manifest write followed by privacy toggle rewrites uncommitted shard and unreadable peer manifest keeps cached data', async () => {
  const root = makeTempDir();
  const sharedDir = join(root, 'SharedPrivacy');
  const novTs = Date.UTC(2026, 10, 20, 10, 0, 0);

  const storeA = createTelemetryStore(join(root, 'a', 'telemetry.sqlite'));
  const storeB = createTelemetryStore(join(root, 'b', 'telemetry.sqlite'));
  try {
    const settingsA = createSettingsStore(join(root, 'a', 'settings.json'));
    settingsA.update({
      multiMachineSync: { enabled: true, syncDir: sharedDir, machineLabel: 'HostA', includeErrorText: false }
    });
    storeA.replaceSourceRequests('agy:err', 'v1', [
      makeRow({ id: 'err-priv-1', timestampMs: novTs, billingTsMs: novTs, status: 'error', errorCode: 'timeout', errorText: 'SENSITIVE_SECRET_TOKEN_XYZ' })
    ]);

    const syncA1 = createFolderSync({ paths: { home: join(root, 'a') }, store: storeA, settings: settingsA, env: {}, hostnameFn: () => 'HostA' });
    assert.equal((await syncA1.syncAsync({ force: true, now: novTs })).state, 'ok');

    // Enable errorText, publish shard, then simulate manifest write failure by leaving a stale manifest
    // while keeping pending shard state (simulate manifest rename failure by replacing manifest.json with a directory temporarily)
    const machineDirA = join(sharedDir, 'machines', syncA1.getLocalMachineId());
    const manifestPathA = join(machineDirA, 'manifest.json');
    const savedRedactedManifest = readFileSync(manifestPathA, 'utf8');
    rmSync(manifestPathA, { force: true });
    mkdirSync(manifestPathA); // causes manifest atomic rename to fail after shard rewrite!

    settingsA.update({ multiMachineSync: { includeErrorText: true } });
    const failedPass = await syncA1.syncAsync({ force: true, now: novTs + 1000 });
    assert.equal(failedPass.state, 'error');

    // Verify the uncommitted shard on disk currently contains the sensitive error text
    const shardPathA = join(machineDirA, '2026-11.ndjson.gz');
    assert.match(zlib.gunzipSync(readFileSync(shardPathA)).toString('utf8'), /SENSITIVE_SECRET_TOKEN_XYZ/);

    // Restore the old redacted manifest, disable errorText, and retry with a brand new FolderSync instance
    rmSync(manifestPathA, { recursive: true, force: true });
    writeFileSync(manifestPathA, savedRedactedManifest, 'utf8');
    settingsA.update({ multiMachineSync: { includeErrorText: false } });

    const syncA2 = createFolderSync({ paths: { home: join(root, 'a') }, store: storeA, settings: settingsA, env: {}, hostnameFn: () => 'HostA' });
    const recoveredPass = await syncA2.syncAsync({ force: true, now: novTs + 2000 });
    assert.equal(recoveredPass.state, 'ok');
    // Uncommitted shard MUST have been rewritten without sensitive errorText
    assert.doesNotMatch(zlib.gunzipSync(readFileSync(shardPathA)).toString('utf8'), /SENSITIVE_SECRET_TOKEN_XYZ/);

    // Machine B imports A, then A's manifest becomes temporarily unreadable -> B must retain cached rows and report partial
    const settingsB = createSettingsStore(join(root, 'b', 'settings.json'));
    settingsB.update({ multiMachineSync: { enabled: true, syncDir: sharedDir, machineLabel: 'HostB' } });
    const syncB = createFolderSync({ paths: { home: join(root, 'b') }, store: storeB, settings: settingsB, env: {}, hostnameFn: () => 'HostB' });
    assert.equal((await syncB.syncAsync({ force: true, now: novTs + 3000 })).state, 'ok');
    assert.equal(storeB.listAllRequests().length, 1);

    writeFileSync(manifestPathA, '{truncated-json', 'utf8');
    const partialRes = await syncB.syncAsync({ force: true, now: novTs + 4000 });
    assert.equal(partialRes.state, 'partial');
    assert.equal(storeB.listAllRequests().length, 1);
    assert.equal(partialRes.remoteMachinesCount, 1);

    // Out-of-range billing timestamp (> year 9999) stays consistent between totalRequests and exported shards
    storeA.replaceSourceRequests('agy:huge', 'v1', [
      makeRow({ id: 'huge-ts-1', timestampMs: novTs, billingTsMs: 9e15 })
    ]);
    const stHuge = await syncA2.syncAsync({ force: true, now: novTs + 5000 });
    assert.equal(stHuge.state, 'ok');
    const updatedManifest = JSON.parse(readFileSync(manifestPathA, 'utf8'));
    const shardSum = Object.values(updatedManifest.shards).reduce((s, x) => s + x.count, 0);
    assert.equal(updatedManifest.totalRequests, shardSum);
    assert.equal(updatedManifest.totalRequests, 2);

    // Fixed clock throttling uses caller clock consistently
    const skipped = await syncA2.syncAsync({ force: false, now: novTs + 10000 });
    assert.equal(skipped.lastSyncAtMs, novTs + 5000);
    const ranAfterInterval = await syncA2.syncAsync({ force: false, now: novTs + 5000 + 35000 });
    assert.equal(ranAfterInterval.lastSyncAtMs, novTs + 5000 + 35000);
  } finally {
    storeA.close();
    storeB.close();
    safeRmDir(root);
  }
});

test('external SQLite write is never skipped by atomic dirty snapshot and upgraded store uses selective indexes', () => {
  const root = makeTempDir();
  const dbPath = join(root, 'ext.sqlite');
  const octTs = Date.UTC(2026, 9, 10, 8, 0, 0);
  const novTs = Date.UTC(2026, 10, 10, 8, 0, 0);

  const store = createTelemetryStore(dbPath);
  const extDb = new DatabaseSync(dbPath);
  try {
    store.replaceSourceRequests('agy:oct', 'v1', [makeRow({ id: 'oct-1', nativeSessionId: 'sess-oct', timestampMs: octTs, billingTsMs: octTs, inputTokens: 100 })]);
    store.replaceSourceRequests('agy:nov', 'v1', [makeRow({ id: 'nov-1', nativeSessionId: 'sess-nov', timestampMs: novTs, billingTsMs: novTs, inputTokens: 200 })]);

    // Verify upgraded query plans never fall back to a broad is_remote-only index
    const linkPlan = extDb.prepare(`
      EXPLAIN QUERY PLAN
      UPDATE requests
      SET t3_thread_id = ?, t3_thread_title = ?, account_id = CASE WHEN ? != '' THEN ? ELSE account_id END
      WHERE is_remote = 0
        AND native_session_id = ?
        AND (t3_thread_id IS NULL OR t3_thread_id != ? OR t3_thread_title != ? OR (? != '' AND account_id != ?))
    `).all('t1', 'title', 'acct', 'acct', 'sess-oct', 't1', 'title', 'acct', 'acct');
    assert.ok(linkPlan.some(p => /idx_requests_(local_)?session_ts/.test(p.detail)), `unexpected link plan: ${JSON.stringify(linkPlan)}`);

    const incPlan = extDb.prepare(`
      EXPLAIN QUERY PLAN
      SELECT * FROM requests
      WHERE is_remote = 0 AND timestamp_ms >= ? AND (status = 'error' OR retries > 0)
      ORDER BY timestamp_ms DESC
    `).all(octTs);
    assert.ok(incPlan.some(p => /idx_requests_local_incidents_v2_ts/.test(p.detail)), `unexpected incident plan: ${JSON.stringify(incPlan)}`);

    const sharedDir = join(root, 'SharedExt');
    const settings = createSettingsStore(join(root, 'settings.json'));
    settings.update({ multiMachineSync: { enabled: true, syncDir: sharedDir, machineLabel: 'ExtHost' } });
    const sync = createFolderSync({ paths: { home: root }, store, settings, env: {}, hostnameFn: () => 'ExtHost' });

    assert.equal(sync.sync({ force: true, now: novTs }).state, 'ok');
    // External connection updates October row, THEN daemon updates November -> October must NOT be hidden!
    extDb.prepare('UPDATE requests SET input_tokens = 999 WHERE id = ?').run('oct-1');
    store.replaceSourceRequests('agy:nov', 'v2', [makeRow({ id: 'nov-1', nativeSessionId: 'sess-nov', timestampMs: novTs, billingTsMs: novTs, inputTokens: 300 })]);
    assert.equal(sync.sync({ force: true, now: novTs + 1000 }).state, 'ok');

    const octShard = join(sharedDir, 'machines', sync.getLocalMachineId(), '2026-10.ndjson.gz');
    const octRow = JSON.parse(zlib.gunzipSync(readFileSync(octShard)).toString('utf8').trim());
    assert.equal(octRow.inputTokens, 999);
  } finally {
    extDb.close();
    store.close();
    safeRmDir(root);
  }
});

test('POST /api/sync triggers multi-machine sync and deferInitialSync: false completes initial folder sync before returning', async () => {
  const root = makeTempDir();
  const sharedDir = join(root, 'SharedHttp');
  const now = Date.UTC(2026, 10, 26, 12, 0, 0);
  const pluginDataDir = join(root, '.t3tools');
  mkdirSync(pluginDataDir, { recursive: true });
  writeFileSync(join(pluginDataDir, 'settings.json'), JSON.stringify({
    multiMachineSync: { enabled: true, syncDir: sharedDir, machineLabel: 'HttpSyncHost' }
  }), 'utf8');

  const preStore = createTelemetryStore(join(pluginDataDir, 'telemetry.sqlite'));
  preStore.replaceSourceRequests('agy:pre', 'v1', [makeRow({ id: 'pre-1', timestampMs: now, billingTsMs: now })]);
  preStore.close();

  const daemon = await startDaemon({
    pathOverrides: {
      home: root,
      t3Root: join(root, '.t3'),
      pluginDataDir,
      codexHome: join(root, '.codex')
    },
    portOverride: 0,
    enableCdp: false,
    enableRemoteUpdateCheck: false,
    deferInitialSync: false
  });
  try {
    // Initial sync with deferInitialSync: false already exported local row
    const st = daemon.ctx.folderSync.getStatus();
    assert.equal(st.state, 'ok');
    assert.equal(st.lastExportedRequests, 1);

    // Add another local row and call POST /api/sync -> must export via forceSync RPC
    daemon.ctx.store.replaceSourceRequests('agy:post', 'v1', [makeRow({ id: 'post-1', timestampMs: now + 1000, billingTsMs: now + 1000 })]);
    const res = await fetch(`${daemon.url}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-T3Tools-Token': daemon.authToken },
      body: '{}'
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.data.multiMachineSync.lastExportedRequests, 2);
  } finally {
    await daemon.stop('test done');
    safeRmDir(root);
  }
});

test('t3-state adapter releases bounded Windows handle for file replacement and prepares execution queries lazily', async () => {
  const root = makeTempDir('t3-state-bound-');
  const dbPath = join(root, 'statev2.sqlite');
  const replacementPath = join(root, 'statev2.next.sqlite');

  function createMinimalStateDb(targetPath, threadTitle, runId) {
    const db = new DatabaseSync(targetPath);
    try {
      // Deliberately omit `ordinal` column on runs to ensure lazy per-feature preparation
      db.exec(`
        CREATE TABLE orchestration_v2_projection_threads (
          thread_id TEXT PRIMARY KEY,
          title TEXT,
          default_provider TEXT,
          provider_instance_id TEXT,
          updated_at TEXT,
          archived_at TEXT,
          deleted_at TEXT
        );
        CREATE TABLE orchestration_v2_projection_runs (
          run_id TEXT PRIMARY KEY,
          thread_id TEXT,
          provider_instance_id TEXT,
          status TEXT,
          completed_at TEXT,
          payload_json TEXT
        );
      `);
      db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, ?, ?, NULL, NULL)')
        .run('th-1', threadTitle, 'antigravity', 'Ultra', new Date().toISOString());
      db.prepare('INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?, ?, ?, ?)')
        .run(runId, 'th-1', 'Ultra', 'failed', new Date().toISOString(), JSON.stringify({ modelSelection: { model: 'gemini-4-neon' } }));
    } finally {
      db.close();
    }
  }

  createMinimalStateDb(dbPath, 'Before Replace', 'run-before');
  createMinimalStateDb(replacementPath, 'After Replace', 'run-after');

  const adapter = createT3StateAdapter({ stateDbPath: dbPath, settingsPath: join(root, 'settings.json') });
  try {
    const idx1 = adapter.readThreadIndex();
    assert.equal(idx1.threadsById.get('th-1')?.title, 'Before Replace');
    const failed1 = adapter.readFailedRuns(Date.now() - 60000);
    assert.equal(failed1.length, 1);
    assert.equal(failed1[0].id, 'run:run-before');

    // Wait past bounded handle lifetime (400ms) -> Windows file handle must be closed so replacement succeeds
    await new Promise(r => setTimeout(r, 500));
    rmSync(dbPath);
    writeFileSync(dbPath, readFileSync(replacementPath));

    const idx2 = adapter.readThreadIndex();
    assert.equal(idx2.threadsById.get('th-1')?.title, 'After Replace');
    const failed2 = adapter.readFailedRuns(Date.now() - 60000);
    assert.equal(failed2.length, 1);
    assert.equal(failed2[0].id, 'run:run-after');

    // Exclusive writer on rollback-journal statev2.sqlite must fail fast (< 300ms) instead of stalling 1000ms+
    const lockDb = new DatabaseSync(dbPath);
    try {
      lockDb.exec('BEGIN EXCLUSIVE');
      const tLock0 = Date.now();
      assert.throws(() => adapter.readFailedRuns(Date.now() - 60000));
      assert.ok(Date.now() - tLock0 < 300, 'readFailedRuns must fail fast under exclusive lock');
      lockDb.exec('ROLLBACK');
    } finally {
      lockDb.close();
    }
  } finally {
    adapter.close();
    safeRmDir(root);
  }
});

test('folderSync guards malformed peer manifests, journal failures, >MAX_SAFE_INTEGER timestamps, and worker remote imports', async () => {
  const root = makeTempDir('t3-hardening-');
  const sharedDir = join(root, 'SharedHardening');
  const now = Date.UTC(2026, 10, 26, 12, 0, 0);

  const storeA = createTelemetryStore(join(root, 'a', 'telemetry.sqlite'));
  const storeB = createTelemetryStore(join(root, 'b', 'telemetry.sqlite'));
  try {
    const settingsA = createSettingsStore(join(root, 'a', 'settings.json'));
    settingsA.update({ multiMachineSync: { enabled: true, syncDir: sharedDir, machineLabel: 'HardA' } });
    // Extremely large timestamp (> Number.MAX_SAFE_INTEGER) must clamp cleanly without ERR_OUT_OF_RANGE
    storeA.replaceSourceRequests('agy:safe', 'v1', [
      makeRow({ id: 'safe-1', timestampMs: now, billingTsMs: 1e18 })
    ]);
    const syncA = createFolderSync({ paths: { home: join(root, 'a') }, store: storeA, settings: settingsA, env: {}, hostnameFn: () => 'HardA' });
    const stA = await syncA.syncAsync({ force: true, now });
    assert.equal(stA.state, 'ok');
    assert.equal(stA.lastExportedRequests, 1);

    // Journal write failure MUST abort publication before writing shards
    const origSetMeta = storeA.setMeta;
    storeA.setMeta = () => { throw new Error('sqlite busy'); };
    storeA.replaceSourceRequests('agy:safe2', 'v2', [makeRow({ id: 'safe-2', timestampMs: now + 1000, billingTsMs: now + 1000 })]);
    const failedJournal = await syncA.syncAsync({ force: true, now: now + 2000 });
    assert.equal(failedJournal.state, 'error');
    storeA.setMeta = origSetMeta;

    // Peer manifest missing `shards` object must be treated as partial and preserve cached rows
    const settingsB = createSettingsStore(join(root, 'b', 'settings.json'));
    settingsB.update({ multiMachineSync: { enabled: true, syncDir: sharedDir, machineLabel: 'HardB' } });
    const syncB = createFolderSync({ paths: { home: join(root, 'b') }, store: storeB, settings: settingsB, env: {}, hostnameFn: () => 'HardB' });
    assert.equal((await syncB.syncAsync({ force: true, now: now + 3000 })).state, 'ok');
    assert.equal(storeB.listAllRequests().length, 1);

    const manifestPathA = join(sharedDir, 'machines', syncA.getLocalMachineId(), 'manifest.json');
    const badManifest = JSON.parse(readFileSync(manifestPathA, 'utf8'));
    delete badManifest.shards;
    writeFileSync(manifestPathA, JSON.stringify(badManifest), 'utf8');
    const partialB = await syncB.syncAsync({ force: true, now: now + 4000 });
    assert.equal(partialB.state, 'partial');
    assert.equal(storeB.listAllRequests().length, 1);

    // Invalid shard hash inside valid shards object must also report partial and preserve cached rows
    const badHashManifest = {
      schemaVersion: 1,
      machineId: syncA.getLocalMachineId(),
      machineLabel: 'HardA',
      exportedAtMs: 1e18, // oversized peer timestamp must never throw ERR_OUT_OF_RANGE
      totalRequests: 1,
      shards: { '1970-01': { file: '1970-01.ndjson.gz', sha256: 'not-a-valid-hex', count: 1 } }
    };
    writeFileSync(manifestPathA, JSON.stringify(badHashManifest), 'utf8');
    const partialHashB = await syncB.syncAsync({ force: true, now: now + 4500 });
    assert.equal(partialHashB.state, 'partial');
    assert.equal(storeB.listAllRequests().length, 1);
    assert.doesNotThrow(() => storeB.listSyncPeers());

    // Contradictory empty shards with totalRequests > 0 must report partial and preserve cached rows
    writeFileSync(manifestPathA, JSON.stringify({
      schemaVersion: 1,
      machineId: syncA.getLocalMachineId(),
      machineLabel: 'HardA',
      exportedAtMs: now,
      totalRequests: 1,
      shards: {}
    }), 'utf8');
    const partialEmptyShards = await syncB.syncAsync({ force: true, now: now + 4600 });
    assert.equal(partialEmptyShards.state, 'partial');
    assert.equal(storeB.listAllRequests().length, 1);

    // Partial manifest omitting one of two months (shard count sum 1 !== declared totalRequests 2) must preserve history
    const octTs = Date.UTC(2026, 9, 15, 12, 0, 0);
    storeA.replaceSourceRequests('agy:oct-keep', 'v1', [
      makeRow({ id: 'keep-oct', timestampMs: octTs, billingTsMs: octTs })
    ]);
    assert.equal((await syncA.syncAsync({ force: true, now: now + 4650 })).state, 'ok');
    assert.equal((await syncB.syncAsync({ force: true, now: now + 4700 })).state, 'ok');
    assert.equal(storeB.listAllRequests().length, 3);
    const fullManifestA = JSON.parse(readFileSync(manifestPathA, 'utf8'));
    const partialMissingMonth = {
      ...fullManifestA,
      shards: { '2026-10': fullManifestA.shards['2026-10'] } // totalRequests still 3, sum is 1
    };
    writeFileSync(manifestPathA, JSON.stringify(partialMissingMonth), 'utf8');
    const partialOmittedB = await syncB.syncAsync({ force: true, now: now + 4750 });
    assert.equal(partialOmittedB.state, 'partial');
    assert.equal(storeB.listAllRequests().length, 3);

    // Invalid non-numeric totalRequests (false / null) with shards: {} must NOT prune cached history
    for (const badTotal of [false, null]) {
      writeFileSync(manifestPathA, JSON.stringify({
        ...fullManifestA,
        totalRequests: badTotal,
        shards: {}
      }), 'utf8');
      assert.equal((await syncB.syncAsync({ force: true, now: now + 4760 })).state, 'partial');
      assert.equal(syncB.sync({ force: true, now: now + 4765 }).state, 'partial');
      assert.equal(storeB.listAllRequests().length, 3);
    }

    // Omitting a month while inflating another cached shard's count to match totalRequests must NOT prune history
    writeFileSync(manifestPathA, JSON.stringify({
      ...fullManifestA,
      totalRequests: 3,
      shards: { '2026-10': { ...fullManifestA.shards['2026-10'], count: 3 } }
    }), 'utf8');
    assert.equal((await syncB.syncAsync({ force: true, now: now + 4770 })).state, 'partial');
    assert.equal(syncB.sync({ force: true, now: now + 4775 }).state, 'partial');
    assert.equal(storeB.listAllRequests().length, 3);

    // Exporter must rewrite manifest when an on-disk shard's count OR bytes was tampered even if hash/total/keys match
    const octShardPathA = join(sharedDir, 'machines', syncA.getLocalMachineId(), '2026-10.ndjson.gz');
    const actualOctBytes = statSync(octShardPathA).size;
    const tamperedLocal = {
      ...fullManifestA,
      shards: {
        ...fullManifestA.shards,
        '2026-10': { ...fullManifestA.shards['2026-10'], count: 99, bytes: actualOctBytes + 42 }
      }
    };
    writeFileSync(manifestPathA, JSON.stringify(tamperedLocal), 'utf8');
    assert.equal((await syncA.syncAsync({ force: true, now: now + 4780 })).state, 'ok');
    const repairedManifestA = JSON.parse(readFileSync(manifestPathA, 'utf8'));
    assert.equal(repairedManifestA.shards['2026-10'].count, 1);
    assert.equal(repairedManifestA.shards['2026-10'].bytes, actualOctBytes);

    // Sync path must also repair tampered bytes when reusing shard
    writeFileSync(manifestPathA, JSON.stringify({
      ...repairedManifestA,
      shards: {
        ...repairedManifestA.shards,
        '2026-10': { ...repairedManifestA.shards['2026-10'], bytes: actualOctBytes + 77 }
      }
    }), 'utf8');
    assert.equal(syncA.sync({ force: true, now: now + 4785 }).state, 'ok');
    assert.equal(JSON.parse(readFileSync(manifestPathA, 'utf8')).shards['2026-10'].bytes, actualOctBytes);

    // Even with NO DB or manifest change, recompressing, truncating, or deleting a shard must bypass early return and repair it
    const octRawNoDb = zlib.gunzipSync(readFileSync(octShardPathA));
    const recompressedNoDb = zlib.gzipSync(octRawNoDb, { level: 0 });
    assert.notEqual(recompressedNoDb.length, actualOctBytes);
    writeFileSync(octShardPathA, recompressedNoDb);
    assert.equal((await syncA.syncAsync({ force: true, now: now + 4786 })).state, 'ok');
    assert.equal(JSON.parse(readFileSync(manifestPathA, 'utf8')).shards['2026-10'].bytes, recompressedNoDb.length);
    // Equal-length 1-byte gzip checksum corruption must also be detected and repaired on forced export (sync & async)
    const validOctGz = readFileSync(octShardPathA);
    const corruptedSameLen = Buffer.from(validOctGz);
    corruptedSameLen[corruptedSameLen.length - 1] ^= 0xff;
    writeFileSync(octShardPathA, corruptedSameLen);
    assert.equal((await syncA.syncAsync({ force: true, now: now + 4786 })).state, 'ok');
    assert.doesNotThrow(() => zlib.gunzipSync(readFileSync(octShardPathA)));
    writeFileSync(octShardPathA, corruptedSameLen);
    assert.equal(syncA.sync({ force: true, now: now + 4786 }).state, 'ok');
    assert.doesNotThrow(() => zlib.gunzipSync(readFileSync(octShardPathA)));

    // Truncating shard to 12 bytes must trigger hash verification failure and regenerate valid gzip
    writeFileSync(octShardPathA, recompressedNoDb.subarray(0, 12));
    assert.equal((await syncA.syncAsync({ force: true, now: now + 4786 })).state, 'ok');
    assert.doesNotThrow(() => zlib.gunzipSync(readFileSync(octShardPathA)));
    writeFileSync(octShardPathA, recompressedNoDb.subarray(0, 12));
    assert.equal(syncA.sync({ force: true, now: now + 4786 }).state, 'ok');
    assert.doesNotThrow(() => zlib.gunzipSync(readFileSync(octShardPathA)));
    rmSync(octShardPathA);
    assert.equal((await syncA.syncAsync({ force: true, now: now + 4787 })).state, 'ok');
    assert.equal(existsSync(octShardPathA), true);
    rmSync(octShardPathA);
    assert.equal(syncA.sync({ force: true, now: now + 4787 }).state, 'ok');
    assert.equal(existsSync(octShardPathA), true);

    // Incremental cache hit must also refresh `bytes` if an unchanged historical shard was recompressed on disk
    const octRaw = zlib.gunzipSync(readFileSync(octShardPathA));
    const recompressedOct = zlib.gzipSync(octRaw, { level: 0 });
    assert.notEqual(recompressedOct.length, actualOctBytes);
    writeFileSync(octShardPathA, recompressedOct);
    storeA.replaceSourceRequests('agy:nov-bump', 'v1', [makeRow({ id: 'nov-bump-1', timestampMs: now + 5000, billingTsMs: now + 5000 })]);
    assert.equal((await syncA.syncAsync({ force: true, now: now + 4788 })).state, 'ok');
    assert.equal(JSON.parse(readFileSync(manifestPathA, 'utf8')).shards['2026-10'].bytes, recompressedOct.length);
    // Re-sync B so B has clean 4 rows from A before tampering A's manifest
    assert.equal((await syncB.syncAsync({ force: true, now: now + 4789 })).state, 'ok');
    const baselineRowsB = storeB.listAllRequests().length;
    assert.equal(baselineRowsB, 4);
    const validManifestBeforeCross = JSON.parse(readFileSync(manifestPathA, 'utf8'));

    // Duplicate request IDs in a shard (count: 2 with 2 identical-ID lines) must NOT prune cached history
    const dupLine = JSON.stringify({
      id: 'dup-1', providerDriver: 'antigravity', accountId: 'Ultra',
      nativeSessionId: 's-dup', modelId: 'gemini-4-neon', modelRaw: 'gemini-4-neon',
      timestampMs: octTs, billingTsMs: octTs, status: 'success'
    });
    const dupNdjson = `${dupLine}\n${dupLine}\n`;
    const dupHash = createHash('sha256').update(dupNdjson).digest('hex');
    const dupGz = zlib.gzipSync(Buffer.from(dupNdjson, 'utf8'));
    writeFileSync(octShardPathA, dupGz);
    writeFileSync(manifestPathA, JSON.stringify({
      ...repairedManifestA,
      totalRequests: 2,
      shards: { '2026-10': { file: '2026-10.ndjson.gz', sha256: dupHash, count: 2, bytes: dupGz.length } }
    }), 'utf8');
    assert.equal((await syncB.syncAsync({ force: true, now: now + 4790 })).state, 'partial');
    assert.equal(syncB.sync({ force: true, now: now + 4795 }).state, 'partial');
    assert.equal(storeB.listAllRequests().length, baselineRowsB);

    // Cross-month duplicate where an EARLIER month (2026-10) tries to steal an ID owned by a LATER cached month (2026-11)
    // must reject BEFORE committing, preserving both 2026-10's original row and 2026-11's original token count
    const stolenNovLine = JSON.stringify({
      id: 'nov-bump-1', providerDriver: 'antigravity', accountId: 'Ultra',
      nativeSessionId: 's-stolen', modelId: 'gemini-4-neon', modelRaw: 'gemini-4-neon',
      timestampMs: octTs, billingTsMs: octTs, inputTokens: 77777, status: 'success'
    }) + '\n';
    const stolenNovHash = createHash('sha256').update(stolenNovLine).digest('hex');
    const stolenNovGz = zlib.gzipSync(Buffer.from(stolenNovLine, 'utf8'));
    writeFileSync(octShardPathA, stolenNovGz);
    writeFileSync(manifestPathA, JSON.stringify({
      ...validManifestBeforeCross,
      shards: {
        ...validManifestBeforeCross.shards,
        '2026-10': { file: '2026-10.ndjson.gz', sha256: stolenNovHash, count: 1, bytes: stolenNovGz.length }
      }
    }), 'utf8');
    assert.equal((await syncB.syncAsync({ force: true, now: now + 4796 })).state, 'partial');
    assert.equal(syncB.sync({ force: true, now: now + 4796 }).state, 'partial');
    const rowsAfterStolenCheck = storeB.listAllRequests();
    assert.equal(rowsAfterStolenCheck.length, baselineRowsB);
    assert.equal(rowsAfterStolenCheck.some(r => r.id === `remote:${syncA.getLocalMachineId()}:keep-oct`), true);
    assert.notEqual(rowsAfterStolenCheck.find(r => r.id === `remote:${syncA.getLocalMachineId()}:nov-bump-1`)?.inputTokens, 77777);

    // Late/missing November shard while October tries to steal November's cached ID must ALSO preserve both months
    const novShardPathForLate = join(sharedDir, 'machines', syncA.getLocalMachineId(), '2026-11.ndjson.gz');
    const savedNovGz = readFileSync(novShardPathForLate);
    rmSync(novShardPathForLate);
    writeFileSync(manifestPathA, JSON.stringify({
      ...validManifestBeforeCross,
      shards: {
        '2026-10': { file: '2026-10.ndjson.gz', sha256: stolenNovHash, count: 1, bytes: stolenNovGz.length },
        '2026-11': { file: '2026-11.ndjson.gz', sha256: 'a'.repeat(64), count: 3, bytes: savedNovGz.length }
      }
    }), 'utf8');
    assert.equal((await syncB.syncAsync({ force: true, now: now + 4796 })).state, 'partial');
    assert.equal(syncB.sync({ force: true, now: now + 4796 }).state, 'partial');
    const rowsAfterLateCheck = storeB.listAllRequests();
    assert.equal(rowsAfterLateCheck.length, baselineRowsB);
    assert.equal(rowsAfterLateCheck.some(r => r.id === `remote:${syncA.getLocalMachineId()}:keep-oct`), true);
    assert.notEqual(rowsAfterLateCheck.find(r => r.id === `remote:${syncA.getLocalMachineId()}:nov-bump-1`)?.inputTokens, 77777);
    writeFileSync(novShardPathForLate, savedNovGz);

    // Malformed nonblank line (missing id) with declared count: 0 must reject the shard and preserve cached history
    const badLineNdjson = `${JSON.stringify({ providerDriver: 'antigravity', timestampMs: octTs })}\n`;
    const badLineHash = createHash('sha256').update(badLineNdjson).digest('hex');
    const badLineGz = zlib.gzipSync(Buffer.from(badLineNdjson, 'utf8'));
    writeFileSync(octShardPathA, badLineGz);
    writeFileSync(manifestPathA, JSON.stringify({
      ...validManifestBeforeCross,
      totalRequests: 0,
      shards: { '2026-10': { file: '2026-10.ndjson.gz', sha256: badLineHash, count: 0, bytes: badLineGz.length } }
    }), 'utf8');
    assert.equal((await syncB.syncAsync({ force: true, now: now + 4796 })).state, 'partial');
    assert.equal(syncB.sync({ force: true, now: now + 4796 }).state, 'partial');
    assert.equal(storeB.listAllRequests().length, baselineRowsB);

    // Valid cross-month move (Nov -> Oct) with includeThreadTitle: false must replace timestampMs and clear old title
    storeA.replaceSourceRequests('agy:nov-bump', 'v2', [
      makeRow({ id: 'nov-bump-1', t3ThreadTitle: 'Secret Title', timestampMs: octTs + 500, billingTsMs: octTs + 500 })
    ]);
    settingsA.update({ multiMachineSync: { enabled: true, syncDir: sharedDir, machineLabel: 'HardA', includeThreadTitle: false } });
    assert.equal((await syncA.syncAsync({ force: true, now: now + 4796 })).state, 'ok');
    assert.equal((await syncB.syncAsync({ force: true, now: now + 4796 })).state, 'ok');
    const movedRowB = storeB.listAllRequests().find(r => r.id === `remote:${syncA.getLocalMachineId()}:nov-bump-1`);
    assert.equal(movedRowB?.timestampMs, octTs + 500);
    assert.equal(movedRowB?.t3ThreadTitle, '');
    // Restore nov-bump-1 back to Nov and re-enable title sharing for subsequent assertions
    storeA.replaceSourceRequests('agy:nov-bump', 'v3', [
      makeRow({ id: 'nov-bump-1', timestampMs: now + 5000, billingTsMs: now + 5000 })
    ]);
    settingsA.update({ multiMachineSync: { enabled: true, syncDir: sharedDir, machineLabel: 'HardA', includeThreadTitle: true } });
    assert.equal((await syncA.syncAsync({ force: true, now: now + 4796 })).state, 'ok');
    assert.equal((await syncB.syncAsync({ force: true, now: now + 4796 })).state, 'ok');

    // Legacy unversioned remote stamp (upgraded from pre-v2 DB) must trigger re-import and clear stale fields
    const curStampOct = storeB.getSourceStamp(`remote:${syncA.getLocalMachineId()}:2026-10`);
    assert.ok(curStampOct.startsWith('v2:'));
    const rawUpgradeB = new DatabaseSync(join(root, 'b', 'telemetry.sqlite'));
    try {
      rawUpgradeB.prepare('UPDATE source_files SET stamp = ? WHERE source_key = ?')
        .run(curStampOct.slice(3), `remote:${syncA.getLocalMachineId()}:2026-10`);
      rawUpgradeB.prepare('UPDATE requests SET t3_thread_title = ? WHERE id = ?')
        .run('STALE_PRE_UPGRADE_TITLE', `remote:${syncA.getLocalMachineId()}:keep-oct`);
    } finally {
      rawUpgradeB.close();
    }
    assert.equal((await syncB.syncAsync({ force: true, now: now + 4796 })).state, 'ok');
    assert.equal(storeB.listAllRequests().find(r => r.id === `remote:${syncA.getLocalMachineId()}:keep-oct`)?.t3ThreadTitle, 'Secret Project Title');
    assert.equal(storeB.getSourceStamp(`remote:${syncA.getLocalMachineId()}:2026-10`), curStampOct);

    // Interrupted legacy import (rows exist for present peer dir, NO sync_peers row) must NOT prune rows when manifest is late
    const savedManifestRaw = readFileSync(manifestPathA);
    storeB.deleteSyncPeer(syncA.getLocalMachineId());
    rmSync(manifestPathA);
    assert.equal(syncB.sync({ force: true, now: now + 4796 }).state, 'partial');
    assert.equal(storeB.listAllRequests().length, baselineRowsB);
    assert.equal((await syncB.syncAsync({ force: true, now: now + 4796 })).state, 'partial');
    assert.equal(storeB.listAllRequests().length, baselineRowsB);
    writeFileSync(manifestPathA, savedManifestRaw);
    assert.equal((await syncB.syncAsync({ force: true, now: now + 4796 })).state, 'ok');

    // Valid same-ID privacy redaction on October MUST take effect even while November is malformed
    const octOrigJson = JSON.parse(zlib.gunzipSync(readFileSync(octShardPathA)).toString('utf8').trim());
    const octRedactedNdjson = JSON.stringify({ ...octOrigJson, t3ThreadTitle: '' }) + '\n';
    const octRedactedHash = createHash('sha256').update(octRedactedNdjson).digest('hex');
    const octRedactedGz = zlib.gzipSync(Buffer.from(octRedactedNdjson, 'utf8'));
    const savedOctGzForRedact = readFileSync(octShardPathA);
    const savedNovGzForRedact = readFileSync(join(sharedDir, 'machines', syncA.getLocalMachineId(), '2026-11.ndjson.gz'));
    const badNovNdjson = `${JSON.stringify({ providerDriver: 'antigravity', timestampMs: now })}\n`;
    const badNovHash = createHash('sha256').update(badNovNdjson).digest('hex');
    const badNovGz = zlib.gzipSync(Buffer.from(badNovNdjson, 'utf8'));
    writeFileSync(octShardPathA, octRedactedGz);
    writeFileSync(join(sharedDir, 'machines', syncA.getLocalMachineId(), '2026-11.ndjson.gz'), badNovGz);
    writeFileSync(manifestPathA, JSON.stringify({
      ...JSON.parse(savedManifestRaw.toString('utf8')),
      totalRequests: 1,
      shards: {
        '2026-10': { file: '2026-10.ndjson.gz', sha256: octRedactedHash, count: 1, bytes: octRedactedGz.length },
        '2026-11': { file: '2026-11.ndjson.gz', sha256: badNovHash, count: 0, bytes: badNovGz.length }
      }
    }), 'utf8');
    assert.equal((await syncB.syncAsync({ force: true, now: now + 4796 })).state, 'partial');
    assert.equal(storeB.listAllRequests().find(r => r.id === `remote:${syncA.getLocalMachineId()}:keep-oct`)?.t3ThreadTitle, '');
    assert.equal(storeB.listAllRequests().length, baselineRowsB);
    // Restore clean files
    writeFileSync(octShardPathA, savedOctGzForRedact);
    writeFileSync(join(sharedDir, 'machines', syncA.getLocalMachineId(), '2026-11.ndjson.gz'), savedNovGzForRedact);
    writeFileSync(manifestPathA, savedManifestRaw);
    assert.equal((await syncB.syncAsync({ force: true, now: now + 4796 })).state, 'ok');

    // Cross-month conflict spanning three months (Aug [x], Sep [x, y], Oct [y]) must reject ALL three
    // while still allowing an unrelated Nov privacy redaction to commit cleanly
    const augTs = Date.UTC(2026, 7, 10, 12, 0, 0);
    const sepTs = Date.UTC(2026, 8, 10, 12, 0, 0);
    const octChainTs = Date.UTC(2026, 9, 10, 12, 0, 0);
    const chainXLine = JSON.stringify({
      id: 'chain-x', providerDriver: 'antigravity', accountId: 'Ultra',
      nativeSessionId: 's-cx', modelId: 'gemini-4-neon', modelRaw: 'gemini-4-neon',
      timestampMs: augTs, billingTsMs: augTs, status: 'success'
    }) + '\n';
    const chainYLine = JSON.stringify({
      id: 'chain-y', providerDriver: 'antigravity', accountId: 'Ultra',
      nativeSessionId: 's-cy', modelId: 'gemini-4-neon', modelRaw: 'gemini-4-neon',
      timestampMs: sepTs, billingTsMs: sepTs, status: 'success'
    }) + '\n';
    const chainAugNdjson = chainXLine;
    const chainSepNdjson = chainXLine + chainYLine;
    const chainOctNdjson = chainYLine;
    const chainAugGz = zlib.gzipSync(Buffer.from(chainAugNdjson, 'utf8'));
    const chainSepGz = zlib.gzipSync(Buffer.from(chainSepNdjson, 'utf8'));
    const chainOctGz = zlib.gzipSync(Buffer.from(chainOctNdjson, 'utf8'));
    const augShardPathA = join(sharedDir, 'machines', syncA.getLocalMachineId(), '2026-08.ndjson.gz');
    const sepShardPathA = join(sharedDir, 'machines', syncA.getLocalMachineId(), '2026-09.ndjson.gz');
    const julShardPathA = join(sharedDir, 'machines', syncA.getLocalMachineId(), '2026-07.ndjson.gz');
    const julCleanLine = JSON.stringify({
      id: 'keep-oct', providerDriver: 'antigravity', accountId: 'Ultra',
      nativeSessionId: 's-oct', modelId: 'gemini-4-neon', modelRaw: 'gemini-4-neon',
      t3ThreadTitle: '', timestampMs: octChainTs, billingTsMs: octChainTs, status: 'success'
    }) + '\n';
    const julCleanGz = zlib.gzipSync(Buffer.from(julCleanLine, 'utf8'));
    writeFileSync(augShardPathA, chainAugGz);
    writeFileSync(sepShardPathA, chainSepGz);
    writeFileSync(octShardPathA, chainOctGz);
    writeFileSync(julShardPathA, julCleanGz);
    writeFileSync(manifestPathA, JSON.stringify({
      ...JSON.parse(savedManifestRaw.toString('utf8')),
      totalRequests: 5,
      shards: {
        '2026-07': { file: '2026-07.ndjson.gz', sha256: createHash('sha256').update(julCleanLine).digest('hex'), count: 1, bytes: julCleanGz.length },
        '2026-08': { file: '2026-08.ndjson.gz', sha256: createHash('sha256').update(chainAugNdjson).digest('hex'), count: 1, bytes: chainAugGz.length },
        '2026-09': { file: '2026-09.ndjson.gz', sha256: createHash('sha256').update(chainSepNdjson).digest('hex'), count: 2, bytes: chainSepGz.length },
        '2026-10': { file: '2026-10.ndjson.gz', sha256: createHash('sha256').update(chainOctNdjson).digest('hex'), count: 1, bytes: chainOctGz.length }
      }
    }), 'utf8');
    assert.equal((await syncB.syncAsync({ force: true, now: now + 4796 })).state, 'partial');
    assert.equal(storeB.listAllRequests().some(r => r.id === `remote:${syncA.getLocalMachineId()}:chain-x`), false);
    assert.equal(storeB.listAllRequests().some(r => r.id === `remote:${syncA.getLocalMachineId()}:chain-y`), false);
    assert.equal(syncB.sync({ force: true, now: now + 4796 }).state, 'partial');
    assert.equal(storeB.listAllRequests().some(r => r.id === `remote:${syncA.getLocalMachineId()}:chain-x`), false);
    assert.equal(storeB.listAllRequests().some(r => r.id === `remote:${syncA.getLocalMachineId()}:chain-y`), false);
    // Independent Oct privacy redaction still commits alongside an Aug/Sep conflict
    rmSync(julShardPathA);
    writeFileSync(octShardPathA, octRedactedGz);
    writeFileSync(manifestPathA, JSON.stringify({
      ...JSON.parse(savedManifestRaw.toString('utf8')),
      totalRequests: 3,
      shards: {
        '2026-08': { file: '2026-08.ndjson.gz', sha256: createHash('sha256').update(chainAugNdjson).digest('hex'), count: 1, bytes: chainAugGz.length },
        '2026-09': { file: '2026-09.ndjson.gz', sha256: createHash('sha256').update(chainAugNdjson).digest('hex'), count: 1, bytes: chainAugGz.length },
        '2026-10': { file: '2026-10.ndjson.gz', sha256: octRedactedHash, count: 1, bytes: octRedactedGz.length }
      }
    }), 'utf8');
    writeFileSync(sepShardPathA, chainAugGz);
    assert.equal((await syncB.syncAsync({ force: true, now: now + 4796 })).state, 'partial');
    assert.equal(storeB.listAllRequests().find(r => r.id === `remote:${syncA.getLocalMachineId()}:keep-oct`)?.t3ThreadTitle, '');
    assert.equal(storeB.listAllRequests().some(r => r.id === `remote:${syncA.getLocalMachineId()}:chain-x`), false);
    rmSync(augShardPathA);
    rmSync(sepShardPathA);
    writeFileSync(octShardPathA, savedOctGzForRedact);
    writeFileSync(manifestPathA, savedManifestRaw);
    assert.equal((await syncB.syncAsync({ force: true, now: now + 4796 })).state, 'ok');

    // Per-peer import generation advances even on cache-hit imports, rejecting older stale writes and stale peer prunes
    const peerPrefixA = `remote:${syncA.getLocalMachineId()}:`;
    const stateBeforeCacheHit = storeB.getRemotePeerImportState(peerPrefixA);
    assert.equal((await syncB.syncAsync({ force: true, now: now + 4796 })).state, 'ok');
    const stateAfterCacheHit = storeB.getRemotePeerImportState(peerPrefixA);
    assert.ok(stateAfterCacheHit.gen > stateBeforeCacheHit.gen);
    assert.throws(() => storeB.replaceRemoteSourcesBatch([], {
      peerPrefix: peerPrefixA,
      expectedPeerStamps: stateBeforeCacheHit.stamps,
      expectedPeerGen: stateBeforeCacheHit.gen,
      pruneActiveKeys: new Set()
    }), err => err?.code === 'STALE_IMPORT_CONFLICT');
    assert.equal(storeB.pruneRemotePeerIfUnchanged(syncA.getLocalMachineId(), stateBeforeCacheHit), false);
    assert.equal(storeB.listSyncPeers().some(p => p.machineId === syncA.getLocalMachineId()), true);

    // Cross-month move where updated source month arrives BEFORE destination shard must NOT drop moved cached row
    const curManifestClean = JSON.parse(readFileSync(manifestPathA, 'utf8'));
    const novCleanGz = readFileSync(join(sharedDir, 'machines', syncA.getLocalMachineId(), '2026-11.ndjson.gz'));
    const octCleanGz = readFileSync(octShardPathA);
    const novWithoutOne = zlib.gunzipSync(novCleanGz).toString('utf8').split('\n').filter(Boolean).slice(0, 2).join('\n') + '\n';
    const novWithoutOneHash = createHash('sha256').update(novWithoutOne).digest('hex');
    const novWithoutOneGz = zlib.gzipSync(Buffer.from(novWithoutOne, 'utf8'));
    writeFileSync(join(sharedDir, 'machines', syncA.getLocalMachineId(), '2026-11.ndjson.gz'), novWithoutOneGz);
    rmSync(octShardPathA); // destination shard hasn't arrived yet
    writeFileSync(manifestPathA, JSON.stringify({
      ...curManifestClean,
      totalRequests: 4,
      shards: {
        '2026-10': { file: '2026-10.ndjson.gz', sha256: 'b'.repeat(64), count: 2, bytes: 100 },
        '2026-11': { file: '2026-11.ndjson.gz', sha256: novWithoutOneHash, count: 2, bytes: novWithoutOneGz.length }
      }
    }), 'utf8');
    assert.equal((await syncB.syncAsync({ force: true, now: now + 4796 })).state, 'partial');
    assert.equal(syncB.sync({ force: true, now: now + 4796 }).state, 'partial');
    assert.equal(storeB.listAllRequests().length, baselineRowsB);
    // Restore clean files for remaining assertions
    writeFileSync(octShardPathA, octCleanGz);
    writeFileSync(join(sharedDir, 'machines', syncA.getLocalMachineId(), '2026-11.ndjson.gz'), novCleanGz);
    writeFileSync(manifestPathA, JSON.stringify(curManifestClean), 'utf8');

    // Local export failure (e.g. journal error) must still import peers while reporting state='error'
    const origSetMetaB = storeB.setMeta;
    storeB.setMeta = () => { throw new Error('simulated local export error'); };
    storeB.replaceSourceRequests('agy:local-b-fail', 'v1', [makeRow({ id: 'local-b-1', timestampMs: now + 9000, billingTsMs: now + 9000 })]);
    // Add one new row on A and publish so B has a fresh peer update to import
    storeA.replaceSourceRequests('agy:peer-while-err', 'v1', [makeRow({ id: 'peer-extra-1', timestampMs: now + 9500, billingTsMs: now + 9500 })]);
    assert.equal((await syncA.syncAsync({ force: true, now: now + 4796 })).state, 'ok');
    const bWithExportErr = await syncB.syncAsync({ force: true, now: now + 4796 });
    assert.equal(bWithExportErr.state, 'error');
    assert.equal(storeB.listAllRequests().some(r => r.id === `remote:${syncA.getLocalMachineId()}:peer-extra-1`), true);
    storeB.setMeta = origSetMetaB;
    storeB.deleteSourcesByPrefix('agy:local-b-fail');
    storeA.deleteSourcesByPrefix('agy:peer-while-err');
    assert.equal((await syncA.syncAsync({ force: true, now: now + 4796 })).state, 'ok');
    assert.equal((await syncB.syncAsync({ force: true, now: now + 4796 })).state, 'ok');

    // Cross-month duplicate IDs (same ID in 2026-10 and 2026-11) must NOT report ok or prune cached history
    const oneLineNdjson = `${dupLine}\n`;
    const oneLineHash = createHash('sha256').update(oneLineNdjson).digest('hex');
    const oneLineGz = zlib.gzipSync(Buffer.from(oneLineNdjson, 'utf8'));
    const novShardPathA = join(sharedDir, 'machines', syncA.getLocalMachineId(), '2026-11.ndjson.gz');
    writeFileSync(octShardPathA, oneLineGz);
    writeFileSync(novShardPathA, oneLineGz);
    writeFileSync(manifestPathA, JSON.stringify({
      ...repairedManifestA,
      totalRequests: 2,
      shards: {
        '2026-10': { file: '2026-10.ndjson.gz', sha256: oneLineHash, count: 1, bytes: oneLineGz.length },
        '2026-11': { file: '2026-11.ndjson.gz', sha256: oneLineHash, count: 1, bytes: oneLineGz.length }
      }
    }), 'utf8');
    assert.equal((await syncB.syncAsync({ force: true, now: now + 4797 })).state, 'partial');
    assert.equal(syncB.sync({ force: true, now: now + 4798 }).state, 'partial');
    const rowsAfterBothChangedDup = storeB.listAllRequests();
    assert.equal(rowsAfterBothChangedDup.length, baselineRowsB);
    assert.equal(rowsAfterBothChangedDup.some(r => r.id === `remote:${syncA.getLocalMachineId()}:keep-oct`), true);
    assert.equal(rowsAfterBothChangedDup.some(r => r.id === `remote:${syncA.getLocalMachineId()}:nov-bump-1`), true);

    // Matching shard hash with a missing row in SQLite must re-read & self-heal to ok on next valid export
    assert.equal((await syncA.syncAsync({ force: true, now: now + 4799 })).state, 'ok');
    assert.equal((await syncB.syncAsync({ force: true, now: now + 4800 })).state, 'ok');
    assert.equal(storeB.listAllRequests().length, baselineRowsB);
    // Simulate a missing row in B's SQLite while source_files stamp still matches manifest hash
    const rawB = new DatabaseSync(join(root, 'b', 'telemetry.sqlite'));
    try {
      rawB.prepare('DELETE FROM requests WHERE id = ?').run(`remote:${syncA.getLocalMachineId()}:keep-oct`);
    } finally {
      rawB.close();
    }
    assert.equal(storeB.listAllRequests().length, baselineRowsB - 1);
    assert.equal((await syncB.syncAsync({ force: true, now: now + 4801 })).state, 'ok');
    assert.equal(storeB.listAllRequests().length, baselineRowsB);

    // Rejected first shard on a brand-new peer must NOT register the peer or inflate requestCount
    const badNewPeerDir = join(sharedDir, 'machines', 'm-bad-new');
    mkdirSync(badNewPeerDir, { recursive: true });
    writeFileSync(join(badNewPeerDir, '2026-10.ndjson.gz'), oneLineGz);
    writeFileSync(join(badNewPeerDir, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      machineId: 'm-bad-new',
      machineLabel: 'BadNewPeer',
      exportedAtMs: now,
      totalRequests: 2,
      shards: { '2026-10': { file: '2026-10.ndjson.gz', sha256: oneLineHash, count: 2, bytes: oneLineGz.length } }
    }), 'utf8');
    assert.equal((await syncB.syncAsync({ force: true, now: now + 4802 })).state, 'partial');
    assert.equal(storeB.listSyncPeers().some(p => p.machineId === 'm-bad-new'), false);
    assert.equal(syncB.sync({ force: true, now: now + 4805 }).state, 'partial');
    assert.equal(storeB.listSyncPeers().some(p => p.machineId === 'm-bad-new'), false);

    // Large remote shard (> 5000 rows) commits atomically via worker thread without invalidating localRevision/dirtyMonths
    const snapBeforeWorker = storeB.takeDirtyLocalMonthsSnapshot();
    const bigRows = [];
    for (let i = 0; i < 5200; i++) {
      bigRows.push(makeRow({ id: `remote:worker-peer:w-${i}`, nativeSessionId: `ws-${i % 20}`, timestampMs: now + i, billingTsMs: now + i, isRemote: true, machineId: 'worker-peer', machineLabel: 'WorkerPeer' }));
    }
    await storeB.replaceRemoteSourceRequestsAsync('remote:worker-peer:2026-11', 'stamp-big', bigRows, {
      machineId: 'worker-peer',
      machineLabel: 'WorkerPeer'
    });
    assert.equal(storeB.getSourceStamp('remote:worker-peer:2026-11'), 'stamp-big');
    assert.equal(storeB.listAllRequests().filter(r => r.machineId === 'worker-peer').length, 5200);
    const snapAfterWorker = storeB.takeDirtyLocalMonthsSnapshot();
    assert.equal(snapAfterWorker.rev, snapBeforeWorker.rev);
    assert.notEqual(snapAfterWorker.dirtyMonths, null);

    // Orphan remote source pruning removes rows even when no sync_peers row exists
    const pruned = storeB.pruneOrphanRemoteSources(new Set());
    assert.ok(pruned >= 1);
    assert.equal(storeB.listAllRequests().filter(r => r.machineId === 'worker-peer').length, 0);
  } finally {
    storeA.close();
    storeB.close();
    safeRmDir(root);
  }
});

test('SQLite export_locks enforces cross-handle exclusion, recovers failed release, and oversized timestamps do not suppress tickAlerts', async () => {
  const root = makeTempDir('t3-lock-alert-');
  const dbPath = join(root, 'telemetry.sqlite');
  const sharedDir = join(root, 'SharedLock');
  const store1 = createTelemetryStore(dbPath);
  const store2 = createTelemetryStore(dbPath);
  const rawDb = new DatabaseSync(dbPath);
  try {
    // 1. OS-kernel export lock prevents concurrent writers in same process AND separate process even after store2.close()
    assert.equal(store1.tryAcquireExportLock('scope-1', 'tok-1'), true);
    assert.equal(store2.tryAcquireExportLock('scope-1', 'tok-2'), false);
    store1.releaseExportLock('scope-1', 'tok-1');
    assert.equal(store2.tryAcquireExportLock('scope-1', 'tok-2'), true);
    store2.close();
    // Lock must STAY held across store2.close() in both same process and a separate Node process
    assert.equal(store1.tryAcquireExportLock('scope-1', 'tok-3'), false);
    const crossProcScript = `
      import { createTelemetryStore } from './src/core/telemetry-store.mjs';
      const s = createTelemetryStore(process.argv[1]);
      const ok = s.tryAcquireExportLock('scope-1', 'tok-child');
      if (ok) s.releaseExportLock('scope-1', 'tok-child');
      s.close();
      process.stdout.write(String(ok));
    `;
    const childCheck = spawnSync(process.execPath, ['--input-type=module', '-e', crossProcScript, dbPath], { encoding: 'utf8' });
    assert.equal(childCheck.status, 0);
    assert.equal(childCheck.stdout.trim(), 'false');
    // Once the in-flight operation settles, releaseExportLock() on the closed store releases the OS lock
    store2.releaseExportLock('scope-1', 'tok-2');
    assert.equal(store1.tryAcquireExportLock('scope-1', 'tok-3'), true);
    store1.releaseExportLock('scope-1', 'tok-3');

    // 2. Transient release failure is surfaced as error and reclaimed cleanly even by a REPLACEMENT folderSync instance
    const settings = createSettingsStore(join(root, 'settings.json'));
    settings.update({ multiMachineSync: { enabled: true, syncDir: sharedDir, machineLabel: 'LockHost', includeErrorText: false } });
    const now = Date.now();
    store1.replaceSourceRequests('agy:lock', 'v1', [
      makeRow({ id: 'lock-1', status: 'error', errorText: 'SECRET_ERR_TOKEN', timestampMs: now, billingTsMs: now })
    ]);
    const sync = createFolderSync({ paths: { home: root }, store: store1, settings, env: {}, hostnameFn: () => 'LockHost' });
    const origRelease = store1.releaseExportLock;
    let failOnce = true;
    store1.releaseExportLock = (k, t) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('simulated release failure');
      }
      return origRelease(k, t);
    };
    const errRes = await sync.syncAsync({ force: true, now });
    assert.equal(errRes.state, 'error');
    sync.stop();
    // A brand-new replacement folderSync instance in the same process must recover the settled failed lock
    const replacementSync = createFolderSync({ paths: { home: root }, store: store1, settings, env: {}, hostnameFn: () => 'LockHost' });
    const okRes = await replacementSync.syncAsync({ force: true, now: now + 1000 });
    assert.equal(okRes.state, 'ok');
    const syncActive = replacementSync;

    // 2b. Second writer publishing unredacted error text forces first writer to re-redact on forced sync (manifest hash check)
    const storeB = createTelemetryStore(dbPath);
    const settingsB = createSettingsStore(join(root, 'settings-b.json'));
    settingsB.update({ multiMachineSync: { enabled: true, syncDir: sharedDir, machineLabel: 'LockHost', includeErrorText: true } });
    const syncB = createFolderSync({ paths: { home: root }, store: storeB, settings: settingsB, env: {}, hostnameFn: () => 'LockHost' });
    assert.equal((await syncB.syncAsync({ force: true, now: now + 1200 })).state, 'ok');
    const dNow = new Date(now);
    const mKey = `${dNow.getUTCFullYear()}-${String(dNow.getUTCMonth() + 1).padStart(2, '0')}`;
    const shardFile = join(sharedDir, 'machines', syncActive.getLocalMachineId(), `${mKey}.ndjson.gz`);
    assert.match(zlib.gunzipSync(readFileSync(shardFile)).toString('utf8'), /SECRET_ERR_TOKEN/);
    // Writer A forces sync with includeErrorText: false -> must NOT shortcut and must redact shard again
    assert.equal((await syncActive.syncAsync({ force: true, now: now + 1400 })).state, 'ok');
    assert.doesNotMatch(zlib.gunzipSync(readFileSync(shardFile)).toString('utf8'), /SECRET_ERR_TOKEN/);
    storeB.close();

    // 2c. syncThreadLinks AND first-time syncAsync return immediately without blocking when SQLite write lock is held
    const freshDbPath = join(root, 'fresh-busy.sqlite');
    const freshStore = createTelemetryStore(freshDbPath);
    const freshRaw = new DatabaseSync(freshDbPath);
    const freshSync = createFolderSync({ paths: { home: root }, store: freshStore, settings, env: {}, hostnameFn: () => 'FreshBusy' });
    rawDb.exec('BEGIN IMMEDIATE');
    freshRaw.exec('BEGIN IMMEDIATE');
    const t0 = Date.now();
    const linkedWhileBusy = store1.syncThreadLinks(new Map([['sess-1', { threadId: 'th-busy', title: 'Busy' }]]));
    const firstSyncWhileBusy = await freshSync.syncAsync({ force: true, now: now + 1500 });
    const elapsedMs = Date.now() - t0;
    rawDb.exec('ROLLBACK');
    freshRaw.exec('ROLLBACK');
    freshRaw.close();
    freshStore.close();
    assert.equal(linkedWhileBusy, 0);
    assert.equal(firstSyncWhileBusy.state, 'error');
    assert.ok(elapsedMs < 500, `syncThreadLinks/first-time syncAsync should not stall on write lock (took ${elapsedMs}ms)`);

    // 2d. Isolated collision fixture: directory 'm-peer' with raw machineId 'm/peer' must be rejected as partial
    const isoShared = join(root, 'IsoCollision');
    const badIdDir = join(isoShared, 'machines', 'm-peer');
    mkdirSync(badIdDir, { recursive: true });
    writeFileSync(join(badIdDir, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      machineId: 'm/peer',
      machineLabel: 'BadIdPeer',
      exportedAtMs: now,
      totalRequests: 0,
      shards: {}
    }), 'utf8');
    const isoSettings = createSettingsStore(join(root, 'iso-settings.json'));
    isoSettings.update({ multiMachineSync: { enabled: true, syncDir: isoShared, machineLabel: 'IsoHost' } });
    const isoStore = createTelemetryStore(join(root, 'iso.sqlite'));
    try {
      const isoSync = createFolderSync({ paths: { home: root }, store: isoStore, settings: isoSettings, env: {}, hostnameFn: () => 'IsoHost' });
      const isoRes = await isoSync.syncAsync({ force: true, now });
      assert.equal(isoRes.state, 'partial');
      assert.equal(isoStore.listSyncPeers().some(p => p.machineId === 'm-peer'), false);
    } finally {
      isoStore.close();
    }

    // 3. Oversized timestamp_ms (> Number.MAX_SAFE_INTEGER) in DB must NOT suppress alerts for normal recent errors
    const errTs = now + 2000;
    store1.replaceSourceRequests('agy:err', 'v1', [
      makeRow({ id: 'normal-err', status: 'error', errorCode: 'region', timestampMs: errTs, billingTsMs: errTs })
    ]);
    rawDb.prepare(`
      INSERT INTO requests (
        id, source_key, machine_id, machine_label, is_remote,
        provider_driver, account_id, native_session_id, model_id, model_raw,
        timestamp_ms, billing_ts_ms, status, retries
      ) VALUES ('huge-err', 'agy:huge', 'local', '', 0, 'antigravity', 'Ultra', 'sess-huge', 'gemini-4-neon', 'gemini-4-neon', ?, ?, 'error', 0)
    `).run(1e18, 1e18);

    const engine = createAnalyticsEngine({
      store: store1,
      settings,
      t3State: { readThreadIndex: () => ({ nativeToThread: new Map(), threadsById: new Map() }), readFailedRuns: () => [] },
      antigravityAdapter: { syncAll: () => {} },
      codexAdapter: { syncAll: () => {} },
      deferFolderSync: true
    });
    engine.tickAlerts(errTs + 500);
    const alerts = engine.getAlerts();
    assert.ok(alerts.unreadCount >= 1, 'normal recent error must remain visible despite oversized timestamp_ms row');
    assert.ok(alerts.recentAlerts.length >= 1, 'normal recent error must trigger smart alert despite oversized timestamp_ms row');
  } finally {
    rawDb.close();
    store1.close();
    store2.close();
    safeRmDir(root);
  }
});
