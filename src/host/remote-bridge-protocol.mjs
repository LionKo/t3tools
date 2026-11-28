import { isIP, BlockList } from 'node:net';

export const REMOTE_BRIDGE_PROTOCOL_VERSION = 1;
export const PAIRING_CODE_PREFIX = 't3bridge://v1/';
export const isValidEnvironmentId = (value) =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) && !/\s/.test(value);
export const isValidThreadId = isValidEnvironmentId;
const validToken = (value) =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) && value.length === 64;

function requireValid(condition) {
  if (!condition) throw new Error('Invalid bridge configuration');
}

const blocked = new BlockList();
for (const [ip, bits] of [
  ['0.0.0.0', 8],
  ['169.254.0.0', 16],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
])
  blocked.addSubnet(ip, bits);
for (const [ip, bits] of [
  ['::', 96],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['2001::', 32]
])
  blocked.addSubnet(ip, bits, 'ipv6');
blocked.addAddress('100.100.100.200');
blocked.addAddress('168.63.129.16');
blocked.addAddress('fd00:ec2::254', 'ipv6');
const routableV6 = new BlockList();
routableV6.addSubnet('2000::', 3, 'ipv6');
routableV6.addSubnet('fc00::', 7, 'ipv6');
routableV6.addSubnet('::ffff:0:0', 96, 'ipv6');
const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8);
loopback.addAddress('::1', 'ipv6');

export function isAllowedResolvedIp(ip, { allowLoopbackTunnel = false } = {}) {
  const version = isIP(ip);
  if (!version || ip.includes('%')) return false;
  const family = version === 4 ? 'ipv4' : 'ipv6';
  if (loopback.check(ip, family)) return allowLoopbackTunnel === true;
  return !blocked.check(ip, family) && (version === 4 || routableV6.check(ip, family));
}

