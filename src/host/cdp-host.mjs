import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const CDP_BRIDGE_BINDING = '__t3ToolsBridge';
const ISOLATED_WORLD_NAME = 't3tools-isolated';

function canonicalOrigin(rawUrl = '') {
  try {
    const u = new URL(rawUrl);
    if (u.protocol === 't3code:' && u.host.toLowerCase() === 'app') {
      return 't3code://app';
    }
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return u.origin;
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * Strictly verify a CDP target is the T3 Code renderer window.
 * Accepts:
 * 1. T3 Code Electron's dedicated custom scheme (`t3code://app/...`), OR
 * 2. Exact `serverOrigin` match from `server-runtime.json` for HTTP/HTTPS web mode.
 * Never trusts arbitrary loopback HTTP pages by title alone (fixes P1 #4).
 */
export function isT3CodePageTarget(target, serverOrigin = '') {
  if (!target || target.type !== 'page' || !target.webSocketDebuggerUrl) return false;
  const rawUrl = String(target.url || '');
  if (!rawUrl || rawUrl.startsWith('devtools://') || rawUrl.startsWith('chrome-extension://')) return false;
  try {
    const parsed = new URL(rawUrl);

    // 1. Native T3 Code Electron desktop protocol
    if (parsed.protocol === 't3code:' && parsed.host.toLowerCase() === 'app') {
      return true;
    }

    const title = String(target.title || '');
    if (/^T3Tools\s+v\d/i.test(title)) return false;

    // 2. HTTP/HTTPS web mode requires exact independently verified serverOrigin
    if (!serverOrigin) return false;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const expected = new URL(serverOrigin);
    return parsed.origin === expected.origin;
  } catch {
    return false;
  }
}

export function isValidLoopbackDebuggerUrl(wsUrl, expectedPort) {
  try {
    const u = new URL(wsUrl);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return false;
    const isLoopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (!isLoopback) return false;
    if (expectedPort && Number(u.port) !== Number(expectedPort)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Return ALL candidate CDP debugging ports (DevToolsActivePort across all candidate profiles
 * + any explicit fixed ports discovered from T3 Code shortcuts), instead of stopping at the first stale file (fixes P2 #19).
 */
export function collectDevToolsPortCandidates(paths, fixedPorts = []) {
  const results = [];
  const seenPorts = new Set();

  const files = [
    paths.devToolsPortFile,
    ...(paths.electronUserDataCandidates || []).map(d => join(d, 'DevToolsActivePort'))
  ];
  const seenFiles = new Set();

  for (const file of files) {
    if (!file || seenFiles.has(file)) continue;
    seenFiles.add(file);
    if (!existsSync(file)) continue;
    try {
      const firstLine = readFileSync(file, 'utf8').split(/\r?\n/)[0]?.trim();
      const port = Number(firstLine);
      if (Number.isInteger(port) && port >= 1 && port <= 65535 && !seenPorts.has(port)) {
        seenPorts.add(port);
        results.push({ port, source: file });
      }
    } catch {}
  }

  for (const p of fixedPorts || []) {
    const port = Number(p);
    if (Number.isInteger(port) && port >= 1 && port <= 65535 && !seenPorts.has(port)) {
      seenPorts.add(port);
      results.push({ port, source: 'shortcut-fixed-port' });
    }
  }

  return results;
}

export function readDevToolsActivePort(paths) {
  const list = collectDevToolsPortCandidates(paths);
  return list.length ? { port: list[0].port, file: list[0].source } : null;
}

export function readT3ServerOrigin(serverRuntimePath) {
  if (!serverRuntimePath || !existsSync(serverRuntimePath)) return '';
  try {
    const rt = JSON.parse(readFileSync(serverRuntimePath, 'utf8'));
    return typeof rt?.origin === 'string' ? rt.origin : '';
  } catch {
    return '';
  }
}

export function connectCdpSocket(wsUrl, { WebSocketImpl = globalThis.WebSocket } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(wsUrl);
    const pending = new Map();
    const listeners = new Set();
    let seq = 0;

    const connectTimer = setTimeout(() => {
      try { socket.close(); } catch {}
      reject(new Error('CDP 连接超时'));
    }, 4500);

    const failAll = reason => {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(reason));
      }
      pending.clear();
    };

    socket.addEventListener('error', () => {
      clearTimeout(connectTimer);
      failAll('CDP 连接错误');
      reject(new Error('CDP 连接不可用'));
    });

    socket.addEventListener('close', () => {
      clearTimeout(connectTimer);
      failAll('CDP 连接已关闭');
    });

    socket.addEventListener('message', event => {
      let msg;
      try { msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        clearTimeout(p.timer);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'CDP 命令失败'));
        else p.resolve(msg.result);
      } else {
        for (const fn of listeners) {
          try { fn(msg); } catch {}
        }
      }
    });

    socket.addEventListener('open', () => {
      clearTimeout(connectTimer);
      resolve({
        socket,
        onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        send(method, params = {}) {
          if (socket.readyState !== 1) return Promise.reject(new Error('CDP 连接已断开'));
          return new Promise((res, rej) => {
            const id = ++seq;
            const timeoutMs = method === 'Runtime.evaluate' ? 15000 : 5000;
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`CDP ${method} 超时`));
            }, timeoutMs);
            pending.set(id, { resolve: res, reject: rej, timer });
            socket.send(JSON.stringify({ id, method, params }));
          });
        }
      });
    });
  });
}

