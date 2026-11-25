import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { createTelemetryStore } from '../src/core/telemetry-store.mjs';
import { createSettingsStore } from '../src/core/settings.mjs';
import { createPricingResolver } from '../src/core/pricing.mjs';
import { durationOrTimestampMs, decodeFields } from '../src/core/protobuf.mjs';
import { connectCdpSocket, createCdpHost } from '../src/host/cdp-host.mjs';
import { writeWrapperVbs, launchT3WithDebugPort } from '../src/host/windows-launcher.mjs';
import { startDaemon } from '../src/host/daemon.mjs';
import { buildClientBundle } from '../src/ui/bundle.mjs';
import { createAntigravityAdapter } from '../src/adapters/antigravity.mjs';
import { createCodexAdapter } from '../src/adapters/codex.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 't3-review-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  return root;
}

test('failed schema migration restores the old cache and refuses newer formats', t => {
  const file = join(fixture(t), 'store.db');
  const db = new DatabaseSync(file);
  try {
    db.exec("CREATE TABLE store_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO store_meta VALUES ('schema_version','1'); CREATE TABLE requests(id); INSERT INTO requests VALUES ('original'); CREATE TABLE conflicting(id); CREATE INDEX idx_requests_ts ON conflicting(id)");
    // Force DDL failure after DROP, before the new schema finishes.
    db.exec("CREATE VIEW source_files AS SELECT * FROM conflicting");
    assert.throws(() => createTelemetryStore(file));
    assert.equal(db.prepare('SELECT id FROM requests').get().id, 'original');
    assert.equal(db.prepare('SELECT value FROM store_meta').get().value, '1');
    db.exec("UPDATE store_meta SET value='999'");
    assert.throws(() => createTelemetryStore(file), /newer telemetry schema/);
    assert.equal(db.prepare('SELECT id FROM requests').get().id, 'original');
  } finally { db.close(); }
});

test('removing settings restores isolated defaults for the next read and update', t => {
  const file = join(fixture(t),'settings.json'), store = createSettingsStore(file);
  store.update({theme:'light',overviewPosition:{top:99}});
  rmSync(file);
  assert.equal(store.get().theme,'dark');
  store.get().overviewPosition.top = 2;
  assert.equal(store.update({theme:'light'}).overviewPosition.top,56);
});

test('time protobuf fields are signed and out-of-range tags never alias valid fields', () => {
  assert.equal(durationOrTimestampMs(Buffer.from('08ffffffffffffffffff01','hex')), -1000);
  assert.equal(durationOrTimestampMs(Buffer.from('0a0131','hex')), null);
  assert.throws(() => decodeFields(Buffer.from('888080801000','hex')), /tag/);
});

test('Antigravity rejects non-filename session IDs before opening a conversation', () => {
  const adapter = createAntigravityAdapter({paths:{}});
  for (const id of ['../parent','nested\\child','drive:name']) assert.equal(adapter.readLiveContext('work',id),null);
});

test('Codex chooses the latest live context across rollouts of a session', t => {
  const dir = fixture(t);
  for (const [file, minute] of [['a',1],['b',20]]) {
    writeFileSync(join(dir,file+'.jsonl'),[
      {type:'session_meta',payload:{id:'same'}},
      {timestamp:new Date(Date.UTC(2026,1,1,1,minute)).toISOString(),type:'token_usage_record',
        payload:{thread_id:'same',response_id:file,model_context_window:10000,usage:{input_tokens:minute,output_tokens:10}}}
    ].map(row=>JSON.stringify(row)).join('\n'));
  }
  const adapter = createCodexAdapter({paths:{codexSessionsDir:dir},pricing:createPricingResolver(''),
    t3State:{readThreadIndex:()=>({nativeToThread:new Map()})},
    store:{getSourceStamp:()=>null,replaceSourceRequests(){},pruneMissingSources(){}}});
  adapter.syncAll();
  assert.equal(adapter.readLiveContext('same').lastRequestAtMs,Date.UTC(2026,1,1,1,20));
});

