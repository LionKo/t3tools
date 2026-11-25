import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { createSettingsStore } from '../src/core/settings.mjs';
import {
  createAppUpdater,
  detectInstallContext,
  isAllowedUpdateUrl,
  selectUpdatePackage
} from '../src/host/app-updater.mjs';
import { startDaemon } from '../src/host/daemon.mjs';
import { buildFallbackHtml } from '../src/ui/fallback-page.mjs';

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function makeFakeReleaseDir(root, { installMode = 'installed', withRuntime = true } = {}) {
  const appRoot = join(root, 'app');
  mkdirSync(join(appRoot, 'bin'), { recursive: true });
  writeFileSync(join(appRoot, 'bin', 't3tools.mjs'), 'console.log("v0.1.0");\n', 'utf8');
  writeFileSync(join(root, 'T3Tools.exe'), 'fake-exe-v0.1.0', 'utf8');
  writeFileSync(join(root, 'release.json'), JSON.stringify({
    version: '0.1.0',
    channel: 'stable',
    installMode,
    minNodeVersion: '22.13.0'
  }), 'utf8');
  if (withRuntime) {
    mkdirSync(join(root, 'runtime'), { recursive: true });
    writeFileSync(join(root, 'runtime', 'node.exe'), 'bundled-node-marker', 'utf8');
  }
  return appRoot;
}

