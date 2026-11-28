import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { renameSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSettingsStore } from '../src/core/settings.mjs';
import { createRemoteBridge } from '../src/host/remote-bridge.mjs';
import * as protocol from '../src/host/remote-bridge-protocol.mjs';
import { startDaemon } from '../src/host/daemon.mjs';

function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 't3-bridge-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
async function listen() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}
async function freePort() {
  const server = await listen(),
    port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function fixture(name, n, threadId = 'same') {
  return {
    updatedAtMs: 10,
    thread: {
      threadId,
      accountId: name,
      title: name,
      recentThreads: ['hidden'],
      streaming: { text: 'hidden' },
      natives: ['hidden'],
      steps: [{ id: name, type: 'command_execution', title: 'hidden command line' }],
      unresolved: false
    },
    context: { accountId: name, tps: n, usedTokens: n * 100, nativeSessionId: 'hidden' },
    quotas: {
      groups: [
        { accountId: name, windows: [{ remainingPercent: n }] },
        { accountId: 'hidden', windows: [] }
      ]
    },
    threadErrors: [{ id: name, errorText: 'hidden', nativeSessionId: 'hidden' }]
  };
}

test('pairing, literal address restrictions and receive-side allowlist', () => {
  const pair = {
    v: 1,
    token: '1'.repeat(64),
    environmentId: 'A',
    url: 'http://machine:9000',
    label: 'Machine'
  };
  const code = protocol.encodePairingCode(pair);
  assert.deepEqual(protocol.decodePairingCode(code), pair);
  for (const invalid of [code + '!', code.slice(0, -6), 't3bridge://v2/', null])
    assert.throws(() => protocol.decodePairingCode(invalid));
  for (const id of ['../foo', 'a%5c', 'a/b', 'a\n', null]) assert.equal(protocol.isValidThreadId(id), false);
  for (const url of [
    'http://169.254.169.254',
    'http://[::ffff:a9fe:a9fe]',
    'http://[fe80::1]',
    'http://0.0.0.0',
    'http://[::]',
    'http://224.0.0.1',
    'https://user@host',
    'http://host/?',
    'http://host#',
    'http://host/..',
    'ftp://host'
  ]) {
    assert.throws(() => protocol.validateRemoteOrigin(url, { allowLoopbackTunnel: true }));
  }
  for (const host of ['127.3.2.1', '[::ffff:127.0.0.1]', '[::1]', 'localhost']) {
    const url = 'http://' + host + ':9000';
    assert.throws(() => protocol.validateRemoteOrigin(url));
    assert.doesNotThrow(() => protocol.validateRemoteOrigin(url, { allowLoopbackTunnel: true }));
    assert.throws(() =>
      protocol.validateRemoteOrigin(url, { allowLoopbackTunnel: true, blockedPorts: [9000] })
    );
  }
  const payload = protocol.buildSanitizedRemoteLivePayload(fixture('A', 1), {
    environmentId: 'A',
    requestedThreadId: 'same',
    machineLabel: 'A'
  });
  payload.thread.natives = ['hidden'];
  const clean = protocol.validateRemoteLivePayload(payload, {
    expectedEnvironmentId: 'A',
    expectedThreadId: 'same'
  });
  assert.ok(!JSON.stringify(clean).includes('hidden'));
  assert.equal(clean.context.accountId, clean.quotas.groups[0].accountId);
  assert.throws(
    () => protocol.validateRemoteLivePayload(clean, { expectedEnvironmentId: 'B', expectedThreadId: 'same' }),
    /identityMismatch/
  );
});

test('disabled lifecycle, environment file discovery, Tailscale retries and port collision', async (t) => {
  const root = directory(t),
    settings = createSettingsStore(join(root, 'settings.json'));
  const paths = {
    environmentIdPath: join(root, 'environment-id'),
    remoteBridgeSecretsPath: join(root, 'secrets')
  };
  let clock = 0,
    scans = 0,
    addresses = {},
    scheduled = null;
  const bridge = createRemoteBridge({
    paths,
    settings,
    engine: {},
    now: () => clock,
    createHttpListener: (...args) => {
      const server = http.createServer(...args);
      const listen = server.listen.bind(server);
      server.listen = (port, address, done) =>
        listen(port, address === '100.70.1.1' ? '127.0.0.1' : address, done);
      return server;
    },
    networkInterfaces: () => {
      scans++;
      return addresses;
    },
    setTimeout: (fn, delay) => (scheduled = { fn, delay }),
    clearTimeout: () => {
      scheduled = null;
    }
  });
  try {
    await bridge.configure();
    assert.equal(scans, 0);
    assert.equal(scheduled, null);
    assert.equal(existsSync(paths.remoteBridgeSecretsPath), false);
    assert.equal(bridge.localEnvironmentId(), '');
    writeFileSync(paths.environmentIdPath, 'A');
    clock += 501;
    assert.equal(bridge.localEnvironmentId(), 'A');
    settings.update({ remoteBridge: { server: { enabled: true, port: await freePort() } } });
    await bridge.configure();
    assert.equal(bridge.getStatus().state, 'waiting_interface');
    assert.equal(scheduled.delay, 2000);
    await scheduled.fn();
    assert.equal(scheduled.delay, 5000);
    addresses = { vpn: [{ address: '100.70.1.1' }] };
    await scheduled.fn();
    assert.equal(bridge.getStatus().state, 'ambiguous_interface');
    addresses = { Tailscale: [{ address: '100.70.1.1' }] };
    await scheduled.fn();
    assert.equal(bridge.getStatus().state, 'listening');
    addresses = {};
    await scheduled.fn();
    assert.equal(bridge.getStatus().state, 'waiting_interface');
    const occupied = await listen();
    try {
      settings.update({
        remoteBridge: { server: { bindMode: 'custom', bindHost: '127.0.0.1', port: occupied.address().port } }
      });
      await bridge.configure();
      assert.equal(bridge.getStatus().state, 'port_in_use');
    } finally {
      await new Promise((resolve) => occupied.close(resolve));
    }
    await scheduled.fn();
    assert.equal(bridge.getStatus().state, 'listening');
  } finally {
    await bridge.stop();
  }
  assert.equal(scheduled, null);
});

test('two daemons isolate same-ID threads, inherit CDP target, guard mutations and clear disconnected metrics', async (t) => {
  const root = directory(t);
  async function machine(name, n) {
    const home = join(root, name);
    const userdata = join(home, '.t3', 'userdata');
    mkdirSync(userdata, { recursive: true });
    writeFileSync(join(userdata, 'environment-id'), name);
    const db = new DatabaseSync(join(userdata, 'statev2.sqlite'));
    const iso = new Date().toISOString();
    db.exec(`
      CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,environment_id TEXT,title TEXT,default_provider TEXT,provider_instance_id TEXT,updated_at TEXT,archived_at TEXT,deleted_at TEXT);
      CREATE TABLE orchestration_v2_projection_runs(run_id TEXT,thread_id TEXT,ordinal INTEGER,provider TEXT,provider_instance_id TEXT,provider_thread_id TEXT,status TEXT,requested_at TEXT,completed_at TEXT,payload_json TEXT);
      CREATE TABLE orchestration_v2_projection_turn_items(turn_item_id TEXT,thread_id TEXT,run_id TEXT,ordinal INTEGER,type TEXT,status TEXT,updated_at TEXT,payload_json TEXT);
    `);
    db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,NULL,NULL)').run(
      'same',
      name,
      name,
      'codex',
      name,
      iso
    );
    db.prepare('INSERT INTO orchestration_v2_projection_runs VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      'run',
      'same',
      1,
      'codex',
      name,
      null,
      'completed',
      iso,
      iso,
      '{}'
    );
    db.prepare('INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?,?,?,?,?,?)').run(
      name,
      'same',
      'run',
      1,
      'reasoning',
      'completed',
      iso,
      '{}'
    );
    db.close();
    const caches = join(home, '.t3', 'caches');
    mkdirSync(caches);
    writeFileSync(
      join(caches, name + '.json'),
      JSON.stringify({
        instanceId: name,
        driver: 'codex',
        enabled: true,
        usageLimits: { checkedAt: iso, windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 100 - n }] }
      })
    );
    const daemon = await startDaemon({
      pathOverrides: {
        home,
        t3Root: join(home, '.t3'),
        codexHome: join(home, '.codex'),
        appData: home,
        localAppData: home,
        pluginDataDir: join(home, '.t3tools')
      },
      portOverride: 0,
      enableCdp: false,
      enableRemoteUpdateCheck: false
    });
    daemon.ctx.store.replaceSourceRequests(
      'bridge-fixture',
      '1',
      Array.from({ length: n / 11 }, (_, i) => ({
        id: name + i,
        timestampMs: Date.now() - i,
        accountId: name,
        providerDriver: 'codex',
        modelId: name,
        t3ThreadId: 'same',
        nativeSessionId: name,
        inputTokens: n * 100,
        outputTokens: n,
        contextUsedTokens: n * 100,
        streamingMs: 1000,
        durationMs: 1000,
        tps: n,
        tpsKind: 'generation',
        status: 'error',
        errorCode: 'timeout',
        errorText: 'hidden diagnostic'
      }))
    );
    daemon.ctx.engine.tickAlerts();
    return daemon;
  }
  const a = await machine('A', 11),
    b = await machine('B', 22);
  try {
    async function enable(d, name) {
      await d.handleRpc('updateSettings', {
        remoteBridge: {
          server: {
            enabled: true,
            bindMode: 'custom',
            bindHost: '127.0.0.1',
            port: await freePort(),
            machineLabel: name
          }
        }
      });
      return (await d.handleRpc('getRemoteBridgePairingCode')).code;
    }
    const codeA = await enable(a, 'A'),
      codeB = await enable(b, 'B');
    const pair = async (d, code) =>
      d.handleRpc('upsertRemoteBridgePeer', { code, allowLoopbackTunnel: true, verify: true });
    const peer = await pair(a, codeB);
    assert.equal(peer.verified, true);
    assert.equal((await pair(b, codeA)).verified, true);
    const live = (d, env, threadId = 'same') => d.handleRpc('getLive', { environmentId: env, threadId });
    for (const [d, env, n, local] of [
      [a, 'B', 22, 11],
      [b, 'A', 11, 22]
    ]) {
      const snap = await live(d, env);
      assert.equal(snap.context.tps, n);
      assert.equal(snap.context.usedTokens, n * 100);
      assert.equal(snap.thread.steps[0].id, env);
      assert.equal(snap.quotas.groups[0].windows[0].remainingPercent, n);
      assert.equal(snap.globalAlerts.otherUnreadCount, local / 11);
      assert.equal(snap.sidebarUsage.totalTokens, local * 101 * (local / 11));
      const inherited = await (await fetch(d.url + '/api/live')).json();
      assert.equal(inherited.data.target.environmentId, env);
      assert.equal(inherited.data.context.tps, n);
      for (const action of ['focusThread', 'resolveErrors'])
        assert.equal((await d.handleRpc(action, { environmentId: env, threadId: 'same' })).ok, false);
    }
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 31000;
      const expired = await (await fetch(a.url + '/api/live')).json();
      assert.equal(expired.data.remote, null);
      assert.equal(expired.data.target.environmentId, 'A');
    } finally {
      Date.now = realNow;
    }
    assert.equal((await live(a, 'B', 'missing')).remote.status, 'threadNotFound');
    assert.equal((await live(a, 'B', 'same')).context.tps, 22);
    const known = [codeA, codeB].map((code) => protocol.decodePairingCode(code).token);
    await assert.rejects(
      a.handleRpc('updateSettings', { remoteBridge: { server: { machineLabel: known[0] } } })
    );
    const responses = [
      await (await fetch(a.url + '/api/live?environmentId=' + known[1])).text(),
      await a.handleRpc('updateSettings', { remoteBridge: { server: { machineLabel: 'A' } } }),
      readFileSync(a.ctx.paths.pluginSettingsPath, 'utf8')
    ];
    for (const path of ['/api/status', '/api/settings', '/api/live'])
      responses.push(await (await fetch(a.url + path)).text());
    responses.push(await a.handleRpc('parseRemoteBridgePairingCode', { code: codeB }));
    const post = (path, body, auth) =>
      fetch(a.url + '/api/remote-bridge/' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(auth ? { 'X-T3Tools-Token': a.authToken } : {}) },
        body: JSON.stringify(body)
      });
    assert.equal((await post('pairing-code', {}, false)).status, 401);
    responses.push(await (await post('parse-code', { code: known[0] }, true)).text());
    for (const token of known) assert.ok(!JSON.stringify(responses).includes(token));
    const bUrl = protocol.decodePairingCode(codeB).url;
    const remote = (path, method = 'GET') =>
      fetch(bUrl + path, { method, headers: { Authorization: 'Bearer ' + known[1] } });
    assert.equal((await fetch(bUrl + '/unknown')).status, 401);
    assert.equal((await remote('/unknown')).status, 404);
    assert.equal((await remote('/api/remote/info', 'POST')).status, 405);
    assert.equal((await remote('/api/remote/live')).status, 400);
    const dbPath = b.ctx.paths.stateDbPath;
    b.ctx.t3State.close();
    renameSync(dbPath, dbPath + '.away');
    try {
      const unavailable = await remote('/api/remote/live?threadId=same');
      assert.equal(unavailable.status, 503);
      assert.equal((await unavailable.json()).code, 'DATA_UNAVAILABLE');
    } finally {
      renameSync(dbPath + '.away', dbPath);
    }
    const unknown = protocol.decodePairingCode(codeB);
    const mismatched = protocol.encodePairingCode({ ...unknown, environmentId: 'C' });
    await a.handleRpc('upsertRemoteBridgePeer', { code: mismatched, allowLoopbackTunnel: true });
    assert.equal((await live(a, 'C')).remote.status, 'identityMismatch');
    assert.equal((await live(a, 'C', 'missing')).remote.status, 'identityMismatch');
    await b.handleRpc('rotateRemoteBridgeToken');
    assert.equal((await remote('/api/remote/info')).status, 401);
    assert.equal((await live(a, 'B', 'new')).remote.status, 'unauthorized');
    assert.equal((await live(a, 'B', 'different')).remote.status, 'unauthorized');
    const repaired = await pair(a, (await b.handleRpc('getRemoteBridgePairingCode')).code);
    assert.equal(repaired.id, peer.id);
    assert.equal((await live(a, 'B')).context.tps, 22);
    await b.stop();
    await new Promise((resolve) => setTimeout(resolve, 550));
    const failed = await (await fetch(a.url + '/api/live?environmentId=B&threadId=same')).json();
    assert.equal(failed.ok, true);
    assert.equal(failed.data.remote.status, 'offline');
    assert.equal(failed.data.context, null);
    assert.deepEqual(failed.data.quotas.groups, []);
    assert.equal(failed.data.globalAlerts.otherUnreadCount, 1);
    await a.handleRpc('toggleRemoteBridgePeer', { peerId: peer.id, enabled: false });
    assert.equal((await live(a, 'B')).remote.status, 'disabled');
    await a.handleRpc('removeRemoteBridgePeer', { peerId: peer.id });
    assert.equal((await live(a, 'B')).remote.status, 'unpaired');
    writeFileSync(a.ctx.paths.environmentIdPath, 'invalid/id');
    await new Promise((resolve) => setTimeout(resolve, 510));
    assert.equal((await live(a, 'B')).remote.status, 'localEnvUnknown');
    assert.equal((await live(a, 'A')).context.tps, 11);
    assert.equal((await live(a, 'A', 'missing')).remote.status, 'localEnvUnknown');
  } finally {
    await b.stop();
    await a.stop();
  }
});

