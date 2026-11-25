import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { createSettingsStore, sanitizeSettingsPatch } from '../src/core/settings.mjs';
import { buildClientBundle } from '../src/ui/bundle.mjs';

function createMockNode(tagName = 'DIV', attrs = {}, { rect = null, computed = null } = {}) {
  const listeners = new Map();
  const children = [];
  const node = {
    tagName: String(tagName).toUpperCase(),
    id: attrs.id || '',
    attrs: { ...attrs },
    style: {
      setProperty(k, v) { this[k] = v; },
      removeProperty(k) { delete this[k]; }
    },
    parentElement: null,
    isConnected: false,
    _rect: rect,
    _computed: computed || { display: 'block', flexDirection: 'row', flexWrap: 'nowrap', position: 'static', visibility: 'visible', getPropertyValue: () => '' },
    get children() { return children; },
    get nextElementSibling() {
      if (!this.parentElement) return null;
      const siblings = this.parentElement.children;
      const idx = siblings.indexOf(this);
      return idx >= 0 && idx + 1 < siblings.length ? siblings[idx + 1] : null;
    },
    get previousElementSibling() {
      if (!this.parentElement) return null;
      const siblings = this.parentElement.children;
      const idx = siblings.indexOf(this);
      return idx > 0 ? siblings[idx - 1] : null;
    },
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    getBoundingClientRect() { return this._rect || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
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
        if (selector.includes('[data-message-role]') && cur.getAttribute('data-message-role')) return cur;
        if (selector.includes('[role="dialog"]') && cur.getAttribute('role') === 'dialog') return cur;
        if (selector.includes('[aria-modal="true"]') && cur.getAttribute('aria-modal') === 'true') return cur;
        if (selector.includes('[data-pt-action]') && cur.getAttribute('data-pt-action')) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    insertAdjacentElement(position, el) {
      if (position === 'afterend' && this.parentElement) {
        this.parentElement.appendChild(el);
      }
      return el;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchClick(target) {
      for (const fn of listeners.get('click') || []) fn({ target });
    },
    attachShadow() {
      const shadow = {
        children: [],
        append(...els) { this.children.push(...els); }
      };
      this.shadowRoot = shadow;
      return shadow;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild(child) {
      if (child.parentElement) {
        const oldKids = child.parentElement.children;
        const idx = oldKids.indexOf(child);
        if (idx >= 0) oldKids.splice(idx, 1);
      }
      children.push(child);
      child.parentElement = this;
      const propagate = (n, connected) => {
        n.isConnected = connected;
        for (const k of n.children) propagate(k, connected);
      };
      propagate(child, this.isConnected);
      return child;
    },
    remove() {
      if (this.parentElement) {
        const idx = this.parentElement.children.indexOf(this);
        if (idx >= 0) this.parentElement.children.splice(idx, 1);
        this.parentElement = null;
      }
      const propagate = (n) => {
        n.isConnected = false;
        for (const k of n.children) propagate(k);
      };
      propagate(this);
    }
  };
  return node;
}

function createHarness({ vw = 1440, vh = 900, initialSettings = {} } = {}) {
  const body = createMockNode('BODY', {}, { rect: { left: 0, top: 0, right: vw, bottom: vh, width: vw, height: vh } });
  body.isConnected = true;

  const timers = new Map();
  let observerCb = null;
  let resizeCb = null;
  let resizeDisconnected = false;
  let selectorMap = new Map();
  let liveSettings = {
    enabled: true,
    showComposerBar: false,
    showOverviewCard: true,
    overviewMode: 'adaptive',
    overviewCollapsed: false,
    overviewPosition: { top: 56, right: 18 },
    pollIntervalMs: 60000,
    ...initialSettings
  };

  const win = new EventTarget();
  win.innerWidth = vw;
  win.innerHeight = vh;

  const context = {
    document: {
      body,
      documentElement: { getAttribute: () => 'dark' },
      createElement: tag => createMockNode(tag),
      querySelector: sel => (selectorMap.get(sel) || [])[0] || null,
      querySelectorAll: sel => selectorMap.get(sel) || []
    },
    getComputedStyle: el => el?._computed || {
      display: 'block', flexDirection: 'row', flexWrap: 'nowrap', position: 'static', visibility: 'visible',
      getPropertyValue: () => ''
    },
    location: { hash: '#/env-1/thread-1', pathname: '/', search: '', href: 't3code://app/#/env-1/thread-1' },
    window: win,
    MutationObserver: class {
      constructor(cb) { observerCb = cb; }
      observe() {}
      disconnect() {}
    },
    ResizeObserver: class {
      constructor(cb) { resizeCb = cb; }
      observe() {}
      unobserve() {}
      disconnect() { resizeDisconnected = true; }
    },
    AbortController, URLSearchParams,
    clearTimeout: id => timers.delete(id),
    setTimeout: (fn, ms) => { timers.set(fn, ms); return fn; },
    fetch: async url => {
      if (url.includes('/api/settings')) {
        return { ok: true, json: async () => ({ ok: true, data: liveSettings }) };
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            settings: liveSettings,
            thread: { unresolved: false, threadId: 'thread-1', accountId: 'work', phase: 'idle', phaseLabel: '空闲', steps: [] },
            context: { accountId: 'work', modelId: 'gemini-4-neon' },
            quotas: { groups: [] }
          }
        })
      };
    }
  };

  return {
    body,
    win,
    context,
    timers,
    setSelectors(nextMap) { selectorMap = nextMap; },
    setSettings(patch) { liveSettings = { ...liveSettings, ...patch }; },
    triggerMutation(mutations = [{ addedNodes: [createMockNode('DIV')], removedNodes: [] }]) {
      observerCb?.(mutations);
    },
    triggerResize() {
      resizeCb?.();
    },
    isResizeDisconnected: () => resizeDisconnected,
    boot() {
      runInNewContext(buildClientBundle({ transport: 'http', authToken: 'test' }), context);
    },
    findOverviewHost() {
      const walk = node => {
        if (node.id === 't3tools-overview') return node;
        for (const ch of node.children) {
          const hit = walk(ch);
          if (hit) return hit;
        }
        return null;
      };
      return walk(body);
    }
  };
}

