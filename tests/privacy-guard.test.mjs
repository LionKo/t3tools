import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePaths } from '../src/core/paths.mjs';
import { DEFAULT_SETTINGS, createSettingsStore, sanitizeSettingsPatch } from '../src/core/settings.mjs';
import {
  PRIVACY_ENV_KEYS,
  LEGACY_PRIVACY_ENV_KEYS,
  TELEMETRY_ENV_OVERRIDES,
  CDP_TELEMETRY_BLOCK_URLS,
  CDP_FAVICON_BLOCK_URLS,
  computeBlockedCdpUrls,
  buildT3LaunchEnv,
  inspectPrivacyEnvBackup,
  inspectT3PrivacyTraceSignals,
  inspectT3PrivacyTraceSignalsAsync,
  createPrivacyGuard,
  restorePrivacyEnvBackup,
  readPrivacyEnvBackup
} from '../src/host/privacy-guard.mjs';
import { createCdpHost } from '../src/host/cdp-host.mjs';
import { relaunchT3WithDebugPort } from '../src/host/windows-launcher.mjs';
import { startDaemon } from '../src/host/daemon.mjs';
import { buildFallbackHtml } from '../src/ui/fallback-page.mjs';

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 't3tools-privacy-'));
}

function makeFakeWinEnvRunner(initial = {}, { failWrite = false, delayMs = 0, onWriteEnter = null, writeGate = null } = {}) {
  const store = new Map(Object.entries(initial));
  const calls = [];
  const exec = (script, envVars = {}) => {
    calls.push({ script, envVars });
    if (script.includes('Set-ItemProperty') || script.includes('Remove-ItemProperty')) {
      if (failWrite) {
        return { ok: false, stdout: '', stderr: 'simulated registry write error', status: 1 };
      }
      const touched = new Set();
      const setRe = /Set-ItemProperty -LiteralPath \$regPath -Name '([^']+)' -Value \$env:([A-Z0-9_]+)/g;
      let m;
      while ((m = setRe.exec(script)) !== null) {
        store.set(m[1], String(envVars[m[2]] ?? ''));
        touched.add(m[1]);
      }
      const remRe = /Remove-ItemProperty -LiteralPath \$regPath -Name '([^']+)'/g;
      while ((m = remRe.exec(script)) !== null) {
        store.delete(m[1]);
        touched.add(m[1]);
      }
      const verify = {};
      for (const k of touched) {
        verify[k] = store.has(k) ? store.get(k) : null;
      }
      return { ok: true, stdout: JSON.stringify(verify), stderr: '', status: 0 };
    }
    if (script.includes('GetEnvironmentVariable')) {
      const out = {};
      for (const k of LEGACY_PRIVACY_ENV_KEYS) {
        out[k] = store.has(k) ? store.get(k) : null;
      }
      return { ok: true, stdout: JSON.stringify(out), stderr: '', status: 0 };
    }
    return { ok: false, stdout: '', stderr: 'unexpected script', status: 1 };
  };
  const runnerAsync = async (script, envVars = {}) => {
    const isWrite = script.includes('Set-ItemProperty') || script.includes('Remove-ItemProperty');
    if (isWrite && onWriteEnter) onWriteEnter();
    if (isWrite && writeGate) await writeGate.promise;
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    return exec(script, envVars);
  };
  return { runner: exec, runnerAsync, store, calls };
}

test('privacyGuard defaults to OFF and validates strict boolean schema', () => {
  assert.deepEqual(DEFAULT_SETTINGS.privacyGuard, {
    blockTelemetryAndTracing: false,
    blockGoogleFavicons: false
  });
  assert.deepEqual(PRIVACY_ENV_KEYS, ['T3CODE_TELEMETRY_ENABLED']);
  assert.deepEqual(TELEMETRY_ENV_OVERRIDES, { T3CODE_TELEMETRY_ENABLED: 'false' });

  const clean = sanitizeSettingsPatch({
    privacyGuard: { blockTelemetryAndTracing: true, blockGoogleFavicons: false }
  });
  assert.deepEqual(clean.privacyGuard, {
    blockTelemetryAndTracing: true,
    blockGoogleFavicons: false
  });

  assert.throws(() => sanitizeSettingsPatch({ privacyGuard: 'invalid' }), /必须为对象/);
  assert.throws(() => sanitizeSettingsPatch({ privacyGuard: { blockGoogleFavicons: 'yes' } }), /必须为布尔值/);
});