test('isAllowedUpdateUrl, detectInstallContext and selectUpdatePackage enforce safety & delta selection', () => {
  assert.equal(isAllowedUpdateUrl('https://github.com/LionKo/t3tools/releases/latest/download/latest.json'), true);
  assert.equal(isAllowedUpdateUrl('https://objects.githubusercontent.com/some/asset.zip'), true);
  assert.equal(isAllowedUpdateUrl('http://github.com/LionKo/t3tools/releases/latest/download/latest.json'), false);
  assert.equal(isAllowedUpdateUrl('https://evil.example.com/latest.json'), false);

  const tmp = mkdtempSync(join(tmpdir(), 't3tools-upd-ctx-'));
  try {
    // Dev checkout with .git must disallow auto-update
    const devDir = join(tmp, 'dev-repo');
    mkdirSync(join(devDir, '.git'), { recursive: true });
    const devCtx = detectInstallContext({ appRoot: devDir });
    assert.equal(devCtx.mode, 'dev');
    assert.equal(devCtx.canAutoUpdate, false);

    // Standard Release layout enables auto-update
    const relRoot = join(tmp, 'installed');
    const appRoot = makeFakeReleaseDir(relRoot, { installMode: 'installed' });
    const relCtx = detectInstallContext({ appRoot });
    assert.equal(relCtx.mode, 'installed');
    assert.equal(relCtx.canAutoUpdate, true);
    assert.equal(relCtx.hasBundledNode, true);
    assert.equal(relCtx.installDir, relRoot);

    const shaA = 'a'.repeat(64);
    const shaB = 'b'.repeat(64);
    const manifest = {
      version: '0.2.0',
      minNodeVersion: '22.16.0',
      appPackage: { url: 'https://github.com/LionKo/t3tools/releases/download/v0.2.0/T3Tools-v0.2.0-app.zip', sha256: shaA, size: 204800 },
      fullPackage: { url: 'https://github.com/LionKo/t3tools/releases/download/v0.2.0/T3Tools-v0.2.0-win-x64-portable.zip', sha256: shaB, size: 35000000 }
    };
    assert.equal(selectUpdatePackage(manifest, { currentNodeVersion: '22.16.0' })?.kind, 'app');
    assert.equal(selectUpdatePackage(manifest, { currentNodeVersion: '22.13.0' })?.kind, 'full');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('createAppUpdater checks GitHub manifest, downloads & verifies SHA-256, rejects tampered hash, and skips versions', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 't3tools-upd-flow-'));
  try {
    const relRoot = join(tmp, 'T3Tools');
    const appRoot = makeFakeReleaseDir(relRoot, { installMode: 'installed' });
    const dataDir = join(tmp, '.t3tools');
    const settings = createSettingsStore(join(dataDir, 'settings.json'));

    const zipBytes = Buffer.from('PK\x03\x04mock-zip-content-v0.2.0');
    const validSha = sha256Hex(zipBytes);
    let serveTampered = false;

    const manifestPayload = {
      version: '0.2.0',
      publishedAt: '2026-11-26T00:00:00Z',
      minNodeVersion: '22.13.0',
      notes: '- 自动更新测试版本',
      appPackage: {
        url: 'https://github.com/LionKo/t3tools/releases/download/v0.2.0/T3Tools-v0.2.0-app.zip',
        sha256: validSha,
        size: zipBytes.length
      }
    };

    const fakeFetch = async url => {
      if (url.endsWith('/latest.json')) {
        return {
          ok: true,
          status: 200,
          url,
          json: async () => manifestPayload
        };
      }
      const payload = serveTampered ? Buffer.from('corrupted-bytes') : zipBytes;
      return {
        ok: true,
        status: 200,
        url: 'https://objects.githubusercontent.com/t3tools/T3Tools-v0.2.0-app.zip',
        headers: new Headers({ 'content-length': String(payload.length) }),
        arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
      };
    };

    const updater = createAppUpdater({
      currentVersion: '0.1.0',
      settings,
      paths: { pluginDataDir: dataDir },
      appRoot,
      fetchImpl: fakeFetch,
      enableBackgroundCheck: false,
      nodeVersion: '22.16.0'
    });

    const checked = await updater.checkForUpdates({ force: true });
    assert.equal(checked.hasUpdate, true);
    assert.equal(checked.latestVersion, '0.2.0');
    assert.equal(checked.status, 'available');
    assert.equal(checked.packageKind, 'app');

    // 1. Skip version persists cleanly
    const skipped = updater.skipVersion('0.2.0');
    assert.equal(skipped.isSkipped, true);
    assert.equal(settings.get().appUpdates.skippedVersion, '0.2.0');

    // 2. Tampered download must fail SHA-256 verification
    serveTampered = true;
    const badStart = await updater.startInstall();
    assert.equal(badStart.ok, true);
    const badResult = await updater.waitForInstall();
    assert.equal(badResult.status, 'error');
    assert.match(badResult.lastError, /SHA-256/);
    assert.equal(badResult.applyRequestedAtMs, null);

    // 3. Valid download stages zip + pending-update.json and signals ready
    serveTampered = false;
    const goodStart = await updater.startInstall();
    assert.equal(goodStart.ok, true);
    const goodResult = await updater.waitForInstall();
    assert.equal(goodResult.status, 'ready');
    assert.equal(goodResult.progressPercent, 100);
    assert.equal(goodResult.stagedSha256, validSha);
    assert.ok(goodResult.applyRequestedAtMs > 0);
    assert.equal(existsSync(goodResult.stagedZipPath), true);
    assert.equal(existsSync(join(relRoot, '_staging', 'pending-update.json')), true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Daemon exposes /api/status, /api/live appUpdate and guards /api/app-update/* mutations; UI renders update banners', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 't3tools-upd-daemon-'));
  const relRoot = join(tmp, 'T3Tools');
  const appRoot = makeFakeReleaseDir(relRoot, { installMode: 'installed' });
  const zipBytes = Buffer.from('PK\x03\x04daemon-zip');
  const fakeFetch = async url => ({
    ok: true,
    status: 200,
    url,
    json: async () => ({
      version: '9.9.9',
      publishedAt: '2026-11-26T00:00:00Z',
      minNodeVersion: '22.13.0',
      notes: '- 集成测试版本',
      appPackage: {
        url: 'https://github.com/LionKo/t3tools/releases/download/v9.9.9/T3Tools-v9.9.9-app.zip',
        sha256: sha256Hex(zipBytes),
        size: zipBytes.length
      }
    })
  });

  const daemon = await startDaemon({
    pathOverrides: {
      home: tmp,
      appData: join(tmp, 'AppData', 'Roaming'),
      localAppData: join(tmp, 'AppData', 'Local'),
      t3Root: join(tmp, '.t3'),
      pluginDataDir: join(tmp, '.t3tools')
    },
    portOverride: 0,
    enableCdp: false,
    fetchImpl: fakeFetch,
    enableRemoteUpdateCheck: false,
    enableAppUpdateCheck: false,
    appUpdateOptions: { appRoot, nodeVersion: '22.16.0' }
  });

  try {
    // Reject unauthorized mutation
    const unauth = await fetch(`${daemon.url}/api/app-update/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(unauth.status, 401);

    // Authorized check discovers v9.9.9
    const checkRes = await fetch(`${daemon.url}/api/app-update/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-T3Tools-Token': daemon.authToken },
      body: '{}'
    });
    assert.equal(checkRes.status, 200);
    const checkJson = await checkRes.json();
    assert.equal(checkJson.ok, true);
    assert.equal(checkJson.data.hasUpdate, true);
    assert.equal(checkJson.data.latestVersion, '9.9.9');

    // /api/status and /api/live both expose appUpdate
    const [stRes, liveRes] = await Promise.all([
      fetch(`${daemon.url}/api/status`).then(r => r.json()),
      fetch(`${daemon.url}/api/live`).then(r => r.json())
    ]);
    assert.equal(stRes.data.appUpdate.latestVersion, '9.9.9');
    assert.equal(liveRes.data.appUpdate.latestVersion, '9.9.9');

    // Fallback HTML includes update banner & settings controls with valid JS
    const html = buildFallbackHtml({ version: '0.1.0', authToken: daemon.authToken });
    assert.match(html, /id="pt-app-update-banner"/);
    assert.match(html, /data-pt-action="install-app-update"/);
    assert.match(html, /data-app-update-setting="autoCheck"/);

    // Shared sidebar renderer displays clickable app update pill
    const sharedSrc = readFileSync(new URL('../src/ui/shared-views.js', import.meta.url), 'utf8');
    const sandbox = {};
    vm.runInNewContext(`${sharedSrc}\nglobalThis.renderSidebarTriggerHtml = renderSidebarTriggerHtml;`, sandbox);
    const sidebarHtml = sandbox.renderSidebarTriggerHtml(
      { appUpdate: stRes.data.appUpdate, settings: { sidebarUsageRange: 'today' } },
      { status: 'attached' }
    );
    assert.match(sidebarHtml, /data-pt-app-update="9\.9\.9"/);
    assert.match(sidebarHtml, /data-pt-action="install-app-update"/);
  } finally {
    await daemon.stop('test done');
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('compiled T3Tools.exe --apply-update performs atomic delta swap, preserves runtime/installMode, and rolls back on bad package', {
  skip: process.platform !== 'win32'
}, () => {
  const tmp = mkdtempSync(join(tmpdir(), 't3tools-native-swap-'));
  try {
    const compiledExe = join(tmp, 'built', 'T3Tools.exe');
    const buildRes = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(process.cwd(), 'scripts', 'build-tray.ps1'), '-OutExe', compiledExe, '-Version', '0.2.0'],
      { encoding: 'utf8', windowsHide: true, timeout: 45000 }
    );
    assert.equal(buildRes.status, 0, `build-tray.ps1 failed: ${buildRes.stderr || buildRes.stdout}`);
    assert.equal(existsSync(compiledExe), true);

    const installDir = join(tmp, 'install');
    const dataDir = join(tmp, 'userdata');
    makeFakeReleaseDir(installDir, { installMode: 'portable', withRuntime: true });

    // Build a valid v0.2.0 delta app zip (no runtime/ inside -> existing runtime/ must stay untouched)
    const zipSrc = join(tmp, 'zip_src');
    mkdirSync(join(zipSrc, 'app', 'bin'), { recursive: true });
    writeFileSync(join(zipSrc, 'app', 'bin', 't3tools.mjs'), 'console.log("v0.2.0-updated");\n', 'utf8');
    writeFileSync(join(zipSrc, 'T3Tools.exe'), readFileSync(compiledExe));
    writeFileSync(join(zipSrc, 'release.json'), JSON.stringify({
      version: '0.2.0',
      channel: 'stable',
      installMode: 'installed',
      minNodeVersion: '22.13.0'
    }), 'utf8');

    const stagingDir = join(installDir, '_staging');
    mkdirSync(stagingDir, { recursive: true });
    const zipPath = join(stagingDir, 'T3Tools-v0.2.0-app.zip');
    const zipPs = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${zipSrc.replaceAll("'", "''")}', '${zipPath.replaceAll("'", "''")}')`;
    const zipRes = spawnSync('powershell.exe', ['-NoProfile', '-Command', zipPs], { encoding: 'utf8', windowsHide: true });
    assert.equal(zipRes.status, 0, zipRes.stderr);

    const validSha = sha256Hex(readFileSync(zipPath));
    const updaterCopy = join(tmp, 'T3Tools-updater-test.exe');
    writeFileSync(updaterCopy, readFileSync(compiledExe));

    // 1. Bad SHA-256 must fail cleanly and leave v0.1.0 untouched
    const badSwap = spawnSync(
      updaterCopy,
      ['--apply-update', '--pid', '0', '--zip', zipPath, '--sha256', '0'.repeat(64), '--dst', installDir, '--from-version', '0.1.0', '--to-version', '0.2.0', '--no-relaunch'],
      { encoding: 'utf8', windowsHide: true, env: { ...process.env, T3TOOLS_DIR: dataDir } }
    );
    assert.notEqual(badSwap.status, 0);
    assert.match(readFileSync(join(installDir, 'app', 'bin', 't3tools.mjs'), 'utf8'), /v0\.1\.0/);
    assert.equal(existsSync(join(dataDir, 'last-update-error.json')), true);

    // 2. Valid SHA-256 performs atomic swap, preserves runtime/node.exe and portable installMode, cleans _staging
    const okSwap = spawnSync(
      updaterCopy,
      ['--apply-update', '--pid', '0', '--zip', zipPath, '--sha256', validSha, '--dst', installDir, '--from-version', '0.1.0', '--to-version', '0.2.0', '--no-relaunch'],
      { encoding: 'utf8', windowsHide: true, env: { ...process.env, T3TOOLS_DIR: dataDir } }
    );
    assert.equal(okSwap.status, 0, `native updater failed: ${okSwap.stderr || okSwap.stdout}`);
    assert.match(readFileSync(join(installDir, 'app', 'bin', 't3tools.mjs'), 'utf8'), /v0\.2\.0-updated/);
    assert.equal(readFileSync(join(installDir, 'runtime', 'node.exe'), 'utf8'), 'bundled-node-marker');
    const nextRelease = JSON.parse(readFileSync(join(installDir, 'release.json'), 'utf8'));
    assert.equal(nextRelease.version, '0.2.0');
    assert.equal(nextRelease.installMode, 'portable');
    assert.equal(existsSync(stagingDir), false);
    const justUpdated = JSON.parse(readFileSync(join(dataDir, 'just-updated.json'), 'utf8'));
    assert.equal(justUpdated.fromVersion, '0.1.0');
    assert.equal(justUpdated.toVersion, '0.2.0');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
