import http from 'node:http';
import {createHttpServer} from '../src/host/http-server.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildRequestLedger,sourceGroup} from '../src/analytics/request-ledger.mjs';
import {buildFallbackHtml} from '../src/ui/fallback-page.mjs';
import {createAnalyticsEngine} from '../src/analytics/engine.mjs';

const start = +new Date(2026,9,1), day=86400000;
const range = {preset:'7d',start,end:start+7*day,match:()=>true};
const rows = [
  {id:'a', outputTokens:100, streamingMs:500, ttftMs:100,costUsd:0.12},
  {id:'b', outputTokens:150, streamingMs:500, ttftMs:300, retries:1},
  {id:'c', outputTokens:100, durationMs:2000, modelId:'beta', accountId:'work',providerDriver:'codex',sourceKey:'codex-rollout:xyz'},
  {id:'d', status:'error', timestampMs:start+day,errorCode:'other',errorText:'line 1, "quote"\r\nline 2'},
  {id:'e',status:'recorded', outcomeKnown:false,sourceKey:'t3-usage-scan-cache',modelId:'beta',timestampMs:start+day}
].map(r=>({accountId:'main',modelId:'alpha',modelRaw:'raw-name',providerDriver:'antigravity',sourceKey:'agy:file',timestampMs:start,inputTokens:100,cacheReadTokens:200,cacheWriteTokens:100,outputTokens:0,thinkingTokens:7,tpsKind:'generation',status:'success',...r}));
const diag={anomalies:new Map([['a',{kind:'cleared'}]]),excludedCompactions:new Set(['b'])};
const build=(q={})=>buildRequestLedger(rows,range,q,diag);
test('ledger reconciles tokens, prices, outcomes, timing thresholds and true per-request medians',()=>{
  const {ledger:l}=build(),t=l.totals;
  assert.deepEqual([t.calls,t.knownOutcomeCount,t.errors,t.successCount,t.recordedOnly,t.retried,t.excludedCompactions,t.anomalies],[5,4,1,3,1,1,1,1]);
  assert.deepEqual([t.totalTokens,t.thinkingTokens,t.cacheHitPercent,t.costUsd,t.pricedCount,t.unpricedCount],[2350,35,50,.12,1,4]);
  assert.deepEqual([t.decodeOut,t.decodeMs,t.decodeN,t.floorOut,t.floorMs,t.floorN,t.avgTtftMs],[250,1000,2,100,2000,1,200]);
  assert.deepEqual(l.speeds.items.map(r=>[r.name,r.medianTps,r.isFloor,r.medianTtftMs]),[['alpha',250,false,200],['beta',50,true,null]]);
  assert.equal(build({requestId:'b'}).ledger.totals.costUsd,null);
  assert.equal(build({q:'no-such-row'}).ledger.totals.costUsd,0);
  assert.equal(build({q:'RAW-NAME'}).filtered.length,5);
  assert.equal(build({q:'QUOTE'}).filtered[0].id,'d');
});
test('dimension and day filters preserve sibling rankings, sources and temporal context',()=>{
  const l=build({day:'2026-10-01',model:'alpha'}).ledger;
  assert.equal(l.bucket,'day');assert.equal(l.totals.calls,2);
  assert.deepEqual(l.series.map(p=>p.calls),[2,1]);
  assert.deepEqual(l.by.model.map(r=>[r.name,r.calls]),[['alpha',2],['beta',1]]);
  assert.deepEqual(l.chartBy.model.map(r=>[r.name,r.calls]),[['alpha',3],['beta',2]]);
  const scoped=build({driver:'codex',account:'work',model:'beta'}).ledger;
  assert.equal(scoped.totals.calls,1);assert.equal(scoped.by.modelAt[0].sub,'work');
  assert.equal(build({account:'work'}).ledger.by.account.length,2);
  assert.equal(build({driver:'codex'}).ledger.by.driver.length,2);
  const sources=build({sourceGroup:'codex'});assert.equal(sources.filtered[0].id,'c');assert.equal(sources.ledger.sources.all.calls,5);
  assert.deepEqual(sources.ledger.sources.items.map(x=>x.calls),[3,1,1]);
  assert.equal(sourceGroup('custom'),'other');
  assert.deepEqual(build({onlyAnomalies:true}).filtered.map(r=>r.id),['a']);
});
test('engine paginates independently of ledger and CSV totals', () => {
  const history = Array.from({length:121}, (_,i)=>({...rows[i%5],id:'request-'+i,nativeSessionId:'session'}));
  const engine = createAnalyticsEngine({
    store:{listAllRequests:()=>history,getRevision:()=>1},settings:{get:()=>({})},
    t3State:{},antigravityAdapter:{},codexAdapter:{},quotaAdapter:{readAllQuotas:()=>({flatWindows:[]})}
  });
  history[0].accountId = '__proto__';
  const q={preset:'all',page:3,pageSize:50};
  const data=engine.getDashboardData(q,{now:start+2*day});
  assert.equal(data.accountUsage.__proto__.requests,1);
  const overflow=engine.getDashboardData({...q,page:'Infinity',pageSize:50.8},{now:start+2*day});
  assert.deepEqual(overflow.requests,data.requests);
  assert.equal(data.requests.items.length,21);assert.equal(data.requests.totalPages,3);
  assert.equal(data.requestsLedger.totals.calls,121);assert.equal(data.requestsLedger.bucket,'week');
  assert.equal(data.overviewLedger.totals.calls,121);
  // Request-tab filters (model/status/onlyAnomalies) narrow requestsLedger without polluting overviewLedger
  const filteredDash = engine.getDashboardData({ ...q, model: 'beta', status: 'error' }, { now: start + 2 * day });
  assert.equal(filteredDash.overviewLedger.totals.calls, 121);
  assert.equal(filteredDash.requestsLedger.totals.calls, 0);
  assert.equal(data.requests.items[0].sourceGroup,'antigravity');
  assert.deepEqual(data.facets.drivers,['antigravity','codex']);
  assert.equal(engine.exportRequestsCsv(q,{now:start+2*day}).rowsCount,121);
});
test('hourly gaps and sample boundaries retain zero TTFT and exclude implausible timings',()=>{
  const ts = +new Date(2026,9,1,10);
  const samples=[
    {outputTokens:250,streamingMs:50,ttftMs:0},
    {outputTokens:251,streamingMs:50},
    {outputTokens:50,durationMs:500,tpsKind:'e2e-estimate'},
    {outputTokens:49,durationMs:500,tpsKind:'e2e-estimate'},
    {outputTokens:100,durationMs:300001,tpsKind:'e2e-estimate'},
    {outputTokens:100,streamingMs:50,ttftMs:17,status:'error',timestampMs:ts+7200000}
  ].map((r,i)=>({...rows[0],id:String(i),ttftMs:null,streamingMs:null,timestampMs:ts,...r}));
  const {ledger}=buildRequestLedger(samples,{...range,preset:'24h',end:start+day},{},diag);
  assert.equal(ledger.bucket,'hour');
  assert.deepEqual(ledger.series.map(p=>p.calls),[5,0,1]);
  assert.deepEqual([ledger.totals.decodeN,ledger.totals.floorN,ledger.totals.ttftCount,ledger.totals.avgTtftMs],[1,1,1,0]);
  assert.equal(ledger.speeds.items[0].medianTps,5000);
});
test('CSV exports all matching rows with BOM and quoted multiline fields',()=>{
  const csv=buildRequestLedger(rows,range,{page:20,pageSize:1},diag,true);
  assert.equal(csv.rowsCount,5);assert.equal(csv.csv.charCodeAt(0),0xfeff);
  const formula = buildRequestLedger([{...rows[0],t3ThreadTitle:' =1+1',errorText:'@sample'}],range,{},diag,true);
  assert.ok(formula.csv.includes("\"' =1+1\""));
  assert.ok(formula.csv.includes("\"'@sample\""));
  assert.ok(csv.csv.includes('"line 1, ""quote""\r\nline 2"'));
  assert.equal(buildRequestLedger(rows,range,{driver:'codex'},diag,true).rowsCount,1);
});
test('both inline standalone scripts and shared ledger renderers handle data, detail and empty states',()=>{
  const html=buildFallbackHtml();for(const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)){ if(script[0].includes('type="application/json">') || script[0].split('>')[0].includes('application/json')) JSON.parse(script[1]); else new Function(script[1]); }
  const topHeader = html.match(/<header class="app-top">[\s\S]*?<\/header>/)?.[0] || '';
  assert.equal(topHeader.includes('top-preset-select'), false);
  assert.equal(topHeader.includes('top-account-select'), false);
  assert.equal(topHeader.includes('hide-to-tray'), false);
  assert.equal(topHeader.includes('toggle-theme'), false);
  assert.ok(html.includes('id="view-data-head"'));
  assert.ok(html.includes('id="settings-theme-segs"'));
  const src=readFileSync(new URL('../src/ui/shared-views.js',import.meta.url),'utf8');
  const { renderRequestsViewHtml: render, renderOverviewCoreHtml, renderModelsAnalysisHtml, renderDashboardHtml, bindOverview, formatPeriodRangeLabel } = new Function(src+';return { renderRequestsViewHtml, renderOverviewCoreHtml, renderModelsAnalysisHtml, renderDashboardHtml, bindOverview, formatPeriodRangeLabel }')();
  const {ledger,filtered}=build();const data={
    overviewLedger:ledger,
    requestsLedger:ledger,
    range:{preset:'7d',start,end:start+7*day},
    summary:{kpis:{totalRequests:5},models:[{modelId:'alpha',requests:3,knownOutcomeCount:3,success:2,errors:1,retryRequests:1,successRate:66.7,retryRate:33.3,healthStatus:'degraded',errorCodes:{other:1},retryErrorCodes:{},totalTokens:1850,tokenSharePercent:78.7,costUsd:0.12,costSharePercent:100,cacheHitPercent:50,avgTps:250,avgTpsKind:'generation',peakTps:300,avgTtftMs:200}]},
    heatmap:{startDate:'2026-10-01',endDate:'2026-10-02',activeDays:2,maxTokens:1500,maxRequests:3,maxCost:0.12,maxErrors:1,days:[{date:'2026-10-01',requests:3,tokens:1500,costUsd:0.12,errors:0},{date:'2026-10-02',requests:2,tokens:850,costUsd:0,errors:1}]},
    quotas:{groups:[{accountId:'main',shortName:'main',displayName:'main',driver:'antigravity',minRemainingPercent:80,windows:[{remainingPercent:80}]}]},
    requests:{items:filtered,total:5,page:1,pageSize:50,totalPages:1}
  };
  assert.equal(html.includes('view-live'), false);
  assert.equal(html.includes('实时监控'), false);
  // bindOverview switches heatmap metrics synchronously in-place (tokens -> requests -> errors)
  const hmState = { heatmapMetric: 'tokens' };
  const hmWrap = { scrollLeft: 42 };
  const hmCard = { outerHTML: '', querySelector: sel => sel === '.pt-heatmap-wrap' ? hmWrap : null };
  const fakeRoot = {
    onclick: null,
    onkeydown: null,
    querySelector: sel => sel === '[data-pt-heatmap-card]' ? hmCard : sel === '[data-pt-heatmap-card] .pt-heatmap-wrap' ? hmWrap : null
  };
  const fakeHost = { querySelector: sel => sel === '[data-pt-overview-root]' ? fakeRoot : null };
  bindOverview(fakeHost, data, hmState, { render() {}, openView() {}, applyAccount() {} });
  let stopped = false;
  const reqBtn = { disabled: false, getAttribute: k => k === 'data-pt-heatmap' ? 'requests' : null, closest: sel => sel.includes('data-pt-heatmap') ? reqBtn : null };
  fakeRoot.onclick({ target: reqBtn, stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
  assert.equal(hmState.heatmapMetric, 'requests');
  assert.ok(hmCard.outerHTML.includes('pt-tab active" role="tab" aria-selected="true" data-pt-heatmap="requests"'));
  assert.ok(hmCard.outerHTML.includes('峰值 3 次/日'));
  const renderRing = new Function(src+'; return renderQuotaRingSvg;')();
  assert.ok(renderRing('a"b','muted').includes('a&quot;b'));
  // Plan A split: Requests view stays focused on the ledger table without duplicating KPI cards, trend chart, or speed table
  const list=render(data,{});
  for(const cls of ['pt-led-head-card','pt-led-vias','pt-led-hscroll','pt-led-export','ttft lc-opt2'])assert.ok(list.includes(cls),cls);
  for(const removed of ['pt-led-strip','pt-led-trend','pt-led-speed'])assert.equal(list.includes(removed),false,'requests should not duplicate '+removed);
  assert.equal(list.includes('data-pt-anomaly-count'),false,'zero anomalies should not show 0 count in filter');
  assert.ok(list.includes('>掉缓存</button>'));
  const listWithAnom=render({...data,anomalySummary:{total:2}},{});
  assert.ok(listWithAnom.includes('掉缓存 <b data-pt-anomaly-count>2</b>'));
  assert.ok(html.includes('id="nav-badge-anomalies" data-tone="danger" hidden style="display:none"></span>'));
  const dashZeroAnom=renderDashboardHtml({...data,anomalySummary:{total:0}},{tab:'requests'});
  assert.ok(dashZeroAnom.includes('data-pt-tab-anom-count hidden style="display:none"></span>'));
  const dashWithAnom=renderDashboardHtml({...data,anomalySummary:{total:3}},{tab:'requests'});
  assert.ok(dashWithAnom.includes('data-tone="danger" data-pt-tab-anom-count>3</span>'));
  const detail=render(data,{detailId:'d'});assert.ok(detail.includes('pt-led-dl'));assert.ok(detail.includes('&quot;quote&quot;'));assert.ok(detail.includes('data-pt-led-back'));
  // Plan A split: Overview owns interactive KPI strip, trend + rank drill-down, account chip toggle, and heatmap error gating
  const ov = renderOverviewCoreHtml(data, { account: 'main', heatmapMetric: 'errors' });
  for(const cls of ['pt-led-strip','pt-led-chart','pt-led-rank','data-pt-led-day','data-pt-ov-jump="anomaly"','data-pt-ov-account="main"','pt-quota-chip active'])assert.ok(ov.includes(cls),cls);
  assert.ok(src.includes('@container(max-width:740px){.pt-led-strip{grid-template-columns:repeat(6,minmax(0,1fr))}'));
  assert.ok(src.includes('@container(max-width:480px){.pt-led-strip{grid-template-columns:repeat(2,minmax(0,1fr))}'));
  assert.equal(src.includes('@container(max-width:960px){.pt-led-strip'), false);
  assert.equal(ov.includes('data-pt-heatmap-day="2026-10-01"'), false);
  assert.ok(ov.includes('data-pt-heatmap-day="2026-10-02"'));
  // Plan A split: Models Analysis owns median speed / median TTFT ranking & clickable model drill-down
  const modelsHtml = renderModelsAnalysisHtml(data, { modelSort: 'medianTps', modelSortDir: -1 });
  for(const marker of ['data-pt-model-sort="medianTps"','data-pt-model-sort="medianTtftMs"','data-pt-model-requests="alpha"','250 tok/s','2 速度 · 2 首字'])assert.ok(modelsHtml.includes(marker),marker);
  const dash = renderDashboardHtml({ ...data, range: { preset: 'last:6h', start, end: start + 6 * 3600000 }, facets: { accounts: ['main', 'work'], models: [] } }, { tab: 'overview', preset: 'last:6h', account: 'work' });
  assert.ok(dash.includes('pt-view-head'));
  assert.ok(dash.includes('data-pt-period="weeklyQuota"'));
  assert.ok(dash.includes('data-pt-range-trigger="1"'));
  assert.ok(dash.includes('data-pt-account-trigger="1"'));
  assert.ok(dash.includes('近 6 小时'));
  assert.equal(formatPeriodRangeLabel('last:12h'), '近 12 小时');
});

test('requests.csv uses host and origin guards before dispatch and preserves the attachment bytes',async t=>{
  const server=createHttpServer({port:0,engine:{exportRequestsCsv:q=>buildRequestLedger(rows,range,q,diag,true)}});
  const {port}=await server.listen();t.after(()=>server.close());
  const url='http://127.0.0.1:'+port+'/api/requests.csv?driver=codex';
  const csv=await fetch(url);
  assert.equal(csv.status,200);
  assert.equal(csv.headers.get('Content-Type'),'text/csv; charset=utf-8');
  assert.equal(csv.headers.get('Content-Disposition'),'attachment; filename="t3tools-requests.csv"');
  assert.deepEqual(Buffer.from(await csv.arrayBuffer()),Buffer.from(buildRequestLedger(rows,range,{driver:'codex'},diag,true).csv));
  assert.equal((await fetch(url,{headers:{Origin:'https://untrusted.example'}})).status,403);
  const badHost=await new Promise((resolve,reject)=>http.get(url,{headers:{Host:'untrusted.example'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject));
  assert.equal(badHost,403);
});
