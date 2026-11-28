import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { networkInterfaces as interfaces, hostname as osHostname } from 'node:os';
import { isIP } from 'node:net';
import { createHash, randomBytes as bytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import {
  buildSanitizedRemoteLivePayload,
  validateRemoteLivePayload,
  encodePairingCode,
  decodePairingCode,
  isValidEnvironmentId,
  isValidThreadId,
  validateRemoteOrigin,
  isAllowedResolvedIp,
  sanitizeBridgeConfig
} from './remote-bridge-protocol.mjs';

const delays = [2000, 5000, 15000, 30000];
const digest = (s) => createHash('sha256').update(s).digest();
const fail = (status) => {
  throw new Error(status);
};
const permanent = new Set(['unauthorized', 'identityMismatch', 'incompatible']);
const validSecret = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s) && s.length === 64;

function cleanLabelCandidate(raw) {
  const text = String(raw || '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim()
    .slice(0, 64);
  return text;
}

function pickTailscaleNodeName(node) {
  if (!node || typeof node !== 'object') return '';
  const host = cleanLabelCandidate(node.HostName);
  if (host && !/^localhost(?:\.localdomain)?$/i.test(host)) return host;
  const dns = cleanLabelCandidate(node.DNSName).replace(/\.+$/, '');
  if (dns) {
    const first = cleanLabelCandidate(dns.split('.')[0]);
    if (first && !/^localhost$/i.test(first)) return first;
  }
  return '';
}

function parseTailscaleStatusJson(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const peersByIp = new Map();
  const selfName = pickTailscaleNodeName(parsed?.Self);
  for (const ip of Array.isArray(parsed?.Self?.TailscaleIPs) ? parsed.Self.TailscaleIPs : []) {
    const cleanIp = String(ip || '').trim().toLowerCase();
    if (cleanIp && selfName) peersByIp.set(cleanIp, selfName);
  }
  for (const peer of Object.values(parsed?.Peer || {})) {
    const name = pickTailscaleNodeName(peer);
    if (!name) continue;
    for (const ip of Array.isArray(peer?.TailscaleIPs) ? peer.TailscaleIPs : []) {
      const cleanIp = String(ip || '').trim().toLowerCase();
      if (cleanIp) peersByIp.set(cleanIp, name);
    }
  }
  return { selfName, peersByIp };
}

function defaultTailscaleProbe() {
  return new Promise((resolve) => {
    try {
      execFile(
        'tailscale',
        ['status', '--json'],
        { windowsHide: true, encoding: 'utf8', timeout: 2500, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (err || !stdout) return resolve({ selfName: '', peersByIp: new Map() });
          try {
            resolve(parseTailscaleStatusJson(stdout));
          } catch {
            resolve({ selfName: '', peersByIp: new Map() });
          }
        }
      );
    } catch {
      resolve({ selfName: '', peersByIp: new Map() });
    }
  });
}

function readT3EnvironmentLabel(paths) {
  const files = [paths?.serverRuntimePath, paths?.settingsPath].filter(Boolean);
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      const found = cleanLabelCandidate(data?.environmentLabel || data?.label || data?.environment?.label);
      if (found) return found;
    } catch {}
  }
  return '';
}

function savePrivate(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(tmp, '', { mode: 0o600, flag: 'wx' });
    if (process.platform === 'win32') {
      const run = (exe, args) =>
        execFileSync(join(process.env.SystemRoot, 'System32', exe), args, {
          windowsHide: true,
          encoding: 'utf8',
          timeout: 5000
        });
      const sid = run('whoami.exe', ['/user', '/fo', 'csv', '/nh']).match(/S-1-[\d-]+/i)?.[0];
      if (!sid) fail('secretStoreUnavailable');
      run('icacls.exe', [tmp, '/inheritance:r', '/grant:r', '*' + sid + ':F']);
    }
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, path);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

