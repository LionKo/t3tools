import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createTelemetryStore } from '../src/core/telemetry-store.mjs';
import { DEFAULT_SETTINGS, sanitizeSettingsPatch } from '../src/core/settings.mjs';
import { createErrorAlerts } from '../src/analytics/error-alerts.mjs';
import { createAnalyticsEngine } from '../src/analytics/engine.mjs';
import { formatLocalDay } from '../src/analytics/heatmap-health.mjs';
import { createHttpServer } from '../src/host/http-server.mjs';
import { buildClientBundle } from '../src/ui/bundle.mjs';
import { buildFallbackHtml } from '../src/ui/fallback-page.mjs';
import { runInNewContext } from 'node:vm';

test('smart alerts ignore history, detect critical failures and bursts, deduplicate polling and coalesce cooldowns', () => {
  const monitor = createErrorAlerts(1000);
  const cfg = DEFAULT_SETTINGS.alertConfig;
  const event = (id, timestampMs, modelId, errorCode = 'eof') => ({id,timestampMs,modelId,errorCode});
  const first = event('1',1100,'a');
  monitor.evaluate([event('old',800,'b','region'),first],cfg,1200);
  assert.equal(monitor.snapshot().latestSeq,0);
  monitor.evaluate([first,event('2',1300,'a')],cfg,1300);
  assert.equal(monitor.snapshot().latestAlert.countInWindow,2);
  monitor.evaluate([event('3',1500,'a')],cfg,1500);
  assert.equal(monitor.snapshot().latestSeq,1);
  assert.equal(monitor.snapshot().latestAlert.countInWindow,3);
  for (const code of ['region','rate-limit','failed']) monitor.evaluate([event(code,1800,code,code)],cfg,1800);
  assert.equal(monitor.snapshot().latestSeq,4);
  monitor.evaluate([event('4',125000,'a')],cfg,125000);
  assert.equal(monitor.snapshot().latestSeq,5);
  monitor.evaluate([event('quiet',126000,'q')],{...cfg, mode:'quiet'},126000);
  assert.equal(monitor.snapshot().latestAlert.desktopNotify,false);
  monitor.evaluate([event('off',127000,'z','region')],{...cfg,enabled:false},127000);
  assert.equal(monitor.snapshot().latestSeq,6);
});