test('outbound DNS pinning, single flight, deadlines, blocked ports and config invalidation', async (t) => {
  const root = directory(t),
    settings = createSettingsStore(join(root, 'settings'));
  const paths = {
    environmentIdPath: join(root, 'environment'),
    remoteBridgeSecretsPath: join(root, 'private')
  };
  writeFileSync(paths.environmentIdPath, 'A');
  let lookups = 0,
    clock = 1000,
    answer = [{ address: '127.0.0.1' }],
    pending,
    calls = 0,
    portBlock = 0;
  let gate = null,
    response = null;
  const listener = http.createServer((req, res) => {
    calls++;
    const id = new URL(req.url, 'http://localhost').searchParams.get('threadId');
    const payload = protocol.buildSanitizedRemoteLivePayload(fixture('B', 20, id), {
      environmentId: 'B',
      machineLabel: 'B',
      requestedThreadId: id
    });
    res.end(response ?? JSON.stringify({ ok: true, data: payload }));
  });
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  const bridge = createRemoteBridge({
    paths,
    settings,
    engine: { getLocalCommonShell: () => ({}) },
    getLocalPort: () => portBlock,
    now: () => clock,
    dnsLookup: async (host) => {
      assert.equal(host, 'peer.invalid');
      lookups++;
      if (gate) await gate.promise;
      return answer;
    },
    setTimeout: (fn, delay) => {
      assert.equal(delay, 2500);
      pending = fn;
      return 1;
    },
    clearTimeout: () => {}
  });
  try {
    await bridge.manage('upsertRemoteBridgePeer', {
      environmentId: 'B',
      url: 'http://peer.invalid:' + port,
      label: 'B',
      token: 'a'.repeat(64),
      allowLoopbackTunnel: true
    });
    const read = (id) => bridge.fetchRemoteLive('B', id);
    const results = await Promise.all([read('same'), read('same')]);
    assert.ok(results.every((r) => r.context.tps === 20));
    assert.equal(calls, 1);
    assert.equal(lookups, 1);
    await read('same');
    assert.equal(calls, 1);
    clock += 501;
    await read('same');
    assert.equal(calls, 2);
    portBlock = port;
    assert.equal((await read('blocked')).remote.status, 'offline');
    assert.equal(calls, 2);
    portBlock = 0;
    await bridge.configure();
    answer = [{ address: '::ffff:169.254.169.254' }];
    assert.equal((await read('metadata')).remote.status, 'offline');
    assert.equal(calls, 2);
    answer = [{ address: '127.0.0.1' }];
    clock += 1999;
    await read('different');
    assert.equal(calls, 2);
    clock++;
    await read('different');
    assert.equal(calls, 3);
    response = 'x'.repeat(524289);
    assert.equal((await read('oversize')).remote.status, 'incompatible');
    response = null;
    assert.equal((await read('again')).remote.status, 'incompatible');
    await bridge.configure();
    gate = Promise.withResolvers();
    const expires = read('deadline');
    pending();
    assert.equal((await expires).remote.status, 'offline');
    gate.resolve();
    gate = null;
    await bridge.configure();
    gate = Promise.withResolvers();
    const stale = read('stale');
    await bridge.configure();
    assert.equal((await stale).remote.status, 'reconfigured');
    gate.resolve();
    gate = null;
    assert.equal((await read('fresh')).remote.status, 'connected');
  } finally {
    await bridge.stop();
    await new Promise((resolve) => listener.close(resolve));
  }
});

