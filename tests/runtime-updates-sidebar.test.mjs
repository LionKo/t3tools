import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeUpdatesAdapter, compareSemver, resolveAntigravityManifestTarget } from '../src/adapters/runtime-updates.mjs';
import { createT3StateAdapter } from '../src/adapters/t3-state.mjs';
import { resolvePaths } from '../src/core/paths.mjs';
import { createTelemetryStore } from '../src/core/telemetry-store.mjs';
import { createRuntimeContext, startDaemon } from '../src/host/daemon.mjs';
import { buildClientBundle } from '../src/ui/bundle.mjs';

function setupTempEnv() {
  const root = mkdtempSync(join(tmpdir(), 't3tools-rtupd-'));
  const t3Root = join(root, '.t3');
  const pluginDataDir = join(root, '.t3tools');
  mkdirSync(join(t3Root, 'userdata'), { recursive: true });
  mkdirSync(join(t3Root, 'caches'), { recursive: true });
  mkdirSync(pluginDataDir, { recursive: true });
  const paths = resolvePaths({ home: root, codexHome: join(root, '.codex'), t3Root, pluginDataDir });
  return { root, t3Root, pluginDataDir, paths, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('compareSemver & resolveAntigravityManifestTarget handle common cases', () => {
  assert.equal(compareSemver('1.5.16', '1.5.17'), -1);
  assert.equal(compareSemver('1.5.16', '1.5.16'), 0);
  assert.equal(compareSemver('1.6.0', '1.5.99'), 1);
  assert.equal(compareSemver('v0.172.0', '0.173.0'), -1);
  assert.equal(compareSemver('invalid', '1.0.0'), null);

  assert.equal(resolveAntigravityManifestTarget('win32', 'x64'), 'windows_amd64');
  assert.equal(resolveAntigravityManifestTarget('win32', 'arm64'), 'windows_arm64');
  assert.equal(resolveAntigravityManifestTarget('darwin', 'arm64'), 'darwin_arm64');
  assert.equal(resolveAntigravityManifestTarget('linux', 'x64', true), 'linux_amd64_musl');
});

test('Scheme 3: Codex reads T3 Code cache versionAdvisory directly with zero network calls', async () => {
  const env = setupTempEnv();
  try {
    writeFileSync(env.paths.settingsPath, JSON.stringify({
      providerInstances: {
        codex: { driver: 'codex', enabled: true }
      }
    }), 'utf8');
    writeFileSync(join(env.paths.t3Caches, 'codex.json'), JSON.stringify({
      instanceId: 'codex',
      driver: 'codex',
      displayName: 'Codex',
      enabled: true,
      installed: true,
      version: '0.172.0',
      versionAdvisory: {
        status: 'behind_latest',
        currentVersion: '0.172.0',
        latestVersion: '0.173.0',
        canUpdate: true,
        checkedAt: '2026-11-25T10:25:31.679Z'
      }
    }), 'utf8');

    let fetchCalls = 0;
    const t3State = createT3StateAdapter(env.paths);
    const adapter = createRuntimeUpdatesAdapter({
      paths: env.paths,
      t3State,
      fetchImpl: async () => { fetchCalls++; throw new Error('should not fetch'); }
    });

    const snap = adapter.readRuntimeUpdates();
    assert.equal(fetchCalls, 0);
    assert.equal(snap.hasUpdates, true);
    assert.equal(snap.updateCount, 1);
    assert.equal(snap.items.length, 1);
    assert.equal(snap.items[0].driver, 'codex');
    assert.equal(snap.items[0].currentVersion, '0.172.0');
    assert.equal(snap.items[0].latestVersion, '0.173.0');
    assert.equal(snap.items[0].hasUpdate, true);
    assert.equal(snap.items[0].source, 't3-cache');

    // Broken latestVersionStatus suppresses false update nag
    writeFileSync(join(env.paths.t3Caches, 'codex.json'), JSON.stringify({
      instanceId: 'codex',
      driver: 'codex',
      displayName: 'Codex',
      enabled: true,
      installed: true,
      version: '0.172.0',
      versionAdvisory: { status: 'behind_latest', currentVersion: '0.172.0', latestVersion: '0.173.0', canUpdate: true },
      compatibilityAdvisory: { status: 'supported', latestVersionStatus: 'broken' }
    }), 'utf8');
    const blocked = adapter.readRuntimeUpdates();
    assert.equal(blocked.hasUpdates, false);
    assert.equal(blocked.updateCount, 0);
  } finally {
    env.cleanup();
  }
});

test('Scheme 3: Antigravity deduplicates instances, checks manifest lazily with cooldown, and prefers T3 cache when present', async () => {
  const env = setupTempEnv();
  try {
    writeFileSync(env.paths.settingsPath, JSON.stringify({
      enableProviderUpdateChecks: true,
      providerInstances: {
        antigravity: { driver: 'antigravity', enabled: true },
        Ultra: { driver: 'antigravity', displayName: 'Antigravity', enabled: true }
      }
    }), 'utf8');
    writeFileSync(join(env.paths.t3Caches, 'antigravity.json'), JSON.stringify({
      instanceId: 'antigravity',
      driver: 'antigravity',
      displayName: 'Antigravity',
      enabled: true,
      installed: true,
      version: '1.5.16'
    }), 'utf8');
    writeFileSync(join(env.paths.t3Caches, 'Ultra.json'), JSON.stringify({
      instanceId: 'Ultra',
      driver: 'antigravity',
      displayName: 'Antigravity',
      enabled: true,
      installed: true,
      version: '1.5.16'
    }), 'utf8');

    const requestedUrls = [];
    const t3State = createT3StateAdapter(env.paths);
    const adapter = createRuntimeUpdatesAdapter({
      paths: env.paths,
      t3State,
      platform: 'win32',
      arch: 'x64',
      checkIntervalMs: 60 * 60 * 1000,
      fetchImpl: async url => {
        requestedUrls.push(url);
        return { ok: true, status: 200, json: async () => ({ version: '1.5.17' }) };
      }
    });

    const checked = await adapter.checkNow();
    assert.equal(requestedUrls.length, 1);
    assert.ok(requestedUrls[0].endsWith('/manifests/windows_amd64.json'));
    assert.equal(checked.items.length, 1);
    assert.deepEqual(checked.items[0].instanceIds.sort(), ['Ultra', 'antigravity']);
    assert.equal(checked.items[0].driver, 'antigravity');
    assert.equal(checked.items[0].currentVersion, '1.5.16');
    assert.equal(checked.items[0].latestVersion, '1.5.17');
    assert.equal(checked.items[0].hasUpdate, true);
    assert.equal(checked.items[0].source, 'antigravity-manifest');

    // Subsequent poll within cooldown does NOT trigger another fetch
    const cachedSnap = adapter.readRuntimeUpdates();
    assert.equal(requestedUrls.length, 1);
    assert.equal(cachedSnap.hasUpdates, true);

    // If T3 Code itself later writes versionAdvisory to cache, reuse cache & skip remote fetch
    writeFileSync(join(env.paths.t3Caches, 'antigravity.json'), JSON.stringify({
      instanceId: 'antigravity',
      driver: 'antigravity',
      displayName: 'Antigravity',
      enabled: true,
      installed: true,
      version: '1.5.17',
      versionAdvisory: { status: 'current', currentVersion: '1.5.17', latestVersion: '1.5.17', canUpdate: false }
    }), 'utf8');
    const afterCache = await adapter.checkNow();
    assert.equal(requestedUrls.length, 1);
    assert.equal(afterCache.hasUpdates, false);
    assert.equal(afterCache.items[0].source, 't3-cache');
  } finally {
    env.cleanup();
  }
});

test('Scheme 3: respects T3 Code enableProviderUpdateChecks = false', async () => {
  const env = setupTempEnv();
  try {
    writeFileSync(env.paths.settingsPath, JSON.stringify({
      enableProviderUpdateChecks: false,
      providerInstances: {
        antigravity: { driver: 'antigravity', enabled: true }
      }
    }), 'utf8');
    writeFileSync(join(env.paths.t3Caches, 'antigravity.json'), JSON.stringify({
      instanceId: 'antigravity',
      driver: 'antigravity',
      displayName: 'Antigravity',
      enabled: true,
      installed: true,
      version: '1.5.16'
    }), 'utf8');

    let fetchCalls = 0;
    const t3State = createT3StateAdapter(env.paths);
    const adapter = createRuntimeUpdatesAdapter({
      paths: env.paths,
      t3State,
      fetchImpl: async () => { fetchCalls++; return { ok: true, json: async () => ({ version: '1.5.17' }) }; }
    });
    const snap = await adapter.checkNow();
    assert.equal(fetchCalls, 0);
    assert.equal(snap.checksEnabled, false);
    assert.equal(snap.hasUpdates, false);
  } finally {
    env.cleanup();
  }
});

test('Sidebar trigger renders T3 icon, today tokens + USD spend, and dismissible runtime update banner', () => {
  const sharedViewsSrc = readFileSync(new URL('../src/ui/shared-views.js', import.meta.url), 'utf8');
  const renderSidebarTrigger = new Function(`${sharedViewsSrc}\nreturn renderSidebarTriggerHtml;`)();

  for (const field of ['totalTokens', 'costUsd']) {
    const usage = { totalTokens: 123, costUsd: 1, [field]: null };
    const html = renderSidebarTrigger({ todayUsage: usage, settings: { sidebarUsageRange: '7d' } });
    assert.ok(html.includes('data-pt-sidebar-range="today"'));
    assert.ok(html.includes('pt-sidebar-val pt-mono">-</span>'));
  }
  const normalHtml = renderSidebarTrigger({
    todayUsage: { day: '2026-11-25', costUsd: 3.456, totalTokens: 1200000, requests: 14 },
    runtimeUpdates: {
      hasUpdates: false,
      updateCount: 0,
      items: [
        { driver: 'codex', displayName: 'Codex', currentVersion: '0.172.0', latestVersion: '0.172.0', status: 'current', hasUpdate: false }
      ]
    }
  });
  assert.ok(normalHtml.includes('class="pt-sidebar-logo" data-state="attached"'));
  assert.ok(normalHtml.includes('<span class="pt-sidebar-logo-text">T3</span>'));
  assert.ok(normalHtml.includes('<span class="pt-sidebar-status-dot"></span>'));
  assert.equal(normalHtml.includes('⚡ T3Tools'), false);
  assert.ok(normalHtml.includes('<span class="pt-sidebar-today" data-pt-sidebar-range="today">今日</span>'));
  assert.ok(normalHtml.includes('data-pt-today-tokens="1"'));
  assert.ok(normalHtml.includes('1.20M'));
  assert.ok(normalHtml.includes('data-pt-today-cost="1"'));
  assert.ok(normalHtml.includes('$3.46'));
  assert.equal(normalHtml.includes('pt-sidebar-update-row'), false);

  const rangeCases = [
    ['24h', '24h', '近 24 小时'],
    ['weeklyQuota', '本周期', '本周限额周期'],
    ['week', '本周', '本周'],
    ['7d', '7天', '近 7 天'],
    ['30d', '30天', '近 30 天'],
    ['all', '累计', '全部历史']
  ];
  for (const [preset, shortLabel, fullLabel] of rangeCases) {
    const html = renderSidebarTrigger({
      sidebarUsage: { preset, costUsd: 12.34, totalTokens: 2500000, requests: 20 }
    });
    assert.ok(html.includes(`data-pt-sidebar-range="${preset}">${shortLabel}</span>`), `expected ${shortLabel} for ${preset}`);
    assert.ok(html.includes(`${fullLabel} 2.50M tokens`));
    assert.ok(html.includes('$12.34'));
  }

  const withUnreadErrorsHtml = renderSidebarTrigger({
    todayUsage: { day: '2026-11-25', costUsd: 1.5, totalTokens: 200000, requests: 3 },
    globalAlerts: { unreadCount: 2 }
  });
  assert.ok(withUnreadErrorsHtml.includes('class="pt-sidebar-logo" data-state="attached"'));
  assert.ok(withUnreadErrorsHtml.includes('已连接'));

  const disconnectedHtml = renderSidebarTrigger(
    { todayUsage: { day: '2026-11-25', costUsd: 1.5, totalTokens: 200000, requests: 3 } },
    { status: 'disconnected' }
  );
  assert.ok(disconnectedHtml.includes('class="pt-sidebar-logo" data-state="disconnected"'));
  assert.ok(disconnectedHtml.includes('服务未连接'));

  const zeroHtml = renderSidebarTrigger({
    todayUsage: { day: '2026-11-25', costUsd: 0, totalTokens: 0, requests: 0 },
    runtimeUpdates: { hasUpdates: false, updateCount: 0, items: [] }
  });
  assert.ok(zeroHtml.includes('<span class="pt-sidebar-val pt-mono">0</span>'));
  assert.ok(zeroHtml.includes('$0.00'));

  const emptyHtml = renderSidebarTrigger(null);
  assert.ok(emptyHtml.includes('class="pt-sidebar-logo" data-state="waiting"'));
  assert.ok(emptyHtml.includes('今日用量看板'));

  const withUpdateHtml = renderSidebarTrigger({
    todayUsage: { day: '2026-11-25', costUsd: 1.25, totalTokens: 500000, requests: 6 },
    runtimeUpdates: {
      hasUpdates: true,
      updateCount: 1,
      items: [
        { driver: 'antigravity', displayName: 'Antigravity', currentVersion: '1.5.16', latestVersion: '1.5.17', status: 'behind_latest', hasUpdate: true }
      ]
    }
  });
  assert.ok(withUpdateHtml.includes('pt-sidebar-update-row'));
  assert.ok(withUpdateHtml.includes('↑ Antigravity 1.5.17 可更新'));
  assert.ok(withUpdateHtml.includes('data-pt-action="open-provider-settings"'));
  assert.ok(withUpdateHtml.includes('data-pt-update-sig="antigravity:1.5.17"'));
  assert.ok(withUpdateHtml.includes('500k'));
  assert.ok(withUpdateHtml.includes('$1.25'));

  // Dismissing the exact version hides the banner, but a newer version brings it back
  const dismissedHtml = renderSidebarTrigger({
    todayUsage: { day: '2026-11-25', costUsd: 1.25, totalTokens: 500000, requests: 6 },
    runtimeUpdates: {
      hasUpdates: true,
      updateCount: 1,
      items: [
        { driver: 'antigravity', displayName: 'Antigravity', currentVersion: '1.5.16', latestVersion: '1.5.17', status: 'behind_latest', hasUpdate: true }
      ]
    }
  }, { dismissedUpdateSig: 'antigravity:1.5.17' });
  assert.equal(dismissedHtml.includes('pt-sidebar-update-row'), false);

  const newerHtml = renderSidebarTrigger({
    todayUsage: { day: '2026-11-25', costUsd: 1.25, totalTokens: 500000, requests: 6 },
    runtimeUpdates: {
      hasUpdates: true,
      updateCount: 1,
      items: [
        { driver: 'antigravity', displayName: 'Antigravity', currentVersion: '1.5.16', latestVersion: '1.5.18', status: 'behind_latest', hasUpdate: true }
      ]
    }
  }, { dismissedUpdateSig: 'antigravity:1.5.17' });
  assert.ok(newerHtml.includes('↑ Antigravity 1.5.18 可更新'));

  // Multi-runtime update combines names cleanly
  const multiHtml = renderSidebarTrigger({
    todayUsage: { day: '2026-11-25', costUsd: 2.5, totalTokens: 900000, requests: 9 },
    runtimeUpdates: {
      hasUpdates: true,
      updateCount: 2,
      items: [
        { driver: 'codex', displayName: 'Codex', currentVersion: '0.172.0', latestVersion: '0.173.0', status: 'behind_latest', hasUpdate: true },
        { driver: 'antigravity', displayName: 'Antigravity', currentVersion: '1.5.16', latestVersion: '1.5.17', status: 'behind_latest', hasUpdate: true }
      ]
    }
  });
  assert.ok(multiHtml.includes('↑ Codex / Antigravity 有更新'));

  // Assembled client bundle remains syntactically valid and warning-icon free
  const bundle = buildClientBundle({ version: '0.1.0', transport: 'cdp' });
  assert.doesNotThrow(() => new Function(bundle));
  assert.equal(bundle.includes('⚠'), false);
});

test('Daemon /api/live, /api/status, and POST /api/runtime-updates/check return todayUsage and runtimeUpdates', async () => {
  const env = setupTempEnv();
  let daemon = null;
  try {
    writeFileSync(env.paths.settingsPath, JSON.stringify({
      providerInstances: {
        codex: { driver: 'codex', enabled: true },
        antigravity: { driver: 'antigravity', enabled: true }
      }
    }), 'utf8');
    writeFileSync(join(env.paths.t3Caches, 'codex.json'), JSON.stringify({
      instanceId: 'codex',
      driver: 'codex',
      displayName: 'Codex',
      enabled: true,
      installed: true,
      version: '0.172.0',
      versionAdvisory: { status: 'current', currentVersion: '0.172.0', latestVersion: '0.172.0', canUpdate: false }
    }), 'utf8');
    writeFileSync(join(env.paths.t3Caches, 'antigravity.json'), JSON.stringify({
      instanceId: 'antigravity',
      driver: 'antigravity',
      displayName: 'Antigravity',
      enabled: true,
      installed: true,
      version: '1.5.16'
    }), 'utf8');

    // Pre-populate telemetry.sqlite with 1 request today ($1.75), 1 yesterday ($9.99), and 1 ten days ago ($20.00)
    const now = Date.now();
    const yesterday = now - 36 * 60 * 60 * 1000;
    const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
    const preStore = createTelemetryStore(env.paths.telemetryDbPath);
    preStore.replaceSourceRequests('manual-test', 'v1', [
      {
        id: 'req-today',
        providerDriver: 'codex',
        accountId: 'codex',
        nativeSessionId: 'sess-1',
        modelId: 'gpt-6.2-astra',
        timestampMs: now - 1000,
        billingTsMs: now - 1000,
        inputTokens: 1000,
        outputTokens: 500,
        costUsd: 1.75,
        status: 'success'
      },
      {
        id: 'req-yesterday',
        providerDriver: 'codex',
        accountId: 'codex',
        nativeSessionId: 'sess-0',
        modelId: 'gpt-6.2-astra',
        timestampMs: yesterday,
        billingTsMs: yesterday,
        inputTokens: 1000,
        outputTokens: 500,
        costUsd: 9.99,
        status: 'success'
      },
      {
        id: 'req-old',
        providerDriver: 'codex',
        accountId: 'codex',
        nativeSessionId: 'sess-old',
        modelId: 'gpt-6.2-astra',
        timestampMs: tenDaysAgo,
        billingTsMs: tenDaysAgo,
        inputTokens: 2000,
        outputTokens: 1000,
        costUsd: 20.0,
        status: 'success'
      }
    ]);
    preStore.close();

    daemon = await startDaemon({
      pathOverrides: env.paths,
      portOverride: 0,
      enableCdp: false,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ version: '1.5.17' }) })
    });

    // Trigger manual check endpoint
    const checkRes = await fetch(`${daemon.url}/api/runtime-updates/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-T3Tools-Token': daemon.authToken },
      body: '{}'
    });
    assert.equal(checkRes.status, 200);
    const checkJson = await checkRes.json();
    assert.equal(checkJson.ok, true);
    assert.equal(checkJson.data.hasUpdates, true);
    assert.equal(checkJson.data.updateCount, 1);

    // /api/live defaults to today for both todayUsage and sidebarUsage
    const liveRes = await fetch(`${daemon.url}/api/live`);
    const liveJson = await liveRes.json();
    assert.equal(liveJson.ok, true);
    assert.equal(liveJson.data.todayUsage.costUsd, 1.75);
    assert.equal(liveJson.data.todayUsage.requests, 1);
    assert.equal(liveJson.data.sidebarUsage.preset, 'today');
    assert.equal(liveJson.data.sidebarUsage.costUsd, 1.75);
    assert.equal(liveJson.data.runtimeUpdates.hasUpdates, true);

    // /api/status includes both as well
    const stRes = await fetch(`${daemon.url}/api/status`);
    const stJson = await stRes.json();
    assert.equal(stJson.ok, true);
    assert.equal(stJson.data.todayUsage.costUsd, 1.75);
    assert.equal(stJson.data.sidebarUsage.preset, 'today');
    assert.equal(stJson.data.sidebarUsage.costUsd, 1.75);
    assert.equal(stJson.data.runtimeUpdates.updateCount, 1);

    // Switching sidebarUsageRange to 7d updates sidebarUsage while preserving todayUsage
    const set7dRes = await fetch(`${daemon.url}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-T3Tools-Token': daemon.authToken },
      body: JSON.stringify({ sidebarUsageRange: '7d' })
    });
    assert.equal(set7dRes.status, 200);
    const live7d = await (await fetch(`${daemon.url}/api/live`)).json();
    assert.equal(live7d.data.settings.sidebarUsageRange, '7d');
    assert.equal(live7d.data.todayUsage.costUsd, 1.75);
    assert.equal(live7d.data.sidebarUsage.preset, '7d');
    assert.equal(live7d.data.sidebarUsage.requests, 2);
    assert.equal(live7d.data.sidebarUsage.costUsd, 11.74);
    assert.equal(live7d.data.sidebarUsage.totalTokens, 3000);

    // Switching to all includes the 10-day-old request as well
    const setAllRes = await fetch(`${daemon.url}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-T3Tools-Token': daemon.authToken },
      body: JSON.stringify({ sidebarUsageRange: 'all' })
    });
    assert.equal(setAllRes.status, 200);
    const stAll = await (await fetch(`${daemon.url}/api/status`)).json();
    assert.equal(stAll.data.sidebarUsage.preset, 'all');
    assert.equal(stAll.data.sidebarUsage.requests, 3);
    assert.equal(stAll.data.sidebarUsage.costUsd, 31.74);
    assert.equal(stAll.data.sidebarUsage.totalTokens, 6000);

    // Invalid sidebarUsageRange is rejected
    const badRes = await fetch(`${daemon.url}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-T3Tools-Token': daemon.authToken },
      body: JSON.stringify({ sidebarUsageRange: 'invalid-range' })
    });
    assert.equal(badRes.status, 400);
  } finally {
    await daemon?.stop();
    env.cleanup();
  }
});

