import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_SETTINGS = {
  enabled: true,
  port: 17373,
  theme: 'dark',
  autoPatchLauncher: true,
  autoAttachT3: true,
  minimizeToTray: true,
  startMinimizedToTray: false,
  launchOnStartup: false,
  showComposerBar: true,
  showOverviewCard: true,
  overviewMode: 'adaptive',
  overviewCollapsed: false,
  overviewPosition: { right: 18, top: 56 },
  defaultRangePreset: 'weeklyQuota',
  sidebarUsageRange: 'today',
  pollIntervalMs: 2500,
  alertConfig: { enabled: true, desktopNotification: true, injectedBanner: false, mode: 'smart',
    burstThreshold: 2, burstWindowMs: 300000, cooldownMs: 120000 },
  appUpdates: {
    autoCheck: true,
    skippedVersion: ''
  },
  anomalyConfig: {
    maxGapMs: 180000,
    minPrevCache: 4000,
    minPrevHit: 50,
    minCurInput: 4000,
    minMissedInput: 16000,
    minKeepRatio: 0.6
  }
};

const VALID_PRESETS = new Set(['weeklyQuota', 'today', '24h', 'week', '7d', '30d', 'all']);
const VALID_THEMES = new Set(['dark', 'light']);
const VALID_OVERVIEW_MODES = new Set(['adaptive', 'avoid', 'fixed']);

function clampInt(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function clampFloat(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Strictly validate and whitelist settings patches (rejects prototype pollution,
 * unknown fields, and out-of-range numeric values).
 */
export function sanitizeSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('配置格式必须为 JSON 对象');
  }
  const clean = {};
  for (const boolKey of [
    'enabled',
    'autoPatchLauncher',
    'autoAttachT3',
    'minimizeToTray',
    'startMinimizedToTray',
    'launchOnStartup',
    'showComposerBar',
    'showOverviewCard',
    'overviewCollapsed'
  ]) {
    if (Object.prototype.hasOwnProperty.call(patch, boolKey)) {
      if (typeof patch[boolKey] !== 'boolean') throw new Error(`${boolKey} 必须为布尔值`);
      clean[boolKey] = patch[boolKey];
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'port')) {
    const p = Number(patch.port);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('port 必须为 1024-65535 的整数');
    clean.port = p;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'pollIntervalMs')) {
    clean.pollIntervalMs = clampInt(patch.pollIntervalMs, 1000, 30000, DEFAULT_SETTINGS.pollIntervalMs);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'defaultRangePreset')) {
    if (!VALID_PRESETS.has(patch.defaultRangePreset)) throw new Error('不支持的 defaultRangePreset');
    clean.defaultRangePreset = patch.defaultRangePreset;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'sidebarUsageRange')) {
    if (!VALID_PRESETS.has(patch.sidebarUsageRange)) throw new Error('不支持的 sidebarUsageRange');
    clean.sidebarUsageRange = patch.sidebarUsageRange;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'theme')) {
    if (!VALID_THEMES.has(patch.theme)) throw new Error('theme 必须为 dark 或 light');
    clean.theme = patch.theme;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'overviewMode')) {
    if (!VALID_OVERVIEW_MODES.has(patch.overviewMode)) throw new Error('overviewMode 必须为 adaptive、avoid 或 fixed');
    clean.overviewMode = patch.overviewMode;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'overviewPosition')) {
    const pos = patch.overviewPosition;
    if (!pos || typeof pos !== 'object' || Array.isArray(pos)) throw new Error('overviewPosition 必须为对象');
    clean.overviewPosition = {};
    if (Object.prototype.hasOwnProperty.call(pos, 'right')) clean.overviewPosition.right = clampInt(pos.right, 0, 2000, 18);
    if (Object.prototype.hasOwnProperty.call(pos, 'top')) clean.overviewPosition.top = clampInt(pos.top, 0, 2000, 56);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'anomalyConfig')) {
    const ac = patch.anomalyConfig;
    if (!ac || typeof ac !== 'object' || Array.isArray(ac)) throw new Error('anomalyConfig 必须为对象');
    clean.anomalyConfig = {};
    if (Object.prototype.hasOwnProperty.call(ac, 'maxGapMs')) clean.anomalyConfig.maxGapMs = clampInt(ac.maxGapMs, 5000, 1800000, 180000);
    if (Object.prototype.hasOwnProperty.call(ac, 'minPrevCache')) clean.anomalyConfig.minPrevCache = clampInt(ac.minPrevCache, 0, 1000000, 4000);
    if (Object.prototype.hasOwnProperty.call(ac, 'minPrevHit')) clean.anomalyConfig.minPrevHit = clampFloat(ac.minPrevHit, 0, 100, 50);
    if (Object.prototype.hasOwnProperty.call(ac, 'minCurInput')) clean.anomalyConfig.minCurInput = clampInt(ac.minCurInput, 0, 1000000, 4000);
    if (Object.prototype.hasOwnProperty.call(ac, 'minMissedInput')) clean.anomalyConfig.minMissedInput = clampInt(ac.minMissedInput, 0, 1000000, 16000);
    if (Object.prototype.hasOwnProperty.call(ac, 'minKeepRatio')) clean.anomalyConfig.minKeepRatio = clampFloat(ac.minKeepRatio, 0.1, 1, 0.6);
  }
  if (Object.hasOwn(patch, 'alertConfig')) {
    const config = patch.alertConfig;
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('alertConfig 必须为对象');
    const cleanConfig = {};
    for (const key of ['enabled', 'desktopNotification', 'injectedBanner']) {
      if (!Object.hasOwn(config, key)) continue;
      if (typeof config[key] !== 'boolean') throw new Error(key + ' 必须为布尔值');
      cleanConfig[key] = config[key];
    }
    if (Object.hasOwn(config, 'mode')) {
      if (!['smart','every','quiet'].includes(config.mode)) throw new Error('告警模式无效');
      cleanConfig.mode = config.mode;
    }
    for (const [key, min, max] of [['burstThreshold',1,20], ['burstWindowMs',60000,1800000], ['cooldownMs',15000,1800000]]) {
      if (!Object.hasOwn(config,key)) continue;
      if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(key + ' 数值无效');
      cleanConfig[key] = config[key];
    }
    clean.alertConfig = cleanConfig;
  }
  if (Object.hasOwn(patch, 'appUpdates')) {
    const au = patch.appUpdates;
    if (!au || typeof au !== 'object' || Array.isArray(au)) throw new Error('appUpdates 必须为对象');
    const cleanUpdates = {};
    if (Object.hasOwn(au, 'autoCheck')) {
      if (typeof au.autoCheck !== 'boolean') throw new Error('autoCheck 必须为布尔值');
      cleanUpdates.autoCheck = au.autoCheck;
    }
    if (Object.hasOwn(au, 'skippedVersion')) {
      if (typeof au.skippedVersion !== 'string') throw new Error('skippedVersion 必须为字符串');
      const trimmed = au.skippedVersion.trim().replace(/^v/i, '');
      if (trimmed && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(trimmed)) {
        throw new Error('skippedVersion 版本号格式无效');
      }
      cleanUpdates.skippedVersion = trimmed;
    }
    clean.appUpdates = cleanUpdates;
  }
  return clean;
}

