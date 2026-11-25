import http from 'node:http';
import { URL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function sendText(res, status, contentType, text) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    let oversized = false;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      if (oversized) return;
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        oversized = true;
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (oversized) return;
      if (!raw.trim()) return resolve({});
      try {
        const body = JSON.parse(raw);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch { reject(Object.assign(new Error('请求体必须为 JSON 对象'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

function safeTokenMatch(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Hardened localhost-only HTTP API + Independent Web Fallback server (fixes P1 #5):
 * - Enforces Host header check (prevents DNS rebinding)
 * - Enforces exact Origin allowlist BEFORE dispatch (blocks cross-origin localhost reads/writes)
 * - Requires per-daemon X-T3Tools-Token + application/json on all mutating POST endpoints
 * - Removes forced rescan side-effects from GET endpoints
 */
export function createHttpServer({
  port = 17373,
  authToken = randomBytes(24).toString('hex'),
  getAllowedOrigins = () => [],
  getActiveThreadId = () => '',
  engine,
  settings,
  handleRpc,
  getDaemonStatus,
  buildClientBundle,
  buildFallbackHtml,
  onSettingsUpdated = null,
  onReattachCdp = null,
  onToggleCdp = null,
  onPatchDebugShortcuts = null,
  onLaunchT3 = null,
  onRelaunchT3 = null,
  onShutdown = null
}) {
  let boundPort = port;

  function allowedOriginSet() {
    const set = new Set([
      `http://127.0.0.1:${boundPort}`,
      `http://localhost:${boundPort}`,
      `http://[::1]:${boundPort}`
    ]);
    for (const o of getAllowedOrigins() || []) {
      if (o) set.add(o);
    }
    return set;
  }

  function isValidHost(hostHeader) {
    if (!hostHeader) return false;
    const h = String(hostHeader).toLowerCase().trim();
    return (
      h === `127.0.0.1:${boundPort}` ||
      h === `localhost:${boundPort}` ||
      h === `[::1]:${boundPort}`
    );
  }

  const server = http.createServer(async (req, res) => {
    try {
      // 1. Host header validation (blocks DNS rebinding)
      if (!isValidHost(req.headers.host)) {
        sendJson(res, 403, { ok: false, error: 'Forbidden Host' });
        return;
      }

      // 2. Strict Origin validation BEFORE dispatch
      const origin = req.headers.origin;
      const allowed = allowedOriginSet();
      if (origin) {
        if (!allowed.has(origin)) {
          sendJson(res, 403, { ok: false, error: 'Forbidden Origin' });
          return;
        }
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-T3Tools-Token');
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${boundPort}`);
      const pathname = reqUrl.pathname;

      if (req.method === 'GET' && pathname === '/') {
        const currentSettings = settings.get();
        const html = buildFallbackHtml({
          apiBase: '',
          authToken,
          theme: currentSettings?.theme === 'light' ? 'light' : 'dark'
        });
        sendText(res, 200, 'text/html; charset=utf-8', html);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/status') {
        sendJson(res, 200, { ok: true, data: getDaemonStatus() });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/live') {
        const requestedThreadId = reqUrl.searchParams.get('threadId') || '';
        const allowFallback = reqUrl.searchParams.get('allowFallback') !== '0';
        const threadId = requestedThreadId || (allowFallback ? (getActiveThreadId() || '') : '');
        const data = engine.getLiveThreadSnapshot(threadId, { allowFallback });
        sendJson(res, 200, { ok: true, data });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/requests.csv') {
        const { csv, filename } = engine.exportRequestsCsv(Object.fromEntries(reqUrl.searchParams));
        res.writeHead(200, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` });
        res.end(csv);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/dashboard') {
        const query = Object.fromEntries(reqUrl.searchParams.entries());
        // Never trigger forced rescans from GET requests (fixes P1 #5)
        const data = engine.getDashboardData(query, { forceSync: false });
        sendJson(res, 200, { ok: true, data });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/settings') {
        sendJson(res, 200, { ok: true, data: settings.get() });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/bundle.js') {
        // Never embed the daemon mutation token inside a JS asset (fixes P2 #5)
        const js = buildClientBundle({
          transport: 'http',
          apiBase: `http://127.0.0.1:${boundPort}`
        });
        sendText(res, 200, 'application/javascript; charset=utf-8', js);
        return;
      }

      // Mutating endpoints require per-daemon token + exact application/json media type (fixes P2 #5)
      const mutatingPaths = new Set([
        '/api/settings',
        '/api/errors/ack', '/api/t3/focus-thread', '/api/alerts/test',
        '/api/runtime-updates/check',
        '/api/sync',
        '/api/cdp/reattach',
        '/api/cdp/toggle',
        '/api/launcher/patch-debug',
        '/api/t3/launch',
        '/api/t3/relaunch',
        '/api/shutdown'
      ]);
      if (req.method === 'POST' && mutatingPaths.has(pathname)) {
        const token = req.headers['x-t3tools-token'];
        if (!safeTokenMatch(token, authToken)) {
          sendJson(res, 401, { ok: false, error: 'Unauthorized: missing or invalid X-T3Tools-Token' });
          return;
        }
        const mediaType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (mediaType !== 'application/json') {
          sendJson(res, 415, { ok: false, error: 'Unsupported Media Type: expected application/json' });
          return;
        }
        const action = {
          '/api/errors/ack': 'ackErrors',
          '/api/t3/focus-thread': 'focusThread',
          '/api/alerts/test': 'testAlert',
          '/api/runtime-updates/check': 'checkRuntimeUpdates'
        }[pathname];
        if (action) {
          const body = await readJsonBody(req);
          sendJson(res, 200, { ok: true, data: await handleRpc(action, body) });
          return;
        }
        if (pathname === '/api/settings') {
          const body = await readJsonBody(req);
          try {
            const updated = settings.update(body);
            if (typeof onSettingsUpdated === 'function') {
              await onSettingsUpdated(updated, body);
            }
            sendJson(res, 200, { ok: true, data: updated });
          } catch (validationErr) {
            sendJson(res, 400, { ok: false, error: validationErr?.message || '配置校验失败' });
          }
          return;
        }
        if (pathname === '/api/sync') {
          await readJsonBody(req);
          engine.syncAll({ force: true });
          sendJson(res, 200, { ok: true, data: { syncedAtMs: Date.now() } });
          return;
        }
        if (pathname === '/api/cdp/reattach') {
          await readJsonBody(req);
          const data = typeof onReattachCdp === 'function' ? await onReattachCdp() : getDaemonStatus().cdp;
          sendJson(res, 200, { ok: true, data });
          return;
        }
        if (pathname === '/api/cdp/toggle') {
          const body = await readJsonBody(req);
          if (typeof body?.enabled !== 'boolean') {
            sendJson(res, 400, { ok: false, error: 'enabled 必须为布尔值' });
            return;
          }
          const data = typeof onToggleCdp === 'function' ? await onToggleCdp(body.enabled) : getDaemonStatus().cdp;
          sendJson(res, 200, { ok: true, data });
          return;
        }
        if (pathname === '/api/launcher/patch-debug') {
          await readJsonBody(req);
          const data = typeof onPatchDebugShortcuts === 'function' ? await onPatchDebugShortcuts() : { ok: false, error: '未启用' };
          sendJson(res, data?.ok === false ? 400 : 200, { ok: data?.ok !== false, data, error: data?.error || '' });
          return;
        }
        if (pathname === '/api/t3/launch') {
          await readJsonBody(req);
          const data = typeof onLaunchT3 === 'function' ? await onLaunchT3() : { ok: false, error: '未启用' };
          sendJson(res, data?.ok === false ? 400 : 200, { ok: data?.ok !== false, data, error: data?.error || '' });
          return;
        }
        if (pathname === '/api/t3/relaunch') {
          await readJsonBody(req);
          const data = typeof onRelaunchT3 === 'function' ? await onRelaunchT3() : { ok: false, error: '未启用' };
          sendJson(res, data?.ok === false ? 400 : 200, { ok: data?.ok !== false, data, error: data?.error || '' });
          return;
        }
        if (pathname === '/api/shutdown') {
          await readJsonBody(req);
          sendJson(res, 200, { ok: true, data: { shuttingDown: true } });
          if (typeof onShutdown === 'function') {
            setTimeout(() => { onShutdown(); }, 40);
          }
          return;
        }
      }

      sendJson(res, 404, { ok: false, error: 'Not Found' });
    } catch (err) {
      sendJson(res, [400, 413].includes(err?.statusCode) ? err.statusCode : 500, { ok: false, error: err?.message || 'Internal Server Error' });
    }
  });

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        const addr = server.address();
        boundPort = typeof addr === 'object' && addr ? addr.port : port;
        resolve({ host: '127.0.0.1', port: boundPort });
      });
    });
  }

  function close() {
    return new Promise(resolve => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  return { server, authToken, listen, close };
}