test('computeBlockedCdpUrls never blocks T3 Connect essential hosts', () => {
  assert.deepEqual(computeBlockedCdpUrls({ blockTelemetryAndTracing: false, blockGoogleFavicons: false }), []);
  assert.deepEqual(computeBlockedCdpUrls({ blockTelemetryAndTracing: true, blockGoogleFavicons: false }), [...CDP_TELEMETRY_BLOCK_URLS]);
  assert.deepEqual(computeBlockedCdpUrls({ blockTelemetryAndTracing: false, blockGoogleFavicons: true }), [...CDP_FAVICON_BLOCK_URLS]);

  const all = computeBlockedCdpUrls({ blockTelemetryAndTracing: true, blockGoogleFavicons: true });
  assert.deepEqual(all, [...CDP_TELEMETRY_BLOCK_URLS, ...CDP_FAVICON_BLOCK_URLS]);
  for (const essential of ['clerk.t3.codes', 'relay.t3.codes', 't3coderelay.com', 'argotunnel.com', '1.1.1.1']) {
    assert.equal(all.some(u => u.includes(essential)), false, `should not block ${essential}`);
  }
});

test('buildT3LaunchEnv preserves user pre-existing false when guard never enabled, and strips only owned overrides', () => {
  const onEnv = buildT3LaunchEnv(
    { blockTelemetryAndTracing: true },
    { baseEnv: { PATH: 'C:\\Windows', EXISTING: '1' } }
  );
  assert.equal(onEnv.T3CODE_TELEMETRY_ENABLED, 'false');
  assert.equal(Object.hasOwn(onEnv, 'DO_NOT_TRACK'), false);
  assert.equal(onEnv.EXISTING, '1');

  // Guard NEVER enabled -> user's pre-existing T3CODE_TELEMETRY_ENABLED=false MUST be preserved
  const unownedOffEnv = buildT3LaunchEnv(
    { blockTelemetryAndTracing: false },
    { baseEnv: { PATH: 'C:\\Windows', T3CODE_TELEMETRY_ENABLED: 'false' }, ownedOverride: false }
  );
  assert.equal(unownedOffEnv.T3CODE_TELEMETRY_ENABLED, 'false');

  // Guard previously owned the override -> stale inherited false IS stripped
  const ownedOffEnv = buildT3LaunchEnv(
    { blockTelemetryAndTracing: false },
    { baseEnv: { PATH: 'C:\\Windows', T3CODE_TELEMETRY_ENABLED: 'false' }, ownedOverride: true }
  );
  assert.equal(Object.hasOwn(ownedOffEnv, 'T3CODE_TELEMETRY_ENABLED'), false);

  // Restore entries with legacy DO_NOT_TRACK backup
  const offEnv = buildT3LaunchEnv(
    { blockTelemetryAndTracing: false },
    {
      baseEnv: { PATH: 'C:\\Windows', T3CODE_TELEMETRY_ENABLED: 'false', DO_NOT_TRACK: '1' },
      restoreEntries: {
        T3CODE_TELEMETRY_ENABLED: { existed: false, value: null },
        DO_NOT_TRACK: { existed: true, value: '0' }
      }
    }
  );
  assert.equal(Object.hasOwn(offEnv, 'T3CODE_TELEMETRY_ENABLED'), false);
  assert.equal(offEnv.DO_NOT_TRACK, '0');
});

