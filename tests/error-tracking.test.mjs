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
    for (const [path,action] of [['errors/ack','ackErrors'],['alerts/test','testAlert'],['t3/focus-thread','focusThread']]) {
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
    assert.equal(actions.length,3);
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
