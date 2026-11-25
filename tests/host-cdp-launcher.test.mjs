import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isAnyWrapperShortcut,
  injectDebugArg,
  removeDebugArg,
  hasDebugArg,
  isVerifiedT3Target,
  buildWrapperVbsContent,
  extractExtraArgsFromWrapper,
  patchT3Launchers,
  patchT3ShortcutsDebugArg,
  restoreT3Launchers
} from '../src/host/windows-launcher.mjs';
import { startDaemon, probeRunningDaemon } from '../src/host/daemon.mjs';
import { isT3CodePageTarget, createCdpHost, CDP_BRIDGE_BINDING } from '../src/host/cdp-host.mjs';

test('Windows launcher debug arg helpers & target verification', () => {
  assert.equal(injectDebugArg(''), '--remote-debugging-port=0');
  assert.equal(injectDebugArg('--foo'), '--foo --remote-debugging-port=0');
  assert.equal(injectDebugArg('--foo --remote-debugging-port=0'), '--foo --remote-debugging-port=0');
  assert.equal(hasDebugArg('--remote-debugging-port=9222'), true);
  assert.equal(hasDebugArg('--note "open --remote-debugging-port=22 here"'), false);
  assert.equal(hasDebugArg('--remote-debugging-port-other'), false);
  assert.equal(isAnyWrapperShortcut('wscript.exe', 'other.vbs "launch-t3.vbs"'), false);
  assert.equal(removeDebugArg('--foo --remote-debugging-port=0 --bar'), '--foo --bar');
  // Preserve internal double-spaces AND literal flag text inside quoted user arguments (fixes P2 #18)
  assert.equal(removeDebugArg('--project "Team  North" --remote-debugging-port=0'), '--project "Team  North"');
  assert.equal(removeDebugArg('--note "--remote-debugging-port=0" --remote-debugging-port=0'), '--note "--remote-debugging-port=0"');
  assert.equal(isVerifiedT3Target('C:\\Users\\X\\AppData\\Local\\Programs\\t3code\\T3 Code (Nightly).exe'), true);
  assert.equal(isVerifiedT3Target('C:\\Users\\X\\AppData\\Local\\Programs\\t3code\\helper.exe'), false);
  assert.equal(isVerifiedT3Target('C:\\Users\\X\\AppData\\Local\\Programs\\t3code\\Uninstall T3 Code (Nightly).exe'), false);
  assert.equal(isVerifiedT3Target('C:\\Windows\\System32\\notepad.exe'), false);
});

