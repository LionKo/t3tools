import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { buildClientBundle } from '../src/ui/bundle.mjs';
import { buildFallbackHtml } from '../src/ui/fallback-page.mjs';

const ENV_A = '11111111-1111-4111-8111-111111111111';
const ENV_B = '22222222-2222-4222-8222-222222222222';
const ENV_C = '33333333-3333-4333-8333-333333333333';

function createNode(tagName = 'DIV', attrs = {}) {
  const listeners = new Map();
  const children = [];
  const node = {
    tagName: String(tagName).toUpperCase(),
    id: attrs.id || '',
    attrs: { ...attrs },
    dataset: {},
    value: '',
    checked: false,
    innerHTML: '',
    textContent: '',
    style: {
      setProperty(k, v) { this[k] = v; },
      removeProperty(k) { delete this[k]; }
    },
    parentElement: null,
    isConnected: false,
    get children() { return children; },
    get nextElementSibling() {
      if (!this.parentElement) return null;
      const idx = this.parentElement.children.indexOf(this);
      return idx >= 0 && idx + 1 < this.parentElement.children.length ? this.parentElement.children[idx + 1] : null;
    },
    get previousElementSibling() {
      if (!this.parentElement) return null;
      const idx = this.parentElement.children.indexOf(this);
      return idx > 0 ? this.parentElement.children[idx - 1] : null;
    },
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 400, bottom: 40, width: 400, height: 40 }; },
    contains(other) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentElement;
      }
      return false;
    },
    closest(selector) {
      let cur = this;
      while (cur) {
        if (selector.includes('[data-t3tools]') && cur.getAttribute('data-t3tools') === '1') return cur;
        if (selector.includes('[data-thread-item]') && cur.getAttribute('data-thread-item')) return cur;
        if (selector.includes('[data-pt-action]') && cur.getAttribute('data-pt-action')) return cur;
        if (selector.includes('[data-pt-tab]') && cur.getAttribute('data-pt-tab')) return cur;
        if (selector.includes('[data-pt-bridge-candidate]') && cur.getAttribute('data-pt-bridge-candidate')) return cur;
        if (selector.includes('a[href]') && cur.tagName === 'A' && cur.getAttribute('href')) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    insertAdjacentElement(pos, el) {
      if (pos === 'afterend' && this.parentElement) this.parentElement.appendChild(el);
      return el;
    },
    insertBefore(el, ref) {
      if (el.parentElement) {
        const old = el.parentElement.children;
        const i = old.indexOf(el);
        if (i >= 0) old.splice(i, 1);
      }
      const idx = ref ? children.indexOf(ref) : -1;
      if (idx >= 0) children.splice(idx, 0, el);
      else children.push(el);
      el.parentElement = this;
      el.isConnected = this.isConnected;
      return el;
    },
    appendChild(child) {
      if (child.parentElement) {
        const old = child.parentElement.children;
        const i = old.indexOf(child);
        if (i >= 0) old.splice(i, 1);
      }
      children.push(child);
      child.parentElement = this;
      const syncConn = (n, conn) => {
        n.isConnected = conn;
        for (const k of n.children) syncConn(k, conn);
      };
      syncConn(child, this.isConnected);
      return child;
    },
    remove() {
      if (this.parentElement) {
        const idx = this.parentElement.children.indexOf(this);
        if (idx >= 0) this.parentElement.children.splice(idx, 1);
        this.parentElement = null;
      }
      this.isConnected = false;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatch(type, evt) {
      for (const fn of listeners.get(type) || []) fn(evt);
    },
    attachShadow(init = { mode: 'open' }) {
      const shadow = {
        mode: init?.mode || 'open',
        children: [],
        activeElement: null,
        append(...els) { this.children.push(...els); }
      };
      this._shadowForTest = shadow;
      this.shadowRoot = init?.mode === 'closed' ? null : shadow;
      return shadow;
    },
    querySelector(sel) {
      if (sel === 'a[href]') {
        return children.find(c => c.tagName === 'A' && c.getAttribute('href')) || null;
      }
      return null;
    },
    querySelectorAll() { return []; }
  };
  return node;
}

function createCdpHarness({ hash = '', pathname = '/', search = '', sidebarItem = null, onRpc }) {
  const body = createNode('BODY');
  body.isConnected = true;
  const footer = createNode('DIV', { 'data-chat-composer-footer': '1' });
  footer.isConnected = true;
  const sidebar = createNode('ASIDE', { 'data-slot': 'sidebar' });
  sidebar.isConnected = true;

  const mounted = new Map();
  const origAppend = body.appendChild.bind(body);
  body.appendChild = (el) => {
    if (el.id) mounted.set(el.id, el);
    return origAppend(el);
  };
  const origFooterAppend = footer.appendChild.bind(footer);
  footer.appendChild = (el) => {
    if (el.id) mounted.set(el.id, el);
    return origFooterAppend(el);
  };

  const timers = new Set();
  const win = new EventTarget();
  win.innerWidth = 1440;
  win.innerHeight = 900;
  win.confirm = () => true;

  let activeSidebarEl = sidebarItem;
  const loc = {
    protocol: 't3code:',
    hash,
    pathname,
    search,
    get href() { return `t3code://app${this.pathname}${this.search}${this.hash}`; }
  };
  const clipboardWrites = [];
  const rpcCalls = [];

  const context = {
    document: {
      body,
      documentElement: { getAttribute: () => 'dark', classList: { contains: () => true } },
      createElement: tag => createNode(tag),
      querySelector: sel => {
        if (sel.includes('aria-current') || sel.includes('data-thread-item')) return activeSidebarEl;
        if (sel === '[data-chat-composer-footer]') return footer;
        if (sel === '[data-slot="sidebar"]') return sidebar;
        return null;
      },
      querySelectorAll: sel => {
        if (sel === '[data-chat-composer-footer]') return [footer];
        if (sel === '[data-slot="sidebar"]') return [sidebar];
        return [];
      }
    },
    getComputedStyle: () => ({ display: 'flex', flexDirection: 'row', visibility: 'visible', getPropertyValue: () => '' }),
    location: loc,
    window: win,
    navigator: {
      clipboard: {
        async writeText(text) { clipboardWrites.push(text); }
      }
    },
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    AbortController, URL, URLSearchParams,
    setTimeout: (fn, ms) => {
      const id = globalThis.setTimeout(fn, Math.min(ms, 20000));
      timers.add(id);
      return id;
    },
    clearTimeout: id => { timers.delete(id); globalThis.clearTimeout(id); },
    __t3ToolsBridge: (raw) => {
      const req = JSON.parse(raw);
      rpcCalls.push(req);
      Promise.resolve()
        .then(() => onRpc(req))
        .then(data => context.__t3ToolsReceive(req.id, { ok: true, data }))
        .catch(err => context.__t3ToolsReceive(req.id, { ok: false, error: err?.message || String(err) }));
    }
  };

  runInNewContext(buildClientBundle({ transport: 'cdp', version: '0.1.9', bootId: 'test-boot' }), context);

  return {
    context,
    loc,
    win,
    mounted,
    rpcCalls,
    clipboardWrites,
    setSidebar(el) { activeSidebarEl = el; },
    dispose() {
      context.__t3Tools?.dispose?.();
      for (const id of timers) globalThis.clearTimeout(id);
      timers.clear();
    }
  };
}

function makeResolvedLive({ envId, threadId, tps, accountId, label = '', isRemote = false }) {
  return {
    updatedAtMs: Date.now(),
    settings: {
      enabled: true,
      showComposerBar: true,
      showOverviewCard: true,
      overviewMode: 'fixed',
      overviewCollapsed: false,
      pollIntervalMs: 60000
    },
    target: { environmentId: envId, threadId },
    remote: isRemote
      ? { isRemote: true, status: 'connected', environmentId: envId, peerId: 'peer-b', peerLabel: label, message: 'connected' }
      : null,
    thread: {
      unresolved: false,
      threadId,
      title: 'Shared Thread',
      accountId,
      selectedModel: 'gpt-6.2-astra',
      queuedRuns: 0,
      run: { runId: 'r1', ordinal: 1, status: 'completed', durationMs: 1200 },
      phase: 'completed',
      phaseLabel: '已完成',
      steps: [{ id: 's1', ordinal: 1, type: 'reasoning', status: 'completed', phase: 'thinking', phaseLabel: '思考', title: isRemote ? '远端步骤B' : '本机步骤A', durationMs: 400 }],
      totalSteps: 1
    },
    context: {
      providerDriver: 'codex',
      accountId,
      modelId: 'gpt-6.2-astra',
      usedTokens: 12000,
      maxTokens: 200000,
      usedPercent: 6.0,
      cacheHitPercent: 85.0,
      ttftMs: 900,
      tps,
      tpsKind: 'generation',
      decodeSpeed: tps,
      decodeSamples: 2,
      lastRequestAtMs: Date.now()
    },
    quotas: {
      updatedAtMs: Date.now(),
      groups: [{
        accountId,
        displayName: isRemote ? '远端账号B' : '本机账号A',
        driver: 'codex',
        windows: [{ label: '周限额', kind: 'weekly', poolKey: '3p', remainingPercent: isRemote ? 33 : 88 }]
      }]
    },
    globalAlerts: { unreadCount: 0, otherUnreadCount: 0 }
  };
}

test('route and sidebar detection extracts paired environmentId/threadId without inventing env on legacy routes', async t => {
  const sidebarMatch = createNode('DIV', { 'data-thread-item': `${ENV_B}:legacy-thread`, 'data-thread-id': 'legacy-thread' });
  const sidebarOther = createNode('DIV', { 'data-thread-item': `${ENV_C}:other-thread`, 'data-thread-id': 'other-thread' });

  const h = createCdpHarness({
    hash: `#/${ENV_B}/thread-1`,
    sidebarItem: sidebarOther,
    onRpc: () => ({ settings: { pollIntervalMs: 60000 }, thread: { unresolved: true }, quotas: { groups: [] } })
  });
  t.after(() => h.dispose());

  // 1. Explicit hash route environmentId wins over conflicting sidebar
  assert.deepEqual(
    { env: h.context.__t3Tools.diagnoseAnchors().environmentId, tid: h.context.__t3Tools.diagnoseAnchors().threadId },
    { env: ENV_B, tid: 'thread-1' }
  );

  // 2. /threads/<envUuid>/<threadId> extracts both
  h.loc.hash = `#/threads/${ENV_A}/thread-2`;
  assert.deepEqual(
    { env: h.context.__t3Tools.diagnoseAnchors().environmentId, tid: h.context.__t3Tools.diagnoseAnchors().threadId },
    { env: ENV_A, tid: 'thread-2' }
  );

  // 2b. Valid non-UUID remote route #/env-1/thread-1 extracts BOTH environmentId and threadId (P1-3)
  h.loc.hash = '#/env-1/thread-1';
  assert.deepEqual(
    { env: h.context.__t3Tools.diagnoseAnchors().environmentId, tid: h.context.__t3Tools.diagnoseAnchors().threadId },
    { env: 'env-1', tid: 'thread-1' }
  );

  // 3. /c/<threadId> does NOT invent "c" as environmentId; sidebar fills env ONLY for matching threadId
  h.loc.hash = '#/c/legacy-thread';
  h.setSidebar(sidebarOther);
  assert.deepEqual(
    { env: h.context.__t3Tools.diagnoseAnchors().environmentId, tid: h.context.__t3Tools.diagnoseAnchors().threadId },
    { env: '', tid: 'legacy-thread' }
  );
  h.setSidebar(sidebarMatch);
  assert.deepEqual(
    { env: h.context.__t3Tools.diagnoseAnchors().environmentId, tid: h.context.__t3Tools.diagnoseAnchors().threadId },
    { env: ENV_B, tid: 'legacy-thread' }
  );

  // 4. Non-thread routes & malformed escapes return empty target
  for (const badHash of ['#/settings/providers', '#/draft', `#/${ENV_B}/bad%2Fslash`, `#/${ENV_B}/bad%E0%A4%A`]) {
    h.loc.hash = badHash;
    assert.deepEqual(
      { env: h.context.__t3Tools.diagnoseAnchors().environmentId, tid: h.context.__t3Tools.diagnoseAnchors().threadId },
      { env: '', tid: '' },
      `expected empty target for ${badHash}`
    );
  }
});

test('A -> B -> A switching with identical threadId isolates metrics, discards stale responses, and renders remote error states', async t => {
  const sharedTid = 'same-thread-id';
  let deferredB = null;
  let currentMode = 'normal';

  const h = createCdpHarness({
    hash: `#/${ENV_A}/${sharedTid}`,
    onRpc: async (req) => {
      if (req.action !== 'getLive') return {};
      const { environmentId, threadId } = req.params;
      if (environmentId === ENV_A) {
        return makeResolvedLive({ envId: ENV_A, threadId, tps: 42.1, accountId: 'acc-a', isRemote: false });
      }
      if (environmentId === ENV_B) {
        if (currentMode === 'delay') {
          deferredB = Promise.withResolvers();
          return deferredB.promise;
        }
        if (currentMode === 'unpaired') {
          return {
            updatedAtMs: Date.now(),
            settings: { enabled: true, showComposerBar: true, showOverviewCard: true, overviewMode: 'fixed', pollIntervalMs: 60000 },
            target: { environmentId: ENV_B, threadId },
            thread: { unresolved: true, requestedThreadId: threadId, reason: 'unpaired' },
            context: null,
            quotas: { groups: [] },
            remote: { isRemote: true, status: 'unpaired', environmentId: ENV_B, peerId: '', peerLabel: '', message: 'unpaired' }
          };
        }
        if (currentMode === 'offline') {
          return {
            updatedAtMs: Date.now(),
            settings: { enabled: true, showComposerBar: true, showOverviewCard: true, overviewMode: 'fixed', pollIntervalMs: 60000 },
            target: { environmentId: ENV_B, threadId },
            thread: { unresolved: true, requestedThreadId: threadId, reason: 'offline' },
            context: null,
            quotas: { groups: [] },
            remote: { isRemote: true, status: 'offline', environmentId: ENV_B, peerId: 'peer-b', peerLabel: '办公室主力机', message: 'offline' }
          };
        }
        return makeResolvedLive({ envId: ENV_B, threadId, tps: 91.8, accountId: 'acc-b', label: '办公室主力机', isRemote: true });
      }
      return { thread: { unresolved: true }, quotas: { groups: [] } };
    }
  });
  t.after(() => h.dispose());

  await delay(20);
  const composerHost = h.mounted.get('t3tools-composer');
  const overviewHost = h.mounted.get('t3tools-overview');
  const composerContent = composerHost.shadowRoot.children[1];
  const overviewContent = overviewHost.shadowRoot.children[1];

  // On A: shows 42 tok/s, no remote badge
  assert.equal(composerHost.style.display, 'inline-flex');
  assert.match(composerContent.innerHTML, />42<span class="pt-usage-unit">tok\/s<\/span>/);
  assert.doesNotMatch(composerContent.innerHTML, /pt-remote-pill/);
  assert.match(overviewContent.innerHTML, /本机步骤A/);

  // Navigate to B with the SAME threadId
  h.loc.hash = `#/${ENV_B}/${sharedTid}`;
  h.win.dispatchEvent(new Event('hashchange'));
  // Immediately cleared before B resolves (no A leakage!)
  assert.equal(composerHost.style.display, 'none');

  await delay(20);
  assert.equal(composerHost.style.display, 'inline-flex');
  assert.match(composerContent.innerHTML, />92<span class="pt-usage-unit">tok\/s<\/span>/);
  assert.match(composerContent.innerHTML, /远端 · 办公室主力机/);
  assert.match(overviewContent.innerHTML, /远端步骤B/);
  assert.match(overviewContent.innerHTML, /远端账号B/);

  // Remote unpaired state: hides composer, renders clear unpaired status + settings CTA (NOT "正在加载会话...")
  currentMode = 'unpaired';
  h.win.dispatchEvent(new Event('focus'));
  await delay(20);
  assert.equal(composerHost.style.display, 'none');
  assert.match(overviewContent.innerHTML, /远端未配对/);
  assert.match(overviewContent.innerHTML, /open-remote-bridge-settings/);
  assert.doesNotMatch(overviewContent.innerHTML, /正在加载会话/);

  // Remote offline state: hides composer, renders 远端离线
  currentMode = 'offline';
  h.win.dispatchEvent(new Event('focus'));
  await delay(20);
  assert.equal(composerHost.style.display, 'none');
  assert.match(overviewContent.innerHTML, /远端离线/);

  // Delayed B response arriving AFTER switching back to A must NOT overwrite A
  currentMode = 'delay';
  h.win.dispatchEvent(new Event('focus'));
  await delay(10);
  assert.ok(deferredB, 'expected in-flight B request');

  h.loc.hash = `#/${ENV_A}/${sharedTid}`;
  h.win.dispatchEvent(new Event('hashchange'));
  await delay(20);
  assert.match(composerContent.innerHTML, />42<span class="pt-usage-unit">tok\/s<\/span>/);

  deferredB.resolve(makeResolvedLive({ envId: ENV_B, threadId: sharedTid, tps: 99.9, accountId: 'acc-b', label: '延迟响应B', isRemote: true }));
  await delay(20);
  assert.match(composerContent.innerHTML, />42<span class="pt-usage-unit">tok\/s<\/span>/);
  assert.doesNotMatch(composerContent.innerHTML, />100<span class="pt-usage-unit">tok\/s<\/span>/);
});

test('embedded settings bridge card never renders secrets and rejects untrusted copy clicks', async t => {
  const SECRET_TOKEN = 'a'.repeat(64);
  let pairingRequested = 0;

  const h = createCdpHarness({
    hash: `#/${ENV_A}/t1`,
    onRpc: async (req) => {
      if (req.action === 'getStatus') {
        return {
          version: '0.1.9',
          httpUrl: 'http://127.0.0.1:17373',
          cdp: { connected: true, devToolsPort: 9222 },
          settings: {
            remoteBridge: {
              server: { enabled: true, port: 17374, bindMode: 'lan', bindHost: '', advertiseUrl: '', machineLabel: '本机A' },
              peers: [{ id: 'p1', environmentId: ENV_B, label: '远端B', url: 'http://100.64.1.2:17374', enabled: true, allowLoopbackTunnel: false, verified: true, lastVerifiedAtMs: Date.now() }]
            }
          },
          remoteBridge: {
            state: 'listening',
            boundHost: '192.168.1.10',
            port: 17374,
            environmentId: ENV_A,
            tokenFingerprint: 'deadbeef',
            candidates: [{ name: 'Ethernet', address: '192.168.1.10', trusted: true }]
          }
        };
      }
      if (req.action === 'getRemoteBridgePairingCode') {
        pairingRequested++;
        return { code: 't3bridge://v1/mock-code-' + SECRET_TOKEN };
      }
      if (req.action === 'getDashboard') {
        return { summary: {}, facets: {}, requests: { items: [], total: 0, page: 1, totalPages: 1 }, quotas: { groups: [] }, errorInsights: { summary: {} } };
      }
      return makeResolvedLive({ envId: ENV_A, threadId: 't1', tps: 30, accountId: 'acc-a' });
    }
  });
  t.after(() => h.dispose());

  h.context.__t3Tools.openDashboard();
  await delay(20);
  const overlayHost = h.mounted.get('t3tools-dashboard-overlay');
  const overlayContent = overlayHost.shadowRoot.children[1];

  // Switch to settings tab
  const tabBtn = createNode('BUTTON', { 'data-pt-tab': 'settings' });
  overlayContent.dispatch('click', { target: tabBtn, isTrusted: true });
  await delay(20);

  assert.match(overlayContent.innerHTML, /Connect 跨机实时桥接/);
  assert.match(overlayContent.innerHTML, /deadbeef/);
  assert.match(overlayContent.innerHTML, /明文传输令牌/);
  // P1-1: embedded settings card must NOT mount a pairing credential text input in the open shadow DOM
  assert.doesNotMatch(overlayContent.innerHTML, /data-bridge-pairing-input/);
  assert.match(overlayContent.innerHTML, /prompt-add-bridge-peer/);
  assert.doesNotMatch(overlayContent.innerHTML, new RegExp(SECRET_TOKEN));

  // Synthetic (isTrusted: false) copy click MUST be rejected
  const copyBtn = createNode('BUTTON', { 'data-pt-action': 'copy-bridge-pairing-code' });
  overlayContent.dispatch('click', { target: copyBtn, isTrusted: false });
  await delay(20);
  assert.equal(pairingRequested, 0);
  assert.equal(h.clipboardWrites.length, 0);

  // Real user click (isTrusted: true) copies to clipboard without injecting into DOM
  overlayContent.dispatch('click', { target: copyBtn, isTrusted: true });
  await delay(20);
  assert.equal(pairingRequested, 1);
  assert.equal(h.clipboardWrites.length, 1);
  assert.doesNotMatch(overlayContent.innerHTML, new RegExp(SECRET_TOKEN));
});

test('embedded pairing modal works in Electron without window.prompt using closed Shadow DOM', async t => {
  const SECRET_TOKEN = 'b'.repeat(64);
  const PAIRING_CODE = 't3bridge://v1/mock-' + SECRET_TOKEN;
  const upserts = [];
  const tests = [];
  let promptCalled = 0;

  const h = createCdpHarness({
    hash: `#/${ENV_A}/t1`,
    onRpc: async (req) => {
      if (req.action === 'getStatus') {
        return {
          version: '0.1.10',
          httpUrl: 'http://127.0.0.1:17373',
          cdp: { connected: true, devToolsPort: 9222 },
          settings: {
            remoteBridge: {
              server: { enabled: true, port: 17374, bindMode: 'tailscale', bindHost: '', advertiseUrl: '', machineLabel: 'ReadyToWork' },
              peers: upserts.length
                ? [{ id: 'p2', environmentId: ENV_B, label: 'Knight', url: 'http://100.71.86.74:17374', enabled: true, allowLoopbackTunnel: false, verified: true, lastVerifiedAtMs: Date.now() }]
                : []
            }
          },
          remoteBridge: {
            state: 'listening',
            boundHost: '100.103.198.16',
            port: 17374,
            environmentId: ENV_A,
            tokenFingerprint: '9b7ec23a',
            candidates: [{ name: 'Tailscale', address: '100.103.198.16', trusted: true }]
          }
        };
      }
      if (req.action === 'upsertRemoteBridgePeer') {
        upserts.push(req.params);
        return { id: 'p2', environmentId: ENV_B, label: 'Knight', url: 'http://100.71.86.74:17374', verified: true, verifyStatus: 'verified' };
      }
      if (req.action === 'testRemoteBridgePeer') {
        tests.push(req.params);
        return { verified: true, status: 'verified' };
      }
      if (req.action === 'getDashboard') {
        return { summary: {}, facets: {}, requests: { items: [], total: 0, page: 1, totalPages: 1 }, quotas: { groups: [] }, errorInsights: { summary: {} } };
      }
      return makeResolvedLive({ envId: ENV_A, threadId: 't1', tps: 30, accountId: 'acc-a' });
    }
  });
  t.after(() => h.dispose());

  // Simulate Electron renderer where window.prompt() always throws
  h.win.prompt = () => {
    promptCalled++;
    throw new Error('prompt() is and will not be supported.');
  };

  h.context.__t3Tools.openDashboard();
  await delay(20);
  const overlayHost = h.mounted.get('t3tools-dashboard-overlay');
  const overlayContent = overlayHost.shadowRoot.children[1];

  const tabBtn = createNode('BUTTON', { 'data-pt-tab': 'settings' });
  overlayContent.dispatch('click', { target: tabBtn, isTrusted: true });
  await delay(20);

  const findInTree = (node, predicate) => {
    if (!node) return null;
    if (predicate(node)) return node;
    for (const child of node.children || []) {
      const found = findInTree(child, predicate);
      if (found) return found;
    }
    return null;
  };

  // Untrusted click must be rejected
  const addBtn = createNode('BUTTON', { 'data-pt-action': 'prompt-add-bridge-peer' });
  overlayContent.dispatch('click', { target: addBtn, isTrusted: false });
  await delay(10);
  assert.equal(h.mounted.get('t3tools-bridge-modal'), undefined);

  // Trusted click opens a CLOSED shadow modal without calling window.prompt()
  overlayContent.dispatch('click', { target: addBtn, isTrusted: true });
  await delay(10);
  assert.equal(promptCalled, 0);
  const modalHost = h.mounted.get('t3tools-bridge-modal');
  assert.ok(modalHost, 'expected bridge pairing modal to mount');
  assert.equal(modalHost.shadowRoot, null, 'modal must use closed Shadow DOM so host page cannot read credentials');

  const closedRoot = modalHost._shadowForTest;
  const inputEl = findInTree(closedRoot, n => n.getAttribute?.('data-pt-bridge-modal-input') === '1');
  const submitBtn = findInTree(closedRoot, n => n.getAttribute?.('data-pt-bridge-modal-submit') === '1');
  assert.ok(inputEl && submitBtn, 'expected input and submit button inside closed shadow modal');

  inputEl.value = PAIRING_CODE;
  submitBtn.dispatch('click', { target: submitBtn, isTrusted: true });
  await delay(30);

  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].code, PAIRING_CODE);
  assert.equal(upserts[0].verify, true);
  assert.equal(inputEl.value, '', 'input value must be wiped on modal close');
  assert.equal(modalHost.isConnected, false, 'modal host must be removed after submit');
  assert.doesNotMatch(overlayContent.innerHTML, new RegExp(SECRET_TOKEN));

  // Test-only action also uses the closed shadow modal
  const testBtn = createNode('BUTTON', { 'data-pt-action': 'prompt-test-bridge-peer' });
  overlayContent.dispatch('click', { target: testBtn, isTrusted: true });
  await delay(10);
  assert.equal(promptCalled, 0);
  const testModalHost = h.mounted.get('t3tools-bridge-modal');
  const testInput = findInTree(testModalHost._shadowForTest, n => n.getAttribute?.('data-pt-bridge-modal-input') === '1');
  const testSubmit = findInTree(testModalHost._shadowForTest, n => n.getAttribute?.('data-pt-bridge-modal-submit') === '1');
  testInput.value = PAIRING_CODE;
  testSubmit.dispatch('click', { target: testSubmit, isTrusted: true });
  await delay(30);
  assert.equal(tests.length, 1);
  assert.equal(tests[0].code, PAIRING_CODE);
});

test('standalone fallback HTML includes remote bridge slot, handlers, and valid inline JS syntax', () => {
  const html = buildFallbackHtml({ version: '0.1.9', apiBase: '', authToken: 'tok', theme: 'dark' });
  assert.match(html, /id="settings-remote-bridge-slot"/);
  assert.match(html, /renderRemoteBridgeCardHtml/);
  assert.match(html, /\/api\/remote-bridge\/pairing-code/);
  assert.match(html, /\/api\/remote-bridge\/peers\/upsert/);

  const scriptMatch = html.match(/<script>\s*([\s\S]*?)<\/script>\s*<\/body>/);
  assert.ok(scriptMatch && scriptMatch[1], 'expected inline script block in fallback HTML');
  assert.doesNotThrow(() => new Function(scriptMatch[1]));
});
