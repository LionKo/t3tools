import { formatLocalDay } from './heatmap-health.mjs';

const labels = { antigravity: 'Antigravity 对话库', codex: 'Codex Rollout', t3scan: 'T3 扫描缓存', other: '其他来源' };
export function sourceGroup(key = '') {
  if (key?.startsWith('agy:')) return 'antigravity';
  if (key?.startsWith('codex-rollout:')) return 'codex';
  return key === 't3-usage-scan-cache' ? 't3scan' : 'other';
}

const dims = ['model','modelAt','account','driver'];
const dimensions = () => Object.fromEntries(dims.map(k => [k, new Map()]));
const tokens = ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','thinkingTokens'];
const counters = ['calls','knownOutcomeCount','successCount','errors','retried','recordedOnly','anomalies','excludedCompactions',
  ...tokens,'totalTokens','savedUsd','pricedCount','unpricedCount','decodeOut','decodeMs','decodeN','floorOut','floorMs','floorN','ttftSumMs','ttftCount'];
const zero = Object.fromEntries([...counters, 'costUsd'].map(k => [k, 0]));
function empty() { return { ...zero }; }
function sample(r) {
  const s = empty();
  s.calls = 1;
  s.successCount = +(r.outcomeKnown !== false && r.status === 'success');
  s.errors = +(r.outcomeKnown !== false && r.status === 'error');
  s.knownOutcomeCount = s.successCount + s.errors;
  s.recordedOnly = 1 - s.knownOutcomeCount;
  s.retried = +(r.retries > 0);
  s.anomalies = +Boolean(r.cacheAnomaly);
  s.excludedCompactions = +r.excludedCompaction;
  for (const k of tokens) s[k] = r[k] || 0;
  s.totalTokens = s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheWriteTokens;
  s.pricedCount = +(r.costUsd != null);
  s.unpricedCount = 1 - s.pricedCount;
  s.costUsd = r.costUsd || 0;
  s.savedUsd = r.savedUsd || 0;
  if (!s.successCount) return s;
  if (r.ttftMs != null && r.ttftMs >= 0) { s.ttftSumMs = r.ttftMs; s.ttftCount = 1; }
  if (r.tpsKind === 'generation' && r.streamingMs >= 50 && r.outputTokens > 0 && r.outputTokens <= 5*r.streamingMs) {
    s.decodeN = 1; s.decodeMs = r.streamingMs; s.decodeOut = r.outputTokens;
  } else if (r.durationMs >= 500 && r.durationMs <= 300000 && r.outputTokens >= 50 && r.outputTokens <= 5*r.durationMs) {
    s.floorN = 1; s.floorMs = r.durationMs; s.floorOut = r.outputTokens;
  }
  return s;
}
function add(a,b) {
  for (const k of counters) a[k] += b[k];
  a.costUsd += b.costUsd;
}
function finish(a) {
  const prompt = a.totalTokens - a.outputTokens;
  return { ...a, tokens: a.totalTokens, costUsd: a.unpricedCount && !a.pricedCount ? null : a.costUsd,
    avgTtftMs: a.ttftCount ? a.ttftSumMs/a.ttftCount : null, cacheHitPercent: prompt ? 100*a.cacheReadTokens/prompt : null };
}
function shares(map) { return [...map.values()].map(finish).sort((a,b) => b.tokens-a.tokens || a.name.localeCompare(b.name)); }
function median(arr) {
  arr.sort((a,b) => a-b);
  return arr.length ? (arr[(arr.length-1)>>1] + arr[arr.length>>1])/2 : null;
}
function period(ts,bucket) {
  const d = new Date(ts);
  if (bucket === 'hour') return ts - d.getMinutes()*60000 - d.getSeconds()*1000 - d.getMilliseconds();
  d.setHours(0,0,0,0);
  if (bucket === 'week') d.setDate(d.getDate()-(d.getDay()+6)%7);
  return +d;
}
export function buildRequestLedger(rows, range, q, diagnosis, csvOnly = false, siblingRange = range) {
  const by = dimensions(), chartBy = dimensions(), points = new Map(), sources = new Map(), speeds = new Map();
  const totals = empty(), filtered = [];
  const anomalies = { cleared:0, dropped:0, missed:0, excludedCompactions:0 };
  const search = String(q.session || q.q || '').trim().toLowerCase();
  const matches = (key,v) => !q[key] || q[key] === 'all' || q[key] === v;
  const onlyAnomalies = [true,'true','1'].includes(q.onlyAnomalies);
  const span = range.end-range.start;
  const bucket = range.preset === 'all' || span > 120*86400000 ? 'week' : span <= 2*86400000 ? 'hour' : 'day';
  for (const row of rows) {
    const incident = row.status === 'error' || row.retries > 0;
    if ((q.requestId && row.id !== q.requestId) || (!matches('errorCode',incident ? row.errorCode || 'other' : '')) ||
      (q.status === 'retried' ? !row.retries : q.status === 'error_or_retried' ? !incident : !matches('status',row.status))) continue;
    if (search && !['t3ThreadTitle','t3ThreadId','nativeSessionId','modelId','modelRaw','accountId','providerDriver','id','errorText'].some(k=>String(row[k] || '').toLowerCase().includes(search))) continue;
    const account = matches('account',row.accountId), model = matches('model',row.modelId), driver = matches('driver',row.providerDriver);
    const group = sourceGroup(row.sourceKey), source = matches('sourceGroup',group);
    const day = !q.day || q.day === formatLocalDay(row.timestampMs);
    const inRange = range.match(row), inSiblingRange = siblingRange.match(row);
    if (!inRange && !inSiblingRange) continue;
    const r = { ...row, sourceGroup: group, cacheAnomaly: diagnosis.anomalies.get(row.id) || null, excludedCompaction: diagnosis.excludedCompactions.has(row.id) };
    const selected = inRange && account && model && driver;
    if (selected && day && source) {
      if (r.cacheAnomaly) anomalies[r.cacheAnomaly.kind]++;
      if (r.excludedCompaction) anomalies.excludedCompactions++;
    }
    if (onlyAnomalies && !r.cacheAnomaly) continue;
    if (selected && day && source) filtered.push(r);
    if (csvOnly) continue;
    const s = sample(r);
    if (selected && day) {
      if (!sources.has(group)) sources.set(group,{id:group,label:labels[group],calls:0,tokens:0,errors:0});
      const item = sources.get(group);
      item.calls++; item.tokens += s.totalTokens; item.errors += s.errors;
    }
    if (!source) continue;
    let point;
    if (selected) {
      const timeMs = period(r.timestampMs,bucket);
      if (!points.has(timeMs)) points.set(timeMs,{ ...empty(),timeMs,dayKey:formatLocalDay(timeMs),key:String(timeMs),by:dimensions() });
      point = points.get(timeMs);
      add(point,s);
      if (day) {
        add(totals,s);
        if (r.status !== 'error') {
          const name = r.modelId || r.modelRaw || '未知模型';
          if (!speeds.has(name)) speeds.set(name,{name,modelId:name,requests:0,decode:[],floor:[],ttft:[]});
          const speed = speeds.get(name); speed.requests++;
          if (s.decodeN && s.decodeOut >= 50) speed.decode.push(1000*s.decodeOut/s.decodeMs);
          if (s.floorN) speed.floor.push(1000*s.floorOut/s.floorMs);
          if (s.ttftCount) speed.ttft.push(s.ttftSumMs);
        }
      }
    }
    for (const dim of dims) {
      const clearAccount = dim === 'account' || dim === 'modelAt';
      const clearModel = dim === 'model' || dim === 'modelAt';
      if (!(clearAccount ? inSiblingRange : inRange) || (!account && !clearAccount) || (!model && !clearModel) || (!driver && dim !== 'driver')) continue;
      const name = (dim === 'account' ? r.accountId : dim === 'driver' ? r.providerDriver : r.modelId) || '未知';
      const sub = dim === 'modelAt' ? r.accountId : '';
      const id = dim === 'modelAt' ? JSON.stringify([name,sub]) : name;
      for (const map of [chartBy[dim],day && by[dim],point?.by[dim]]) {
        if (!map) continue;
        if (!map.has(id)) map.set(id,{...empty(),id,name,sub,driver:r.providerDriver});
        add(map.get(id),s);
      }
    }
  }
  if (csvOnly) return exportCsv(filtered);
  // Keep empty intervals between observations on the same time scale, including local DST transitions.
  const times = Array.from(points.keys()).sort((a, b) => a - b);
  for (let cursor = times[0]; cursor < times.at(-1);) {
    const next = new Date(cursor);
    if (bucket === 'hour') next.setTime(cursor + 3600000);
    else next.setDate(next.getDate() + (bucket === 'week' ? 7 : 1));
    cursor = +next;
    if (!points.has(cursor)) points.set(cursor, { ...empty(), timeMs: cursor, dayKey: formatLocalDay(cursor), key: String(cursor), by: dimensions() });
  }
  const lists = groups => Object.fromEntries(dims.map(d=>[d,shares(groups[d])]));
  const all = {calls:0,tokens:0,errors:0};
  for (const item of sources.values()) for (const k of Object.keys(all)) all[k]+=item[k];
  const items = [...speeds.values()].map(({modelId,name,decode,floor,ttft,requests})=>{
    const samples = decode.length ? decode : floor;
    return {modelId,name,requests,medianTps:median(samples),isFloor:!decode.length && !!floor.length,medianTtftMs:median(ttft),speedSamples:samples.length,ttftSamples:ttft.length};
  }).sort((a,b)=>(b.medianTps ?? -1)-(a.medianTps ?? -1));
  const chartShares = lists(chartBy);
  const modelsByTokens = chartShares.model.map(({id, name, tokens}) => ({id, name, tokens}));
  return {filtered, anomalies, ledger:{totals:finish(totals),sources:{all,items:[...sources.values()]},bucket,day:q.day || '',modelsByTokens,
    series:[...points.values()].sort((a,b)=>a.timeMs-b.timeMs).map(p=>({...finish(p),by:lists(p.by)})),
    by:lists(by),chartBy:chartShares,speeds:{speedMinTokens:50,items}}};
}
function exportCsv(rows) {
  const keys = 'id dedupeKey timestampMs billingTsMs providerDriver accountId sourceGroup sourceKey modelId modelRaw effort role t3ThreadId t3ThreadTitle nativeSessionId status outcomeKnown retries errorCode errorText inputTokens outputTokens cacheReadTokens cacheWriteTokens thinkingTokens cacheHitPercent contextUsedTokens contextMaxTokens costUsd savedUsd durationMs ttftMs streamingMs tps tpsKind tpsEstimated compactionBefore excludedCompaction cacheAnomaly'.split(' ');
  const quote = value => {
    const text = typeof value === 'string' && /^(?:\s*[=+@-]|[\t\r\n])/.test(value) ? "'" + value : String(value ?? '');
    return '"' + text.replaceAll('"','""') + '"';
  };
  const lines = [keys.map(quote).join(',')];
  for (const row of rows) {
    lines.push(keys.map(key => quote(key === 'cacheAnomaly' ? row.cacheAnomaly?.reason : row[key])).join(','));
  }
  return { filename: 't3tools-requests.csv', rowsCount: rows.length, csv: '\uFEFF' + lines.join('\r\n') + '\r\n' };
}