export function validateRemoteOrigin(rawUrl, { allowLoopbackTunnel = false, blockedPorts = [] } = {}) {
  requireValid(
    typeof rawUrl === 'string' && rawUrl.length <= 512 && /^https?:\/\/[^/\\@?#%\s]+\/?$/i.test(rawUrl)
  );
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    requireValid(false);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  requireValid(port > 0);
  if (isIP(host)) {
    requireValid(isAllowedResolvedIp(host, { allowLoopbackTunnel }));
    if (!isAllowedResolvedIp(host)) requireValid(!blockedPorts.includes(port));
  } else if (/(^|\.)localhost\.?$/i.test(host)) {
    requireValid(allowLoopbackTunnel === true && !blockedPorts.includes(port));
  }
  return url.origin;
}

function keys(obj, allowed) {
  requireValid(
    obj &&
      typeof obj === 'object' &&
      !Array.isArray(obj) &&
      Object.keys(obj).every((k) => allowed.includes(k))
  );
}
function label(s) {
  requireValid(typeof s === 'string' && s.length <= 64 && !/[\x00-\x1f\x7f]/.test(s));
  return s;
}
function pairing(p) {
  keys(p, ['v', 'environmentId', 'label', 'url', 'token']);
  requireValid(p.v === 1 && isValidEnvironmentId(p.environmentId) && validToken(p.token));
  requireValid(
    [p.environmentId, p.label, p.url].every((value) => typeof value === 'string' && !value.includes(p.token))
  );
  return {
    v: 1,
    environmentId: p.environmentId,
    label: label(p.label),
    url: validateRemoteOrigin(p.url, { allowLoopbackTunnel: true }),
    token: p.token
  };
}
export function encodePairingCode(data) {
  return PAIRING_CODE_PREFIX + Buffer.from(JSON.stringify(pairing(data))).toString('base64url');
}
export function decodePairingCode(code) {
  try {
    requireValid(typeof code === 'string' && code.length <= 2048 && code.startsWith(PAIRING_CODE_PREFIX));
    const encoded = code.slice(PAIRING_CODE_PREFIX.length);
    const data = Buffer.from(encoded, 'base64url');
    requireValid(data.toString('base64url') === encoded);
    return pairing(JSON.parse(data.toString()));
  } catch {
    throw new Error('Invalid pairing code');
  }
}

export function sanitizeBridgeConfig(config) {
  keys(config, ['server', 'peers']);
  const out = {};
  if (Object.hasOwn(config, 'server')) {
    const s = config.server;
    keys(s, ['enabled', 'port', 'bindMode', 'bindHost', 'advertiseUrl', 'machineLabel']);
    if ('enabled' in s) requireValid(typeof s.enabled === 'boolean');
    if ('port' in s) requireValid(Number.isInteger(s.port) && s.port >= 1024 && s.port <= 65535);
    if ('bindMode' in s) requireValid(['tailscale', 'lan', 'all', 'custom'].includes(s.bindMode));
    if ('bindHost' in s) requireValid(s.bindHost === '' || isIP(s.bindHost));
    if ('machineLabel' in s) label(s.machineLabel);
    out.server = { ...s };
    if ('advertiseUrl' in s && s.advertiseUrl !== '')
      out.server.advertiseUrl = validateRemoteOrigin(s.advertiseUrl, { allowLoopbackTunnel: true });
  }
  if (Object.hasOwn(config, 'peers')) {
    const ids = new Set(),
      envs = new Set();
    requireValid(Array.isArray(config.peers) && config.peers.length <= 128);
    out.peers = config.peers.map((p) => {
      keys(p, [
        'id',
        'environmentId',
        'label',
        'url',
        'enabled',
        'allowLoopbackTunnel',
        'verified',
        'lastVerifiedAtMs'
      ]);
      requireValid(
        isValidEnvironmentId(p.id) &&
          isValidEnvironmentId(p.environmentId) &&
          !ids.has(p.id) &&
          !envs.has(p.environmentId)
      );
      ids.add(p.id);
      envs.add(p.environmentId);
      requireValid([p.enabled, p.allowLoopbackTunnel, p.verified].every((v) => typeof v === 'boolean'));
      requireValid(
        p.lastVerifiedAtMs === null || (Number.isSafeInteger(p.lastVerifiedAtMs) && p.lastVerifiedAtMs >= 0)
      );
      return { ...p, label: label(p.label), url: validateRemoteOrigin(p.url, p) };
    });
  }
  return out;
}

function fields(source, strings, numbers = '', bools = '') {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const out = {};
  for (const k of strings.split(' ').filter(Boolean))
    if (typeof source[k] === 'string') out[k] = source[k].replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 256);
  for (const k of numbers.split(' ').filter(Boolean))
    if (source[k] === null || Number.isFinite(source[k])) out[k] = source[k];
  for (const k of bools.split(' ').filter(Boolean)) if (typeof source[k] === 'boolean') out[k] = source[k];
  return out;
}
function list(rows, fn) {
  return Array.isArray(rows) ? rows.slice(0, 256).map(fn).filter(Boolean) : [];
}
export function buildSanitizedRemoteLivePayload(s, { environmentId, machineLabel, requestedThreadId }) {
  const t = s.thread;
  requireValid(
    t &&
      t.threadId === requestedThreadId &&
      !t.unresolved &&
      isValidThreadId(requestedThreadId) &&
      isValidEnvironmentId(environmentId)
  );
  const thread = fields(
    t,
    'reason threadId title accountId selectedModel phase phaseLabel',
    'queuedRuns totalSteps',
    'unresolved'
  );
  thread.run = fields(t.run, 'runId status', 'ordinal startedAtMs completedAtMs durationMs');
  thread.steps = list(t.steps, (step) => {
    const out = fields(
      step,
      'id type status phase phaseLabel title',
      'ordinal startedAtMs completedAtMs updatedAtMs durationMs'
    );
    if (out?.type === 'command_execution') out.title = 'Command execution';
    return out;
  });
  const accountId = thread.accountId || '';
  const context =
    s.context?.accountId && s.context.accountId !== accountId
      ? null
      : fields(
          s.context,
          'providerDriver modelRaw modelId tpsKind',
          'usedTokens maxTokens usedPercent compactions cacheReadTokens inputTokens outputTokens cacheHitPercent ttftMs ttftSamples streamingMs durationMs decodeSpeed decodeSamples callTps outputThroughput throughputSamples tps liveTps lastRequestAtMs cacheWindowMs cacheAgeMs cacheRemainingMs',
          'tpsEstimated liveStreaming stale'
        );
  if (context)
    Object.assign(context, {
      accountId,
      categories: list(s.context.categories, (c) => fields(c, 'label', 'tokens'))
    });
  const group = accountId && s.quotas?.groups?.find((g) => g?.accountId === accountId);
  const groups = group
    ? [
        {
          ...fields(group, 'accountId displayName driver'),
          resetCredits: fields(group.resetCredits, '', 'availableCount nextExpiresAtMs'),
          windows: list(group.windows, (w) =>
            fields(
              w,
              'label windowId poolKey poolLabel windowTag kind',
              'usedPercent remainingPercent resetsAtMs remainingTimeMs windowDurationMins observedAtMs',
              'isExpired isIdleFull'
            )
          )
        }
      ]
    : [];
  return {
    protocolVersion: 1,
    environmentId,
    machineLabel: label(machineLabel),
    requestedThreadId,
    updatedAtMs: Number.isFinite(s.updatedAtMs) ? s.updatedAtMs : null,
    thread,
    context,
    quotas: {
      updatedAtMs: Number.isFinite(s.quotas?.updatedAtMs) ? s.quotas.updatedAtMs : null,
      groups,
      flatWindows: []
    },
    threadErrors: list(s.threadErrors, (e) =>
      fields(e, 'id errorCode modelId status', 'timestampMs retries', 'resolved')
    )
  };
}

export function validateRemoteLivePayload(raw, { expectedEnvironmentId, expectedThreadId }) {
  if (raw?.protocolVersion !== 1) throw new Error('incompatible');
  if (
    raw.environmentId !== expectedEnvironmentId ||
    raw.requestedThreadId !== expectedThreadId ||
    raw.thread?.threadId !== expectedThreadId
  )
    throw new Error('identityMismatch');
  if (
    !Number.isFinite(raw.updatedAtMs) ||
    !Array.isArray(raw.quotas?.groups) ||
    !Array.isArray(raw.threadErrors)
  )
    throw new Error('incompatible');
  try {
    return buildSanitizedRemoteLivePayload(raw, {
      environmentId: expectedEnvironmentId,
      machineLabel: raw.machineLabel,
      requestedThreadId: expectedThreadId
    });
  } catch {
    throw new Error('incompatible');
  }
}