test('injected HTTP dashboard applies settings, authenticates forced refresh and stays disposed', async () => {
  const mounted = new Map(), events = [], timers = new Map();
  const element = () => ({
    style:{setProperty(){}}, setAttribute(){}, addEventListener(){}, querySelector(){return null;},
    querySelectorAll(){return [];}, attachShadow(){return {append(){}};},
    appendChild(el){el.isConnected=true; mounted.set(el.id,el); el.parentElement=this;},
    remove(){this.isConnected=false;mounted.delete(this.id);}
  });
  const footer=element();
  footer.getBoundingClientRect=()=>({width:100,height:30});
  const gate=Promise.withResolvers();
  const context={
    document:{body:element(),documentElement:{getAttribute:()=>'dark'},createElement:element,
      querySelector:()=>null,querySelectorAll:s=>s==='[data-chat-composer-footer]'?[footer]:[]},
    getComputedStyle:()=>({getPropertyValue:()=>''}),location:{hash:'#/env/thread'},
    window:new EventTarget(),MutationObserver:class {observe(){} disconnect(){}},
    AbortController, URLSearchParams, clearTimeout:id=>timers.delete(id),setTimeout:(fn,ms)=>{timers.set(fn,ms);return fn;},
    fetch:async(url,options)=>{
      events.push({url,options});
      if(url.includes('/api/dashboard')) return gate.promise;
      const settings={showComposerBar:false,showOverviewCard:false,pollIntervalMs:7000,overviewPosition:{top:70,right:9}};
      return {ok:true,json:async()=>({ok:true,data:{settings,thread:{},quotas:{groups:[]}}})};
    }
  };
  runInNewContext(buildClientBundle({transport:'http',authToken:'fixture'}),context);
  await delay(0);
  assert.equal(mounted.get('t3tools-composer').style.display,'none');
  assert.equal(mounted.get('t3tools-overview').style.top,'70px');
  assert.equal(mounted.get('t3tools-overview').style.display,'none');
  const [timer] = timers.keys(); timers.delete(timer); await timer();
  assert.deepEqual([...timers.values()],[7000]);
  context.__t3Tools.openDashboard();
  await delay(0);
  const sync = events.find(e=>e.url.endsWith('/api/sync')).options;
  assert.equal(sync.headers['X-T3Tools-Token'],'fixture');
  assert.equal(sync.headers['Content-Type'],'application/json');
  context.__t3Tools.dispose();
  assert.ok(events.find(e => e.url.includes('/api/dashboard')).options.signal.aborted);
  gate.resolve({ok:true,json:async()=>({ok:true,data:{}})});
  await delay(0);
  assert.equal(mounted.size,0);
  assert.equal(timers.size,0);
});

test('null model rates preserve unknown prices and cache pricing defaults', t => {
  const file = join(fixture(t),'rates.json');
  writeFileSync(file,JSON.stringify({sample:{input_cost_per_token:1,output_cost_per_token:2,cache_read_input_token_cost:null}, missing:{input_cost_per_token:null}}));
  const prices = createPricingResolver(file);
  assert.equal(prices.lookupRate('sample').cacheRead,0.1);
  assert.equal(prices.lookupRate('missing'),null);
});

test('heatmap includes the last hour of a 25-hour local day', () => {
  const module = new URL('../src/analytics/heatmap-health.mjs',import.meta.url).href;
  const code = "import {build53WeekHeatmap} from " + JSON.stringify(module) +
    ";const time=+new Date(2026,10,1,23,30); console.log(build53WeekHeatmap([{timestampMs:time}],time).days.at(-1).requests)";
  assert.equal(execFileSync(process.execPath,['--input-type=module','-e',code], {
    env:{...process.env,TZ:'America/New_York'},encoding:'utf8'
  }).trim(),'1');
});

test('CDP handshake settles on close and disable waits for pending discovery', async () => {
  class ClosedSocket extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('close'))); }
  }
  await assert.rejects(connectCdpSocket('ws://localhost', {WebSocketImpl:ClosedSocket}), /关闭/);
  const gate = Promise.withResolvers();
  let connects = 0;
  const host = createCdpHost({paths:{},getFixedPorts:()=>[9000],fetchImpl:()=>gate.promise,
    connectImpl:()=>{connects++; throw Error('unexpected connection');}});
  const poll = host.pollOnce();
  const paused = host.setEnabled(false);
  gate.resolve({ok:true,json:async()=>[{type:'page',id:'one',url:'t3code://app/',webSocketDebuggerUrl:'ws://localhost:9000/page'}]});
  await poll;
  assert.equal((await paused).connected,false);
  await host.pollOnce();
  assert.equal(connects,0);
  await host.stop();
});

