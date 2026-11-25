import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeUpdatesAdapter, compareSemver, resolveAntigravityManifestTarget } from '../src/adapters/runtime-updates.mjs';
import { createT3StateAdapter } from '../src/adapters/t3-state.mjs';
import { resolvePaths } from '../src/core/paths.mjs';
import { createTelemetryStore } from '../src/core/telemetry-store.mjs';
import { startDaemon } from '../src/host/daemon.mjs';
import { buildClientBundle } from '../src/ui/bundle.mjs';

function setupTempEnv() {
  const root = mkdtempSync(join(tmpdir(), 't3tools-rtupd-'));
  const t3Root = join(root, '.t3');
  const pluginDataDir = join(root, '.t3tools');
  mkdirSync(join(t3Root, 'userdata'), { recursive: true });
  mkdirSync(join(t3Root, 'caches'), { recursive: true });
  mkdirSync(pluginDataDir, { recursive: true });
  const paths = resolvePaths({ home: root, t3Root, pluginDataDir });
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

test('Sidebar trigger renders today USD spend and dismissible runtime update banner', () => {
  const sharedViewsSrc = readFileSync(new URL('../src/ui/shared-views.js', import.meta.url), 'utf8');
  const renderSidebarTrigger = new Function(`${sharedViewsSrc}\nreturn renderSidebarTriggerHtml;`)();

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
  assert.ok(normalHtml.includes('<span>⚡ T3Tools</span>'));
  assert.ok(normalHtml.includes('今日 $3.46'));
  assert.equal(normalHtml.includes('pt-sidebar-update-row'), false);

  const zeroHtml = renderSidebarTrigger({
    todayUsage: { day: '2026-11-25', costUsd: 0, totalTokens: 0, requests: 0 },
    runtimeUpdates: { hasUpdates: false, updateCount: 0, items: [] }
  });
  assert.ok(zeroHtml.includes('今日 $0.00'));

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
  assert.ok(withUpdateHtml.includes('今日 $1.25'));

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

    // Pre-populate telemetry.sqlite with 1 request today ($1.75) and 1 request yesterday ($9.99)
    const now = Date.now();
    const yesterday = now - 36 * 60 * 60 * 1000;
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
      }
    ]);
    preStore.close();

    daemon = await startDaemon({
      pathOverrides: { home: env.root, t3Root: env.t3Root, pluginDataDir: env.pluginDataDir },
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

    // /api/live includes todayUsage (only today's $1.75) and runtimeUpdates
    const liveRes = await fetch(`${daemon.url}/api/live`);
    const liveJson = await liveRes.json();
    assert.equal(liveJson.ok, true);
    assert.equal(liveJson.data.todayUsage.costUsd, 1.75);
    assert.equal(liveJson.data.todayUsage.requests, 1);
    assert.equal(liveJson.data.runtimeUpdates.hasUpdates, true);

    // /api/status includes both as well
    const stRes = await fetch(`${daemon.url}/api/status`);
    const stJson = await stRes.json();
    assert.equal(stJson.ok, true);
    assert.equal(stJson.data.todayUsage.costUsd, 1.75);
    assert.equal(stJson.data.runtimeUpdates.updateCount, 1);
  } finally {
    await daemon?.stop();
    env.cleanup();
  }
});