test('Scheme A wrapper launcher: install converts shortcut preserving icon & args, is idempotent, and uninstall restores original exe', () => {
  const dir = mkdtempSync(join(tmpdir(), 't3tools-lnk-'));
  try {
    const desktop = join(dir, 'Desktop');
    mkdirSync(desktop, { recursive: true });
    const scPath = join(desktop, 'T3 Code (Nightly).lnk');
    writeFileSync(scPath, 'LNK');

    const origExe = 'C:\\Programs\\t3code\\T3 Code (Nightly).exe';
    const state = {
      target: origExe,
      arguments: '--project "Team  North"',
      workingDirectory: 'C:\\Programs\\t3code',
      iconLocation: ',0'
    };

    const mockRunner = (script, env) => {
      if (env.T3TOOLS_SHORTCUTS) {
        return {
          ok: true,
          stdout: JSON.stringify([{ path: scPath, ...state }])
        };
      }
      if (env.T3TOOLS_UPDATES) {
        const item = JSON.parse(env.T3TOOLS_UPDATES)[0];
        state.target = item.target;
        state.arguments = item.arguments;
        state.iconLocation = item.iconLocation;
        state.workingDirectory = item.workingDirectory;
        return { ok: true, stdout: '1' };
      }
      if (env.T3TOOLS_RESTORE) {
        const item = JSON.parse(env.T3TOOLS_RESTORE)[0];
        state.target = item.target;
        state.arguments = item.arguments;
        state.iconLocation = item.iconLocation;
        state.workingDirectory = item.workingDirectory;
        return { ok: true, stdout: '1' };
      }
      return { ok: true, stdout: '' };
    };

    const vbsPath = join(dir, 'launch-t3.vbs');
    const paths = {
      home: dir,
      appData: join(dir, 'AppData'),
      pluginDataDir: dir,
      t3InstallDir: dir,
      launcherBackupPath: join(dir, 'backup.json'),
      launcherVbsPath: vbsPath
    };

    // Install -> converts to wscript.exe + launch-t3.vbs while keeping original T3 icon and args
    const p1 = patchT3Launchers(paths, { runner: mockRunner, sandbox: true });
    assert.equal(p1.ok, true);
    assert.equal(p1.patched, 1);
    assert.ok(state.target.toLowerCase().endsWith('wscript.exe'));
    assert.ok(state.arguments.includes(`"${vbsPath}"`));
    assert.equal(extractExtraArgsFromWrapper(state.arguments, vbsPath), '--project "Team  North"');
    assert.equal(state.iconLocation, `${origExe},0`);

    // Simulate a shortcut write that completed just before the helper reported failure.
    const interrupted = restoreT3Launchers(paths, {runner:mockRunner,sandbox:true});
    assert.equal(interrupted.ok,true);
    const failed = patchT3Launchers(paths,{sandbox:true,runner:(script,env)=>{
      const result=mockRunner(script,env);
      return env.T3TOOLS_UPDATES ? {ok:false,stderr:'interrupted'} : result;
    }});
    assert.equal(failed.ok,false);
    assert.equal(restoreT3Launchers(paths,{runner:mockRunner,sandbox:true}).ok,true);
    assert.equal(state.target,origExe);
    assert.equal(patchT3Launchers(paths,{runner:mockRunner,sandbox:true}).ok,true);

    // Second install is idempotent
    const p2 = patchT3Launchers(paths, { runner: mockRunner, sandbox: true });
    assert.equal(p2.ok, true);
    assert.equal(p2.patched, 0);
    assert.equal(p2.alreadyPatched, 1);

    // User adds an extra argument AFTER install
    state.arguments += ' --user-flag=1';

    // Uninstall restores original T3 exe & preserves user's extra argument
    const r = restoreT3Launchers(paths, { runner: mockRunner, sandbox: true });
    assert.equal(r.ok, true);
    assert.equal(r.restored, 1);
    assert.equal(state.target, origExe);
    assert.equal(state.iconLocation, ',0');
    assert.equal(state.arguments, '--project "Team  North" --user-flag=1');

    // Verify generated VBS content runs hidden (style 0)
    const vbs = buildWrapperVbsContent({ nodeExe: 'C:\\node.exe', cliPath: 'E:\\cli.mjs' });
    assert.ok(vbs.includes('shell.Run "%T3TOOLS_WRAPPER_CMD%", 0, False'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Scheme A daemon: single-instance probe and auto-exit watchdog when T3 Code closes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't3tools-autoexit-'));
  let daemon;
  try {
    let t3Running = true;
    let exited = false;
    daemon = await startDaemon({
      pathOverrides: { t3Root: join(dir, '.t3'), codexSessionsDir: join(dir, '.codex'), pluginDataDir: dir, home: dir, appData: dir },
      portOverride: 0,
      enableCdp: false,
      autoExitWhenT3Gone: true,
      autoExitGraceMs: 10,
      autoExitPollMs: 40,
      checkT3Running: () => t3Running,
      onAutoExit: () => { exited = true; }
    });

    // Single-instance probe detects live daemon
    const probed = await probeRunningDaemon(join(dir, 'runtime.json'));
    assert.ok(probed);
    assert.equal(probed.pid, process.pid);
    const staleFile = join(dir, 'stale.json');
    writeFileSync(staleFile, JSON.stringify({...probed, startedAtMs: 1}));
    assert.equal(await probeRunningDaemon(staleFile), null);
    writeFileSync(staleFile, JSON.stringify({...probed, url:'https://example.invalid'}));
    let fetched = false;
    assert.equal(await probeRunningDaemon(staleFile, {fetchImpl: () => { fetched = true; }}), null);
    assert.equal(fetched, false);

    // Simulate T3 Code exiting -> after 2 consecutive checks daemon stops cleanly
    t3Running = false;
    await new Promise(res => setTimeout(res, 220));
    assert.equal(exited, true);
    const afterProbe = await probeRunningDaemon(join(dir, 'runtime.json'));
    assert.equal(afterProbe, null);
  } finally {
    await daemon?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isT3CodePageTarget accepts t3code://app desktop protocol or verified T3 HTTP origin and rejects unrelated apps', () => {
  assert.equal(
    isT3CodePageTarget({ type: 'page', url: 't3code://app/#/env1/thread1', title: 'T3Tools / Thread', webSocketDebuggerUrl: 'ws://127.0.0.1:5481/page/1' }, ''),
    true
  );
  assert.equal(
    isT3CodePageTarget({ type: 'page', url: 'http://127.0.0.1:3773/env1/thread1', title: 'T3 Code (Nightly)', webSocketDebuggerUrl: 'ws://127.0.0.1:9999/page/1' }, 'http://127.0.0.1:3773'),
    true
  );
  assert.equal(
    isT3CodePageTarget({ type: 'page', url: 'http://127.0.0.1:8080/', title: 'Other Local App', webSocketDebuggerUrl: 'ws://127.0.0.1:9999/page/2' }, 'http://127.0.0.1:3773'),
    false
  );
  assert.equal(
    isT3CodePageTarget({ type: 'page', url: 'devtools://devtools/bundled/inspector.html', title: 'DevTools', webSocketDebuggerUrl: 'ws://127.0.0.1:9999/page/3' }, 'http://127.0.0.1:3773'),
    false
  );
  // Reject our own fallback web page even if serverOrigin somehow matched
  assert.equal(
    isT3CodePageTarget({ type: 'page', url: 'http://127.0.0.1:17373/', title: 'T3Tools v0.1.0', webSocketDebuggerUrl: 'ws://127.0.0.1:9999/page/5' }, 'http://127.0.0.1:17373'),
    false
  );
  // Missing serverOrigin MUST NOT trust any loopback page by title alone (fixes P1 #4)
  assert.equal(
    isT3CodePageTarget({ type: 'page', url: 'http://127.0.0.1:9999/', title: 'T3 Code (Nightly)', webSocketDebuggerUrl: 'ws://127.0.0.1:9999/page/4' }, ''),
    false
  );
});

test('createCdpHost isolates execution world, rejects untrusted context RPC, and falls through stale/failed ports', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't3tools-cdp-'));
  try {
    const staleDir = join(dir, 'stale');
    const badAttachDir = join(dir, 'badattach');
    const liveDir = join(dir, 'live');
    mkdirSync(staleDir, { recursive: true });
    mkdirSync(badAttachDir, { recursive: true });
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(join(staleDir, 'DevToolsActivePort'), '11111\n/stale\n');
    writeFileSync(join(badAttachDir, 'DevToolsActivePort'), '22222\n/badattach\n');
    writeFileSync(join(liveDir, 'DevToolsActivePort'), '45678\n/live\n');
    const rtPath = join(dir, 'server-runtime.json');
    writeFileSync(rtPath, JSON.stringify({ origin: 'http://127.0.0.1:3773' }));

    const sentMethods = [];
    let bindingHandler = null;
    let gate;
    const rpcCalls = [];
    const mockClient = {
      socket: { readyState: 1, addEventListener() {}, close() {} },
      onEvent(fn) { bindingHandler = fn; },
      async send(method, params) {
        sentMethods.push({ method, params });
        if (method === 'Runtime.evaluate' && params.expression.includes('function navigate(')) {
          assert.equal(params.contextId,42);
          const location = { hash:'#/threads/env/old', protocol:'t3code:', pathname:'/' };
          const invoke = new Function('document','location','return ' + params.expression);
          const method = invoke({querySelectorAll:()=>[]},location);
          if (method) assert.equal(location.hash,'/threads/env/target');
          return { result:{value:method} };
        }
        if (method === 'Runtime.enable' && bindingHandler) {
          await bindingHandler({
            method: 'Runtime.executionContextCreated',
            params: { context: { id: 7, auxData:{frameId:'frame-top'}, name: 't3tools-isolated', origin: 'http://127.0.0.1:3773' } }
          });
        }
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-top', url: 'http://127.0.0.1:3773/env/th1' } } };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
        return { result: { value: true } };
      }
    };

    const host = createCdpHost({
      paths: {
        devToolsPortFile: join(staleDir, 'DevToolsActivePort'),
        electronUserDataCandidates: [staleDir, badAttachDir, liveDir],
        serverRuntimePath: rtPath
      },
      buildClientBundle: () => 'globalThis.__t3Tools={version:"0.1.0",healthy:true};',
      handleRpc: async (action) => { rpcCalls.push(action); await gate?.promise; return { echo: action }; },
      fetchImpl: async (url) => {
        if (url.includes(':11111')) throw new Error('ECONNREFUSED stale port');
        const port = url.includes(':22222') ? 22222 : 45678;
        return {
          ok: true,
          json: async () => [{
            id: `target-${port}`,
            type: 'page',
            title: 'T3 Code (Nightly)',
            url: 'http://127.0.0.1:3773/env/th1',
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/target-${port}`
          }]
        };
      },
      connectImpl: async (wsUrl) => {
        if (wsUrl.includes(':22222')) throw new Error('attach refused on 22222');
        return mockClient;
      }
    });

    const st = await host.pollOnce();
    assert.equal(st.connected, true);
    assert.equal(st.devToolsPort, 45678);
    assert.ok(st.lastError.includes('22222'));
    assert.ok(sentMethods.some(m => m.method === 'Runtime.evaluate' && m.params.contextId === 7 && String(m.params.expression).includes('dispose')));
    assert.ok(sentMethods.some(m => m.method === 'Page.createIsolatedWorld' && m.params.frameId === 'frame-top'));
    assert.ok(sentMethods.some(m => m.method === 'Runtime.addBinding' && m.params.name === CDP_BRIDGE_BINDING && m.params.executionContextName === 't3tools-isolated'));

    assert.equal((await host.focusThread({threadId:'target'})).method,'route');
    assert.ok(sentMethods.some(call=>call.method==='Page.bringToFront'));
    // Untrusted frame / main-world executionContextId (99 != 42) MUST be ignored
    await bindingHandler({
      method: 'Runtime.bindingCalled',
      params: { name: CDP_BRIDGE_BINDING, executionContextId: 99, payload: JSON.stringify({ id: 'bad_1', action: 'getStatus' }) }
    });
    assert.equal(rpcCalls.length, 0);

    // Verified isolated world executionContextId (42) succeeds
    await bindingHandler({
      method: 'Runtime.bindingCalled',
      params: { name: CDP_BRIDGE_BINDING, executionContextId: 42, payload: JSON.stringify({ id: 'ok_1', action: 'getStatus' }) }
    });
    assert.deepEqual(rpcCalls, ['getStatus']);

    gate = Promise.withResolvers();
    const delayed = bindingHandler({method:'Runtime.bindingCalled', params:{name:CDP_BRIDGE_BINDING,
      executionContextId:42, payload:JSON.stringify({id:'old-document',action:'getStatus'})}});
    await bindingHandler({method:'Runtime.executionContextDestroyed',params:{executionContextId:42}});
    gate.resolve();
    await delayed;
    assert.equal(sentMethods.some(call=>call.params?.expression?.includes('old-document')),false);

    // Removing server-runtime.json closes active CDP clients cleanly (fixes P2 #4)
    let closedCount = 0;
    mockClient.socket.close = () => { closedCount++; };
    rmSync(rtPath, { force: true });
    const stAfter = await host.pollOnce();
    assert.equal(stAfter.connected, false);
    assert.equal(stAfter.attachedTargets, 0);
    assert.equal((await host.focusThread({threadId:"target"})).focused,false);
    assert.equal(closedCount, 1);

    await host.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Tray debug-arg shortcut mode preserves original T3 Code exe target, is idempotent, and restores cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 't3tools-argmode-'));
  try {
    const desktop = join(dir, 'Desktop');
    mkdirSync(desktop, { recursive: true });
    const scPath = join(desktop, 'T3 Code (Nightly).lnk');
    writeFileSync(scPath, 'LNK');

    const origExe = 'C:\\Programs\\t3code\\T3 Code (Nightly).exe';
    const state = {
      target: origExe,
      arguments: '--project "Team  North"',
      workingDirectory: 'C:\\Programs\\t3code',
      iconLocation: `${origExe},0`
    };

    const mockRunner = (script, env) => {
      if (env.T3TOOLS_SHORTCUTS) {
        return { ok: true, stdout: JSON.stringify([{ path: scPath, ...state }]) };
      }
      if (env.T3TOOLS_UPDATES) {
        const item = JSON.parse(env.T3TOOLS_UPDATES)[0];
        state.arguments = item.arguments;
        state.workingDirectory = item.workingDirectory;
        return { ok: true, stdout: '1' };
      }
      if (env.T3TOOLS_RESTORE) {
        const item = JSON.parse(env.T3TOOLS_RESTORE)[0];
        state.target = item.target;
        state.arguments = item.arguments;
        return { ok: true, stdout: '1' };
      }
      return { ok: true, stdout: '' };
    };

    const paths = {
      home: dir,
      appData: join(dir, 'AppData'),
      pluginDataDir: dir,
      t3InstallDir: dir,
      launcherBackupPath: join(dir, 'backup.json'),
      launcherVbsPath: join(dir, 'launch-t3.vbs')
    };

    const p1 = patchT3ShortcutsDebugArg(paths, { runner: mockRunner, sandbox: true });
    assert.equal(p1.ok, true);
    assert.equal(p1.patched, 1);
    assert.equal(state.target, origExe);
    assert.equal(state.arguments, '--project "Team  North" --remote-debugging-port=0');

    // Second call is idempotent
    const p2 = patchT3ShortcutsDebugArg(paths, { runner: mockRunner, sandbox: true });
    assert.equal(p2.ok, true);
    assert.equal(p2.patched, 0);
    assert.equal(p2.alreadyPatched, 1);

    // Restore cleanly removes only the added debug flag
    const r = restoreT3Launchers(paths, { runner: mockRunner, sandbox: true });
    assert.equal(r.ok, true);
    assert.equal(r.restored, 1);
    assert.equal(state.target, origExe);
    assert.equal(state.arguments, '--project "Team  North"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Tray daemon control API: authTokenOverride, tray settings persistence, CDP toggle/reattach, and graceful shutdown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't3tools-trayapi-'));
  let daemon;
  let shutdownCalled = false;
  const customToken = 'a'.repeat(48);
  try {
    daemon = await startDaemon({
      pathOverrides: { t3Root: join(dir, '.t3'), codexSessionsDir: join(dir, '.codex'), pluginDataDir: dir, home: dir, appData: dir },
      portOverride: 0,
      authTokenOverride: customToken,
      enableCdp: true,
      onShutdownRequest: () => { shutdownCalled = true; }
    });
    assert.equal(daemon.authToken, customToken);

    // Unauthorized request to /api/cdp/reattach is rejected
    const unauth = await fetch(`${daemon.url}/api/cdp/reattach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(unauth.status, 401);

    // Authenticated tray settings update succeeds
    const setRes = await fetch(`${daemon.url}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-T3Tools-Token': customToken },
      body: JSON.stringify({ minimizeToTray: true, startMinimizedToTray: true, autoAttachT3: false })
    });
    assert.equal(setRes.status, 200);
    const setJson = await setRes.json();
    assert.equal(setJson.data.startMinimizedToTray, true);
    assert.equal(setJson.data.autoAttachT3, false);

    // Toggle CDP back on via /api/cdp/toggle
    const toggleRes = await fetch(`${daemon.url}/api/cdp/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-T3Tools-Token': customToken },
      body: JSON.stringify({ enabled: true })
    });
    assert.equal(toggleRes.status, 200);
    const toggleJson = await toggleRes.json();
    assert.equal(toggleJson.data.enabled, true);

    // Reattach trigger responds with live CDP status
    const reattachRes = await fetch(`${daemon.url}/api/cdp/reattach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-T3Tools-Token': customToken },
      body: '{}'
    });
    assert.equal(reattachRes.status, 200);

    // Graceful shutdown via /api/shutdown
    const shutRes = await fetch(`${daemon.url}/api/shutdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-T3Tools-Token': customToken },
      body: '{}'
    });
    assert.equal(shutRes.status, 200);
    await new Promise(res => setTimeout(res, 150));
    assert.equal(shutdownCalled, true);
  } finally {
    await daemon?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