test('startup failure after bind releases the database and listener', async t => {
  const root=fixture(t);
  const paths={home:root,codexHome:join(root,'.codex'),appData:root,pluginDataDir:root};
  const options={pathOverrides:paths,enableCdp:false,portOverride:0};
  mkdirSync(join(root,'runtime.json'));
  await assert.rejects(startDaemon(options));
  rmSync(join(root,'telemetry.sqlite')); // An open SQLite handle prevents deletion on Windows.
});

test('Windows launcher preserves quoted arguments and Unicode wrapper paths', {skip:process.platform !== 'win32'}, async t => {
  const root = fixture(t);
  const cliPath = join(root,'参数.mjs'), output = join(root,'argv.json');
  writeFileSync(cliPath,"import {writeFileSync} from 'node:fs';writeFileSync(process.argv[3],JSON.stringify(process.argv.slice(4)))");
  const vbs = writeWrapperVbs({pluginDataDir:root},{cliPath});
  // WSH consumes its own quoting syntax. Supply the raw shortcut argument string.
  const args = ['space and trailing slash\\', '中文', '%T3TOOLS_WRAPPER_TEST%'];
  const raw = [vbs,output,...args].map(a => '"' + a + '"').join(' ');
  execFileSync('cscript.exe',['//NoLogo',raw],{windowsHide:true,windowsVerbatimArguments:true,
    env:{...process.env,T3TOOLS_WRAPPER_TEST:'must remain literal'}});
  let actual;
  for (let i=0;i<100 && !actual;i++) {
    try { actual=JSON.parse(readFileSync(output,'utf8')); } catch { await delay(25); }
  }
  assert.deepEqual(actual,args);
  mkdirSync(join(root,'T3 Code.exe'));
  assert.equal((await launchT3WithDebugPort({t3InstallDir:root})).ok,false);
});

