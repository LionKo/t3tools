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
    if (action === 'exportRequestsCsv') {
      const res = await fetch(apiBase + '/api/requests.csv?' + new URLSearchParams(params));
      if (!res.ok) throw new Error('CSV HTTP ' + res.status);
      return { csv: '\uFEFF' + await res.text(), filename: 't3tools-requests.csv' };
    }
    if (action === 'getDashboard') {
      const sp = new URLSearchParams();
      const skip = new Set(['force', 'tab', 'heatmapMetric', 'quotaDriver', 'quotaSort', 'quotaView', 'hideEmail', 'detailId', 'ledgerScroll', 'ledgerFocus', 'speedSort', 'speedDir', 'modelSort', 'modelSortDir', '_chartW']);
      for (const [k, v] of Object.entries(params || {})) {
        if (!skip.has(k) && v !== undefined && v !== null && v !== '') sp.set(k, String(v));
      }
      if (params.force) {
        await callRpc('forceSync');
      }
      const r = await fetch(`${apiBase}/api/dashboard?${sp.toString()}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || '请求失败');
      return j.data;
    }
    if (['focusThread','ackErrors','testAlert'].includes(action)) {
      const path = action === 'focusThread' ? '/api/t3/focus-thread' : action === 'testAlert' ? '/api/alerts/test' : '/api/errors/ack';
      const res = await fetch(apiBase + path,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(params)});
      const json = await res.json();
      if (!json.ok) throw new Error(json.error);
      return json.data;
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
      const response = await fetch(apiBase + '/api/sync', {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}'
      });
      const result = await response.json();
      if (!result.ok) throw new Error(result.error || '刷新失败');
      return result.data;
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

  function isNonThreadRoutePath(pathname = '') {
    return /^\/(draft|settings|usage|projects?|themes?|login|auth)(?:\/|$)/i.test(String(pathname || ''));
  }

  function normalizeThreadIdCandidate(raw) {
    const val = String(raw || '').trim();
    if (!val || val === 'true' || val === '1') return '';
    // T3 Code sidebar data-thread-item uses "<envUuid>:<threadId>"
    const envPrefixMatch = val.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(.+)$/i);
    if (envPrefixMatch && envPrefixMatch[1]) {
      return envPrefixMatch[1].trim();
    }
    return val;
  }

  function matchRouteThreadId(pathname, search = '') {
    if (isNonThreadRoutePath(pathname)) return '';
    const pathAndQuery = `${pathname || ''}${search || ''}`;
    for (const pattern of selectors.routeThreadPatterns || []) {
      try {
        const re = new RegExp(pattern, 'i');
        const target = pattern.startsWith('[?&]') ? pathAndQuery : (pathname || '');
        const m = target.match(re);
        if (m && m[1]) {
          const decoded = decodeURIComponent(m[1]).trim();
          if (decoded && !/^(new|draft|settings|usage|projects|themes|home)$/i.test(decoded)) {
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
      const normalizedHashPath = hashPath.startsWith('/') ? hashPath : `/${hashPath}`;
      if (isNonThreadRoutePath(normalizedHashPath)) return '';
      const fromHash = matchRouteThreadId(normalizedHashPath, hashSearch);
      if (fromHash) return fromHash;
    }

    // 2. Standard browser path routing: http://127.0.0.1:3773/<envId>/<threadId>
    if (isNonThreadRoutePath(location.pathname)) return '';
    const fromRoute = matchRouteThreadId(location.pathname, location.search);
    if (fromRoute) return fromRoute;

    // 3. Fallback to active sidebar thread item
    const activeEl = findAnchor('activeThreadItem');
    if (activeEl) {
      const container = activeEl.closest?.('[data-thread-item]') || activeEl;
      const attr = normalizeThreadIdCandidate(
        container.getAttribute?.('data-thread-id') || container.getAttribute?.('data-thread-item')
      );
      if (attr) return attr;

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
    mount?.contentEl?._ledResize?.disconnect();
    mount?.contentEl?._ovResize?.disconnect();
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
  let lastLiveThreadId = '';
  let lastSettings = null;
  let activeThreadId = detectActiveThreadId();
  let lastRouteHref = String(location.href || '');
  let consecutiveLiveErrors = 0;
  let lastDash = null;
  let lastStatus = null;
  let dashLoading = false;
  let dashError = '';
  let dashSideCollapsed = false;
  try { dashSideCollapsed = localStorage.getItem('t3tools.sideCollapsed') === '1'; } catch {}
  let overlayToastText = '';
  let overlayToastTimer = null;
  let overviewCollapsed = false;
  let showAllSteps = false;
  let dashboardOpen = false;
  let dashRequestSeq = 0;
  let initialDashPreset = 'weeklyQuota';
  try {
    const storedPreset = localStorage.getItem('t3tools.usagePeriod');
    if (storedPreset && isKeptPeriod(storedPreset)) initialDashPreset = storedPreset;
  } catch {}
  let initialHeatmapMetric = 'tokens';
  try {
    const storedHm = localStorage.getItem('t3tools.heatmapMetric');
    if (storedHm) initialHeatmapMetric = normalizeHeatmapMetric(storedHm);
  } catch {}

  let dashState = {
    tab: 'overview',
    preset: initialDashPreset,
    account: 'all',
    model: 'all',
    status: 'all',
    session: '',
    onlyAnomalies: false,
    heatmapMetric: initialHeatmapMetric,
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
      if (recreatedComposer) {
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
          <button class="pt-sidebar-trigger" data-pt-action="open-dashboard" title="打开 T3Tools">
            <span>⚡ T3Tools</span>
            <span class="pt-muted" style="font-size:10.5px;">看板</span>
          </button>
        `;
        sidebarMount.contentEl.addEventListener('click', onWidgetClick);
      }
      if (!sidebar.contains(sidebarMount.host)) {
        sidebar.appendChild(sidebarMount.host);
      }
    }
  }

  function hasMatchingLiveForThread(live, threadId) {
    return Boolean(
      threadId &&
      live &&
      !live?.thread?.unresolved &&
      live?.thread?.threadId === threadId &&
      lastLiveThreadId === threadId
    );
  }

  function renderLiveWidgets() {
    const currentThreadId = detectActiveThreadId();
    const cfg = lastLive?.settings || lastSettings || {};
    const matched = hasMatchingLiveForThread(lastLive, currentThreadId);
    const effectiveLive = matched
      ? lastLive
      : (lastLive && !currentThreadId && lastLive?.thread?.unresolved
          ? lastLive
          : {
              settings: cfg,
              thread: {
                unresolved: true,
                reason: currentThreadId ? '正在加载会话...' : '打开会话后显示',
                steps: []
              },
              context: null,
              quotas: { groups: [] }
            });

    if (composerMount) {
      const hidden = cfg.enabled === false || cfg.showComposerBar === false || !matched;
      const isInline = composerMountMode === 'footer-inline';
      const nextDisplay = hidden ? 'none' : (isInline ? 'inline-flex' : 'block');
      if (composerMount.host.style.display !== nextDisplay) {
        composerMount.host.style.display = nextDisplay;
      }
      const nextComposerHtml = renderComposerBarHtml(effectiveLive, { hideWhenUnresolved: true, inline: isInline });
      if (nextComposerHtml !== lastComposerHtml) {
        composerMount.contentEl.innerHTML = nextComposerHtml;
        lastComposerHtml = nextComposerHtml;
      }
    }
    if (sidebarMount) sidebarMount.host.style.display = cfg.enabled === false ? 'none' : 'block';
    if (overviewMount) {
      overviewMount.host.style.display = cfg.enabled === false || cfg.showOverviewCard === false ? 'none' : 'block';
      if (cfg.overviewPosition) {
        overviewMount.host.style.top = cfg.overviewPosition.top + 'px';
        overviewMount.host.style.right = cfg.overviewPosition.right + 'px';
      }
      overviewMount.contentEl.innerHTML = renderOverviewCardHtml(effectiveLive, overviewCollapsed, showAllSteps);
    }
  }

  function showOverlayToast(message) {
    overlayToastText = String(message || '');
    const toastEl = overlayMount?.contentEl?.querySelector('[data-pt-overlay-toast]');
    if (toastEl) toastEl.textContent = overlayToastText;
    clearTimeout(overlayToastTimer);
    if (overlayToastText) {
      overlayToastTimer = setTimeout(() => {
        overlayToastText = '';
        const el = overlayMount?.contentEl?.querySelector('[data-pt-overlay-toast]');
        if (el) el.textContent = '';
      }, 2800);
    }
  }

  async function fetchOverlayStatus() {
    try {
      const st = await callRpc('getStatus');
      if (disposed) return;
      lastStatus = st;
      if (st?.settings) lastSettings = st.settings;
      if (dashboardOpen) renderDashboardOverlay();
    } catch {}
  }

  function renderDashboardOverlay({ partialRequestsOnly = false, resetScroll = false } = {}) {
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

    function wireLedger() {
      bindLedger(overlayMount.contentEl,lastDash,dashState,refreshDashboard,renderDashboardOverlay,async ()=>{
        const result=await callRpc('exportRequestsCsv',dashState);
        ledgerDownload(new Blob([result.csv],{type:'text/csv;charset=utf-8'}),result.filename);
      },showOverlayToast);
    }
    if (partialRequestsOnly && dashState.tab==='requests' && refreshLedgerResults(overlayMount.contentEl,lastDash,dashState)){
      const badge=overlayMount.contentEl.querySelector('[data-pt-tab-anom-count]');
      if(badge)badge.textContent=lastDash.anomalySummary.total;
      wireLedger();
      return;
    }

    const prevViewport = overlayMount.contentEl.querySelector('.app-viewport');
    const prevScrollTop = (!resetScroll && prevViewport) ? prevViewport.scrollTop : 0;

    const bodyContent = renderDashboardHtml(lastDash, dashState, {
      standalone: false,
      version: VERSION,
      sideCollapsed: dashSideCollapsed,
      statusData: lastStatus,
      fallbackSettings: lastLive?.settings || lastSettings,
      loading: dashLoading,
      error: dashError,
      toastText: overlayToastText
    });

    overlayMount.contentEl._ledResize?.disconnect();
    overlayMount.contentEl._ovResize?.disconnect();
    overlayMount.contentEl.innerHTML = `
      <div class="pt-overlay-backdrop" data-pt-backdrop="1">
        ${bodyContent}
      </div>
    `;
    const nextViewport = overlayMount.contentEl.querySelector('.app-viewport');
    if (nextViewport && prevScrollTop > 0) nextViewport.scrollTop = prevScrollTop;
    positionSegsThumb(overlayMount.contentEl, { animate: false });
    if (lastDash && dashState.tab === 'overview') {
      bindOverview(overlayMount.contentEl, lastDash, dashState, {
        render: renderDashboardOverlay,
        applyAccount: nextAcc => {
          closePtPopMenu();
          dashState.account = nextAcc || 'all';
          dashState.page = 1;
          refreshDashboard();
        },
        openView: (view, { fetch: shouldFetch = false } = {}) => {
          closePtPopMenu();
          dashState.tab = view;
          if (view === 'settings') fetchOverlayStatus();
          if (shouldFetch) refreshDashboard();
          else renderDashboardOverlay({ resetScroll: true });
        }
      });
    }
    if(lastDash && dashState.tab==='requests')wireLedger();
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
      resolveLedgerStep(lastDash,dashState);
      dashLoading = false;
      dashError = '';
      renderDashboardOverlay({ partialRequestsOnly });
    } catch (err) {
      if (seq !== dashRequestSeq || !dashboardOpen) return;
      dashLoading = false;
      dashError = err?.message || '连接本地服务失败，请确认 T3Tools 正在运行';
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
      renderDashboardOverlay({ resetScroll: true });
      fetchOverlayStatus();
      refreshDashboard({ force: true });
    } else if (action === 'open-quotas') {
      dashState.tab = 'quotas';
      dashboardOpen = true;
      renderDashboardOverlay({ resetScroll: true });
      fetchOverlayStatus();
      refreshDashboard({ force: true });
    }
  }

  async function onDashboardClick(e) {
    // Capture the inner element before the first await retargets the Shadow DOM event.
    const target = e.target;
    const toast = showOverlayToast;
    try {
      if (await handleErrorClick(e,dashState,{toast,rpc:callRpc,current:()=>dashState.tab,
        close:()=>{dashboardOpen=false;renderDashboardOverlay();},
        open:async view=>{
          dashState.tab = view;
          await refreshDashboard();
          if (view === 'models') overlayMount?.contentEl.querySelector('[data-error-center]')?.scrollIntoView();
        }})) return;
    } catch (err) { toast(err.message); return; }
    // Only close when clicking the backdrop itself, NEVER when clicking inside the dashboard (fixes P1 #1)
    if (target?.getAttribute?.('data-pt-backdrop') === '1') {
      closePtPopMenu();
      dashboardOpen = false;
      renderDashboardOverlay();
      return;
    }
    const applyDashPeriod = nextPreset => {
      if (!nextPreset) return;
      closePtPopMenu();
      dashState.preset = nextPreset;
      dashState.day = '';
      dashState.page = 1;
      if (isKeptPeriod(nextPreset)) {
        try { localStorage.setItem('t3tools.usagePeriod', nextPreset); } catch {}
      }
      const rootEl = overlayMount?.contentEl;
      if (rootEl) {
        const isCustom = !PT_PERIOD_PRESET_KEYS.has(nextPreset);
        for (const b of rootEl.querySelectorAll('[data-pt-period]')) {
          const on = b.getAttribute('data-pt-period') === nextPreset;
          b.classList.toggle('on', on);
          b.setAttribute('aria-selected', on ? 'true' : 'false');
        }
        const rb = rootEl.querySelector('[data-pt-range-trigger]');
        if (rb) {
          rb.classList.toggle('on', isCustom);
          rb.setAttribute('aria-selected', isCustom ? 'true' : 'false');
          const sp = rb.querySelector('span');
          if (sp) sp.textContent = isCustom ? formatPeriodRangeLabel(nextPreset) : '自定义';
        }
        positionSegsThumb(rootEl, { animate: true });
      }
      refreshDashboard();
    };
    const periodEl = target.closest?.('[data-pt-period]');
    if (periodEl) {
      applyDashPeriod(periodEl.getAttribute('data-pt-period'));
      return;
    }
    const rangeEl = target.closest?.('[data-pt-range-trigger]');
    if (rangeEl) {
      openPtRangeMenu(rangeEl, dashState.preset, applyDashPeriod);
      return;
    }
    const accEl = target.closest?.('[data-pt-account-trigger]');
    if (accEl) {
      openPtAccountMenu(accEl, lastDash?.facets?.accounts || [], dashState.account, nextAcc => {
        closePtPopMenu();
        dashState.account = nextAcc || 'all';
        dashState.page = 1;
        refreshDashboard();
      });
      return;
    }
    const actionEl = target.closest?.('[data-pt-action]');
    if (actionEl) {
      const action = actionEl.getAttribute('data-pt-action');
      if (action === 'close-dashboard') {
        closePtPopMenu();
        dashboardOpen = false;
        renderDashboardOverlay();
        return;
      }
      if (action === 'toggle-sidebar') {
        dashSideCollapsed = !dashSideCollapsed;
        try { localStorage.setItem('t3tools.sideCollapsed', dashSideCollapsed ? '1' : '0'); } catch {}
        const shellEl = overlayMount?.contentEl?.querySelector('.app-shell');
        if (shellEl) {
          shellEl.setAttribute('data-side-collapsed', dashSideCollapsed ? 'true' : 'false');
          setTimeout(() => positionSegsThumb(overlayMount?.contentEl, { animate: false }), 200);
        } else {
          renderDashboardOverlay();
        }
        return;
      }
      if (action === 'test-alert') {
        try {
          await callRpc('testAlert', {});
          showOverlayToast('已发送测试告警');
        } catch (err) {
          showOverlayToast(err?.message || '发送测试告警失败');
        }
        return;
      }
      if (action === 'refresh') {
        actionEl.classList?.add('busy');
        fetchOverlayStatus();
        refreshDashboard({ force: true });
        return;
      }
      if (action === 'toggle-hide-email') {
        dashState.hideEmail = !dashState.hideEmail;
        renderDashboardOverlay();
        return;
      }
    }
    const driverEl = target.closest?.('[data-pt-quota-driver]');
    if (driverEl) {
      dashState.quotaDriver = driverEl.getAttribute('data-pt-quota-driver') || 'all';
      renderDashboardOverlay();
      return;
    }
    const qViewEl = target.closest?.('[data-pt-quota-view]');
    if (qViewEl) {
      dashState.quotaView = qViewEl.getAttribute('data-pt-quota-view') || 'cards';
      renderDashboardOverlay();
      return;
    }
    const inspectEl = target.closest?.('[data-pt-inspect-account]');
    if (inspectEl) {
      dashState.account = inspectEl.getAttribute('data-pt-inspect-account') || 'all';
      dashState.tab = 'overview';
      dashState.page = 1;
      refreshDashboard();
      return;
    }
    const modelSortEl = target.closest?.('[data-pt-model-sort]');
    if (modelSortEl) {
      const key = modelSortEl.getAttribute('data-pt-model-sort');
      const prev = dashState.modelSort || 'totalTokens';
      dashState.modelSortDir = prev === key ? -(dashState.modelSortDir || -1) : (key === 'modelId' ? 1 : -1);
      dashState.modelSort = key;
      renderDashboardOverlay();
      return;
    }
    const modelReqEl = target.closest?.('[data-pt-model-requests]');
    if (modelReqEl) {
      Object.assign(dashState, {
        model: modelReqEl.getAttribute('data-pt-model-requests') || 'all',
        driver: 'all',
        sourceGroup: 'all',
        errorCode: 'all',
        status: 'all',
        onlyAnomalies: false,
        day: '',
        session: '',
        detailId: '',
        requestId: '',
        page: 1,
        tab: 'requests'
      });
      refreshDashboard();
      return;
    }
    const tabEl = target.closest?.('[data-pt-tab]');
    if (tabEl) {
      closePtPopMenu();
      dashState.tab = tabEl.getAttribute('data-pt-tab');
      if (dashState.tab === 'settings') fetchOverlayStatus();
      renderDashboardOverlay({ resetScroll: true });
      return;
    }
    const hmEl = target.closest?.('[data-pt-heatmap]');
    if (hmEl) {
      dashState.heatmapMetric = normalizeHeatmapMetric(hmEl.getAttribute('data-pt-heatmap'));
      try { localStorage.setItem('t3tools.heatmapMetric', dashState.heatmapMetric); } catch {}
      renderDashboardOverlay();
      return;
    }
    const pageEl = target.closest?.('[data-pt-page]');
    if (pageEl && !pageEl.disabled) {
      dashState.page = Number(pageEl.getAttribute('data-pt-page')) || 1;
      refreshDashboard({ partialRequestsOnly: true });
    }
  }

  async function onDashboardChange(e) {
    const target = e.target;
    if (target?.dataset?.alertSetting) {
      const key = target.dataset.alertSetting;
      const value = target.type === 'number'
        ? target.valueAsNumber * (key.endsWith('Ms') ? 1000 : 1)
        : key === 'mode'
          ? target.value
          : Boolean(target.checked);
      try {
        const updated = await callRpc('updateSettings', { alertConfig: { [key]: value } });
        if (updated) {
          lastSettings = updated;
          if (lastStatus) lastStatus.settings = updated;
        }
        showOverlayToast('设置已保存');
      } catch (err) {
        showOverlayToast(err?.message || '保存失败');
      }
      return;
    }
    const settingEl = target.closest?.('[data-pt-setting]');
    if (settingEl) {
      const key = settingEl.getAttribute('data-pt-setting');
      const val = Boolean(settingEl.checked);
      try {
        const updated = await callRpc('updateSettings', { [key]: val });
        if (updated) {
          lastSettings = updated;
          if (lastLive) lastLive.settings = updated;
          if (lastStatus) lastStatus.settings = updated;
          renderLiveWidgets();
        }
        showOverlayToast('设置已保存');
      } catch (err) {
        showOverlayToast(err?.message || '保存失败');
      }
      return;
    }
    const sortEl = target.closest?.('[data-pt-quota-sort]');
    if (sortEl) {
      dashState.quotaSort = sortEl.value || 'remaining';
      renderDashboardOverlay();
      return;
    }
    const el = target.closest?.('[data-pt-filter]');
    if (!el) return;
    const key = el.getAttribute('data-pt-filter');
    if (key === 'session') return;
    if (key === 'onlyAnomalies' || key === 'includeRetried' || key === 'errorOnlyToday') dashState[key] = Boolean(el.checked);
    else dashState[key] = el.value;
    dashState.page = 1;
    // Keep account selectors in header & filter bar synced; partial update only for table-local filters
    const partial = dashState.tab === 'requests' && (key === 'model' || key === 'status' || key === 'errorCode' || key === 'onlyAnomalies');
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
    searchTimer = setTimeout(() => refreshDashboard({ partialRequestsOnly: true }), 250);
  }

  let inFlightPolls = 0;
  let liveRequestSeq = 0;

  function syncActiveThread({ triggerPoll = true } = {}) {
    if (disposed) return false;
    const nextHref = String(location.href || '');
    const nextThreadId = detectActiveThreadId();
    const hrefChanged = nextHref !== lastRouteHref;
    const threadChanged = nextThreadId !== activeThreadId;
    if (!hrefChanged && !threadChanged) return false;
    lastRouteHref = nextHref;
    activeThreadId = nextThreadId;
    if (threadChanged) {
      // Immediately drop stale snapshot so old TPS/TTFT/cache/context never leak into the new conversation
      if (lastLiveThreadId !== nextThreadId) {
        lastLive = null;
        lastLiveThreadId = '';
      }
      renderLiveWidgets();
      if (triggerPoll) {
        pollLive({ force: true });
      }
    }
    return threadChanged;
  }

  async function pollLive({ force = false } = {}) {
    if (disposed) return;
    if (!force && inFlightPolls > 0) return;
    const reqSeq = ++liveRequestSeq;
    inFlightPolls++;
    try {
      ensureMounts();
      const threadId = detectActiveThreadId();
      activeThreadId = threadId;
      lastRouteHref = String(location.href || '');
      const live = await callRpc('getLive', { threadId });
      // Discard delayed responses if a newer request was issued
      if (disposed || reqSeq !== liveRequestSeq) return;
      // If user navigated to another thread while this request was in flight, immediately refetch the new thread
      if (detectActiveThreadId() !== threadId) {
        syncActiveThread({ triggerPoll: true });
        return;
      }
      consecutiveLiveErrors = 0;
      if (live?.settings) {
        if (!lastSettings && typeof live.settings.overviewCollapsed === 'boolean') {
          overviewCollapsed = live.settings.overviewCollapsed;
        }
        lastSettings = live.settings;
      }
      if (dashboardOpen && dashState.tab === 'models' && lastLive?.globalAlerts?.unreadCount !== live.globalAlerts?.unreadCount) refreshDashboard();
      lastLive = live;
      lastLiveThreadId = (!live?.thread?.unresolved && live?.thread?.threadId) ? String(live.thread.threadId) : '';
      renderLiveWidgets();
    } catch {
      if (disposed || reqSeq !== liveRequestSeq) return;
      consecutiveLiveErrors++;
      const nowThreadId = detectActiveThreadId();
      if (nowThreadId !== activeThreadId) {
        syncActiveThread({ triggerPoll: true });
        return;
      }
      // Clear stale snapshot on daemon disconnect/timeout or when switching to a thread that fails to load
      if (consecutiveLiveErrors >= 2 || lastLiveThreadId !== nowThreadId) {
        lastLive = null;
        lastLiveThreadId = '';
        renderLiveWidgets();
      }
    } finally {
      inFlightPolls = Math.max(0, inFlightPolls - 1);
    }
  }

  const domObserver = new MutationObserver(() => {
    if (disposed) return;
    syncActiveThread({ triggerPoll: true });
    ensureMounts();
  });
  domObserver.observe(document.body, { childList: true, subtree: true });

  const onKeyDown = e => {
    if (e.key === 'Escape' && dashboardOpen) {
      if (closePtPopMenu()) { e.preventDefault(); return; }
      const back = overlayMount?.contentEl.querySelector('[data-pt-led-back]');
      if (back) { e.preventDefault(); back.click(); return; }
      dashboardOpen = false;
      renderDashboardOverlay();
    }
  };
  const onRouteChange = () => {
    if (disposed) return;
    if (!syncActiveThread({ triggerPoll: true })) {
      pollLive({ force: true });
    }
  };
  const onClickNavHint = () => {
    if (disposed) return;
    Promise.resolve().then(() => {
      if (!disposed) syncActiveThread({ triggerPoll: true });
    });
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('hashchange', onRouteChange);
  window.addEventListener('popstate', onRouteChange);
  window.addEventListener('focus', onRouteChange);
  window.addEventListener('click', onClickNavHint, true);

  ensureMounts();
  pollLive({ force: true });
  let pollTimer;
  function schedulePoll() {
    if (disposed) return;
    pollTimer = setTimeout(async () => {
      await pollLive();
      schedulePoll();
    }, (lastLive?.settings || lastSettings)?.pollIntervalMs || 2500);
  }
  schedulePoll();

  globalThis.__t3Tools = {
    version: VERSION,
    bootId: BOOT_ID,
    healthy: true,
    openDashboard() {
      dashboardOpen = true;
      renderDashboardOverlay({ resetScroll: true });
      fetchOverlayStatus();
      refreshDashboard({ force: true });
    },
    diagnoseAnchors() {
      const report = {};
      for (const key of Object.keys(selectors.anchors || {})) {
        report[key] = Boolean(findAnchor(key));
      }
      return { threadId: detectActiveThreadId(), lastLiveThreadId, anchors: report };
    },
    dispose() {
      disposed = true;
      dashboardOpen = false;
      dashRequestSeq++;
      liveRequestSeq++;
      lastLive = null;
      lastLiveThreadId = '';
      closePtPopMenu();
      clearTimeout(pollTimer);
      clearTimeout(searchTimer);
      clearTimeout(overlayToastTimer);
      for (const entry of pendingRpc.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('实例已重载'));
      }
      pendingRpc.clear();
      domObserver.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('hashchange', onRouteChange);
      window.removeEventListener('popstate', onRouteChange);
      window.removeEventListener('focus', onRouteChange);
      window.removeEventListener('click', onClickNavHint, true);
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