function mergeSettings(base, rawPatch) {
  const safePatch = {};
  for (const key of Object.keys(base)) {
    if (!rawPatch || !Object.hasOwn(rawPatch, key)) continue;
    const value = rawPatch[key];
    if (base[key] && typeof base[key] === 'object' && value && typeof value === 'object') {
      for (const field of Object.keys(base[key])) {
        if (!Object.hasOwn(value, field)) continue;
        try {
          Object.assign(safePatch[key] ??= {}, sanitizeSettingsPatch({ [key]: { [field]: value[field] } })[key]);
        } catch { /* Preserve the default for this field. */ }
      }
    } else {
      try { Object.assign(safePatch, sanitizeSettingsPatch({ [key]: value })); } catch {}
    }
  }
  return {
    ...base,
    ...safePatch,
    alertConfig: { ...base.alertConfig, ...safePatch.alertConfig },
    appUpdates: { ...base.appUpdates, ...(safePatch.appUpdates || {}) },
    overviewPosition: {
      ...base.overviewPosition,
      ...(safePatch.overviewPosition || {})
    },
    anomalyConfig: {
      ...base.anomalyConfig,
      ...(safePatch.anomalyConfig || {})
    }
  };
}

export function atomicWriteJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(value, null, 2) + '\n', 'utf8');
    renameSync(tempPath, filePath);
  } finally {
    try { unlinkSync(tempPath); } catch {}
  }
}

export function createSettingsStore(filePath) {
  let current = mergeSettings(DEFAULT_SETTINGS, {});

  function load() {
    if (!existsSync(filePath)) {
      current = mergeSettings(DEFAULT_SETTINGS, {});
      return current;
    }
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      current = mergeSettings(DEFAULT_SETTINGS, parsed);
    } catch {
      current = mergeSettings(DEFAULT_SETTINGS, {});
    }
    return current;
  }

  function get() {
    return load();
  }

  function update(patch) {
    const validated = sanitizeSettingsPatch(patch);
    const next = mergeSettings(load(), validated);
    atomicWriteJson(filePath, next);
    current = next;
    return current;
  }

  load();
  return { get, update };
}