test('review regressions: origin restriction, missing local env on old DB, encoded pairing redaction, ackErrors guard, port range and HTTP error codes', async (t) => {
  // P2-4: port validation rejects < 1024 and fractional ports
  assert.throws(() => protocol.sanitizeBridgeConfig({ server: { port: 80 } }));
  assert.throws(() => protocol.sanitizeBridgeConfig({ server: { port: 17374.9 } }));
  assert.equal(protocol.sanitizeBridgeConfig({ server: { port: 17374 } }).server.port, 17374);

  const root = directory(t);
  const t3Root = join(root, '.t3');
  const userData = join(t3Root, 'userdata');
  mkdirSync(userData, { recursive: true });
  writeFileSync(join(userData, 'server-runtime.json'), JSON.stringify({ origin: 'http://127.0.0.1:3773' }));

  // Older DB WITHOUT environment_id column and WITHOUT environment-id file
  const db = new DatabaseSync(join(userData, 'statev2.sqlite'));
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads(
      thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, default_provider TEXT,
      provider_instance_id TEXT, updated_at TEXT, archived_at TEXT, deleted_at TEXT
    );
    INSERT INTO orchestration_v2_projection_threads VALUES ('t-old','p1','Local Old','codex','codex','2026-01-01T00:00:00Z',NULL,NULL);
  `);
  db.close();

  const daemon = await startDaemon({
    pathOverrides: {
      home: root,
      appData: root,
      localAppData: root,
      t3Root,
      codexHome: join(root, '.codex'),
      pluginDataDir: join(root, '.t3tools')
    },
    portOverride: 0,
    enableCdp: false,
    enableRemoteUpdateCheck: false,
    enableAppUpdateCheck: false
  });
  let unauthSrv = null;
  try {
    const base = daemon.url;
    const authHeaders = { 'Content-Type': 'application/json', 'X-T3Tools-Token': daemon.authToken };

    // P1-4: missing local environment-id + old DB without environment_id column must return localEnvUnknown for explicit env
    const oldDbRes = await fetch(`${base}/api/live?environmentId=remote-env-1&threadId=t-old&allowFallback=0`);
    const oldDbJson = await oldDbRes.json();
    assert.equal(oldDbJson.ok, true);
    assert.equal(oldDbJson.data.remote?.status, 'localEnvUnknown');
    assert.equal(oldDbJson.data.thread?.unresolved, true);
    assert.equal(oldDbJson.data.context, null);

    // Legacy thread-only request without environmentId still works locally
    const localOnlyRes = await fetch(`${base}/api/live?threadId=t-old&allowFallback=0`);
    const localOnlyJson = await localOnlyRes.json();
    assert.equal(localOnlyJson.ok, true);
    assert.equal(localOnlyJson.data.remote, null);
    assert.equal(localOnlyJson.data.thread?.threadId, 't-old');

    // Now create local environment-id file and enable bridge server
    writeFileSync(join(userData, 'environment-id'), '11111111-1111-4111-8111-111111111111');
    const bridgePort = await freePort();
    const enableRes = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        remoteBridge: {
          server: { enabled: true, bindMode: 'custom', bindHost: '127.0.0.1', port: bridgePort, machineLabel: 'HostA' }
        }
      })
    });
    assert.equal(enableRes.status, 200);

    // P1-2: cross-origin T3 runtime origin MUST be rejected on GET / and POST /api/remote-bridge/pairing-code
    const htmlCross = await fetch(`${base}/`, { headers: { Origin: 'http://127.0.0.1:3773' } });
    assert.equal(htmlCross.status, 403);
    const codeCross = await fetch(`${base}/api/remote-bridge/pairing-code`, {
      method: 'POST',
      headers: { ...authHeaders, Origin: 'http://127.0.0.1:3773' },
      body: '{}'
    });
    assert.equal(codeCross.status, 403);

    // Same-origin (daemon origin) pairing-code request succeeds and returns unredacted code
    const codeSame = await fetch(`${base}/api/remote-bridge/pairing-code`, {
      method: 'POST',
      headers: { ...authHeaders, Origin: base },
      body: '{}'
    });
    assert.equal(codeSame.status, 200);
    const codeJson = await codeSame.json();
    assert.ok(codeJson.ok && codeJson.data?.code?.startsWith('t3bridge://v1/'));

    // P1-5: encoded pairing code pasted into public settings MUST be rejected
    const leakAttempt = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ multiMachineSync: { syncDir: codeJson.data.code } })
    });
    assert.equal(leakAttempt.status, 400);
    const settingsGet = await (await fetch(`${base}/api/settings`)).text();
    assert.ok(!settingsGet.includes('t3bridge://v1/'));

    // P1-6: remote-scoped ackErrors is blocked as read-only
    const ackRes = await fetch(`${base}/api/errors/ack`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ environmentId: '22222222-2222-4222-8222-222222222222' })
    });
    const ackJson = await ackRes.json();
    assert.equal(ackJson.data?.ok, false);
    assert.match(String(ackJson.data?.reason || ''), /read-only/i);

    // P2-3: allowlisted bridge error codes are preserved over HTTP 400
    const badParse = await fetch(`${base}/api/remote-bridge/parse-code`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ code: 'not-a-valid-code' })
    });
    assert.equal(badParse.status, 400);
    const badParseJson = await badParse.json();
    assert.equal(badParseJson.code, 'Invalid pairing code');

    // P2-1: upsertRemoteBridgePeer returns verifyStatus for permanent failure (unauthorized)
    unauthSrv = http.createServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ ok: false, code: 'UNAUTHORIZED' }));
    });
    await new Promise((resolve) => unauthSrv.listen(0, '127.0.0.1', resolve));
    const peerCode401 = protocol.encodePairingCode({
      v: 1,
      environmentId: '22222222-2222-4222-8222-222222222222',
      label: 'UnauthPeer',
      url: `http://127.0.0.1:${unauthSrv.address().port}`,
      token: 'b'.repeat(64)
    });
    const upsertRes = await fetch(`${base}/api/remote-bridge/peers/upsert`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ code: peerCode401, allowLoopbackTunnel: true, verify: true })
    });
    assert.equal(upsertRes.status, 200);
    const upsertJson = await upsertRes.json();
    assert.equal(upsertJson.data?.verified, false);
    assert.equal(upsertJson.data?.verifyStatus, 'unauthorized');
  } finally {
    if (unauthSrv) {
      await new Promise((resolve) => {
        unauthSrv.close(resolve);
        unauthSrv.closeAllConnections?.();
      });
    }
    await daemon.stop('test done');
  }
});