/**
 * Create the hardened CDP Host controller:
 * - Verifies exact T3 Code origin and loopback debugger URL (fixes P1 #4)
 * - Injects into an isolated execution world on the verified top-level frame only,
 *   and restricts Runtime.addBinding + RPC dispatch strictly to that isolated context (fixes P1 #4)
 * - Probes all port candidates (DevToolsActivePort + fixed shortcut ports) and preserves
 *   attachment errors in status (fixes P2 #19)
 */
export function createCdpHost({
  paths,
  buildClientBundle,
  handleRpc,
  getFixedPorts = () => [],
  pollIntervalMs = 4000,
  fetchImpl = globalThis.fetch,
  connectImpl = connectCdpSocket,
  version = '0.1.0'
}) {
  const clients = new Map();
  const bootId = randomUUID();
  let stopped = false;
  let polling = false;
  let timer = null;
  let lastState = {
    connected: false,
    devToolsPort: null,
    devToolsFile: '',
    attachedTargets: 0,
    message: '等待 T3 Code 本地调试端口',
    lastError: '',
    checkedAtMs: 0
  };

  async function disposePreviousIsolatedContexts(meta, keepCtxId = null) {
    const ids = new Set(meta.knownIsolatedContextIds || []);
    if (Number.isInteger(meta.isolatedContextId)) ids.add(meta.isolatedContextId);
    for (const oldId of ids) {
      if (oldId === keepCtxId) continue;
      try {
        await meta.client.send('Runtime.evaluate', {
          expression: 'globalThis.__t3Tools?.dispose?.()',
          contextId: oldId
        });
      } catch {}
      meta.knownIsolatedContextIds?.delete(oldId);
    }
  }

  async function installInTopIsolatedWorld(meta, bundleSource) {
    const tree = await meta.client.send('Page.getFrameTree');
    const topFrame = tree?.frameTree?.frame;
    if (!topFrame?.id) throw new Error('无法获取顶层 Frame');
    const topOrigin = canonicalOrigin(topFrame.url || meta.url);
    if (!topOrigin || (meta.expectedOrigin && topOrigin !== meta.expectedOrigin)) {
      throw new Error(`顶层 Frame 来源不匹配: ${topOrigin || topFrame.url}`);
    }

    await disposePreviousIsolatedContexts(meta);

    meta.topFrameId = topFrame.id;
    const world = await meta.client.send('Page.createIsolatedWorld', {
      frameId: topFrame.id,
      worldName: ISOLATED_WORLD_NAME,
      grantUniveralAccess: false
    });
    const ctxId = world?.executionContextId;
    if (!Number.isInteger(ctxId)) throw new Error('创建隔离执行上下文失败');
    await disposePreviousIsolatedContexts(meta, ctxId);
    meta.isolatedContextId = ctxId;
    meta.knownIsolatedContextIds?.add(ctxId);

    await meta.client.send('Runtime.addBinding', {
      name: CDP_BRIDGE_BINDING,
      executionContextName: ISOLATED_WORLD_NAME
    });

    const evalRes = await meta.client.send('Runtime.evaluate', {
      expression: bundleSource,
      contextId: ctxId
    });
    if (evalRes?.exceptionDetails) {
      throw new Error(evalRes.exceptionDetails.text || '前端脚本注入异常');
    }
  }

  async function attachTarget(target, serverOrigin) {
    const client = await connectImpl(target.webSocketDebuggerUrl);
    const targetOrigin = canonicalOrigin(target.url);
    const meta = {
      targetId: target.id,
      url: target.url,
      wsUrl: target.webSocketDebuggerUrl,
      title: target.title || '',
      expectedOrigin: targetOrigin === 't3code://app' ? 't3code://app' : (canonicalOrigin(serverOrigin) || targetOrigin),
      topFrameId: '',
      isolatedContextId: null,
      knownIsolatedContextIds: new Set(),
      attachedAtMs: Date.now(),
      client
    };
    clients.set(target.id, meta);

    client.socket.addEventListener('close', () => {
      if (clients.get(target.id) === meta) clients.delete(target.id);
    });

    client.onEvent(async evt => {
      if (evt.method === 'Runtime.executionContextCreated') {
        const ctx = evt.params?.context;
        if (ctx?.name === ISOLATED_WORLD_NAME && Number.isInteger(ctx.id)) {
          meta.knownIsolatedContextIds.add(ctx.id);
        }
        return;
      }
      if (evt.method === 'Runtime.executionContextDestroyed') {
        const destroyedId = evt.params?.executionContextId;
        if (Number.isInteger(destroyedId)) {
          meta.knownIsolatedContextIds.delete(destroyedId);
          if (meta.isolatedContextId === destroyedId) meta.isolatedContextId = null;
        }
        return;
      }
      if (evt.method === 'Runtime.executionContextsCleared') {
        meta.knownIsolatedContextIds.clear();
        meta.isolatedContextId = null;
        return;
      }

      // Re-inject into fresh isolated world after top-level navigation
      if (evt.method === 'Page.frameNavigated' && evt.params?.frame?.id === meta.topFrameId && !evt.params?.frame?.parentId) {
        try {
          const navOrigin = canonicalOrigin(evt.params.frame.url || '');
          if (navOrigin && navOrigin === meta.expectedOrigin) {
            const bundleSource = buildClientBundle({ transport: 'cdp', bootId });
            await installInTopIsolatedWorld(meta, bundleSource);
          } else {
            meta.isolatedContextId = null;
          }
        } catch {}
        return;
      }

      if (evt.method !== 'Runtime.bindingCalled') return;
      if (evt.params?.name !== CDP_BRIDGE_BINDING) return;

      // Strictly reject calls from any non-verified frame or execution context (fixes P1 #4)
      if (!Number.isInteger(meta.isolatedContextId) || evt.params.executionContextId !== meta.isolatedContextId) {
        return;
      }

      let req;
      try { req = JSON.parse(evt.params.payload || '{}'); } catch { return; }
      if (!req || !req.id || !req.action) return;

      let reply;
      try {
        const data = await handleRpc(req.action, req.params || {});
        reply = { ok: true, data };
      } catch (err) {
        reply = { ok: false, error: err?.message || String(err) };
      }

      try {
        await client.send('Runtime.evaluate', {
          expression: `globalThis.__t3ToolsReceive?.(${JSON.stringify(req.id)}, ${JSON.stringify(reply)})`,
          contextId: meta.isolatedContextId
        });
      } catch {}
    });

    await client.send('Runtime.enable');
    await client.send('Page.enable');

    const bundleSource = buildClientBundle({ transport: 'cdp', bootId });
    await installInTopIsolatedWorld(meta, bundleSource);
  }

  async function pollOnce() {
    if (stopped || polling) return lastState;
    polling = true;
    const pollErrors = [];

    try {
      const serverOrigin = readT3ServerOrigin(paths.serverRuntimePath);
      const candidates = collectDevToolsPortCandidates(paths, getFixedPorts());

      // Disconnect any previously attached HTTP clients if serverOrigin disappeared
      if (!serverOrigin) {
        for (const [id, meta] of clients.entries()) {
          if (meta.expectedOrigin !== 't3code://app') {
            try { meta.client.socket.close(); } catch {}
            clients.delete(id);
          }
        }
      }

      if (!candidates.length) {
        lastState = {
          connected: false,
          devToolsPort: null,
          devToolsFile: '',
          attachedTargets: 0,
          message: '未检测到 DevToolsActivePort（请先运行 install-launcher 并重启 T3 Code）',
          lastError: '',
          checkedAtMs: Date.now()
        };
        return lastState;
      }

      // Probe ALL candidate ports AND continue to next candidate if attaching fails (fixes P2 #19)
      let activeCandidate = null;
      let attachedMatchedIds = new Set();

      for (const cand of candidates) {
        let valid = [];
        try {
          const res = await fetchImpl(`http://127.0.0.1:${cand.port}/json/list`, {
            signal: AbortSignal.timeout(3000)
          });
          if (!res.ok) {
            pollErrors.push(`端口 ${cand.port} 返回 ${res.status}`);
            continue;
          }
          const targets = await res.json();
          if (!Array.isArray(targets)) continue;
          valid = targets.filter(t =>
            isT3CodePageTarget(t, serverOrigin) &&
            isValidLoopbackDebuggerUrl(t.webSocketDebuggerUrl, cand.port)
          );
        } catch (err) {
          pollErrors.push(`端口 ${cand.port}: ${err?.message || err}`);
          continue;
        }

        if (!valid.length) continue;

        let attachedOnThisPort = 0;
        for (const target of valid) {
          const existing = clients.get(target.id);
          try {
            if (existing && existing.wsUrl !== target.webSocketDebuggerUrl) {
              try { existing.client.socket.close(); } catch {}
              clients.delete(target.id);
            }
            if (!clients.has(target.id)) {
              await attachTarget(target, serverOrigin);
            } else {
              const meta = clients.get(target.id);
              const check = await meta.client.send('Runtime.evaluate', {
                expression: `Boolean(globalThis.__t3Tools && globalThis.__t3Tools.version === ${JSON.stringify(version)} && globalThis.__t3Tools.bootId === ${JSON.stringify(bootId)} && globalThis.__t3Tools.healthy !== false)`,
                contextId: meta.isolatedContextId,
                returnByValue: true
              });
              if (check?.result?.value !== true) {
                const bundleSource = buildClientBundle({ transport: 'cdp', bootId });
                await installInTopIsolatedWorld(meta, bundleSource);
              }
            }
            attachedMatchedIds.add(target.id);
            attachedOnThisPort++;
          } catch (err) {
            try { clients.get(target.id)?.client.socket.close(); } catch {}
            clients.delete(target.id);
            pollErrors.push(`端口 ${cand.port} 挂载失败: ${err?.message || err}`);
          }
        }

        if (attachedOnThisPort > 0) {
          activeCandidate = cand;
          break;
        }
      }

      for (const [id, meta] of clients.entries()) {
        if (!attachedMatchedIds.has(id)) {
          try { meta.client.socket.close(); } catch {}
          clients.delete(id);
        }
      }

      lastState = {
        connected: clients.size > 0,
        devToolsPort: activeCandidate?.port ?? null,
        devToolsFile: activeCandidate?.source ?? '',
        attachedTargets: clients.size,
        message: clients.size > 0
          ? `已挂载到 ${clients.size} 个 T3 Code 窗口`
          : (activeCandidate ? '已发现调试端口，等待 T3 Code 主窗口就绪' : '等待 T3 Code 调试接口响应'),
        // Retain attachment errors instead of clearing them at poll end (fixes P2 #19)
        lastError: pollErrors.join('; '),
        checkedAtMs: Date.now()
      };
      return lastState;
    } catch (err) {
      lastState = {
        ...lastState,
        connected: clients.size > 0,
        attachedTargets: clients.size,
        message: '等待 T3 Code 调试接口响应',
        lastError: err?.message || String(err),
        checkedAtMs: Date.now()
      };
      return lastState;
    } finally {
      polling = false;
    }
  }

  function start() {
    stopped = false;
    pollOnce();
    timer = setInterval(pollOnce, pollIntervalMs);
  }

  async function stop() {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    for (const meta of clients.values()) {
      try {
        if (Number.isInteger(meta.isolatedContextId)) {
          await meta.client.send('Runtime.evaluate', {
            expression: 'globalThis.__t3Tools?.dispose?.()',
            contextId: meta.isolatedContextId
          }).catch(() => {});
        }
        meta.client.socket.close();
      } catch {}
    }
    clients.clear();
  }

  function getStatus() {
    return { ...lastState };
  }

  return { start, stop, pollOnce, getStatus };
}
