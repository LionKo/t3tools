import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import { createTelemetryStore } from '../src/core/telemetry-store.mjs';
import { createSettingsStore } from '../src/core/settings.mjs';
import { createFolderSync, detectSuggestedSyncDirs } from '../src/sync/folder-sync.mjs';
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