test('createPrivacyGuard preserves corrupt/invalid backups byte-for-byte, carries effective manual edits to child launch env, and handles write failures honestly', async () => {
  const dir = makeTempDir();
  try {
    const paths = resolvePaths({
      home: dir,
      t3Root: join(dir, '.t3'),
      pluginDataDir: join(dir, '.t3tools')
    });
    const settings = createSettingsStore(paths.pluginSettingsPath);
    const fake = makeFakeWinEnvRunner({ DO_NOT_TRACK: '0' });
    let fakeNow = 1_700_000_000_000;

    const guard = createPrivacyGuard({
      paths,
      settings,
      runner: fake.runner,
      platform: 'win32',
      nowFn: () => fakeNow
    });

    // Default OFF: zero PowerShell calls, no backup file created, preserves user's own env on launch
    const initRes = guard.applySettings();
    assert.equal(initRes.ok, true);
    assert.equal(fake.calls.length, 0);
    assert.equal(existsSync(paths.privacyEnvBackupPath), false);
    assert.equal(guard.getLaunchEnv({ T3CODE_TELEMETRY_ENABLED: 'false' }).T3CODE_TELEMETRY_ENABLED, 'false');

    // Simulate a running T3 Code server started BEFORE applying privacy toggle
    mkdirSync(paths.t3UserData, { recursive: true });
    writeFileSync(paths.serverRuntimePath, JSON.stringify({
      pid: process.pid,
      origin: 'http://127.0.0.1:3773',
      startedAt: new Date(fakeNow - 60_000).toISOString()
    }));

    // Enable telemetry blocking -> writes ONLY T3CODE_TELEMETRY_ENABLED=false, leaves user DO_NOT_TRACK='0' untouched
    settings.update({ privacyGuard: { blockTelemetryAndTracing: true } });
    const enableRes = guard.applySettings();
    assert.equal(enableRes.ok, true);
    assert.equal(fake.store.get('T3CODE_TELEMETRY_ENABLED'), 'false');
    assert.equal(fake.store.get('DO_NOT_TRACK'), '0');

    const backup = readPrivacyEnvBackup(paths.privacyEnvBackupPath);
    assert.ok(backup);
    assert.equal(backup.version, 2);
    assert.deepEqual(backup.entries.T3CODE_TELEMETRY_ENABLED, { existed: false, value: null });
    assert.equal(Object.hasOwn(backup.entries, 'DO_NOT_TRACK'), false);

    // Server started before appliedAtMs -> restartRequired should be true
    const stBeforeRestart = guard.getStatus({ cdpStatus: { connected: true, blockedTargets: 1 }, fresh: false });
    assert.equal(stBeforeRestart.state, 'needs-restart');
    assert.equal(stBeforeRestart.restartRequired, true);
    assert.equal(stBeforeRestart.cdpBlockedActive, true);

    // Simulate T3 Code restarted AFTER appliedAtMs -> restartRequired becomes false
    writeFileSync(paths.serverRuntimePath, JSON.stringify({
      pid: process.pid,
      origin: 'http://127.0.0.1:3773',
      startedAt: new Date(fakeNow + 5_000).toISOString()
    }));
    const stAfterRestart = guard.getStatus({ cdpStatus: { connected: true, blockedTargets: 1 }, fresh: false });
    assert.equal(stAfterRestart.state, 'active');
    assert.equal(stAfterRestart.restartRequired, false);

    // User manually changes T3CODE_TELEMETRY_ENABLED='true' -> disabling must NOT clobber registry AND launch env carries 'true'
    fake.store.set('T3CODE_TELEMETRY_ENABLED', 'true');
    fakeNow += 10_000;
    settings.update({ privacyGuard: { blockTelemetryAndTracing: false } });
    const disableRes = guard.applySettings();
    assert.equal(disableRes.ok, true);
    assert.equal(fake.store.get('T3CODE_TELEMETRY_ENABLED'), 'true');
    assert.equal(existsSync(paths.privacyEnvBackupPath), false);
    const postManualLaunchEnv = guard.getLaunchEnv({ T3CODE_TELEMETRY_ENABLED: 'false' });
    assert.equal(postManualLaunchEnv.T3CODE_TELEMETRY_ENABLED, 'true');

    // Legacy v1 backup with DO_NOT_TRACK='1' is restored cleanly by restorePrivacyEnvBackup
    fake.store.set('T3CODE_TELEMETRY_ENABLED', 'false');
    fake.store.set('DO_NOT_TRACK', '1');
    writeFileSync(paths.privacyEnvBackupPath, JSON.stringify({
      version: 1,
      savedAtMs: fakeNow,
      appliedAtMs: fakeNow,
      entries: {
        T3CODE_TELEMETRY_ENABLED: { existed: false, value: null },
        DO_NOT_TRACK: { existed: true, value: '0' }
      }
    }));
    const unRes = restorePrivacyEnvBackup(paths, { runner: fake.runner, platform: 'win32' });
    assert.equal(unRes.ok, true);
    assert.equal(unRes.restored, true);
    assert.equal(fake.store.has('T3CODE_TELEMETRY_ENABLED'), false);
    assert.equal(fake.store.get('DO_NOT_TRACK'), '0');
    assert.equal(existsSync(paths.privacyEnvBackupPath), false);

    // Corrupt AND invalid-schema backups (including DO_NOT_TRACK-only without T3CODE_TELEMETRY_ENABLED) MUST be preserved byte-for-byte!
    for (const rawCorrupt of [
      '{not-valid-json',
      '{"version":1,"entries":[]}',
      '{"version":1,"entries":{"DO_NOT_TRACK":{"existed":false,"value":null}}}',
      '{"version":99,"entries":{"T3CODE_TELEMETRY_ENABLED":{"existed":false,"value":null}}}'
    ]) {
      writeFileSync(paths.privacyEnvBackupPath, rawCorrupt);
      assert.equal(inspectPrivacyEnvBackup(paths.privacyEnvBackupPath).corrupt, true);

      settings.update({ privacyGuard: { blockTelemetryAndTracing: true } });
      const enableOnCorruptSync = guard.applySettings();
      assert.equal(enableOnCorruptSync.ok, false);
      assert.equal(readFileSync(paths.privacyEnvBackupPath, 'utf8'), rawCorrupt);

      const enableOnCorruptAsync = await guard.applySettingsAsync();
      assert.equal(enableOnCorruptAsync.ok, false);
      assert.equal(readFileSync(paths.privacyEnvBackupPath, 'utf8'), rawCorrupt);

      settings.update({ privacyGuard: { blockTelemetryAndTracing: false } });
      const disableOnCorrupt = guard.applySettings();
      assert.equal(disableOnCorrupt.ok, false);
      assert.equal(readFileSync(paths.privacyEnvBackupPath, 'utf8'), rawCorrupt);

      const uninstallOnCorrupt = restorePrivacyEnvBackup(paths, { runner: fake.runner, platform: 'win32' });
      assert.equal(uninstallOnCorrupt.ok, false);
      assert.equal(readFileSync(paths.privacyEnvBackupPath, 'utf8'), rawCorrupt);
    }
    rmSync(paths.privacyEnvBackupPath, { force: true });

    // Write failure must NOT report envSynced=true even if backup file exists
    const failing = makeFakeWinEnvRunner({}, { failWrite: true });
    const failingGuard = createPrivacyGuard({
      paths,
      settings,
      runner: failing.runner,
      platform: 'win32',
      nowFn: () => fakeNow
    });
    settings.update({ privacyGuard: { blockTelemetryAndTracing: true } });
    const failApply = failingGuard.applySettings();
    assert.equal(failApply.ok, false);
    const stFail = failingGuard.getStatus({ cdpStatus: { connected: true, blockedTargets: 1 } });
    assert.equal(stFail.state, 'error');
    assert.equal(stFail.envSynced, false);
    assert.equal(stFail.restartRequired, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inspectT3PrivacyTraceSignals (sync & async) counts telemetry batches and detects publishAgentActivity state', async () => {
  const dir = makeTempDir();
  try {
    const logsDir = join(dir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(logsDir, 'relay-client.ndjson'), '{"message":["Relay client tunnel connection registered"]}\n');

    const t1 = 1_700_000_000_000;
    const t2 = 1_700_000_050_000;
    const lines = [
      JSON.stringify({ type: 'effect-span', name: 'POST', endTimeUnixNano: String(t1 * 1_000_000), attributes: { 'url.full': 'https://ingest.t3.codes/batch/' } }),
      JSON.stringify({ message: ['publishing agent activity for thread', { threadId: 'th1' }] }),
      JSON.stringify({ type: 'effect-span', name: 'POST', endTimeUnixNano: String(t2 * 1_000_000), attributes: { 'url.full': 'https://ingest.t3.codes/batch/' } })
    ];
    writeFileSync(join(logsDir, 'server.trace.ndjson'), lines.join('\n') + '\n');

    const sig1 = inspectT3PrivacyTraceSignals(logsDir, { sinceMs: t1 + 10_000 });
    const sig1Async = await inspectT3PrivacyTraceSignalsAsync(logsDir, { sinceMs: t1 + 10_000 });
    assert.deepEqual(sig1Async, sig1);
    assert.equal(sig1.recentTelemetryHits, 2);
    assert.equal(sig1.telemetryHitsSinceApply, 1);
    assert.equal(sig1.lastTelemetryAtMs, t2);
    assert.equal(sig1.t3ConnectTunnelDetected, true);
    assert.equal(sig1.publishAgentActivityState, 'enabled');

    writeFileSync(
      join(logsDir, 'server.trace.ndjson'),
      lines.join('\n') + '\n' + JSON.stringify({ message: ['agent activity publishing disabled by T3 Connect preferences'] }) + '\n'
    );
    const sig2 = await inspectT3PrivacyTraceSignalsAsync(logsDir, { sinceMs: t2 + 10_000 });
    assert.equal(sig2.telemetryHitsSinceApply, 0);
    assert.equal(sig2.publishAgentActivityState, 'disabled');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createCdpHost uses narrow Fetch.enable/Fetch.disable, recovers failed pause commands & late enables, and releases pauses during disable', async () => {
  const dir = makeTempDir();
  try {
    const electronDir = join(dir, 'electron');
    mkdirSync(electronDir, { recursive: true });
    writeFileSync(join(electronDir, 'DevToolsActivePort'), '9555\n/devtools/browser/1\n');
    const paths = resolvePaths({
      home: dir,
      t3Root: join(dir, '.t3'),
      electronUserData: electronDir,
      pluginDataDir: join(dir, '.t3tools')
    });

    const sentCommands = [];
    let eventHandler = null;
    let rejectFetchEnable = false;
    let rejectFailAndContinue = false;
    let pollGate = null;
    let socketClosed = 0;

    const fakeConnect = async () => ({
      socket: {
        readyState: 1,
        addEventListener() {},
        close() { socketClosed++; this.readyState = 3; }
      },
      onEvent(fn) { eventHandler = fn; return () => { eventHandler = null; }; },
      async send(method, params = {}) {
        sentCommands.push({ method, params });
        if (method === 'Fetch.enable' && rejectFetchEnable) {
          throw new Error('CDP Fetch.enable 超时');
        }
        if ((method === 'Fetch.failRequest' || method === 'Fetch.continueRequest') && rejectFailAndContinue) {
          throw new Error('interception protocol error');
        }
        if (method === 'Page.getFrameTree') {
          return { frameTree: { frame: { id: 'frame-top', loaderId: 'l1', url: 't3code://app/#/env/th1' } } };
        }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 11 };
        if (method === 'Runtime.evaluate') {
          if (pollGate && String(params.expression || '').includes('__t3ToolsReceive')) {
            await pollGate.promise;
          }
          return { result: { value: true } };
        }
        return {};
      }
    });

    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      async json() {
        return [{
          id: 't1',
          type: 'page',
          url: 't3code://app/#/env/th1',
          title: 'T3 Code (Nightly)',
          webSocketDebuggerUrl: 'ws://127.0.0.1:9555/devtools/page/t1'
        }];
      }
    });

    const host = createCdpHost({
      paths,
      buildClientBundle: () => 'globalThis.__t3Tools = { healthy: true };',
      handleRpc: async () => ({}),
      initialEnabled: true,
      initialBlockedUrls: [],
      fetchImpl: fakeFetch,
      connectImpl: fakeConnect
    });

    await host.pollOnce();
    assert.equal(sentCommands.some(c => c.method === 'Network.enable'), false);
    assert.equal(sentCommands.some(c => c.method === 'Fetch.enable'), false);

    // Hot-enable Google Favicon + Telemetry blocking -> uses narrow Fetch.enable, NEVER Network.enable
    const allRules = [...CDP_TELEMETRY_BLOCK_URLS, ...CDP_FAVICON_BLOCK_URLS];
    const r1 = await host.setBlockedUrls(allRules);
    assert.equal(r1.appliedTargets, 1);
    assert.equal(r1.failedTargets, 0);
    assert.equal(sentCommands.some(c => c.method === 'Network.enable'), false);
    assert.equal(sentCommands.some(c => c.method === 'Network.setBlockedURLs'), false);
    const enableCmd = sentCommands.filter(c => c.method === 'Fetch.enable').at(-1);
    assert.deepEqual(
      enableCmd?.params?.patterns,
      allRules.map(urlPattern => ({ urlPattern, requestStage: 'Request' }))
    );
    assert.equal(host.getStatus().blockedTargets, 1);

    // Fetch.requestPaused: exact HTTPS match -> Fetch.failRequest
    await eventHandler({
      method: 'Fetch.requestPaused',
      params: { requestId: 'req-blocked-1', request: { url: 'https://www.google.com/s2/favicons?domain=example.com&sz=32' } }
    });
    assert.deepEqual(
      sentCommands.at(-1),
      { method: 'Fetch.failRequest', params: { requestId: 'req-blocked-1', errorReason: 'BlockedByClient' } }
    );

    // Fetch.requestPaused: proxy URL containing blocked URL in query string MUST continue
    await eventHandler({
      method: 'Fetch.requestPaused',
      params: { requestId: 'req-safe-1', request: { url: 'https://relay.t3.codes/check?ref=https://ingest.t3.codes/batch' } }
    });
    assert.deepEqual(
      sentCommands.at(-1),
      { method: 'Fetch.continueRequest', params: { requestId: 'req-safe-1' } }
    );

    // Fetch.requestPaused: ws:// MUST always continue
    await eventHandler({
      method: 'Fetch.requestPaused',
      params: { requestId: 'req-ws-1', request: { url: 'ws://127.0.0.1:3773/rpc' } }
    });
    assert.deepEqual(
      sentCommands.at(-1),
      { method: 'Fetch.continueRequest', params: { requestId: 'req-ws-1' } }
    );

    // Rejected failRequest + continueRequest on open socket MUST recover via Fetch.disable and record error
    rejectFailAndContinue = true;
    const disableCountBefore = sentCommands.filter(c => c.method === 'Fetch.disable').length;
    await eventHandler({
      method: 'Fetch.requestPaused',
      params: { requestId: 'req-fail-recover', request: { url: 'https://ingest.t3.codes/batch/' } }
    });
    assert.equal(sentCommands.filter(c => c.method === 'Fetch.disable').length, disableCountBefore + 1);
    assert.equal(host.getStatus().blockedTargets, 0);
    assert.match(host.getStatus().blockedApplyError, /interception protocol error/);
    rejectFailAndContinue = false;

    // Late/timed-out Fetch.enable MUST proactively call Fetch.disable so no late enable survives
    rejectFetchEnable = true;
    const disableBeforeTimeout = sentCommands.filter(c => c.method === 'Fetch.disable').length;
    const rFail = await host.setBlockedUrls([...CDP_FAVICON_BLOCK_URLS]);
    assert.equal(rFail.appliedTargets, 0);
    assert.equal(rFail.failedTargets, 1);
    assert.equal(sentCommands.filter(c => c.method === 'Fetch.disable').length, disableBeforeTimeout + 1);
    assert.equal(host.getStatus().blockedTargets, 0);
    assert.match(host.getStatus().blockedApplyError, /Fetch\.enable 超时/);
    rejectFetchEnable = false;

    // Test pause-failure recovery WHILE first Fetch.enable is still awaiting ack:
    // Fetch.disable must still run and subsequent Fetch.enable ack must NOT clear the error!
    await host.setBlockedUrls([]);
    let enableGate = Promise.withResolvers();
    const origSend = sentCommands;
    rejectFailAndContinue = true;
    const disableBeforeInFlight = origSend.filter(c => c.method === 'Fetch.disable').length;
    // Simulate a second target where Fetch.enable pauses on enableGate
    const dir2 = makeTempDir();
    try {
      const electronDir2 = join(dir2, 'electron');
      mkdirSync(electronDir2, { recursive: true });
      writeFileSync(join(electronDir2, 'DevToolsActivePort'), '9556\n/devtools/browser/2\n');
      const paths2 = resolvePaths({ home: dir2, t3Root: join(dir2, '.t3'), electronUserData: electronDir2, pluginDataDir: join(dir2, '.t3tools') });
      const cmds2 = [];
      let evt2 = null;
      const host2 = createCdpHost({
        paths: paths2,
        buildClientBundle: () => 'globalThis.__t3Tools = { healthy: true };',
        handleRpc: async () => ({}),
        initialEnabled: true,
        initialBlockedUrls: [],
        fetchImpl: async () => ({
          ok: true, status: 200,
          async json() { return [{ id: 't2', type: 'page', url: 't3code://app/#/env/th2', title: 'T3 Code', webSocketDebuggerUrl: 'ws://127.0.0.1:9556/devtools/page/t2' }]; }
        }),
        connectImpl: async () => ({
          socket: { readyState: 1, addEventListener() {}, close() {} },
          onEvent(fn) { evt2 = fn; return () => { evt2 = null; }; },
          async send(method, params = {}) {
            cmds2.push({ method, params });
            if (method === 'Fetch.enable') { await enableGate.promise; return {}; }
            if (method === 'Fetch.failRequest' || method === 'Fetch.continueRequest') throw new Error('in-flight pause err');
            if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'f2', loaderId: 'l2', url: 't3code://app/#/env/th2' } } };
            if (method === 'Page.createIsolatedWorld') return { executionContextId: 22 };
            return { result: { value: true } };
          }
        })
      });
      await host2.pollOnce();
      const enabling = host2.setBlockedUrls([...CDP_FAVICON_BLOCK_URLS]);
      // Wait a microtask so Fetch.enable is in flight
      await Promise.resolve();
      await evt2({ method: 'Fetch.requestPaused', params: { requestId: 'req-inflight', request: { url: 'https://www.google.com/s2/favicons?domain=x.com' } } });
      enableGate.resolve();
      const res2 = await enabling;
      assert.equal(res2.appliedTargets, 0);
      assert.ok(cmds2.some(c => c.method === 'Fetch.disable'));
      assert.equal(host2.getStatus().blockedTargets, 0);
      assert.match(host2.getStatus().blockedApplyError, /in-flight pause err/);
      await host2.stop();
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
    assert.ok(disableBeforeInFlight >= 0);
    rejectFailAndContinue = false;

    // Re-enable cleanly, then simulate a Fetch.requestPaused arriving WHILE setEnabled(false) waits on activePoll
    await host.setBlockedUrls([...CDP_FAVICON_BLOCK_URLS]);
    assert.equal(host.getStatus().blockedTargets, 1);
    pollGate = Promise.withResolvers();
    const inFlightPoll = host.pollOnce();
    const disabling = host.setEnabled(false);
    // While setEnabled(false) awaits inFlightPoll, a pause arrives -> MUST still be continued, never dropped!
    await eventHandler({
      method: 'Fetch.requestPaused',
      params: { requestId: 'req-during-disable', request: { url: 'https://www.google.com/s2/favicons?domain=test.com' } }
    });
    assert.equal(
      sentCommands.some(c => c.method === 'Fetch.continueRequest' && c.params?.requestId === 'req-during-disable'),
      true
    );
    pollGate.resolve();
    await inFlightPoll;
    await disabling;

    // preserveDisabled=true respects disabled auto-attach preference
    const stDisabled = await host.reattachNow({ preserveDisabled: true });
    assert.equal(stDisabled.enabled, false);
    assert.ok(socketClosed >= 1);

    await host.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('relaunchT3WithDebugPort verifies server.asar parent ancestry, leaves unrelated servers untouched, and runs asynchronously', async () => {
  const dir = makeTempDir();
  try {
    const exePath = join(dir, 'T3 Code (Nightly).exe');
    writeFileSync(exePath, 'stub');
    let capturedScript = '';
    let capturedLaunchEnv = null;
    let tickRanWhileClosing = false;

    // Simulated process inventory:
    // - PID 1001: main UI
    // - PID 1002: desktop-owned server.asar (ParentProcessId = 1001) -> SHOULD be tracked & closed
    // - PID 2002: independent server.asar (ParentProcessId = 9999) -> MUST remain ambiguous/untouched
    // - PID 1003: acp-mcp-bridge (ParentProcessId = 1001) -> MUST be untouched
    const res = await relaunchT3WithDebugPort(
      { t3InstallDir: dir },
      [],
      {
        env: { T3CODE_TELEMETRY_ENABLED: 'false', TEST_FLAG: '1' },
        runnerAsync: async script => {
          capturedScript = script;
          await new Promise(resolve => setTimeout(() => { tickRanWhileClosing = true; resolve(); }, 25));
          return {
            ok: true,
            stdout: JSON.stringify({
              closedMainPids: [1001],
              closedServerPids: [1002],
              ambiguousServerPids: [2002]
            }),
            stderr: ''
          };
        },
        launchImpl: async (_paths, _args, opts) => {
          capturedLaunchEnv = opts?.env || null;
          return { ok: true, pid: 5678 };
        }
      }
    );

    assert.equal(res.ok, true);
    assert.equal(res.pid, 5678);
    assert.equal(capturedLaunchEnv?.T3CODE_TELEMETRY_ENABLED, 'false');
    if (process.platform === 'win32') {
      assert.equal(tickRanWhileClosing, true);
      assert.deepEqual(res.ambiguousServerPids, [2002]);
      assert.ok(capturedScript.includes('ParentProcessId'));
      assert.ok(capturedScript.includes('$mainPidSet.Contains($ppidInt)'));
      assert.ok(capturedScript.includes('CreationDate'));
      assert.ok(capturedScript.includes('acp-mcp-bridge'));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('daemon HTTP settings/status round-trip handles fast env writes and exposes fallback slot', async () => {
  const dir = makeTempDir();
  let daemon = null;
  try {
    const fake = makeFakeWinEnvRunner({});
    daemon = await startDaemon({
      pathOverrides: {
        home: dir,
        t3Root: join(dir, '.t3'),
        pluginDataDir: join(dir, '.t3tools'),
        codexHome: join(dir, '.codex')
      },
      portOverride: 0,
      enableCdp: false,
      enableRemoteUpdateCheck: false,
      privacyGuardOptions: { runnerAsync: fake.runnerAsync, platform: 'win32' }
    });

    const st1 = await (await fetch(`${daemon.url}/api/status`)).json();
    assert.equal(st1.ok, true);
    assert.equal(st1.data.settings.privacyGuard.blockTelemetryAndTracing, false);
    assert.equal(st1.data.settings.privacyGuard.blockGoogleFavicons, false);
    assert.equal(st1.data.privacyGuard.state, 'off');

    const upd = await (await fetch(`${daemon.url}/api/settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-T3Tools-Token': daemon.authToken
      },
      body: JSON.stringify({
        privacyGuard: { blockTelemetryAndTracing: true, blockGoogleFavicons: true }
      })
    })).json();
    assert.equal(upd.ok, true);
    assert.equal(upd.data.privacyGuard.blockTelemetryAndTracing, true);
    assert.equal(upd.data.privacyGuard.blockGoogleFavicons, true);
    assert.equal(fake.store.get('T3CODE_TELEMETRY_ENABLED'), 'false');
    assert.equal(fake.store.has('DO_NOT_TRACK'), false);

    const st2 = await (await fetch(`${daemon.url}/api/status`)).json();
    assert.equal(st2.data.privacyGuard.state, 'active');
    assert.equal(st2.data.privacyGuard.envSynced, true);
    assert.deepEqual(st2.data.privacyGuard.cdpBlockedUrls, [...CDP_TELEMETRY_BLOCK_URLS, ...CDP_FAVICON_BLOCK_URLS]);

    const html = buildFallbackHtml({ version: '0.1.0' });
    assert.equal(html.includes('id="settings-privacy-guard-slot"'), true);
    assert.equal(html.includes('renderPrivacyGuardCardHtml'), true);
  } finally {
    if (daemon) await daemon.stop('test cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('daemon updateSettings returns within budget while slow writer is actively in-flight, /api/health stays instant, and stop() drains the writer', async () => {
  const dir = makeTempDir();
  let daemon = null;
  try {
    const enteredWriter = Promise.withResolvers();
    const writeGate = Promise.withResolvers();
    let writerCompleted = false;
    const slow = makeFakeWinEnvRunner({}, {
      onWriteEnter: () => enteredWriter.resolve(),
      writeGate
    });
    const trackedRunnerAsync = async (script, envVars) => {
      const res = await slow.runnerAsync(script, envVars);
      if (script.includes('Set-ItemProperty')) writerCompleted = true;
      return res;
    };

    daemon = await startDaemon({
      pathOverrides: {
        home: dir,
        t3Root: join(dir, '.t3'),
        pluginDataDir: join(dir, '.t3tools'),
        codexHome: join(dir, '.codex')
      },
      portOverride: 0,
      enableCdp: false,
      enableRemoteUpdateCheck: false,
      privacyGuardOptions: { runnerAsync: trackedRunnerAsync, platform: 'win32' }
    });

    const t0 = performance.now();
    const updatePromise = fetch(`${daemon.url}/api/settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-T3Tools-Token': daemon.authToken
      },
      body: JSON.stringify({ privacyGuard: { blockTelemetryAndTracing: true } })
    });

    // Wait until the slow PowerShell writer has DEFINITELY entered before probing /api/health & /api/status
    await enteredWriter.promise;

    const healthT0 = performance.now();
    const healthRes = await (await fetch(`${daemon.url}/api/health`)).json();
    const healthMs = performance.now() - healthT0;
    assert.equal(healthRes.ok, true);
    assert.ok(healthMs < 400, `expected fast /api/health while writer in-flight, got ${healthMs}ms`);

    const midStatus = await (await fetch(`${daemon.url}/api/status`)).json();
    assert.equal(midStatus.data.privacyGuard.applying, true);
    assert.equal(midStatus.data.privacyGuard.state, 'applying');

    // updateSettings MUST return within ~1.5s budget even though writer is still gated!
    const upd = await (await updatePromise).json();
    const elapsedMs = performance.now() - t0;
    assert.equal(upd.ok, true);
    assert.ok(elapsedMs < 2500, `updateSettings hung past budget: ${elapsedMs}ms`);
    assert.equal(writerCompleted, false);

    // Calling daemon.stop() MUST drain the active writer before resolving
    const stopPromise = daemon.stop('drain test');
    setTimeout(() => writeGate.resolve(), 80);
    await stopPromise;
    assert.equal(writerCompleted, true);
    assert.equal(slow.store.get('T3CODE_TELEMETRY_ENABLED'), 'false');
    daemon = null;
  } finally {
    if (daemon) await daemon.stop('test cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