test('health retains its runtime identity while stopping and skips status dependencies', async () => {
  const env = setupTempEnv();
  const daemon = await startDaemon({ pathOverrides: env.paths, portOverride: 0, enableCdp: false });
  const gate = Promise.withResolvers();
  const close = daemon.httpServer.close;
  daemon.httpServer.close = async () => { await gate.promise; await close(); };
  try {
    const unavailable = () => { throw new Error('health touched analytics or settings'); };
    daemon.ctx.engine.getRuntimeUpdates = daemon.ctx.engine.getAlerts = daemon.ctx.settings.get = unavailable;
    const runtime = JSON.parse(readFileSync(env.paths.runtimeFilePath));
    const expected = { version: runtime.version, pid: runtime.pid, startedAtMs: runtime.startedAtMs };
    const health = async () => (await fetch(daemon.url + '/api/health', { signal: AbortSignal.timeout(1000) })).json();
    assert.deepEqual(await health(), { ok: true, data: { ...expected, state: 'running' } });
    daemon.stop('test');
    assert.deepEqual(await health(), { ok: true, data: { ...expected, state: 'stopping' } });
  } finally {
    gate.resolve();
    await daemon.stop();
    env.cleanup();
  }
});

test('disk settings recover each field and weekly totals follow each account across external writes', () => {
  const env = setupTempEnv();
  writeFileSync(env.paths.pluginSettingsPath, JSON.stringify({
    port: 20999, autoAttachT3: false, theme: 'light', sidebarUsageRange: 'unknown',
    alertConfig: { mode: 'quiet', burstThreshold: -1 }
  }));
  const ctx = createRuntimeContext(env.paths, { enableRemoteUpdateCheck: false });
  const writer = createTelemetryStore(env.paths.telemetryDbPath);
  try {
    const cfg = ctx.settings.get();
    assert.deepEqual([cfg.port, cfg.autoAttachT3, cfg.theme, cfg.sidebarUsageRange, cfg.alertConfig.mode],
      [20999, false, 'light', 'today', 'quiet']);
    assert.throws(() => ctx.settings.update({ theme: 'dark', sidebarUsageRange: 'unknown' }));
    assert.equal(ctx.settings.get().theme, 'light');
    const day = 86400000;
    const now = +new Date(2026, 8, 10, 12);
    const windows = [ ['A', 1], ['B', 5] ].map(([accountId, days]) => ({
      kind: 'weekly', accountId, poolKey: 'codex', resetsAtMs: now + days * day
    }));
    ctx.quotaAdapter.readAllQuotas = () => ({ groups: [], flatWindows: windows });
    function row(accountId, ageDays, ordinal) {
      return { id: 'r' + ordinal, accountId, modelId: 'gpt', providerDriver: 'codex',
        timestampMs: now - ageDays * day, inputTokens: 10, costUsd: 0.12345, nativeSessionId: 'session' };
    }
    writer.replaceSourceRequests('fixtures', 'v1', [
      row('A', 4, 1), row('B', 4, 2), row('B', 1, 3), row('unmatched', 6.5, 4), row('unmatched', 8, 5)
    ]);
    const weekly = () => ctx.engine.getSidebarUsageSummary(now, { preset: 'weeklyQuota' });
    const compare = expected => {
      const sidebar = weekly();
      const dash = ctx.engine.getDashboardData({ preset: 'weeklyQuota' }, { now }).overviewLedger.totals;
      assert.deepEqual([sidebar.requests, sidebar.totalTokens, sidebar.costUsd],
        [dash.calls, dash.totalTokens, dash.costUsd]);
      assert.equal(sidebar.requests, expected);
    };
    compare(3);
    windows[1].resetsAtMs = now + day;
    compare(4);
    assert.equal(ctx.engine.getTodayUsageSummary(now).requests, 0);
    writer.replaceSourceRequests('external', 'v2', [row('B', 0, 6), { ...row('A', 0, 7), timestampMs: now + 2 }]);
    compare(5);
    assert.equal(ctx.engine.getTodayUsageSummary(now).requests, 1);
    assert.equal(ctx.engine.getTodayUsageSummary(now + 2).requests, 2);
    assert.equal(ctx.engine.getSidebarUsageSummary(now + 2, { preset: 'weeklyQuota' }).requests, 6);
  } finally {
    writer.close();
    ctx.close();
    env.cleanup();
  }
});