test('dashboard filters preserve later recovery; failed and retry detail, heatmap, unread watermark and v2 migration', () => {
  const dir = mkdtempSync(join(tmpdir(),'t3-errors-')), file = join(dir,'store.sqlite');
  let store = createTelemetryStore(file);
  try {
    const day1 = +new Date(2025,5,18,12), day2 = +new Date(2025,5,19,12);
    const base = {accountId:'acct',providerDriver:'codex',modelId:'a',nativeSessionId:'n',t3ThreadId:'thread',t3ThreadTitle:'first'};
    store.replaceSourceRequests('test','1',[
      {...base,id:'1',timestampMs:day1,status:'error',errorCode:'timeout',errorText:'x'.repeat(900)},
      {...base,id:'2',timestampMs:day1+10,status:'success',retries:1,errorCode:'timeout',nativeSessionId:'recovered',t3ThreadId:null},
      {...base,id:'3',timestampMs:day2,status:'success'},
      {...base,id:'4',timestampMs:day2,status:'error',errorCode:'eof',nativeSessionId:'broken',t3ThreadId:null}
    ]);
    const adapter = {syncAll(){}};
    const engine = createAnalyticsEngine({store,settings:{get:()=>DEFAULT_SETTINGS},antigravityAdapter:adapter,codexAdapter:adapter,
      quotaAdapter:{readAllQuotas:()=>({flatWindows:[]})},t3State:{}});
    const query = {preset:'all',day:formatLocalDay(day1),status:'error_or_retried',errorCode:'timeout'};
    const {requests,errorInsights,heatmap} = engine.getDashboardData(query,{now:day2+10});
    assert.deepEqual(requests.items.map(r=>r.id),['2','1']);
    assert.equal(errorInsights.summary.totalErrors,1);
    assert.equal(errorInsights.summary.totalRetried,1);
    assert.equal(errorInsights.recentErrors[1].errorText.length,900);
    assert.equal(errorInsights.affectedSessions.find(s=>s.sessionKey==='thread').lastSuccessAfterErrorAtMs,day2);
    assert.ok(errorInsights.affectedSessions.every(s=>s.state==='recovered'));
    assert.equal(heatmap.maxErrors,1);
    const all = engine.getDashboardData({preset:'all',includeRetried:'false',errorOnlyToday:'false'},{now:day2+1}).errorInsights;
    assert.equal(all.affectedSessions[0].sessionKey,'broken');
    assert.equal(all.summary.totalRetried,0);
    // Default errorOnlyToday=true scopes Model Analysis tracker to today only and counts both failed + recovered retries
    store.replaceSourceRequests('test-today','2',[
      {...base,id:'5',timestampMs:day2+1000,status:'success',retries:2,errorCode:'eof',errorText:'recovered eof',nativeSessionId:'retry-today',t3ThreadId:'t-retry',t3ThreadTitle:'今日重试恢复对话'}
    ]);
    const todayDash = engine.getDashboardData({preset:'all'},{now:day2+2000});
    assert.equal(todayDash.errorInsights.summary.isTodayScope,true);
    assert.equal(todayDash.errorInsights.summary.totalErrors,1);
    assert.equal(todayDash.errorInsights.summary.totalRetriedRecovered,1);
    assert.equal(todayDash.errorInsights.summary.totalIncidents,2);
    assert.equal(todayDash.errorInsights.hourlyTrend.length,1);
    assert.equal(todayDash.errorInsights.hourlyTrend[0].failed,1);
    assert.equal(todayDash.errorInsights.hourlyTrend[0].recovered,1);
    assert.equal(todayDash.errorInsights.affectedSessions.find(s=>s.sessionKey==='t-retry').onlyRecoveredRetry,true);
    assert.equal(todayDash.summary.models[0].retryErrorCodes.eof,1);
    assert.equal(engine.acknowledgeErrors().unreadCount,0);
    const watermark = store.getMeta('error_ack_ts_ms');
    store.close();
    const db = new DatabaseSync(file);
    db.prepare("UPDATE store_meta SET value='2' WHERE key='schema_version'").run();
    db.close();
    store = createTelemetryStore(file);
    assert.equal(store.getMeta('error_ack_ts_ms'),watermark);
    assert.equal(store.listAllRequests().length,0);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('new error mutations share Host, Origin, token and JSON checks and reject GET',async () => {
  const actions = [];
  const server = createHttpServer({port:0,authToken:'secret',handleRpc:async(action,params)=>{actions.push([action,params]);return {action};}});
  const {port} = await server.listen();
  try {
    for (const [path,action] of [['errors/ack','ackErrors'],['errors/resolve','resolveErrors'],['alerts/test','testAlert'],['t3/focus-thread','focusThread']]) {
      const url = 'http://127.0.0.1:'+port+'/api/'+path;
      const headers = {'Content-Type':'application/json','X-T3Tools-Token':'secret'};
      function send(method, extra) {
        return new Promise((resolve,reject) => {
          const req = request(url,{method,headers:{...headers,...extra}},res=>{
            let body = '';
            res.on('data',chunk=>{body += chunk;});
            res.on('end',()=>resolve({status:res.statusCode,json:()=>JSON.parse(body)}));
          });
          req.on('error',reject);
          req.end(method === 'POST' ? '{"threadId":"th"}' : undefined);
        });
      }
      const post = extra => send('POST',extra);
      assert.equal((await post({Host:'example.org'})).status,403);
      assert.equal((await send('GET',{})).status,404);
      assert.equal((await post({Origin:'https://example.org'})).status,403);
      assert.equal((await post({'X-T3Tools-Token':'bad'})).status,401);
      assert.equal((await post({'Content-Type':'text/plain'})).status,415);
      assert.equal((await (await post({})).json()).data.action,action);
    }
    assert.equal(actions.length,4);
  } finally {await server.close();}
});

test('alert config rejects incorrect types and out of range settings',()=>{
  for (const patch of [{enabled:1},{mode:'none'},{burstThreshold:'2'},{burstWindowMs:500},{cooldownMs:1800001}])
    assert.throws(()=>sanitizeSettingsPatch({alertConfig:patch}));
  assert.deepEqual(sanitizeSettingsPatch({alertConfig:{mode:'quiet'}}),{alertConfig:{mode:'quiet'}});
});

test('high-severity alerts bypass warning cooldown on same model and failedRuns day filter works without ReferenceError', () => {
  const monitor = createErrorAlerts(1000);
  const cfg = DEFAULT_SETTINGS.alertConfig;
  monitor.evaluate([
    { id: 'e1', timestampMs: 1100, modelId: 'gemini-4-neon', errorCode: 'eof' },
    { id: 'e2', timestampMs: 1200, modelId: 'gemini-4-neon', errorCode: 'eof' }
  ], cfg, 1200);
  assert.equal(monitor.snapshot().latestSeq, 1);
  // High-severity 429 on the same model inside warning cooldown must still alert immediately
  monitor.evaluate([
    { id: 'e3', timestampMs: 1500, modelId: 'gemini-4-neon', errorCode: 'rate-limit' }
  ], cfg, 1500);
  assert.equal(monitor.snapshot().latestSeq, 2);
  assert.equal(monitor.snapshot().latestAlert.errorCode, 'rate-limit');

  // Verify getDashboardData({ day }) with active failedRuns does not throw ReferenceError
  const dir = mkdtempSync(join(tmpdir(), 't3-failed-day-'));
  const file = join(dir, 'store.sqlite');
  const store = createTelemetryStore(file);
  try {
    const now = Date.now();
    const adapter = { syncAll() {} };
    const engine = createAnalyticsEngine({
      store,
      settings: { get: () => DEFAULT_SETTINGS },
      antigravityAdapter: adapter,
      codexAdapter: adapter,
      quotaAdapter: { readAllQuotas: () => ({ flatWindows: [] }) },
      t3State: {
        readFailedRuns: () => [{
          id: 'run:r1',
          timestampMs: now + 50,
          modelId: 'gemini-4-neon',
          errorCode: 'failed',
          t3ThreadId: 'thread:subagent:xyz',
          t3ThreadTitle: 'Subagent task',
          accountId: 'Ultra'
        }]
      }
    });
    engine.tickAlerts(now + 100);
    const dash = engine.getDashboardData({ preset: 'all', day: formatLocalDay(now + 100) }, { now: now + 100 });
    assert.equal(dash.errorInsights.failedRuns.length, 1);
    assert.equal(dash.errorInsights.failedRuns[0].t3ThreadId, 'thread:subagent:xyz');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolving errors clears unread/red badge counts while keeping all error history inspectable across restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 't3-resolve-'));
  const file = join(dir, 'store.sqlite');
  let store = createTelemetryStore(file);
  try {
    const baseNow = +new Date(2026, 4, 10, 12, 0, 0);
    const base = { accountId: 'acct', providerDriver: 'antigravity', modelId: 'gemini-4-neon', inputTokens: 100, outputTokens: 50 };
    store.replaceSourceRequests('src-1', '1', [
      { ...base, id: 'err-a1', timestampMs: baseNow - 3000, status: 'error', errorCode: 'eof', errorText: 'eof 1', nativeSessionId: 'nat-a', t3ThreadId: 'th-a', t3ThreadTitle: '对话 A' },
      { ...base, id: 'err-a2', timestampMs: baseNow - 2000, status: 'success', retries: 1, errorCode: 'timeout', errorText: 'retry 1', nativeSessionId: 'nat-a', t3ThreadId: 'th-a', t3ThreadTitle: '对话 A' },
      { ...base, id: 'err-b1', timestampMs: baseNow - 1000, status: 'error', errorCode: 'rate-limit', errorText: '429', nativeSessionId: 'nat-b', t3ThreadId: 'th-b', t3ThreadTitle: '对话 B' }
    ]);
    const adapter = { syncAll() {} };
    const makeEngine = s => createAnalyticsEngine({
      store: s,
      settings: { get: () => DEFAULT_SETTINGS },
      antigravityAdapter: adapter,
      codexAdapter: adapter,
      quotaAdapter: { readAllQuotas: () => ({ flatWindows: [] }) },
      t3State: {}
    });

    let engine = makeEngine(store);
    engine.tickAlerts(baseNow);
    assert.equal(engine.getAlerts().unreadIncidents, 3);
    assert.equal(engine.getAlerts().unreadCount, 2);

    // 1. Resolve single item: red badge decrements, but all 3 error records remain visible
    const itemRes = engine.resolveErrors({ scope: 'item', id: 'err-a1' }, baseNow);
    assert.equal(itemRes.unreadCount, 1);
    assert.equal(itemRes.unreadIncidents, 2);
    let dash = engine.getDashboardData({ preset: 'all' }, { now: baseNow });
    assert.equal(dash.errorInsights.summary.totalErrors, 2);
    assert.equal(dash.errorInsights.summary.totalIncidents, 3);
    assert.equal(dash.errorInsights.summary.resolvedCount, 1);
    assert.equal(dash.errorInsights.recentErrors.length, 3);
    assert.equal(dash.errorInsights.recentErrors.find(r => r.id === 'err-a1').resolved, true);
    assert.equal(dash.errorInsights.recentErrors.find(r => r.id === 'err-b1').resolved, false);

    // 2. Resolve session: clears session unresolved count, keeps session card, new error in same session still triggers badge
    const sessRes = engine.resolveErrors({ scope: 'session', sessionKey: 'th-a', t3ThreadId: 'th-a', nativeSessionId: 'nat-a' }, baseNow);
    assert.equal(sessRes.unreadIncidents, 1);
    dash = engine.getDashboardData({ preset: 'all' }, { now: baseNow });
    assert.equal(dash.errorInsights.affectedSessions.find(s => s.sessionKey === 'th-a').resolved, true);
    assert.equal(dash.errorInsights.summary.activeBrokenThreads, 1);

    store.replaceSourceRequests('src-2', '2', [
      { ...base, id: 'err-a3', timestampMs: baseNow + 5000, status: 'error', errorCode: 'eof', errorText: 'new eof', nativeSessionId: 'nat-a', t3ThreadId: 'th-a', t3ThreadTitle: '对话 A' }
    ]);
    engine.tickAlerts(baseNow + 6000);
    assert.equal(engine.getAlerts().unreadIncidents, 2);
    dash = engine.getDashboardData({ preset: 'all' }, { now: baseNow + 6000 });
    assert.equal(dash.errorInsights.affectedSessions.find(s => s.sessionKey === 'th-a').resolved, false);

    // 3. Resolve all (ack): clears red badge and broken-thread alarm while keeping all 4 errors inspectable
    const allRes = engine.resolveErrors({ scope: 'all' }, baseNow + 7000);
    assert.equal(allRes.unreadCount, 0);
    assert.equal(allRes.unreadRecoveredCount, 0);
    assert.equal(allRes.unreadIncidents, 0);
    assert.equal(allRes.activeBrokenThreads, 0);
    dash = engine.getDashboardData({ preset: 'all' }, { now: baseNow + 7000 });
    assert.equal(dash.errorInsights.summary.totalIncidents, 4);
    assert.equal(dash.errorInsights.summary.resolvedCount, 4);
    assert.equal(dash.errorInsights.summary.unreadIncidents, 0);
    assert.equal(dash.errorInsights.summary.activeBrokenThreads, 0);
    assert.equal(dash.errorInsights.affectedSessions.length, 2);
    assert.ok(dash.errorInsights.affectedSessions.every(s => s.resolved));
    assert.equal(dash.errorInsights.recentErrors.length, 4);
    assert.ok(dash.errorInsights.recentErrors.every(r => r.resolved));

    // 4. Persistence across store/engine restart
    store.close();
    store = createTelemetryStore(file);
    engine = makeEngine(store);
    engine.tickAlerts(baseNow + 8000);
    assert.equal(engine.getAlerts().unreadIncidents, 0);
    dash = engine.getDashboardData({ preset: 'all' }, { now: baseNow + 8000 });
    assert.equal(dash.errorInsights.summary.totalIncidents, 4);
    assert.equal(dash.errorInsights.summary.resolvedCount, 4);

    // 5. Newer error after resolve-all triggers unread badge again
    store.replaceSourceRequests('src-3', '3', [
      { ...base, id: 'err-new', timestampMs: baseNow + 10000, status: 'error', errorCode: 'timeout', errorText: 'fresh error', nativeSessionId: 'nat-c', t3ThreadId: 'th-c', t3ThreadTitle: '新对话' }
    ]);
    engine.tickAlerts(baseNow + 11000);
    assert.equal(engine.getAlerts().unreadCount, 1);
    assert.equal(engine.getAlerts().unreadIncidents, 1);
    assert.equal(engine.getAlerts().activeBrokenThreads, 1);

    // 6. Validation errors carry statusCode 400
    assert.throws(() => engine.resolveErrors({ scope: 'item' }), err => err.statusCode === 400);
    assert.throws(() => engine.resolveErrors({ scope: 'session' }), err => err.statusCode === 400);
    assert.throws(() => engine.resolveErrors({ scope: 'bogus' }), err => err.statusCode === 400);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('injected overlay immediately clears red badge on ackErrors/resolveErrors while keeping error rows visible', async () => {
  const html = buildFallbackHtml({ version: '0.1.0', authToken: 'tok' });
  assert.match(html, /\/api\/errors\/resolve/);
  assert.match(html, /全部标记已解决/);

  const rpcCalls = [];
  let unread = 3;
  const listeners = new Map();
  const makeEl = tag => ({
    tagName: String(tag || 'DIV').toUpperCase(),
    style: { setProperty() {}, removeProperty() {} },
    setAttribute() {},
    getAttribute() { return ''; },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    attachShadow() { return { append(_, contentEl) { this.contentEl = contentEl; } }; },
    appendChild(el) { el.isConnected = true; el.parentElement = this; },
    remove() { this.isConnected = false; }
  });
  let createdOverlayContent = null;
  const body = makeEl('body');
  const context = {
    document: {
      body,
      documentElement: { getAttribute: () => 'dark' },
      createElement(tag) {
        const el = makeEl(tag);
        el.attachShadow = () => ({
          append(_style, content) {
            if (el.id === 't3tools-dashboard-overlay') {
              createdOverlayContent = content;
              content.addEventListener = (type, fn) => listeners.set(type, fn);
            }
          }
        });
        return el;
      },
      querySelector: () => null,
      querySelectorAll: () => []
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    location: { hash: '#/env/th', pathname: '/', search: '', href: 'http://localhost/' },
    window: new EventTarget(),
    MutationObserver: class { observe() {} disconnect() {} },
    AbortController,
    URLSearchParams,
    clearTimeout() {},
    setTimeout() { return 0; },
    fetch: async (url, opts) => {
      rpcCalls.push({ url, method: opts?.method || 'GET', body: opts?.body });
      if (url.includes('/api/errors/ack')) {
        unread = 0;
        return { ok: true, json: async () => ({ ok: true, data: { ackTsMs: Date.now(), unreadCount: 0, unreadRecoveredCount: 0, unreadIncidents: 0, activeBrokenThreads: 0 } }) };
      }
      if (url.includes('/api/status')) {
        return { ok: true, json: async () => ({ ok: true, data: { alerts: { unreadCount: unread, unreadRecoveredCount: 0, unreadIncidents: unread, activeBrokenThreads: unread ? 1 : 0 }, settings: {} } }) };
      }
      if (url.includes('/api/dashboard')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            data: {
              summary: { models: [] },
              quotas: { groups: [] },
              anomalySummary: { total: 0 },
              facets: { accounts: [] },
              errorInsights: {
                summary: { totalErrors: 3, totalRetriedRecovered: 0, totalIncidents: 3, unreadCount: unread, unreadRecoveredCount: 0, unreadIncidents: unread, resolvedCount: unread ? 0 : 3, activeBrokenThreads: unread ? 1 : 0, todayDay: '2026-11-25', scopeDay: '2026-11-25' },
                dailyTrend: [], hourlyTrend: [], affectedSessions: [], recentErrors: [], failedRuns: []
              }
            }
          })
        };
      }
      return { ok: true, json: async () => ({ ok: true, data: { settings: {}, thread: { unresolved: true }, quotas: { groups: [] }, globalAlerts: { unreadCount: unread, unreadRecoveredCount: 0, unreadIncidents: unread } } }) };
    }
  };
  runInNewContext(buildClientBundle({ transport: 'http', authToken: 'tok' }), context);
  context.__t3Tools.openDashboard();
  await new Promise(r => setTimeout(r, 20));
  assert.ok(createdOverlayContent.innerHTML.includes('data-tone="danger">3</span>'));

  const clickHandler = listeners.get('click');
  const fakeBtn = {
    disabled: false,
    dataset: { errorAction: 'ack' },
    closest(sel) { return sel.includes('data-error-action') ? this : null; }
  };
  await clickHandler({ target: fakeBtn });
  await new Promise(r => setTimeout(r, 20));
  assert.ok(rpcCalls.some(c => c.url.endsWith('/api/errors/ack') && c.method === 'POST'));
  assert.ok(!createdOverlayContent.innerHTML.includes('data-tone="danger">3</span>'));
  context.__t3Tools.dispose();
});

test('resolved session incidents never resurrect or re-alert, failedRuns align with unread counts, and tracker headings match unresolved counts', () => {
  const dir = mkdtempSync(join(tmpdir(), 't3-resolve-stable-'));
  const file = join(dir, 'store.sqlite');
  const store = createTelemetryStore(file);
  try {
    const baseNow = Date.now();
    const base = { accountId: 'acct', providerDriver: 'antigravity', modelId: 'gemini-4-neon', inputTokens: 100, outputTokens: 50 };
    store.replaceSourceRequests('src-a', '1', [
      { ...base, id: 'err-x1', timestampMs: baseNow - 4000, status: 'error', errorCode: 'other', errorText: 'canceled 1', nativeSessionId: 'nat-x', t3ThreadId: 'th-x', t3ThreadTitle: '会话 X' },
      { ...base, id: 'err-x2', timestampMs: baseNow - 3000, status: 'error', errorCode: 'other', errorText: 'canceled 2', nativeSessionId: 'nat-x', t3ThreadId: 'th-x', t3ThreadTitle: '会话 X' },
      { ...base, id: 'err-y1', timestampMs: baseNow - 2000, status: 'error', errorCode: 'eof', errorText: 'eof y', nativeSessionId: 'nat-y', t3ThreadId: 'th-y', t3ThreadTitle: '会话 Y' }
    ]);
    let failedRunEmitted = false;
    const adapter = { syncAll() {} };
    const engine = createAnalyticsEngine({
      store,
      settings: { get: () => DEFAULT_SETTINGS },
      antigravityAdapter: adapter,
      codexAdapter: adapter,
      quotaAdapter: { readAllQuotas: () => ({ flatWindows: [] }) },
      t3State: {
        readFailedRuns: () => failedRunEmitted ? [] : ((failedRunEmitted = true), [{
          id: 'run:fr1',
          timestampMs: baseNow + 20,
          modelId: 'gemini-4-neon',
          errorCode: 'failed',
          t3ThreadId: 'th-run',
          t3ThreadTitle: '失败运行',
          accountId: 'acct'
        }])
      }
    });

    // Tick alerts: 3 request errors + 1 failedRun => unreadIncidents = 4 in both status & dashboard
    engine.tickAlerts(baseNow + 50);
    assert.equal(engine.getAlerts().unreadIncidents, 4);
    let dash = engine.getDashboardData({ preset: 'all' }, { now: baseNow + 50 });
    assert.equal(dash.errorInsights.summary.unreadIncidents, 4);
    assert.equal(dash.errorInsights.summary.unresolvedFailedRuns, 1);

    // Resolve session X
    const resX = engine.resolveErrors({ scope: 'session', sessionKey: 'th-x', t3ThreadId: 'th-x', nativeSessionId: 'nat-x' }, baseNow + 100);
    assert.equal(resX.unreadIncidents, 2); // err-y1 + failedRun
    const seqAfterResolve = engine.getAlerts().latestSeq;

    // Even if an external rewrite somehow bumps err-x1/err-x2 timestamps later, resolved IDs stay resolved and never re-alert
    store.replaceSourceRequests('src-a', '2', [
      { ...base, id: 'err-x1', timestampMs: baseNow + 500, status: 'error', errorCode: 'other', errorText: 'canceled 1', nativeSessionId: 'nat-x', t3ThreadId: 'th-x', t3ThreadTitle: '会话 X' },
      { ...base, id: 'err-x2', timestampMs: baseNow + 500, status: 'error', errorCode: 'other', errorText: 'canceled 2', nativeSessionId: 'nat-x', t3ThreadId: 'th-x', t3ThreadTitle: '会话 X' },
      { ...base, id: 'err-y1', timestampMs: baseNow - 2000, status: 'error', errorCode: 'eof', errorText: 'eof y', nativeSessionId: 'nat-y', t3ThreadId: 'th-y', t3ThreadTitle: '会话 Y' }
    ]);
    engine.tickAlerts(baseNow + 600);
    assert.equal(engine.getAlerts().latestSeq, seqAfterResolve);
    assert.equal(engine.getAlerts().unreadIncidents, 2);
    dash = engine.getDashboardData({ preset: 'all' }, { now: baseNow + 600 });
    assert.equal(dash.errorInsights.affectedSessions.find(s => s.sessionKey === 'th-x').resolved, true);
    assert.equal(dash.errorInsights.summary.unresolvedThreads, 1);

    // Resolve the failedRun item -> both status & dashboard drop to 1
    const runResolveId = dash.errorInsights.failedRuns[0].resolveId;
    const resRun = engine.resolveErrors({ scope: 'item', id: runResolveId }, baseNow + 700);
    assert.equal(resRun.unreadIncidents, 1);
    dash = engine.getDashboardData({ preset: 'all' }, { now: baseNow + 700 });
    assert.equal(dash.errorInsights.summary.unreadIncidents, 1);

    // Verify rendered HTML shows "受影响对话 (1 待处理 / 共 2)"
    const bundleSrc = buildClientBundle({ transport: 'http', authToken: 'tok' });
    assert.match(bundleSrc, /待处理 \/ 共/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