test('compiled tray restricts WebView senders and closes only its owned daemon job', {skip:process.platform !== 'win32'}, t => {
  const dir = fixture(t);
  const exe = join(dir,'tray.exe');
  const build = fileURLToPath(new URL('../scripts/build-tray.ps1',import.meta.url));
  const options = {windowsHide:true,timeout:45000,env:{...process.env,T3TOOLS_TEST_EXE:exe,T3TOOLS_DIR:dir}};
  execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',build,'-OutExe',exe],options);
  const script = `
$ErrorActionPreference = 'Stop'
# Exercise only the process selector from each script. The install/uninstall body never runs.
$installedExe = 'C:\\installed\\T3Tools.exe'
function Get-Process { param($Name,$ErrorAction) @(@{Path=$installedExe},@{Path='C:\\other\\T3Tools.exe'}) }
foreach ($name in 'install','uninstall') {
  $errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseFile((Resolve-Path "scripts/$name.ps1"),[ref]$null,[ref]$errors)
  if ($errors.Count) { throw 'invalid installer syntax' }
  $selector=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-InstalledTrayProcess'},$true)
  $selected=@(& $selector.Body.GetScriptBlock())
  if ($selected.Count -ne 1 -or $selected[0].Path -ne $installedExe) { throw 'wrong process selected' }
}
Remove-Item Function:Get-Process
$assembly = [Reflection.Assembly]::LoadFrom($env:T3TOOLS_TEST_EXE)
$method = $assembly.GetType('T3ToolsTray.WebView2Host').GetMethod('IsDashboardSource',[Reflection.BindingFlags]'Static,NonPublic')
$page = 'http://127.0.0.1:12345/?desktop=1'
if (!$method.Invoke($null,@($page,$page))) { throw 'dashboard rejected' }
foreach ($source in @('http://127.0.0.1:2/','https://127.0.0.1:12345/','http://127.0.0.1:12345/api/status','about:blank')) {
  if ($method.Invoke($null,@($source,$page))) { throw 'unexpected bridge access' }
}
$job = [Activator]::CreateInstance($assembly.GetType('T3ToolsTray.ChildProcessJob'))
$worker = [Diagnostics.Process]::new()
$worker.StartInfo.FileName = 'powershell.exe'
$worker.StartInfo.UseShellExecute = $false
$worker.StartInfo.CreateNoWindow = $true
$worker.StartInfo.RedirectStandardInput = $true
$worker.StartInfo.RedirectStandardOutput = $true
$childCode = '[void][Console]::ReadLine(); $p = Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList "-NoProfile -Command Start-Sleep 12"; [Console]::WriteLine($p.Id); Start-Sleep 12'
$worker.StartInfo.Arguments = '-NoProfile -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childCode))
$descendant = $null
try {
  [void]$worker.Start()
  $job.AddProcess($worker)
  $worker.StandardInput.WriteLine('start')
  $descendant = Get-Process -Id ([int]$worker.StandardOutput.ReadLine())
  $job.Dispose()
  if (!$worker.WaitForExit(3000) -or $descendant.HasExited) { throw 'incorrect process ownership' }
} finally {
  $job.Dispose()
  if ($descendant) { if (!$descendant.HasExited) { $descendant.Kill() }; $descendant.Dispose() }
  if (!$worker.HasExited) { $worker.Kill() }
  $worker.Dispose()
}`;
  const testScript = join(dir,'check.ps1');
  writeFileSync(testScript,script);
  execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',testScript], options);
  // Exercise the real supervisor without taking the installed tray's mutex or opening its window.
  const cli = join(dir, 'fixture-daemon.mjs');
  const cliModule = new URL('../bin/t3tools.mjs', import.meta.url).href;
  writeFileSync(cli, `import { existsSync, unlinkSync } from 'node:fs';
    import { join } from 'node:path';
    const root = process.env.T3TOOLS_DIR;
    for (const name of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME', 'T3_DATA_DIR']) process.env[name] = root;
    process.argv.splice(2, Infinity, 'start', '--port=0', '--no-cdp');
    await import(${JSON.stringify(cliModule)});
    const crash = join(root, 'crash-once');
    setInterval(() => {
      if (existsSync(crash)) { unlinkSync(crash); throw new Error('fixture daemon crash'); }
    }, 50).unref();
  `);
  writeFileSync(join(dir, 'tray-config.json'), JSON.stringify({ cliPath: cli, nodeExe: process.execPath }));
  writeFileSync(testScript, `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$assembly = [Reflection.Assembly]::LoadFrom($env:T3TOOLS_TEST_EXE)
$type = $assembly.GetType('T3ToolsTray.T3ToolsTrayForm')
$flags = [Reflection.BindingFlags]'Instance,NonPublic'
$wake = [Threading.AutoResetEvent]::new($false)
$quit = [Threading.AutoResetEvent]::new($false)
$form = [Activator]::CreateInstance($type,@($true,$wake,$quit))
$log = Join-Path $env:T3TOOLS_DIR 'daemon.out.log'
function Wait-Ready([int]$previous) {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  while ($watch.ElapsedMilliseconds -lt 15000) {
    if (Test-Path -LiteralPath $log) {
      $last = Get-Content -LiteralPath $log -Encoding UTF8 | Select-String 'ready pid=([0-9]+) owned=True' | Select-Object -Last 1
      if ($last) {
        $childId = [int]$last.Matches[0].Groups[1].Value
        if ($childId -ne $previous) { return $childId }
      }
    }
    Start-Sleep -Milliseconds 50
  }
  throw "fixture daemon never became ready (previous=$previous)"
}
try {
  $type.GetMethod('StartSupervisor',$flags).Invoke($form,@())
  $first = Wait-Ready 0
  $child = $type.GetField('_daemonProcess',$flags).GetValue($form)
  if ($child.Id -ne $first) { throw 'fixture child mismatch' }
  [IO.File]::WriteAllText((Join-Path $env:T3TOOLS_DIR 'crash-once'), '1')
  $second = Wait-Ready $first
} finally {
  $type.GetMethod('CleanupBeforeExit',$flags).Invoke($form,@())
  $form.Dispose()
  $wake.Dispose()
  $quit.Dispose()
}
if (Test-Path (Join-Path $env:T3TOOLS_DIR 'runtime.json')) { throw 'stale runtime after exit' }
`);
  execFileSync('powershell.exe',['-STA','-NoProfile','-ExecutionPolicy','Bypass','-File',testScript],options);
  const lifecycle = readFileSync(join(dir, 'daemon.out.log'), 'utf8');
  assert.match(lifecycle, /守护进程已启动/);
  assert.match(lifecycle, /graceful shutdown pid=/);
  assert.match(lifecycle, /code=0 \(0x00000000\) expected/);
  assert.doesNotMatch(lifecycle, /forced kill/);
  const errors = readFileSync(join(dir, 'daemon.err.log'), 'utf8');
  assert.match(errors, /\[uncaughtException\] Error: fixture daemon crash/);
  assert.match(errors, /exited pid=.*code=1 \(0x00000001\) unexpected/);

});