test('settings store validates and persists overviewMode', t => {
  const dir = mkdtempSync(join(tmpdir(), 't3-overview-mode-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createSettingsStore(join(dir, 'settings.json'));
  assert.equal(store.get().overviewMode, 'adaptive');
  assert.equal(store.update({ overviewMode: 'avoid' }).overviewMode, 'avoid');
  assert.equal(store.update({ overviewMode: 'fixed' }).overviewMode, 'fixed');
  assert.throws(() => sanitizeSettingsPatch({ overviewMode: 'invalid' }), /overviewMode/);
});

test('shared-views renders docked overview card and overviewMode setting selector', () => {
  const sharedViewsSrc = readFileSync(new URL('../src/ui/shared-views.js', import.meta.url), 'utf8');
  const { renderOverviewCardHtml, renderEmbeddedSettingsHtml } = new Function(
    `${sharedViewsSrc}\nreturn { renderOverviewCardHtml, renderEmbeddedSettingsHtml };`
  )();
  const dockedHtml = renderOverviewCardHtml(
    { thread: { unresolved: false, accountId: 'work', phase: 'idle', phaseLabel: '空闲', steps: [] }, quotas: { groups: [] } },
    false,
    false,
    { docked: true }
  );
  assert.ok(dockedHtml.includes('pt-overview-card docked'));
  assert.ok(dockedHtml.includes('data-pt-overview-mode="docked"'));
  assert.ok(dockedHtml.includes('已合并'));

  const settingsHtml = renderEmbeddedSettingsHtml(null, { showOverviewCard: true, overviewMode: 'avoid' });
  assert.ok(settingsHtml.includes('data-pt-setting="overviewMode"'));
  assert.ok(settingsHtml.includes('<option value="avoid" selected>'));
});

test('adaptive mode docks into unwrapped flex-column right panel and undocks cleanly when closed', async () => {
  const h = createHarness({ vw: 1440, vh: 900 });
  const workspace = createMockNode('DIV', {}, {
    rect: { left: 240, top: 0, right: 1440, bottom: 900, width: 1200, height: 900 },
    computed: { display: 'flex', flexDirection: 'row', flexWrap: 'nowrap', position: 'relative', visibility: 'visible', getPropertyValue: () => '' }
  });
  const conv = createMockNode('MAIN', { 'data-workspace-area': 'conversation' }, {
    rect: { left: 240, top: 0, right: 980, bottom: 900, width: 740, height: 900 },
    computed: { display: 'flex', flexDirection: 'column', flexWrap: 'nowrap', position: 'relative', visibility: 'visible', getPropertyValue: () => '' }
  });
  const header = createMockNode('HEADER', { 'data-chat-header': '' }, {
    rect: { left: 240, top: 0, right: 980, bottom: 48, width: 740, height: 48 }
  });
  // Simulate react-resizable-panels: outer block wrapper -> inner flex-column container
  const rightOuter = createMockNode('DIV', { 'data-panel': 'true' }, {
    rect: { left: 984, top: 0, right: 1440, bottom: 900, width: 456, height: 900 },
    computed: { display: 'block', flexDirection: 'row', flexWrap: 'nowrap', position: 'relative', visibility: 'visible', getPropertyValue: () => '' }
  });
  const rightInnerFlex = createMockNode('DIV', {}, {
    rect: { left: 984, top: 0, right: 1440, bottom: 900, width: 456, height: 900 },
    computed: { display: 'flex', flexDirection: 'column', flexWrap: 'nowrap', position: 'relative', visibility: 'visible', getPropertyValue: () => '' }
  });
  rightOuter.appendChild(rightInnerFlex);
  conv.appendChild(header);
  workspace.appendChild(conv);
  workspace.appendChild(rightOuter);
  h.body.appendChild(workspace);

  h.setSelectors(new Map([
    ['[data-workspace-area="conversation"]', [conv]],
    ['[data-chat-header]', [header]]
  ]));

  h.boot();
  await delay(0);

  const host = h.findOverviewHost();
  assert.ok(host, 'overview host should be mounted');
  assert.equal(host.parentElement, rightInnerFlex, 'should unwrap block panel and dock into inner flex-column container');
  assert.equal(host.style.position, 'sticky');
  assert.equal(host.style.width, '100%');
  assert.equal(h.context.__t3Tools.diagnoseAnchors().overviewLayout.mode, 'docked');
  const contentEl = host.shadowRoot.children[1];
  assert.ok(contentEl.innerHTML.includes('pt-overview-card docked'));

  // Close the right panel -> conversationArea expands to full right edge and overview returns to body
  rightOuter.remove();
  conv._rect = { left: 240, top: 0, right: 1440, bottom: 900, width: 1200, height: 900 };
  header._rect = { left: 240, top: 0, right: 1440, bottom: 52, width: 1200, height: 52 };
  h.triggerMutation();
  await delay(0);

  assert.equal(host.parentElement, h.body, 'should move back to body when right panel closes');
  assert.equal(host.style.position, 'fixed');
  assert.equal(host.style.right, '18px');
  assert.equal(host.style.top, '60px'); // header.bottom (52) + 8
  assert.equal(h.context.__t3Tools.diagnoseAnchors().overviewLayout.mode, 'float');
  assert.equal(contentEl.innerHTML.includes('pt-overview-card docked'), false);

  h.context.__t3Tools.dispose();
  assert.equal(h.isResizeDisconnected(), true);
  assert.equal(h.findOverviewHost(), null);
  assert.equal(h.timers.size, 0);
});

test('non-dockable right panel falls back to automatic avoidance and auto-collapses when conversation is narrow', async () => {
  const h = createHarness({ vw: 1280, vh: 840 });
  const workspace = createMockNode('DIV', {}, {
    rect: { left: 240, top: 0, right: 1280, bottom: 840, width: 1040, height: 840 }
  });
  // Narrow conversation area (width = 560 < 660) beside a non-flex block/iframe right panel
  const conv = createMockNode('MAIN', { 'data-workspace-area': 'conversation' }, {
    rect: { left: 240, top: 0, right: 800, bottom: 840, width: 560, height: 840 }
  });
  const header = createMockNode('HEADER', { 'data-chat-header': '' }, {
    rect: { left: 240, top: 0, right: 800, bottom: 50, width: 560, height: 50 }
  });
  const nonFlexRightPanel = createMockNode('DIV', { 'data-workspace-area': 'preview' }, {
    rect: { left: 800, top: 0, right: 1280, bottom: 840, width: 480, height: 840 },
    computed: { display: 'block', flexDirection: 'row', flexWrap: 'nowrap', position: 'relative', visibility: 'visible', getPropertyValue: () => '' }
  });
  const iframeChild = createMockNode('IFRAME', {}, {
    rect: { left: 800, top: 0, right: 1280, bottom: 840, width: 480, height: 840 }
  });
  nonFlexRightPanel.appendChild(iframeChild);
  conv.appendChild(header);
  workspace.appendChild(conv);
  workspace.appendChild(nonFlexRightPanel);
  h.body.appendChild(workspace);

  h.setSelectors(new Map([
    ['[data-workspace-area="conversation"]', [conv]],
    ['[data-chat-header]', [header]],
    ['[data-workspace-area]:not([data-workspace-area="conversation"]):not([data-workspace-area="sidebar"])', [nonFlexRightPanel]]
  ]));

  h.boot();
  await delay(0);

  const host = h.findOverviewHost();
  assert.equal(host.parentElement, h.body, 'should not dock into non-flex iframe panel');
  assert.equal(host.style.position, 'fixed');
  // vw (1280) - convRect.right (800) + 14 = 494px -> sits cleanly to the left of right panel!
  assert.equal(host.style.right, '494px');
  assert.equal(host.style.top, '58px'); // header.bottom (50) + 8
  assert.equal(h.context.__t3Tools.diagnoseAnchors().overviewLayout.mode, 'avoid');
  assert.equal(h.context.__t3Tools.diagnoseAnchors().overviewLayout.narrowAutoCollapsed, true);
  const contentEl = host.shadowRoot.children[1];
  assert.ok(contentEl.innerHTML.includes('pt-overview-card collapsed'), 'should auto-collapse on narrow conversation');

  // Widening conversation area >= 700 automatically restores expanded card
  conv._rect = { left: 240, top: 0, right: 1000, bottom: 840, width: 760, height: 840 };
  nonFlexRightPanel._rect = { left: 1000, top: 0, right: 1280, bottom: 840, width: 280, height: 840 };
  h.triggerResize();
  await delay(0);

  assert.equal(host.style.right, '294px'); // 1280 - 1000 + 14
  assert.equal(h.context.__t3Tools.diagnoseAnchors().overviewLayout.narrowAutoCollapsed, false);
  assert.equal(contentEl.innerHTML.includes('pt-overview-card collapsed'), false);

  h.context.__t3Tools.dispose();
});

test('fixed mode ignores right panel and keeps configured overviewPosition', async () => {
  const h = createHarness({
    vw: 1440,
    vh: 900,
    initialSettings: { overviewMode: 'fixed', overviewPosition: { top: 64, right: 22 } }
  });
  const conv = createMockNode('MAIN', { 'data-workspace-area': 'conversation' }, {
    rect: { left: 240, top: 0, right: 900, bottom: 900, width: 660, height: 900 }
  });
  const rightFlex = createMockNode('DIV', { 'data-workspace-area': 'diff' }, {
    rect: { left: 900, top: 0, right: 1440, bottom: 900, width: 540, height: 900 },
    computed: { display: 'flex', flexDirection: 'column', flexWrap: 'nowrap', position: 'relative', visibility: 'visible', getPropertyValue: () => '' }
  });
  h.body.appendChild(conv);
  h.body.appendChild(rightFlex);
  h.setSelectors(new Map([
    ['[data-workspace-area="conversation"]', [conv]],
    ['[data-workspace-area]:not([data-workspace-area="conversation"]):not([data-workspace-area="sidebar"])', [rightFlex]]
  ]));

  h.boot();
  await delay(0);

  const host = h.findOverviewHost();
  assert.equal(host.parentElement, h.body);
  assert.equal(host.style.top, '64px');
  assert.equal(host.style.right, '22px');
  assert.equal(h.context.__t3Tools.diagnoseAnchors().overviewLayout.mode, 'fixed');

  h.context.__t3Tools.dispose();
});

test('detects and docks into right panel nested INSIDE full-width <main> (shadcn SidebarInset layout)', async () => {
  const h = createHarness({ vw: 1440, vh: 900 });
  const sidebar = createMockNode('ASIDE', { 'data-slot': 'sidebar' }, {
    rect: { left: 0, top: 0, right: 240, bottom: 900, width: 240, height: 900 }
  });
  // Full-width <main> wraps BOTH chat column and right panel!
  const mainEl = createMockNode('MAIN', { 'data-slot': 'sidebar-inset' }, {
    rect: { left: 240, top: 0, right: 1440, bottom: 900, width: 1200, height: 900 },
    computed: { display: 'flex', flexDirection: 'column', flexWrap: 'nowrap', position: 'relative', visibility: 'visible', getPropertyValue: () => '' }
  });
  const splitRow = createMockNode('DIV', {}, {
    rect: { left: 240, top: 0, right: 1440, bottom: 900, width: 1200, height: 900 },
    computed: { display: 'flex', flexDirection: 'row', flexWrap: 'nowrap', position: 'relative', visibility: 'visible', getPropertyValue: () => '' }
  });
  const chatCol = createMockNode('DIV', {}, {
    rect: { left: 240, top: 0, right: 940, bottom: 900, width: 700, height: 900 },
    computed: { display: 'flex', flexDirection: 'column', flexWrap: 'nowrap', position: 'relative', visibility: 'visible', getPropertyValue: () => '' }
  });
  const composerForm = createMockNode('FORM', { 'data-chat-composer-form': '' }, {
    rect: { left: 280, top: 760, right: 900, bottom: 880, width: 620, height: 120 }
  });
  const nestedRightPanel = createMockNode('DIV', {}, {
    rect: { left: 944, top: 0, right: 1440, bottom: 900, width: 496, height: 900 },
    computed: { display: 'flex', flexDirection: 'column', flexWrap: 'nowrap', position: 'relative', visibility: 'visible', getPropertyValue: () => '' }
  });
  chatCol.appendChild(composerForm);
  splitRow.appendChild(chatCol);
  splitRow.appendChild(nestedRightPanel);
  mainEl.appendChild(splitRow);
  h.body.appendChild(sidebar);
  h.body.appendChild(mainEl);

  h.setSelectors(new Map([
    ['main', [mainEl]],
    ['[data-slot="sidebar"]', [sidebar]],
    ['[data-chat-composer-form]', [composerForm]]
  ]));

  h.boot();
  await delay(0);

  const host = h.findOverviewHost();
  assert.equal(host.parentElement, nestedRightPanel, 'should dock into right panel nested inside <main>');
  assert.equal(h.context.__t3Tools.diagnoseAnchors().overviewLayout.mode, 'docked');

  // Now switch to non-dockable (block) inside <main> -> must STILL avoid using nestedRightPanel.left!
  nestedRightPanel._computed = { display: 'block', flexDirection: 'row', flexWrap: 'nowrap', position: 'relative', visibility: 'visible', getPropertyValue: () => '' };
  h.triggerResize();
  await delay(0);

  assert.equal(host.parentElement, h.body);
  assert.equal(host.style.right, '514px'); // 1440 - 940 + 14
  assert.equal(h.context.__t3Tools.diagnoseAnchors().overviewLayout.mode, 'avoid');

  h.context.__t3Tools.dispose();
});

test('elementsFromPoint detects right-edge portal drawer and avoids modal sheet', async () => {
  const h = createHarness({ vw: 1440, vh: 900 });
  const mainEl = createMockNode('MAIN', {}, {
    rect: { left: 240, top: 0, right: 1440, bottom: 900, width: 1200, height: 900 }
  });
  const composerForm = createMockNode('FORM', { 'data-chat-composer-form': '' }, {
    rect: { left: 300, top: 760, right: 900, bottom: 880, width: 600, height: 120 }
  });
  // Right-side portal sheet without any known selector in selectors.json
  const portalSheet = createMockNode('DIV', { role: 'dialog', 'aria-modal': 'true' }, {
    rect: { left: 960, top: 0, right: 1440, bottom: 900, width: 480, height: 900 },
    computed: { display: 'flex', flexDirection: 'column', flexWrap: 'nowrap', position: 'fixed', visibility: 'visible', getPropertyValue: () => '' }
  });
  const sheetBody = createMockNode('DIV', {}, {
    rect: { left: 960, top: 48, right: 1440, bottom: 900, width: 480, height: 852 }
  });
  portalSheet.appendChild(sheetBody);
  mainEl.appendChild(composerForm);
  h.body.appendChild(mainEl);
  h.body.appendChild(portalSheet);

  h.context.document.elementsFromPoint = (x, y) => (x >= 960 && y >= 48 ? [sheetBody, portalSheet, h.body] : [mainEl, h.body]);
  h.setSelectors(new Map([
    ['main', [mainEl]],
    ['[data-chat-composer-form]', [composerForm]]
  ]));

  h.boot();
  await delay(0);

  const host = h.findOverviewHost();
  assert.equal(host.parentElement, h.body, 'modal right sheet should be avoided rather than docked into');
  assert.equal(host.style.right, '494px'); // 1440 - 960 + 14
  assert.equal(h.context.__t3Tools.diagnoseAnchors().overviewLayout.mode, 'avoid');

  // Non-modal right sheet (e.g., Preview/Diff drawer) should dock cleanly
  delete portalSheet.attrs['aria-modal'];
  h.triggerResize();
  await delay(0);

  assert.equal(host.parentElement, portalSheet, 'non-modal right portal drawer should dock');
  assert.equal(h.context.__t3Tools.diagnoseAnchors().overviewLayout.mode, 'docked');

  h.context.__t3Tools.dispose();
});

test('compact 240px top-right card merges vertically in adaptive mode and stacks below in avoid mode', async () => {
  const h = createHarness({ vw: 1440, vh: 960 });
  const mainEl = createMockNode('MAIN', {}, {
    rect: { left: 240, top: 0, right: 1440, bottom: 960, width: 1200, height: 960 }
  });
  const composerForm = createMockNode('FORM', { 'data-chat-composer-form': '' }, {
    rect: { left: 340, top: 820, right: 1000, bottom: 930, width: 660, height: 110 }
  });
  // Exact replica of T3 Code's [≡] floating workspace/git card (~304x240 at top:52, right:16)
  const topRightCard = createMockNode('DIV', {}, {
    rect: { left: 1120, top: 52, right: 1424, bottom: 292, width: 304, height: 240 },
    computed: {
      display: 'block', flexDirection: 'row', flexWrap: 'nowrap', position: 'fixed', visibility: 'visible',
      backgroundColor: 'rgb(255, 255, 255)', borderTopWidth: '1px', borderLeftWidth: '1px',
      borderRightWidth: '1px', borderBottomWidth: '1px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
      getPropertyValue: () => ''
    }
  });
  const sectionTop = createMockNode('DIV', {}, {
    rect: { left: 1120, top: 52, right: 1424, bottom: 172, width: 304, height: 120 }
  });
  const sectionGit = createMockNode('DIV', {}, {
    rect: { left: 1120, top: 172, right: 1424, bottom: 292, width: 304, height: 120 }
  });
  topRightCard.appendChild(sectionTop);
  topRightCard.appendChild(sectionGit);
  mainEl.appendChild(composerForm);
  h.body.appendChild(mainEl);
  h.body.appendChild(topRightCard);

  h.context.document.elementsFromPoint = (x, y) =>
    (x >= 1120 && x <= 1424 && y >= 52 && y <= 292 ? [sectionTop, topRightCard, mainEl, h.body] : [mainEl, h.body]);
  h.setSelectors(new Map([
    ['main', [mainEl]],
    ['[data-chat-composer-form]', [composerForm]]
  ]));

  h.boot();
  await delay(0);

  const host = h.findOverviewHost();
  assert.equal(host.parentElement, topRightCard, 'should merge into compact top-right block card');
  assert.equal(host.style.position, 'relative');
  assert.equal(h.context.__t3Tools.diagnoseAnchors().overviewLayout.mode, 'docked');

  // In avoid mode, must stack VERTICALLY right below the card (top = 292 + 10 = 302px, right = 16px), NEVER left-right
  h.setSettings({ overviewMode: 'avoid' });
  const [pollTimer] = h.timers.keys();
  h.timers.delete(pollTimer);
  await pollTimer();

  assert.equal(host.parentElement, h.body);
  assert.equal(host.style.position, 'fixed');
  assert.equal(host.style.top, '302px');
  assert.equal(host.style.right, '16px');
  assert.equal(host.style.width, '304px');
  assert.equal(h.context.__t3Tools.diagnoseAnchors().overviewLayout.mode, 'avoid');

  h.context.__t3Tools.dispose();
});

test('330px ReadyToWork card inside full-height right rail uses vertical stack (never left-right)', async () => {
  const h = createHarness({ vw: 1440, vh: 900 });
  const mainEl = createMockNode('MAIN', {}, {
    rect: { left: 240, top: 0, right: 1440, bottom: 900, width: 1200, height: 900 }
  });
  const splitRow = createMockNode('DIV', {}, {
    rect: { left: 240, top: 0, right: 1440, bottom: 900, width: 1200, height: 900 },
    computed: { display: 'flex', flexDirection: 'row', flexWrap: 'nowrap', position: 'relative', visibility: 'visible', getPropertyValue: () => '' }
  });
  const chatCol = createMockNode('DIV', {}, {
    rect: { left: 240, top: 0, right: 1096, bottom: 900, width: 856, height: 900 },
    computed: { display: 'flex', flexDirection: 'column', flexWrap: 'nowrap', position: 'relative', visibility: 'visible', getPropertyValue: () => '' }
  });
  const composerForm = createMockNode('FORM', { 'data-chat-composer-form': '' }, {
    rect: { left: 300, top: 760, right: 1020, bottom: 880, width: 720, height: 120 }
  });
  // Full-height right rail (block/scroll) holding a 330px ReadyToWork card at top
  const rightRail = createMockNode('ASIDE', {}, {
    rect: { left: 1096, top: 0, right: 1440, bottom: 900, width: 344, height: 900 },
    computed: { display: 'block', flexDirection: 'row', flexWrap: 'nowrap', position: 'relative', visibility: 'visible', getPropertyValue: () => '' }
  });
  const railScroll = createMockNode('DIV', {}, {
    rect: { left: 1096, top: 0, right: 1440, bottom: 900, width: 344, height: 900 },
    computed: { display: 'block', flexDirection: 'row', flexWrap: 'nowrap', position: 'relative', visibility: 'visible', getPropertyValue: () => '' }
  });
  const readyCard = createMockNode('DIV', {}, {
    rect: { left: 1112, top: 52, right: 1424, bottom: 382, width: 312, height: 330 },
    computed: {
      display: 'block', flexDirection: 'row', flexWrap: 'nowrap', position: 'relative', visibility: 'visible',
      backgroundColor: 'rgb(255, 255, 255)', borderTopWidth: '1px', borderLeftWidth: '1px',
      borderRightWidth: '1px', borderBottomWidth: '1px', boxShadow: 'none',
      getPropertyValue: () => ''
    }
  });
  railScroll.appendChild(readyCard);
  rightRail.appendChild(railScroll);
  chatCol.appendChild(composerForm);
  splitRow.appendChild(chatCol);
  splitRow.appendChild(rightRail);
  mainEl.appendChild(splitRow);
  h.body.appendChild(mainEl);

  h.setSelectors(new Map([
    ['main', [mainEl]],
    ['[data-chat-composer-form]', [composerForm]]
  ]));

  h.boot();
  await delay(0);

  const host = h.findOverviewHost();
  assert.equal(host.parentElement, railScroll, 'should dock vertically inside railScroll right below ReadyToWork card');
  assert.equal(host.style.position, 'relative');
  assert.equal(host.style.marginTop, '10px');
  const contentEl = host.shadowRoot.children[1];
  assert.ok(contentEl.innerHTML.includes('docked-stack'));

  // In avoid mode, must STILL stack vertically below ReadyToWork (top = 392px, right = 16px), NEVER left-right!
  h.setSettings({ overviewMode: 'avoid' });
  const [pollTimer] = h.timers.keys();
  h.timers.delete(pollTimer);
  await pollTimer();

  assert.equal(host.parentElement, h.body);
  assert.equal(host.style.top, '392px');
  assert.equal(host.style.right, '16px');
  assert.equal(host.style.width, '312px');

  h.context.__t3Tools.dispose();
});

test('right-aligned user chat message bubble is never misdetected as a right panel', async () => {
  const h = createHarness({ vw: 1440, vh: 900 });
  const mainEl = createMockNode('MAIN', {}, {
    rect: { left: 240, top: 0, right: 1440, bottom: 900, width: 1200, height: 900 }
  });
  const composerForm = createMockNode('FORM', { 'data-chat-composer-form': '' }, {
    rect: { left: 340, top: 760, right: 1000, bottom: 880, width: 660, height: 120 }
  });
  const userMsg = createMockNode('DIV', { 'data-message-role': 'user' }, {
    rect: { left: 1120, top: 60, right: 1420, bottom: 200, width: 300, height: 140 },
    computed: {
      display: 'block', flexDirection: 'row', flexWrap: 'nowrap', position: 'relative', visibility: 'visible',
      backgroundColor: 'rgb(240, 240, 240)', borderTopWidth: '1px', borderLeftWidth: '1px',
      borderRightWidth: '1px', borderBottomWidth: '1px', boxShadow: 'none',
      getPropertyValue: () => ''
    }
  });
  mainEl.appendChild(userMsg);
  mainEl.appendChild(composerForm);
  h.body.appendChild(mainEl);

  h.context.document.elementsFromPoint = (x, y) =>
    (x >= 1120 && y <= 200 ? [userMsg, mainEl, h.body] : [mainEl, h.body]);
  h.setSelectors(new Map([
    ['main', [mainEl]],
    ['[data-chat-composer-form]', [composerForm]]
  ]));

  h.boot();
  await delay(0);

  const host = h.findOverviewHost();
  assert.equal(host.parentElement, h.body);
  assert.equal(host.style.right, '18px');
  assert.equal(h.context.__t3Tools.diagnoseAnchors().overviewLayout.mode, 'float');

  h.context.__t3Tools.dispose();
});

test('right panel with header + scroll body + .chat-markdown + single-column grid still stacks vertically', async () => {
  const h = createHarness({ vw: 1440, vh: 900 });
  const mainEl = createMockNode('MAIN', {}, {
    rect: { left: 240, top: 0, right: 1440, bottom: 900, width: 1200, height: 900 }
  });
  const splitRow = createMockNode('DIV', {}, {
    rect: { left: 240, top: 0, right: 1440, bottom: 900, width: 1200, height: 900 },
    computed: { display: 'flex', flexDirection: 'row', flexWrap: 'nowrap', position: 'relative', visibility: 'visible', getPropertyValue: () => '' }
  });
  const chatCol = createMockNode('DIV', {}, {
    rect: { left: 240, top: 0, right: 1096, bottom: 900, width: 856, height: 900 },
    computed: { display: 'flex', flexDirection: 'column', flexWrap: 'nowrap', position: 'relative', visibility: 'visible', getPropertyValue: () => '' }
  });
  const composerForm = createMockNode('FORM', { 'data-chat-composer-form': '' }, {
    rect: { left: 300, top: 760, right: 1020, bottom: 880, width: 720, height: 120 }
  });
  // Updated T3 Code right panel: [header bar (40px), single-column grid scroll body (860px -> 240px card with markdown)]
  const rightRail = createMockNode('ASIDE', {}, {
    rect: { left: 1096, top: 0, right: 1440, bottom: 900, width: 344, height: 900 },
    computed: { display: 'flex', flexDirection: 'column', flexWrap: 'nowrap', position: 'relative', visibility: 'visible', getPropertyValue: () => '' }
  });
  const panelHeader = createMockNode('HEADER', {}, {
    rect: { left: 1096, top: 0, right: 1440, bottom: 40, width: 344, height: 40 }
  });
  const gridBody = createMockNode('DIV', {}, {
    rect: { left: 1096, top: 40, right: 1440, bottom: 900, width: 344, height: 860 },
    computed: { display: 'grid', gridTemplateColumns: '320px', position: 'relative', visibility: 'visible', getPropertyValue: () => '' }
  });
  const flatRoundedCard = createMockNode('DIV', {}, {
    rect: { left: 1108, top: 52, right: 1428, bottom: 292, width: 320, height: 240 },
    computed: {
      display: 'block', position: 'relative', visibility: 'visible',
      backgroundColor: 'rgb(255, 255, 255)', borderTopLeftRadius: '12px',
      borderTopWidth: '0px', borderLeftWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px',
      boxShadow: 'none', getPropertyValue: () => ''
    }
  });
  const mdPreview = createMockNode('DIV', { class: 'chat-markdown' }, {
    rect: { left: 1120, top: 80, right: 1416, bottom: 200, width: 296, height: 120 }
  });
  flatRoundedCard.appendChild(mdPreview);
  gridBody.appendChild(flatRoundedCard);
  rightRail.appendChild(panelHeader);
  rightRail.appendChild(gridBody);
  chatCol.appendChild(composerForm);
  splitRow.appendChild(chatCol);
  splitRow.appendChild(rightRail);
  mainEl.appendChild(splitRow);
  h.body.appendChild(mainEl);

  h.setSelectors(new Map([
    ['main', [mainEl]],
    ['[data-chat-composer-form]', [composerForm]]
  ]));

  h.boot();
  await delay(0);

  const host = h.findOverviewHost();
  const diag = h.context.__t3Tools.diagnoseAnchors().overviewLayout;
  assert.equal(host.parentElement, gridBody, 'should descend past header and dock vertically inside single-column grid scroll body');
  assert.equal(diag.mode, 'docked');
  assert.equal(diag.dockStyle, 'stack');
  assert.equal(diag.contentBottom, 292);

  h.context.__t3Tools.dispose();
});

test('234px overlay top-right card at 2048x1104 is never dropped by tall/compact height boundary', async () => {
  const h = createHarness({ vw: 2048, vh: 1104 });
  const conv = createMockNode('MAIN', { 'data-workspace-area': 'conversation' }, {
    rect: { left: 256, top: 40, right: 2042, bottom: 1104, width: 1786, height: 1064 }
  });
  const composerForm = createMockNode('FORM', { 'data-chat-composer-form': '' }, {
    rect: { left: 600, top: 960, right: 1500, bottom: 1080, width: 900, height: 120 }
  });
  // Exact 234px height that previously fell into the 220..239px dead zone!
  const card234 = createMockNode('DIV', {}, {
    rect: { left: 1726, top: 52, right: 2030, bottom: 286, width: 304, height: 234 },
    computed: {
      display: 'block', position: 'fixed', visibility: 'visible',
      backgroundColor: 'rgb(255, 255, 255)', borderTopWidth: '1px', borderLeftWidth: '1px',
      borderRightWidth: '1px', borderBottomWidth: '1px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
      getPropertyValue: () => ''
    }
  });
  const innerRow = createMockNode('DIV', {}, {
    rect: { left: 1726, top: 52, right: 2030, bottom: 286, width: 304, height: 234 }
  });
  card234.appendChild(innerRow);
  conv.appendChild(composerForm);
  h.body.appendChild(conv);
  h.body.appendChild(card234);

  h.context.document.elementsFromPoint = (x, y) =>
    (x >= 1726 && x <= 2030 && y >= 52 && y <= 286 ? [innerRow, card234, conv, h.body] : [conv, h.body]);
  h.setSelectors(new Map([
    ['[data-workspace-area="conversation"]', [conv]],
    ['[data-chat-composer-form]', [composerForm]]
  ]));

  h.boot();
  await delay(0);

  const host = h.findOverviewHost();
  const diag = h.context.__t3Tools.diagnoseAnchors().overviewLayout;
  assert.equal(host.parentElement, card234, '234px overlay card must be detected and merged');
  assert.equal(diag.mode, 'docked');
  assert.equal(diag.isCompactCard, true);

  h.context.__t3Tools.dispose();
});
