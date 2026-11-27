import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export function resolvePaths(overrides = {}) {
  const home = resolve(overrides.home || process.env.USERPROFILE || homedir());
  const appData = resolve(overrides.appData || process.env.APPDATA || join(home, 'AppData', 'Roaming'));
  const localAppData = resolve(overrides.localAppData || process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'));

  const t3Root = resolve(overrides.t3Root || process.env.T3_DATA_DIR || join(home, '.t3'));
  const t3UserData = join(t3Root, 'userdata');
  const t3Caches = join(t3Root, 'caches');
  const t3ProvidersDir = join(t3UserData, 'providers');
  const t3AntigravityProvidersDir = join(t3ProvidersDir, 'antigravity');

  const electronUserDataCandidates = [
    overrides.electronUserData,
    process.env.T3_ELECTRON_USERDATA,
    join(appData, 't3code-v2'),
    join(appData, 'T3 Code (Nightly)'),
    join(appData, 'T3 Code'),
    join(appData, 't3code')
  ].filter(Boolean);

  const electronUserData = electronUserDataCandidates.find(p => existsSync(p)) || electronUserDataCandidates[0];
  const devToolsPortFile = join(electronUserData, 'DevToolsActivePort');

  const pluginDataDir = resolve(overrides.pluginDataDir || process.env.T3TOOLS_DIR || join(home, '.t3tools'));
  const codexHome = resolve(overrides.codexHome || process.env.CODEX_HOME || join(home, '.codex'));
  const codexSessionsDir = resolve(overrides.codexSessionsDir || join(codexHome, 'sessions'));
  const codexArchivedSessionsDir = resolve(
    overrides.codexArchivedSessionsDir ||
    (overrides.codexSessionsDir ? join(dirname(codexSessionsDir), 'archived_sessions') : join(codexHome, 'archived_sessions'))
  );
  const claudeProjectsDir = resolve(overrides.claudeProjectsDir || join(home, '.claude', 'projects'));

  const t3InstallCandidates = [
    overrides.t3InstallDir,
    join(localAppData, 'Programs', 't3code'),
    join(localAppData, 'Programs', 'T3 Code'),
    join(localAppData, 'Programs', 'T3 Code (Nightly)')
  ].filter(Boolean);
  const t3InstallDir = t3InstallCandidates.find(p => existsSync(p)) || t3InstallCandidates[0];

  return {
    home,
    appData,
    localAppData,
    t3Root,
    t3UserData,
    t3Caches,
    t3ProvidersDir,
    t3AntigravityProvidersDir,
    stateDbPath: join(t3UserData, 'statev2.sqlite'),
    settingsPath: join(t3UserData, 'settings.json'),
    serverRuntimePath: join(t3UserData, 'server-runtime.json'),
    modelRatesPath: join(t3UserData, 'usage-model-rates.json'),
    t3LogsDir: join(t3UserData, 'logs'),
    electronUserData,
    electronUserDataCandidates,
    devToolsPortFile,
    t3InstallDir,
    codexHome,
    codexSessionsDir,
    codexArchivedSessionsDir,
    claudeProjectsDir,
    pluginDataDir,
    pluginSettingsPath: join(pluginDataDir, 'settings.json'),
    telemetryDbPath: join(pluginDataDir, 'telemetry.sqlite'),
    runtimeFilePath: join(pluginDataDir, 'runtime.json'),
    launcherBackupPath: join(pluginDataDir, 'launcher-backup.json'),
    privacyEnvBackupPath: join(pluginDataDir, 'privacy-env-backup.json'),
    launcherVbsPath: join(pluginDataDir, 'launch-t3.vbs'),
    trayExePath: join(pluginDataDir, 'T3Tools.exe'),
    trayConfigPath: join(pluginDataDir, 'tray-config.json')
  };
}

/**
 * T3 Code maps each Antigravity providerInstanceId (e.g. "work", "antigravity")
 * to ~/.t3/userdata/providers/antigravity/<sha256(instanceId)>/antigravity-acp
 */
export function antigravityInstanceHash(instanceId) {
  return createHash('sha256').update(String(instanceId || '')).digest('hex');
}

/**
 * Dynamically locate the latest usage-scan-cache-v*.json file in T3 Code userdata
 * so T3 Code schema version bumps (v17 -> v18 -> ...) never break the plugin.
 */
export function findLatestUsageScanCache(t3UserData) {
  if (!t3UserData || !existsSync(t3UserData)) return null;
  let best = null;
  try {
    for (const name of readdirSync(t3UserData)) {
      const m = name.match(/^usage-scan-cache-v(\d+)\.json$/i);
      if (!m) continue;
      const version = Number(m[1]);
      if (!best || version > best.version) {
        best = { version, path: join(t3UserData, name) };
      }
    }
  } catch {
    return null;
  }
  return best;
}