test('auto-resolves local and peer labels via Tailscale / remote report while allowing manual rename and reset', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 't3-bridge-labels-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const envPath = join(dir, 'environment-id');
  writeFileSync(envPath, '11111111-1111-4111-8111-111111111111');
  const settings = createSettingsStore(join(dir, 'settings.json'));
  const port = await freePort();
  settings.update({
    remoteBridge: {
      server: { enabled: true, port, bindMode: 'custom', bindHost: '127.0.0.1', advertiseUrl: `http://127.0.0.1:${port}`, machineLabel: '' }
    }
  });

  const peerToken = 'c'.repeat(64);
  const peerEnvId = '22222222-2222-4222-8222-222222222222';
  const bridge = createRemoteBridge({
    paths: { environmentIdPath: envPath, remoteBridgeSecretsPath: join(dir, 'secrets.json') },
    settings,
    engine: {
      getLocalCommonShell: () => ({ updatedAtMs: Date.now() }),
      getExactLocalThreadSnapshot: async () => ({ thread: { unresolved: true } })
    },
    version: '0.1.11',
    getLocalPort: () => 17373,
    hostnameFn: () => 'FallbackHost',
    tailscaleProbe: async () => ({
      selfName: 'ReadyToWork',
      peersByIp: new Map([['100.71.86.74', 'Knight']])
    }),
    httpRequest: (_url, _opts, cb) => {
      const listeners = new Map();
      const req = {
        on(evt, fn) { listeners.set(evt, fn); return req; },
        destroy() {},
        end() {
          queueMicrotask(() => {
            const resListeners = new Map();
            const payload = JSON.stringify({
              ok: true,
              data: {
                protocolVersion: 1,
                environmentId: peerEnvId,
                machineLabel: 'KnightRemote',
                requestedThreadId: 'thread-1',
                updatedAtMs: Date.now(),
                thread: {
                  unresolved: false,
                  threadId: 'thread-1',
                  title: 'Demo',
                  accountId: 'acc',
                  selectedModel: 'gemini-4-neon',
                  phase: 'completed',
                  phaseLabel: '已完成',
                  queuedRuns: 0,
                  totalSteps: 0,
                  run: null,
                  steps: []
                },
                context: null,
                quotas: { updatedAtMs: null, groups: [], flatWindows: [] },
                threadErrors: []
              }
            });
            const res = {
              statusCode: 200,
              on(evt, fn) { resListeners.set(evt, fn); return res; }
            };
            cb(res);
            resListeners.get('data')?.(Buffer.from(payload));
            resListeners.get('end')?.();
          });
        }
      };
      return req;
    }
  });
  t.after(() => bridge.stop());

  await bridge.configure();
  const { code: localCode } = await bridge.manage('getRemoteBridgePairingCode');
  assert.equal(protocol.decodePairingCode(localCode).label, 'ReadyToWork');
  assert.equal(bridge.getStatus().defaultMachineLabel, 'ReadyToWork');
  assert.equal(bridge.getStatus().resolvedMachineLabel, 'ReadyToWork');

  // Pairing code with empty label resolves preview + peer status from Tailscale IP automatically
  const emptyLabelPeerCode = protocol.encodePairingCode({
    v: 1,
    environmentId: peerEnvId,
    label: '',
    url: 'http://100.71.86.74:17374',
    token: peerToken
  });
  const parsed = await bridge.manage('parseRemoteBridgePairingCode', { code: emptyLabelPeerCode });
  assert.equal(parsed.label, 'Knight');

  const saved = await bridge.manage('upsertRemoteBridgePeer', { code: emptyLabelPeerCode, verify: false });
  assert.equal(saved.label, '');
  assert.equal(bridge.getStatus().peerResolvedLabels[saved.id], 'Knight');

  // After live fetch, remote-reported machineLabel overrides Tailscale when manual label is empty
  const liveAuto = await bridge.fetchRemoteLive(peerEnvId, 'thread-1');
  assert.equal(liveAuto.remote.status, 'connected');
  assert.equal(liveAuto.remote.peerLabel, 'KnightRemote');

  // Manual rename overrides both remote report and Tailscale
  const renamed = await bridge.manage('renameRemoteBridgePeer', { peerId: saved.id, label: '办公室主力机' });
  assert.equal(renamed.peer.label, '办公室主力机');
  assert.equal(bridge.getStatus().peerResolvedLabels[saved.id], '办公室主力机');
  const liveCustom = await bridge.fetchRemoteLive(peerEnvId, 'thread-1');
  assert.equal(liveCustom.remote.peerLabel, '办公室主力机');

  // Reject secret leakage in rename
  await assert.rejects(
    () => bridge.manage('renameRemoteBridgePeer', { peerId: saved.id, label: peerToken }),
    /Invalid bridge configuration|Credentials cannot appear in settings/
  );

  // Clearing custom label restores automatic detection
  await bridge.manage('renameRemoteBridgePeer', { peerId: saved.id, label: '' });
  assert.equal(bridge.getStatus().peerResolvedLabels[saved.id], 'KnightRemote');
});
