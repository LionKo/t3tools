/**
 * Self-contained client injected into Windows T3 Code renderer via CDP isolated world.
 * Fixes from Codex Astra review:
 * - Backdrop click closes ONLY when backdrop itself is clicked (does not hijack tabs/heatmap/pagination!) (P1 #1)
 * - Route detection supports /$environmentId/$threadId, /threads/$envId/$threadId, and sidebar descendant aria-current (P1 #2)
 * - Preserves session search input focus by updating only the results table container & tracks monotonic response order (P2 #20)
 * - Unregisters detached mounts from themeSync so no stale hosts leak (P3)
 */
(function bootT3Tools(config) {
  const VERSION = config.version || '0.1.0';
  const BOOT_ID = config.bootId || '';
  if (
    globalThis.__t3Tools?.version === VERSION &&
    globalThis.__t3Tools?.bootId === BOOT_ID &&
    globalThis.__t3Tools.healthy
  ) {
    return;
  }
  try { globalThis.__t3Tools?.dispose?.(); } catch {}

  const selectors = config.selectors || { anchors: {}, routeThreadPatterns: [], theme: {} };
  const transport = config.transport || 'cdp';
  const apiBase = config.apiBase || 'http://127.0.0.1:17373';
  const authToken = config.authToken || '';

  const pendingRpc = new Map();
  let rpcSeq = 0;

  globalThis.__t3ToolsReceive = function (id, reply) {
    const entry = pendingRpc.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pendingRpc.delete(id);
    if (reply?.ok) entry.resolve(reply.data);
    else entry.reject(new Error(reply?.error || 'RPC 调用失败'));
  };

  async function callRpc(action, params = {}) {
    if (transport === 'cdp' && typeof globalThis.__t3ToolsBridge === 'function') {
      return new Promise((resolve, reject) => {
        const id = `rpc_${++rpcSeq}_${Date.now()}`;
        const timer = setTimeout(() => {
          pendingRpc.delete(id);
          reject(new Error(`RPC ${action} 超时`));
        }, 8000);
        pendingRpc.set(id, { resolve, reject, timer });
        globalThis.__t3ToolsBridge(JSON.stringify({ id, action, params }));
      });
    }
    const headers = authToken ? { 'X-T3Tools-Token': authToken } : {};
    if (action === 'getLive') {
      const qs = new URLSearchParams({ allowFallback: '0' });
      if (params.threadId) qs.set('threadId', params.threadId);
      const r = await fetch(`${apiBase}/api/live?${qs.toString()}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || '请求失败');
      return j.data;
    }
    if (action === 'getDashboard') {
      const sp = new URLSearchParams();
      const skip = new Set(['force', 'tab', 'heatmapMetric', 'quotaDriver', 'quotaSort', 'quotaView', 'hideEmail']);
      for (const [k, v] of Object.entries(params || {})) {
        if (!skip.has(k) && v !== undefined && v !== null && v !== '') sp.set(k, String(v));
      }
      if (params.force) {
        await fetch(`${apiBase}/api/sync`, { method: 'POST', headers }).catch(() => {});
      }
      const r = await fetch(`${apiBase}/api/dashboard?${sp.toString()}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || '请求失败');
      return j.data;
    }
    if (action === 'updateSettings') {
      const r = await fetch(`${apiBase}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(params || {})
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || '保存失败');
      return j.data;
    }
    if (action === 'forceSync') {
      await fetch(`${apiBase}/api/sync`, { method: 'POST', headers });
      return { ok: true };
    }
    const r = await fetch(`${apiBase}/api/status`);
    return (await r.json()).data;
  }

  function isVisibleElement(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    if (el.closest?.('[data-t3tools]')) return false;
    const rect = el.getBoundingClientRect();
    return Boolean(rect && rect.width > 0 && rect.height > 0);
  }

  function findAnchor(key) {
    const list = selectors.anchors?.[key] || [];
    for (const sel of list) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch {}
    }
    return null;
  }

  function findComposerMountTarget() {
    const footerSelectors = selectors.anchors?.composerFooter || [];
    const rightSelectors = selectors.anchors?.composerFooterRightActions || [];
    for (const sel of footerSelectors) {
      try {
        for (const footer of document.querySelectorAll(sel)) {
          if (!isVisibleElement(footer)) continue;
          let beforeEl = null;
          for (const rSel of rightSelectors) {
            try {
              const found = footer.querySelector(rSel);
              if (found && found.parentElement === footer) {
                beforeEl = found;
                break;
              }
            } catch {}
          }
          return { mode: 'footer-inline', container: footer, beforeEl };
        }
      } catch {}
    }

    const cardSelectors = selectors.anchors?.composerCard || [];
    for (const sel of cardSelectors) {
      try {
        for (const el of document.querySelectorAll(sel)) {
          if (!isVisibleElement(el) || !el.parentElement) continue;
          const parentStyle = getComputedStyle(el.parentElement);
          const isHorizontalFlex = parentStyle.display.includes('flex') && parentStyle.flexDirection.startsWith('row');
          if (!isHorizontalFlex) return { mode: 'below-card', anchor: el };
        }
      } catch {}
    }
    const hostSelectors = selectors.anchors?.composerHost || [];
    for (const sel of hostSelectors) {
      try {
        for (const el of document.querySelectorAll(sel)) {
          if (isVisibleElement(el) && el.parentElement) return { mode: 'below-card', anchor: el };
        }
      } catch {}
    }
    const fallback = findAnchor('composerHost');
    return fallback ? { mode: 'below-card', anchor: fallback } : null;
  }

  function matchRouteThreadId(pathname, search = '') {
    const pathAndQuery = `${pathname || ''}${search || ''}`;
    for (const pattern of selectors.routeThreadPatterns || []) {
      try {
        const re = new RegExp(pattern, 'i');
        const target = pattern.startsWith('[?&]') ? pathAndQuery : (pathname || '');
        const m = target.match(re);
        if (m && m[1]) {
          const decoded = decodeURIComponent(m[1]).trim();
          if (decoded && !/^(new|settings|usage|projects|themes|home)$/i.test(decoded)) {
            return decoded;
          }
        }
      } catch {}
    }
    return '';
  }

  function detectActiveThreadId() {
    // 1. Electron desktop uses Hash routing: t3code://app/#/<envId>/<threadId>
    const rawHash = String(location.hash || '').replace(/^#/, '');
    if (rawHash) {
      const qIdx = rawHash.indexOf('?');
      const hashPath = qIdx >= 0 ? rawHash.slice(0, qIdx) : rawHash;
      const hashSearch = qIdx >= 0 ? rawHash.slice(qIdx) : '';
      const fromHash = matchRouteThreadId(hashPath.startsWith('/') ? hashPath : `/${hashPath}`, hashSearch);
      if (fromHash) return fromHash;
    }

    // 2. Standard browser path routing: http://127.0.0.1:3773/<envId>/<threadId>
    const fromRoute = matchRouteThreadId(location.pathname, location.search);
    if (fromRoute) return fromRoute;

    // 3. Fallback to active sidebar thread item
    const activeEl = findAnchor('activeThreadItem');
    if (activeEl) {
      const container = activeEl.closest?.('[data-thread-item]') || activeEl;
      const attr = container.getAttribute?.('data-thread-id') || container.getAttribute?.('data-thread-item');
      if (attr && attr !== 'true' && attr !== '1') return attr;

      const link = activeEl.tagName === 'A' ? activeEl : (container.querySelector?.('a[href]') || activeEl.closest?.('a[href]'));
      const href = link?.getAttribute?.('href') || '';
      if (href) {
        try {
          const cleanHref = href.startsWith('#') ? href.slice(1) : href;
          const u = new URL(cleanHref, 'http://localhost');
          const fromHref = matchRouteThreadId(u.pathname, u.search);
          if (fromHref) return fromHref;
        } catch {}
      }
    }
    return '';
  }

  const themeSync = createThemeSynchronizer(selectors.theme);
  themeSync.start();

  function destroyMount(mount) {
    if (!mount) return;
    themeSync.unregister(mount.host);
    try { mount.host.remove(); } catch {}
  }

  function createShadowMount(id, hostStyle = '') {
    const host = document.createElement('div');
    host.id = id;
    host.setAttribute('data-t3tools', '1');
    if (hostStyle) host.style.cssText = hostStyle;
    const shadow = host.attachShadow({ mode: 'open' });
    const styleEl = document.createElement('style');
    styleEl.textContent = PT_SHARED_CSS;
    const contentEl = document.createElement('div');
    contentEl.className = 'pt-root';
    shadow.append(styleEl, contentEl);
    themeSync.register(host);
    return { host, shadow, contentEl };
  }

  let disposed = false;
  let lastLive = null;
  let lastDash = null;
  let dashLoading = false;
  let dashError = '';
  let overviewCollapsed = false;
  let showAllSteps = false;
  let dashboardOpen = false;
  let dashRequestSeq = 0;
  let dashState = {
    tab: 'overview',
    preset: 'weeklyQuota',
    account: 'all',
    model: 'all',
    status: 'all',
    session: '',
    onlyAnomalies: false,
    heatmapMetric: 'tokens',
    quotaDriver: 'all',
    quotaSort: 'remaining',
    quotaView: 'cards',
    hideEmail: false,
    page: 1
  };

  let composerMount = null;
  let composerMountMode = 'footer-inline';
  let lastComposerHtml = '';
  let overviewMount = null;
  let sidebarMount = null;
  let overlayMount = null;

  const COMPOSER_INLINE_HOST_STYLE = 'display:inline-flex;align-items:center;position:relative;z-index:20;min-width:0;flex:0 1 auto;overflow:visible;margin-right:6px;';
  const COMPOSER_BLOCK_HOST_STYLE = 'display:block;width:100%;flex:none;overflow:visible;';

  function ensureMounts() {
    if (disposed) return;

    const composerTarget = findComposerMountTarget();
    if (composerTarget) {
      const nextMode = composerTarget.mode;
      let recreatedComposer = false;
      if (!composerMount || !composerMount.host.isConnected || composerMountMode !== nextMode) {
        destroyMount(composerMount);
        composerMountMode = nextMode;
        composerMount = createShadowMount(
          't3tools-composer',
          nextMode === 'footer-inline' ? COMPOSER_INLINE_HOST_STYLE : COMPOSER_BLOCK_HOST_STYLE
        );
        composerMount.contentEl.addEventListener('click', onWidgetClick);
        lastComposerHtml = '';
        recreatedComposer = true;
      }
      if (nextMode === 'footer-inline') {
        const { container, beforeEl } = composerTarget;
        const alreadyPlaced = beforeEl
          ? (composerMount.host.parentElement === container && composerMount.host.nextElementSibling === beforeEl)
          : (composerMount.host.parentElement === container && composerMount.host.nextElementSibling === null);
        if (!alreadyPlaced) {
          if (beforeEl) container.insertBefore(composerMount.host, beforeEl);
          else container.appendChild(composerMount.host);
        }
      } else {
        const { anchor } = composerTarget;
        if (composerMount.host.parentElement !== anchor.parentElement || composerMount.host.previousElementSibling !== anchor) {
          anchor.insertAdjacentElement('afterend', composerMount.host);
        }
      }
      if (recreatedComposer && lastLive) {
        renderLiveWidgets();
      }
    }

    if (!overviewMount || !overviewMount.host.isConnected) {
      destroyMount(overviewMount);
      overviewMount = createShadowMount('t3tools-overview', 'position:fixed;top:54px;right:18px;z-index:9990;');
      overviewMount.contentEl.addEventListener('click', onWidgetClick);
      document.body.appendChild(overviewMount.host);
    }

    const sidebar = findAnchor('sidebar');
    if (sidebar) {
      if (!sidebarMount || !sidebarMount.host.isConnected) {
        destroyMount(sidebarMount);
        sidebarMount = createShadowMount('t3tools-sidebar-btn', 'display:block;width:100%;flex:none;');
        sidebarMount.contentEl.innerHTML = `
          <button class="pt-sidebar-trigger" data-pt-action="open-dashboard" title="打开 T3Tools 用量与缓存看板">
            <span>⚡ 用量 & 缓存看板</span>
            <span class="pt-muted" style="font-size:10.5px;">T3Tools</span>
          </button>
        `;
        sidebarMount.contentEl.addEventListener('click', onWidgetClick);
      }
      if (!sidebar.contains(sidebarMount.host)) {
        sidebar.appendChild(sidebarMount.host);
      }
    }
  }

  function renderLiveWidgets() {
    if (!lastLive) return;
    if (composerMount) {
      const hidden = Boolean(lastLive?.thread?.unresolved);
      const isInline = composerMountMode === 'footer-inline';
      const nextDisplay = hidden ? 'none' : (isInline ? 'inline-flex' : 'block');
      if (composerMount.host.style.display !== nextDisplay) {
        composerMount.host.style.display = nextDisplay;
      }
      const nextComposerHtml = renderComposerBarHtml(lastLive, { hideWhenUnresolved: true, inline: isInline });
      if (nextComposerHtml !== lastComposerHtml) {
        composerMount.contentEl.innerHTML = nextComposerHtml;
        lastComposerHtml = nextComposerHtml;
      }
    }
    if (overviewMount) {
      overviewMount.contentEl.innerHTML = renderOverviewCardHtml(lastLive, overviewCollapsed, showAllSteps);
    }
  }

  function renderDashboardOverlay({ partialRequestsOnly = false } = {}) {
    if (!dashboardOpen) {
      destroyMount(overlayMount);
      overlayMount = null;
      return;
    }
    if (!overlayMount || !overlayMount.host.isConnected) {
      destroyMount(overlayMount);
      overlayMount = createShadowMount('t3tools-dashboard-overlay', 'position:fixed;inset:0;z-index:99998;');
      overlayMount.contentEl.addEventListener('click', onDashboardClick);
      overlayMount.contentEl.addEventListener('change', onDashboardChange);
      overlayMount.contentEl.addEventListener('input', onDashboardInput);
      document.body.appendChild(overlayMount.host);
      partialRequestsOnly = false;
    }

    // Preserve search input focus when only request results changed (fixes P2 #20)
    if (partialRequestsOnly && dashState.tab === 'requests') {
      const card = overlayMount.contentEl.querySelector('[data-pt-requests-card]');
      if (card) {
        card.innerHTML = renderRequestsTableCardHtml(lastDash);
        const anomCount = lastDash?.anomalySummary?.total || 0;
        const c1 = overlayMount.contentEl.querySelector('[data-pt-anomaly-count]');
        const c2 = overlayMount.contentEl.querySelector('[data-pt-tab-anom-count]');
        const cn = overlayMount.contentEl.querySelector('[data-pt-compaction-note]');
        if (c1) c1.textContent = String(anomCount);
        if (c2) c2.textContent = String(anomCount);
        if (cn) cn.textContent = `已排除冷启动及 ${lastDash?.anomalySummary?.excludedCompactions || 0} 次上下文压缩误报`;
        return;
      }
    }

    const bodyContent = (!lastDash && dashLoading)
      ? `<div class="pt-dashboard"><div class="pt-dash-header"><strong>⚡ T3Tools</strong><button class="pt-btn" data-pt-action="close-dashboard">关闭 ✕</button></div><div class="pt-dash-body"><div class="pt-card" style="text-align:center;padding:36px;">正在同步并加载本轮周限额用量数据...</div></div></div>`
      : (!lastDash && dashError)
        ? `<div class="pt-dashboard"><div class="pt-dash-header"><strong>⚡ T3Tools</strong><div class="pt-dash-controls"><button class="pt-btn" data-pt-action="refresh">重试</button><button class="pt-btn" data-pt-action="close-dashboard">关闭 ✕</button></div></div><div class="pt-dash-body"><div class="pt-card"><div class="pt-text-danger" style="font-weight:600;margin-bottom:6px;">无法获取本地守护进程数据</div><div class="pt-muted">${esc(dashError)}</div></div></div></div>`
        : renderDashboardHtml(lastDash, dashState, { standalone: false });

    overlayMount.contentEl.innerHTML = `
      <div class="pt-overlay-backdrop" data-pt-backdrop="1">
        ${bodyContent}
      </div>
    `;
  }

  async function refreshDashboard({ force = false, partialRequestsOnly = false } = {}) {
    const seq = ++dashRequestSeq;
    dashLoading = true;
    dashError = '';
    if (!lastDash) renderDashboardOverlay();
    try {
      const data = await callRpc('getDashboard', { ...dashState, force });
      // Discard stale out-of-order responses (fixes P2 #20)
      if (seq !== dashRequestSeq || !dashboardOpen) return;
      lastDash = data;
      dashLoading = false;
      dashError = '';
      renderDashboardOverlay({ partialRequestsOnly });
    } catch (err) {
      if (seq !== dashRequestSeq || !dashboardOpen) return;
      dashLoading = false;
      dashError = err?.message || '与本地守护进程通信失败（请确认守护进程正在运行）';
      renderDashboardOverlay();
    }
  }

  function onWidgetClick(e) {
    const btn = e.target.closest?.('[data-pt-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-pt-action');
    if (action === 'toggle-overview') {
      overviewCollapsed = !overviewCollapsed;
      renderLiveWidgets();
      callRpc('updateSettings', { overviewCollapsed }).catch(() => {});
    } else if (action === 'toggle-all-steps') {
      showAllSteps = !showAllSteps;
      renderLiveWidgets();
    } else if (action === 'open-dashboard') {
      dashboardOpen = true;
      renderDashboardOverlay();
      refreshDashboard({ force: true });
    } else if (action === 'open-quotas') {
      dashState.tab = 'quotas';
      dashboardOpen = true;
      renderDashboardOverlay();
      refreshDashboard({ force: true });
    }
  }

  function onDashboardClick(e) {
    // Only close when clicking the backdrop itself, NEVER when clicking inside the dashboard (fixes P1 #1)
    if (e.target?.getAttribute?.('data-pt-backdrop') === '1') {
      dashboardOpen = false;
      renderDashboardOverlay();
      return;
    }
    const actionEl = e.target.closest?.('[data-pt-action]');
    if (actionEl) {
      const action = actionEl.getAttribute('data-pt-action');
      if (action === 'close-dashboard') {
        dashboardOpen = false;
        renderDashboardOverlay();
        return;
      }
      if (action === 'refresh') {
        refreshDashboard({ force: true });
        return;
      }
      if (action === 'toggle-hide-email') {
        dashState.hideEmail = !dashState.hideEmail;
        renderDashboardOverlay();
        return;
      }
    }
    const driverEl = e.target.closest?.('[data-pt-quota-driver]');
    if (driverEl) {
      dashState.quotaDriver = driverEl.getAttribute('data-pt-quota-driver') || 'all';
      renderDashboardOverlay();
      return;
    }
    const qViewEl = e.target.closest?.('[data-pt-quota-view]');
    if (qViewEl) {
      dashState.quotaView = qViewEl.getAttribute('data-pt-quota-view') || 'cards';
      renderDashboardOverlay();
      return;
    }
    const inspectEl = e.target.closest?.('[data-pt-inspect-account]');
    if (inspectEl) {
      dashState.account = inspectEl.getAttribute('data-pt-inspect-account') || 'all';
      dashState.tab = 'overview';
      dashState.page = 1;
      refreshDashboard();
      return;
    }
    const tabEl = e.target.closest?.('[data-pt-tab]');
    if (tabEl) {
      dashState.tab = tabEl.getAttribute('data-pt-tab');
      renderDashboardOverlay();
      return;
    }
    const hmEl = e.target.closest?.('[data-pt-heatmap]');
    if (hmEl) {
      dashState.heatmapMetric = hmEl.getAttribute('data-pt-heatmap');
      renderDashboardOverlay();
      return;
    }
    const pageEl = e.target.closest?.('[data-pt-page]');
    if (pageEl && !pageEl.disabled) {
      dashState.page = Number(pageEl.getAttribute('data-pt-page')) || 1;
      refreshDashboard({ partialRequestsOnly: true });
    }
  }

  function onDashboardChange(e) {
    const sortEl = e.target.closest?.('[data-pt-quota-sort]');
    if (sortEl) {
      dashState.quotaSort = sortEl.value || 'remaining';
      renderDashboardOverlay();
      return;
    }
    const el = e.target.closest?.('[data-pt-filter]');
    if (!el) return;
    const key = el.getAttribute('data-pt-filter');
    if (key === 'onlyAnomalies') dashState.onlyAnomalies = Boolean(el.checked);
    else dashState[key] = el.value;
    dashState.page = 1;
    // Keep account selectors in header & filter bar synced; partial update only for table-local filters
    const partial = dashState.tab === 'requests' && (key === 'model' || key === 'status' || key === 'onlyAnomalies');
    refreshDashboard({ partialRequestsOnly: partial });
  }

  let searchTimer = null;
  function onDashboardInput(e) {
    const el = e.target.closest?.('[data-pt-filter="session"]');
    if (!el) return;
    dashState.session = el.value;
    dashState.page = 1;
    // Immediately invalidate any in-flight full refresh so it cannot replace the active search input during debounce (fixes P2 #20)
    dashRequestSeq++;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => refreshDashboard({ partialRequestsOnly: true }), 260);
  }

  let pollInFlight = false;
  let liveRequestSeq = 0;
  async function pollLive() {
    if (disposed || pollInFlight) return;
    pollInFlight = true;
    const reqSeq = ++liveRequestSeq;
    try {
      ensureMounts();
      const threadId = detectActiveThreadId();
      const live = await callRpc('getLive', { threadId });
      // Discard delayed responses if the user navigated to a different thread while in flight (fixes P2 #2)
      if (disposed || reqSeq !== liveRequestSeq || detectActiveThreadId() !== threadId) return;
      if (!lastLive && live?.settings && typeof live.settings.overviewCollapsed === 'boolean') {
        overviewCollapsed = live.settings.overviewCollapsed;
      }
      lastLive = live;
      renderLiveWidgets();
    } catch {} finally {
      pollInFlight = false;
    }
  }

  const domObserver = new MutationObserver(() => {
    if (!disposed) ensureMounts();
  });
  domObserver.observe(document.body, { childList: true, subtree: true });

  const onKeyDown = e => {
    if (e.key === 'Escape' && dashboardOpen) {
      dashboardOpen = false;
      renderDashboardOverlay();
    }
  };
  const onRouteChange = () => {
    if (!disposed) pollLive();
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('hashchange', onRouteChange);
  window.addEventListener('popstate', onRouteChange);

  ensureMounts();
  pollLive();
  const pollTimer = setInterval(pollLive, 2500);

  globalThis.__t3Tools = {
    version: VERSION,
    bootId: BOOT_ID,
    healthy: true,
    openDashboard() {
      dashboardOpen = true;
      renderDashboardOverlay();
      refreshDashboard({ force: true });
    },
    diagnoseAnchors() {
      const report = {};
      for (const key of Object.keys(selectors.anchors || {})) {
        report[key] = Boolean(findAnchor(key));
      }
      return { threadId: detectActiveThreadId(), anchors: report };
    },
    dispose() {
      disposed = true;
      clearInterval(pollTimer);
      clearTimeout(searchTimer);
      for (const entry of pendingRpc.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('实例已重载'));
      }
      pendingRpc.clear();
      domObserver.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('hashchange', onRouteChange);
      window.removeEventListener('popstate', onRouteChange);
      destroyMount(composerMount);
      destroyMount(overviewMount);
      destroyMount(sidebarMount);
      destroyMount(overlayMount);
      composerMount = overviewMount = sidebarMount = overlayMount = null;
      lastComposerHtml = '';
      themeSync.dispose();
      if (globalThis.__t3Tools) globalThis.__t3Tools.healthy = false;
    }
  };
})(__T3TOOLS_CONFIG__);