function selectInterface(cfg, getInterfaces) {
  if (cfg.bindMode === 'custom') return { host: cfg.bindHost };
  if (cfg.bindMode === 'all') return { host: '0.0.0.0' };
  const candidates = [];
  for (const [name, addresses] of Object.entries(getInterfaces())) {
    const ips = (addresses || []).filter((a) => !a.internal).map((a) => a.address);
    const tail = ips.filter(
      (ip) => /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) || /^fd7a:115c:a1e0:/i.test(ip)
    );
    const lan = ips.filter((ip) => /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(ip));
    const choices = cfg.bindMode === 'lan' ? lan : tail;
    if (choices.length)
      candidates.push({
        name,
        address: choices.find((ip) => isIP(ip) === 4) || choices[0],
        trusted: cfg.bindMode === 'lan' || /tailscale/i.test(name)
      });
  }
  const trusted = candidates.filter((c) => c.trusted);
  if (trusted.length === 1) return { host: trusted[0].address, candidates };
  return { state: candidates.length ? 'ambiguous_interface' : 'waiting_interface', candidates };
}

export function createRemoteBridge({
  paths,
  settings,
  engine,
  version = '',
  getLocalPort = () => 0,
  now = Date.now,
  networkInterfaces = interfaces,
  hostnameFn = osHostname,
  tailscaleProbe = defaultTailscaleProbe,
  createHttpListener = http.createServer,
  dnsLookup = lookup,
  httpRequest = (url, opts, cb) => (url.protocol === 'https:' ? https : http).request(url, opts, cb),
  randomBytes = bytes,
  setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: cancel = globalThis.clearTimeout
}) {
  let cfg = settings.get().remoteBridge,
    epoch = 0,
    timer,
    server,
    state = 'disabled',
    boundHost = '',
    candidates = [],
    attempt = 0;
  let secret,
    environmentId = '',
    envExpires = -Infinity,
    stopped = false,
    lifecycle = Promise.resolve();
  let tsDirectory = { selfName: '', peersByIp: new Map() },
    tsFetchedAt = -Infinity,
    tsInflight = null;
  const inflight = new Map(),
    cache = new Map(),
    penalties = new Map(),
    controllers = new Set(),
    observedPeerLabels = new Map();

  function refreshTailscaleDirectory(force = false) {
    if (stopped || typeof tailscaleProbe !== 'function') return Promise.resolve(tsDirectory);
    if (!force && now() - tsFetchedAt < 60000) return Promise.resolve(tsDirectory);
    if (tsInflight) return tsInflight;
    const p = Promise.resolve()
      .then(() => tailscaleProbe())
      .then((res) => {
        if (!stopped && res && typeof res === 'object') {
          tsDirectory = {
            selfName: cleanLabelCandidate(res.selfName),
            peersByIp: res.peersByIp instanceof Map ? res.peersByIp : new Map(Object.entries(res.peersByIp || {}))
          };
          tsFetchedAt = now();
        }
        return tsDirectory;
      })
      .catch(() => tsDirectory)
      .finally(() => {
        if (tsInflight === p) tsInflight = null;
      });
    tsInflight = p;
    return p;
  }

  function defaultLocalMachineLabel() {
    const t3Label = readT3EnvironmentLabel(paths);
    if (t3Label) return t3Label;
    if (tsDirectory.selfName) return tsDirectory.selfName;
    try {
      const host = cleanLabelCandidate(hostnameFn?.());
      if (host && !/^localhost(?:\.localdomain)?$/i.test(host)) return host;
    } catch {}
    return '';
  }

  function effectiveLocalMachineLabel() {
    return cleanLabelCandidate(cfg.server.machineLabel) || defaultLocalMachineLabel();
  }

  function peerTailscaleName(peer) {
    if (!peer?.url || !tsDirectory.peersByIp?.size) return '';
    try {
      const host = new URL(peer.url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
      return cleanLabelCandidate(tsDirectory.peersByIp.get(host));
    } catch {
      return '';
    }
  }

  function resolvePeerLabel(peer, remoteReportedLabel = '') {
    const manual = cleanLabelCandidate(peer?.label);
    if (manual) return manual;
    const reported = cleanLabelCandidate(remoteReportedLabel);
    if (reported) return reported;
    const observed = cleanLabelCandidate(observedPeerLabels.get(peer?.id));
    if (observed) return observed;
    return peerTailscaleName(peer);
  }

  function localEnvironmentId(fresh = false) {
    if (fresh || now() >= envExpires) {
      envExpires = now() + 500;
      try {
        environmentId = readFileSync(paths.environmentIdPath, 'utf8').trim();
      } catch {
        environmentId = '';
      }
      if (!isValidEnvironmentId(environmentId)) environmentId = '';
    }
    return environmentId;
  }
  function secrets() {
    if (!secret) {
      try {
        secret = JSON.parse(readFileSync(paths.remoteBridgeSecretsPath, 'utf8'));
      } catch (e) {
        if (e.code !== 'ENOENT') fail('secretStoreUnavailable');
        secret = { serverToken: '', peers: {} };
      }
    }
    return secret;
  }
  function persist(next) {
    try {
      savePrivate(paths.remoteBridgeSecretsPath, next);
    } catch {
      fail('secretStoreUnavailable');
    }
    secret = next;
  }
  // A peer can echo its bearer or an encoded pairing code in an otherwise displayable field.
  const PAIRING_CODE_PATTERN = /t3bridge:\/\/v1\/[A-Za-z0-9_-]+/gi;
  function redactText(text) {
    if (!text) return text;
    if (PAIRING_CODE_PATTERN.test(text)) {
      text = text.replace(PAIRING_CODE_PATTERN, '[redacted]');
    }
    if (!/[0-9a-f]{64}/.test(text)) return text;
    const data = secrets();
    const tokens = [data.serverToken, ...Object.values(data.peers).map((entry) => entry.token)];
    for (const token of tokens)
      if (validSecret(token) && text.includes(token)) text = text.replaceAll(token, '[redacted]');
    return text;
  }
  function validatePublicSettings(patch) {
    const raw = JSON.stringify(patch);
    if (/t3bridge:\/\/v1\//i.test(raw) || raw !== redactText(raw)) fail('Credentials cannot appear in settings');
  }
  function publicData(data) {
    if (data == null) return data;
    const raw = JSON.stringify(data);
    if (!secret && !cfg.server.enabled && !cfg.peers.length && !/t3bridge:\/\/v1\//i.test(raw)) return data;
    const clean = redactText(raw);
    return clean === raw ? data : JSON.parse(clean);
  }
  function serverToken(rotate = false) {
    const data = secrets();
    if (rotate || !validSecret(data.serverToken))
      persist({ ...data, serverToken: randomBytes(32).toString('hex') });
    return secret.serverToken;
  }
  function getStatus() {
    if (cfg.server.enabled || cfg.peers.length) refreshTailscaleDirectory();
    const peerResolvedLabels = {};
    for (const p of cfg.peers) {
      const resolved = resolvePeerLabel(p);
      if (resolved) peerResolvedLabels[p.id] = resolved;
    }
    return {
      state,
      boundHost,
      message:
        {
          port_in_use: 'Bridge port is already in use',
          waiting_interface: 'Waiting for the selected interface',
          ambiguous_interface: 'Select an interface address',
          unavailable: 'Bridge unavailable'
        }[state] || '',
      port: cfg.server.port,
      candidates,
      environmentId: localEnvironmentId(),
      defaultMachineLabel: defaultLocalMachineLabel(),
      resolvedMachineLabel: effectiveLocalMachineLabel(),
      peerResolvedLabels,
      tokenFingerprint: secret?.serverToken ? digest(secret.serverToken).toString('hex').slice(0, 8) : ''
    };
  }
  function makeServer() {
    let count = 0,
      rate = 0,
      reset = now();
    const generation = epoch;
    const listener = createHttpListener(
      { requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 8192 },
      async (req, res) => {
        const send = (n, obj) => {
          res.writeHead(n, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            Connection: 'close'
          });
          res.end(redactText(JSON.stringify(obj)));
        };
        const error = (n, code) => send(n, { ok: false, code, error: code });
        const token = req.headers.authorization?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
        if (!token || !timingSafeEqual(digest(token), digest(secret.serverToken)))
          return error(401, 'UNAUTHORIZED');
        if (generation !== epoch || stopped) return error(503, 'DATA_UNAVAILABLE');
        if (now() - reset >= 1000) {
          reset = now();
          rate = 0;
        }
        if (++rate > 40 || count >= 8) return error(429, 'RATE_LIMIT');
        if (req.method !== 'GET') return error(405, 'METHOD_NOT_ALLOWED');
        count++;
        try {
          const url = new URL(req.url, 'http://localhost');
          const env = localEnvironmentId(),
            machineLabel = effectiveLocalMachineLabel();
          if (!['/api/remote/info', '/api/remote/live'].includes(url.pathname))
            return error(404, 'NOT_FOUND');
          if (!env) return error(503, 'DATA_UNAVAILABLE');
          if (url.pathname === '/api/remote/info')
            return send(200, {
              ok: true,
              data: { protocolVersion: 1, environmentId: env, machineLabel, version }
            });
          const threadId = url.searchParams.get('threadId');
          if (!isValidThreadId(threadId)) return error(400, 'INVALID_THREAD');
          const snapshot = await engine.getExactLocalThreadSnapshot(threadId, { allowFallback: false });
          if (generation !== epoch || snapshot.dbUnavailable) return error(503, 'DATA_UNAVAILABLE');
          if (!snapshot.thread || snapshot.thread.unresolved) return error(404, 'THREAD_NOT_FOUND');
          send(200, {
            ok: true,
            data: buildSanitizedRemoteLivePayload(snapshot, {
              environmentId: env,
              machineLabel,
              requestedThreadId: threadId
            })
          });
        } catch {
          error(503, 'DATA_UNAVAILABLE');
        } finally {
          count--;
        }
      }
    );
    listener.setTimeout(5000, (socket) => socket.destroy());
    listener.maxConnections = 32;
    return listener;
  }
  async function closeServer() {
    const old = server;
    server = null;
    boundHost = '';
    if (old)
      await new Promise((resolve) => {
        old.close(resolve);
        old.closeAllConnections();
      });
  }
  async function reconcile(generation) {
    if (generation !== epoch) return;
    if (!stopped && (cfg.server.enabled || cfg.peers.length)) {
      refreshTailscaleDirectory();
    }
    if (!cfg.server.enabled || stopped) {
      await closeServer();
      state = 'disabled';
      return;
    }
    try {
      if (cfg.server.port === getLocalPort()) fail('EADDRINUSE');
      serverToken();
      const selected = selectInterface(cfg.server, networkInterfaces);
      candidates = selected.candidates || [];
      if (boundHost !== selected.host || !server) {
        await closeServer();
        if (generation !== epoch) return;
        state = selected.state || 'waiting_interface';
        if (selected.host) {
          const s = makeServer();
          server = s;
          await new Promise((resolve, reject) => {
            s.once('error', reject);
            s.listen(cfg.server.port, selected.host, resolve);
          });
          boundHost = selected.host;
          state = 'listening';
          attempt = 0;
        }
      }
    } catch (e) {
      await closeServer();
      state =
        (e.code || e.message) === 'EADDRINUSE'
          ? 'port_in_use'
          : e.code === 'EADDRNOTAVAIL'
            ? 'waiting_interface'
            : 'unavailable';
    }
    if (generation === epoch && cfg.server.enabled && !stopped) {
      const delay = state === 'listening' ? 15000 : delays[Math.min(attempt++, 3)];
      timer = schedule(() => (lifecycle = lifecycle.then(() => reconcile(generation))), delay);
      timer?.unref?.();
    }
  }
  function configure() {
    const generation = ++epoch;
    if (!stopped) cfg = settings.get().remoteBridge;
    if (timer !== undefined && timer !== null) cancel(timer);
    candidates = [];
    attempt = 0;
    timer = null;
    for (const c of controllers) c.abort();
    cache.clear();
    inflight.clear();
    penalties.clear();
    lifecycle = lifecycle.then(async () => {
      await closeServer();
      await reconcile(generation);
    });
    return lifecycle;
  }
  async function stop() {
    stopped = true;
    await configure();
  }

  async function request(peer, token, path) {
    if (!validSecret(token) || stopped) fail('unauthorized');
    const blockedPorts = [getLocalPort(), ...(cfg.server.enabled ? [cfg.server.port] : [])];
    const origin = validateRemoteOrigin(peer.url, { ...peer, blockedPorts });
    const url = new URL(path, origin);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const c = new AbortController();
    controllers.add(c);
    const timeout = schedule(() => c.abort(), 2500);
    try {
      const work = async () => {
        const ips = isIP(host) ? [{ address: host }] : await dnsLookup(host, { all: true, verbatim: true });
        c.signal.throwIfAborted();
        const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
        if (
          !ips.length ||
          ips.some(
            ({ address }) =>
              !isAllowedResolvedIp(address, peer) ||
              (!isAllowedResolvedIp(address) && blockedPorts.includes(port))
          )
        )
          fail('invalidAddress');
        const address = ips[0].address;
        return new Promise((resolve, reject) => {
          const req = httpRequest(
            url,
            {
              agent: false,
              signal: c.signal,
              autoSelectFamily: false,
              lookup: (_host, opts, cb) =>
                opts.all ? cb(null, [{ address, family: isIP(address) }]) : cb(null, address, isIP(address)),
              headers: { Authorization: 'Bearer ' + token }
            },
            (res) => {
              let size = 0;
              const chunks = [];
              res.on('error', reject);
              res.on('data', (chunk) => {
                size += chunk.length;
                if (size > 524288) {
                  req.destroy();
                  reject(new Error('incompatible'));
                } else chunks.push(chunk);
              });
              res.on('end', () => {
                if (res.statusCode === 401) return reject(new Error('unauthorized'));
                let body;
                try {
                  body = JSON.parse(Buffer.concat(chunks));
                } catch {}
                if (res.statusCode === 404 && body?.code === 'THREAD_NOT_FOUND')
                  return reject(new Error('threadNotFound'));
                if (res.statusCode !== 200) return reject(new Error('offline'));
                if (body?.ok !== true || !body.data) return reject(new Error('incompatible'));
                resolve(body.data);
              });
            }
          );
          req.on('error', reject);
          req.end();
        });
      };
      return await Promise.race([
        work(),
        new Promise((_, reject) =>
          c.signal.addEventListener('abort', () => reject(new Error('offline')), { once: true })
        )
      ]);
    } finally {
      cancel(timeout);
      controllers.delete(c);
    }
  }
  function peerToken(p) {
    const entry = secrets().peers?.[p.id];
    return entry?.environmentId === p.environmentId && entry.url === p.url ? entry.token : '';
  }
  async function remoteData(peer, threadId) {
    const key = JSON.stringify([peer.id, threadId]);
    const penalty = penalties.get(peer.id);
    if (penalty?.until > now()) return { status: penalty.status };
    if (cache.get(key)?.until > now()) return cache.get(key).result;
    if (inflight.has(key)) return inflight.get(key);
    const generation = epoch;
    const pending = (async () => {
      let result, ttl;
      try {
        const raw = await request(
          peer,
          peerToken(peer),
          '/api/remote/live?threadId=' + encodeURIComponent(threadId)
        );
        const data = validateRemoteLivePayload(raw, {
          expectedEnvironmentId: peer.environmentId,
          expectedThreadId: threadId
        });
        const reportedLabel = cleanLabelCandidate(data?.machineLabel);
        if (reportedLabel) observedPeerLabels.set(peer.id, reportedLabel);
        result = { status: 'connected', data, receivedAtMs: now() };
        ttl = 500;
      } catch (e) {
        const status = permanent.has(e.message) || e.message === 'threadNotFound' ? e.message : 'offline';
        result = { status };
        if (status === 'threadNotFound') ttl = 2000;
        else if (generation === epoch && !permanent.has(penalties.get(peer.id)?.status)) {
          const n = Math.min((penalties.get(peer.id)?.attempt ?? -1) + 1, 3);
          penalties.set(peer.id, {
            status,
            attempt: n,
            until: permanent.has(status) ? Infinity : now() + delays[n]
          });
        }
      }
      if (generation !== epoch) return { status: 'reconfigured' };
      const paused = penalties.get(peer.id);
      if (paused && permanent.has(paused.status)) return { status: paused.status };
      if (ttl) {
        if (result.data) penalties.delete(peer.id);
        if (cache.size >= 256) cache.delete(cache.keys().next().value);
        cache.set(key, { result, until: now() + ttl });
      }
      return result;
    })();
    inflight.set(key, pending);
    try {
      return await pending;
    } finally {
      if (inflight.get(key) === pending) inflight.delete(key);
    }
  }
  async function fetchRemoteLive(environmentId, threadId, override) {
    const peer = cfg.peers.find((p) => p.environmentId === environmentId);
    const status =
      override ||
      (!peer ? 'unpaired' : !peer.enabled ? 'disabled' : !isValidThreadId(threadId) ? 'invalidThread' : '');
    const result = status ? { status } : await remoteData(peer, threadId);
    const data = result.data;
    return {
      ...engine.getLocalCommonShell(),
      target: { environmentId, threadId },
      thread: data?.thread ?? { unresolved: true, requestedThreadId: threadId, reason: result.status },
      context: data?.context ?? null,
      quotas: data?.quotas ?? { updatedAtMs: null, groups: [], flatWindows: [] },
      threadErrors: data?.threadErrors ?? [],
      remote: {
        isRemote: true,
        status: result.status,
        environmentId,
        peerId: peer?.id || '',
        peerLabel: resolvePeerLabel(peer, data?.machineLabel),
        message: result.status,
        receivedAtMs: result.receivedAtMs || null,
        remoteUpdatedAtMs: data?.updatedAtMs ?? null
      }
    };
  }
  async function verify(peer, token) {
    const info = await request(peer, token, '/api/remote/info');
    if (info.protocolVersion !== 1) fail('incompatible');
    if (info.environmentId !== peer.environmentId) fail('identityMismatch');
    return info;
  }
  function decodeInput(params) {
    const p = params.code
      ? decodePairingCode(params.code)
      : decodePairingCode(
          encodePairingCode({
            v: 1,
            environmentId: params.environmentId,
            label: params.label || '',
            url: params.url,
            token: params.token
          })
        );
    const allowLoopbackTunnel = params.allowLoopbackTunnel === true;
    return {
      ...p,
      allowLoopbackTunnel,
      url: validateRemoteOrigin(p.url, {
        allowLoopbackTunnel,
        blockedPorts: [getLocalPort(), cfg.server.enabled && cfg.server.port]
      })
    };
  }
  async function savePeers(peers) {
    settings.update({ remoteBridge: { peers } });
    await configure();
  }
  async function manage(action, params = {}) {
    if (stopped) fail('disabled');
    if (action === 'rotateRemoteBridgeToken') {
      serverToken(true);
      return getStatus();
    }
    if (action === 'getRemoteBridgePairingCode') {
      if (state !== 'listening') fail('serverUnavailable');
      await refreshTailscaleDirectory();
      const address = isIP(boundHost) === 6 ? '[' + boundHost + ']' : boundHost;
      const url = cfg.server.advertiseUrl || 'http://' + address + ':' + cfg.server.port;
      return {
        code: encodePairingCode({
          v: 1,
          url,
          environmentId: localEnvironmentId(true),
          label: effectiveLocalMachineLabel(),
          token: serverToken()
        })
      };
    }
    if (action === 'parseRemoteBridgePairingCode') {
      const { environmentId, label, url } = decodePairingCode(params.code);
      return { environmentId, label: label || peerTailscaleName({ url }), url };
    }
    const peer = cfg.peers.find((p) => p.id === params.peerId);
    const generation = epoch;
    if (action === 'testRemoteBridgePeer' || action === 'upsertRemoteBridgePeer') {
      const byId = action === 'testRemoteBridgePeer' && params.peerId;
      if (byId && !peer) fail('unpaired');
      const input = byId ? peer : decodeInput(params);
      const token = byId ? peerToken(peer) : input.token;
      if (input.environmentId === localEnvironmentId()) fail('identityMismatch');
      const test = action === 'testRemoteBridgePeer' || params.verify === true;
      let status = 'untested';
      let verifiedInfo = null;
      if (test) {
        try {
          verifiedInfo = await verify(input, token);
          status = 'verified';
        } catch (e) {
          status = permanent.has(e.message) ? e.message : 'offline';
        }
      }
      if (generation !== epoch) fail('reconfigured');
      if (action === 'testRemoteBridgePeer') {
        if (byId) {
          const reportedLabel = cleanLabelCandidate(verifiedInfo?.machineLabel);
          if (reportedLabel) observedPeerLabels.set(peer.id, reportedLabel);
          await savePeers(
            cfg.peers.map((p) =>
              p !== peer
                ? p
                : {
                    ...p,
                    verified: status === 'verified',
                    lastVerifiedAtMs: status === 'verified' ? now() : null
                  }
            )
          );
          if (permanent.has(status)) penalties.set(peer.id, { status, until: Infinity, attempt: 0 });
        }
        return { verified: status === 'verified', status };
      }
      const old = cfg.peers.find((p) => p.environmentId === input.environmentId);
      const next = {
        id: old?.id || randomUUID(),
        environmentId: input.environmentId,
        label: cleanLabelCandidate(params.label ?? input.label ?? old?.label ?? ''),
        url: input.url,
        enabled: params.enabled ?? old?.enabled ?? true,
        allowLoopbackTunnel: input.allowLoopbackTunnel,
        verified: status === 'verified',
        lastVerifiedAtMs: status === 'verified' ? now() : null
      };
      const reportedLabel = cleanLabelCandidate(verifiedInfo?.machineLabel);
      if (reportedLabel) observedPeerLabels.set(next.id, reportedLabel);
      const peers = [...cfg.peers.filter((p) => p !== old), next];
      sanitizeBridgeConfig({ peers });
      validatePublicSettings({ peers });
      if (JSON.stringify(next).includes(token)) fail('Invalid peer metadata');
      const previous = secrets();
      persist({
        ...previous,
        peers: { ...previous.peers, [next.id]: { environmentId: next.environmentId, url: next.url, token } }
      });
      try {
        await savePeers(peers);
        if (permanent.has(status)) penalties.set(next.id, { status, until: Infinity, attempt: 0 });
      } catch (e) {
        persist(previous);
        throw e;
      }
      return { ...next, verifyStatus: status };
    }
    if (!peer) fail('unpaired');
    if (action === 'renameRemoteBridgePeer') {
      if (typeof params.label !== 'string') fail('Invalid bridge configuration');
      const nextLabel = params.label.trim();
      const peers = cfg.peers.map((p) => (p !== peer ? p : { ...p, label: nextLabel }));
      sanitizeBridgeConfig({ peers });
      validatePublicSettings({ peers });
      const tok = peerToken(peer);
      if (tok && nextLabel.includes(tok)) fail('Invalid bridge configuration');
      await savePeers(peers);
      const updatedPeer = cfg.peers.find((p) => p.id === peer.id);
      return { peer: updatedPeer, status: getStatus() };
    }
    if (action === 'toggleRemoteBridgePeer') {
      await savePeers(cfg.peers.map((p) => (p !== peer ? p : { ...p, enabled: params.enabled })));
      return getStatus();
    }
    if (action === 'removeRemoteBridgePeer') {
      const data = secrets(),
        remaining = { ...data.peers };
      delete remaining[peer.id];
      persist({ ...data, peers: remaining });
      observedPeerLabels.delete(peer.id);
      try {
        await savePeers(cfg.peers.filter((p) => p !== peer));
      } catch (e) {
        persist(data);
        throw e;
      }
      return getStatus();
    }
    fail('unsupported');
  }
  return {
    configure,
    stop,
    validatePublicSettings,
    publicData,
    redactText,
    getStatus,
    localEnvironmentId,
    fetchRemoteLive,
    resolveLiveSnapshot: fetchRemoteLive,
    manage
  };
}
