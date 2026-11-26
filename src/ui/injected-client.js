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
    globalThis.__t3Tools.healthy && typeof globalThis.__t3ToolsReceive === 'function'
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
    else entry.reject(Object.assign(new Error(reply?.error || 'RPC 调用失败'), { receivedReply: true }));
  };

  const httpRequests = new Set();
  let transportState = 'waiting';
  let transportFailures = 0;

  async function callRpc(action, params = {}) {
    let controller;
    let timeout;
    try {
      if (transport !== 'cdp') {
        controller = new AbortController();
        httpRequests.add(controller);
        timeout = setTimeout(() => controller.abort(), 8000);
      }
      const data = await requestRpc(action, params, controller?.signal);
      transportFailures = 0;
      transportState = 'connected';
      return data;
    } catch (err) {
      if (err.receivedReply) {
        transportFailures = 0;
        transportState = 'connected';
      } else if (++transportFailures >= 2) {
        transportState = 'disconnected';
      }
      throw err;
    } finally {
      clearTimeout(timeout);
      httpRequests.delete(controller);
    }
  }

  async function requestRpc(action, params, signal) {
    async function http(url, options) {
      const response = await fetch(url, { ...options, signal });
      if (!response.ok) throw Object.assign(new Error('HTTP ' + response.status), { receivedReply: response.status < 500 });
      return response;
    }
    if (transport === 'cdp') {
      if (typeof globalThis.__t3ToolsBridge !== 'function') throw new Error('CDP 桥接已断开');
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
      const r = await http(`${apiBase}/api/live?${qs.toString()}`);
      const j = await r.json();
      if (!j.ok) throw Object.assign(new Error(j.error || '请求失败'), { receivedReply: true });
      return j.data;
    }
    if (action === 'exportRequestsCsv') {
      const res = await http(apiBase + '/api/requests.csv?' + new URLSearchParams(params));
      return { csv: '\uFEFF' + await res.text(), filename: 't3tools-requests.csv' };
    }
    if (action === 'getDashboard') {
      const sp = new URLSearchParams();
      const skip = new Set(['force', 'tab', 'heatmapMetric', 'quotaDriver', 'quotaSort', 'quotaView', 'hideEmail', 'detailId', 'ledgerScroll', 'ledgerFocus', 'speedSort', 'speedDir', 'modelSort', 'modelSortDir', '_chartW']);
      for (const [k, v] of Object.entries(params || {})) {
        if (!skip.has(k) && v !== undefined && v !== null && v !== '') sp.set(k, String(v));
      }
      if (params.force) {
        await requestRpc('forceSync', {}, signal);
      }
      const r = await http(`${apiBase}/api/dashboard?${sp.toString()}`);
      const j = await r.json();
      if (!j.ok) throw Object.assign(new Error(j.error || '请求失败'), { receivedReply: true });
      return j.data;
    }
    if (['focusThread','ackErrors','resolveErrors','testAlert','checkRuntimeUpdates','checkAppUpdate','installAppUpdate','skipAppUpdate'].includes(action)) {
      const path = {
        focusThread: '/api/t3/focus-thread',
        ackErrors: '/api/errors/ack',
        resolveErrors: '/api/errors/resolve',
        testAlert: '/api/alerts/test',
        checkRuntimeUpdates: '/api/runtime-updates/check',
        checkAppUpdate: '/api/app-update/check',
        installAppUpdate: '/api/app-update/install',
        skipAppUpdate: '/api/app-update/skip'
      }[action];
      const res = await http(apiBase + path,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(params)});
      const json = await res.json();
      if (!json.ok) throw Object.assign(new Error(json.error), { receivedReply: true });
      return json.data;
    }
    if (action === 'updateSettings') {
      const r = await http(`${apiBase}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(params || {})
      });
      const j = await r.json();
      if (!j.ok) throw Object.assign(new Error(j.error || '保存失败'), { receivedReply: true });
      return j.data;
    }
    if (action === 'forceSync') {
      const response = await http(apiBase + '/api/sync', {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}'
      });
      const result = await response.json();
      if (!result.ok) throw Object.assign(new Error(result.error || '刷新失败'), { receivedReply: true });
      return result.data;
    }
    const r = await http(`${apiBase}/api/status`);
    const reply = await r.json();
    if (!reply.ok) throw Object.assign(new Error(reply.error || '请求失败'), { receivedReply: true });
    return reply.data;
  }

  function safeComputedStyle(el) {
    try {
      return typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    } catch {
      return null;
    }
  }

  function getElementRect(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    try {
      const rect = el.getBoundingClientRect();
      if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return null;
      return rect;
    } catch {
      return null;
    }
  }

  function isVisibleElement(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    if (el.closest?.('[data-t3tools]')) return false;
    const cs = safeComputedStyle(el);
    if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
    const rect = getElementRect(el);
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

  function findVisibleAnchor(key) {
    const list = selectors.anchors?.[key] || [];
    for (const sel of list) {
      try {
        const nodes = typeof document.querySelectorAll === 'function'
          ? document.querySelectorAll(sel)
          : (document.querySelector?.(sel) ? [document.querySelector(sel)] : []);
        for (const el of nodes) {
          if (isVisibleElement(el)) return el;
        }
      } catch {}
    }
    return null;
  }

  const EXCLUDED_DOCK_TAGS = new Set([
    'IFRAME', 'WEBVIEW', 'CANVAS', 'SVG', 'VIDEO', 'IMG',
    'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'DIALOG', 'HEADER', 'FOOTER', 'NAV'
  ]);
  const TRANSIENT_POPUP_SELECTOR = '[role="menu"],[role="listbox"],[role="tooltip"],[data-t3tools]';
  const CHAT_STREAM_NODE_SELECTOR = '[data-message-role],[data-chat-composer-form],[data-chat-composer-footer]';

  function isVerticalFlexContainer(el) {
    const cs = safeComputedStyle(el);
    if (!cs) return false;
    const disp = String(cs.display || '');
    const dir = String(cs.flexDirection || '');
    const wrap = String(cs.flexWrap || '');
    return (disp === 'flex' || disp === 'inline-flex') && dir === 'column' && wrap !== 'wrap';
  }

  function isSingleColumnGrid(el) {
    const cs = safeComputedStyle(el);
    if (!cs) return false;
    const disp = String(cs.display || '');
    if (disp !== 'grid' && disp !== 'inline-grid') return false;
    const cols = String(cs.gridTemplateColumns || '').trim();
    if (!cols || cols === 'none') return true;
    return cols.split(/\s+/).filter(Boolean).length <= 1;
  }

  function hasVisualCardChrome(el) {
    const cs = safeComputedStyle(el);
    if (!cs) return false;
    const bg = String(cs.backgroundColor || '').trim();
    const isTransparentBg = !bg || bg === 'transparent' || /rgba\([^)]*,\s*0(?:\.0+)?\s*\)/i.test(bg);
    const hasBg = !isTransparentBg;
    const bw = parseFloat(cs.borderTopWidth || '0') + parseFloat(cs.borderLeftWidth || '0') +
      parseFloat(cs.borderRightWidth || '0') + parseFloat(cs.borderBottomWidth || '0');
    const ow = parseFloat(cs.outlineWidth || '0');
    const radius = parseFloat(cs.borderTopLeftRadius || cs.borderRadius || '0');
    const hasShadow = Boolean(cs.boxShadow && cs.boxShadow !== 'none');
    const hasBackdrop = Boolean(cs.backdropFilter && cs.backdropFilter !== 'none');
    return (hasBg && (bw > 0 || ow > 0 || hasShadow || hasBackdrop || radius >= 6)) || bw >= 2 || hasShadow;
  }

  function isVerticallyStackedBlock(el) {
    const cs = safeComputedStyle(el);
    if (!cs) return false;
    const disp = String(cs.display || '');
    if (disp !== 'block' && disp !== 'flow-root' && !isSingleColumnGrid(el)) return false;
    const kids = Array.from(el.children || []).filter(ch => {
      if (!ch || ch.getAttribute?.('data-t3tools') === '1') return false;
      return isVisibleElement(ch);
    });
    if (!kids.length) return false;
    for (const ch of kids) {
      const tag = String(ch.tagName || '').toUpperCase();
      if (['IFRAME', 'WEBVIEW', 'CANVAS', 'VIDEO'].includes(tag)) return false;
    }
    return true;
  }

  function getMaxChildBottom(el) {
    let maxBottom = -Infinity;
    const kids = Array.from(el?.children || []).filter(ch =>
      ch && ch.getAttribute?.('data-t3tools') !== '1' && isVisibleElement(ch)
    );
    for (const ch of kids) {
      const r = getElementRect(ch);
      if (r && r.bottom > maxBottom) maxBottom = r.bottom;
    }
    return Number.isFinite(maxBottom) ? maxBottom : null;
  }

  function findPanelContentSummary(panelEl, vh) {
    const panelRect = getElementRect(panelEl);
    if (!panelRect) return null;
    // Descend through full-height transparent scroll/padding wrappers (including header + scroll-body layouts)
    let listContainer = panelEl;
    for (let depth = 0; depth < 5 && listContainer; depth++) {
      const curRect = getElementRect(listContainer) || panelRect;
      const kids = Array.from(listContainer.children || []).filter(ch =>
        ch && ch.getAttribute?.('data-t3tools') !== '1' && isVisibleElement(ch)
      );
      if (!kids.length) break;
      let nextContainer = null;
      if (kids.length === 1) {
        const only = kids[0];
        const onlyRect = getElementRect(only);
        if (onlyRect && onlyRect.height >= curRect.height - 80 && !hasVisualCardChrome(only)) {
          nextContainer = only;
        }
      } else {
        // Handle [header/tabs or thin resize handle, full-height scroll body] inside a right panel
        const dominantBody = kids.find(ch => {
          if (hasVisualCardChrome(ch)) return false;
          const r = getElementRect(ch);
          if (!r || r.width < curRect.width * 0.75 || r.height < curRect.height * 0.65) return false;
          const innerBottom = getMaxChildBottom(ch);
          return innerBottom !== null && innerBottom < r.bottom - 80;
        });
        if (dominantBody) nextContainer = dominantBody;
      }
      if (!nextContainer) break;
      const tag = String(nextContainer.tagName || '').toUpperCase();
      if (EXCLUDED_DOCK_TAGS.has(tag)) break;
      listContainer = nextContainer;
    }

    const contentKids = Array.from(listContainer.children || []).filter(ch =>
      ch && ch.getAttribute?.('data-t3tools') !== '1' && isVisibleElement(ch)
    );
    if (!contentKids.length) {
      return {
        listContainer,
        visualCard: hasVisualCardChrome(panelEl) ? panelEl : null,
        contentBottom: panelRect.bottom,
        contentLeft: panelRect.left,
        contentRight: panelRect.right,
        contentWidth: panelRect.width,
        hasSpaceBelow: vh > 0 && (vh - panelRect.bottom) >= 90
      };
    }

    let minLeft = Infinity;
    let maxRight = -Infinity;
    let maxBottom = -Infinity;
    for (const ch of contentKids) {
      const r = getElementRect(ch);
      if (!r) continue;
      if (r.left < minLeft) minLeft = r.left;
      if (r.right > maxRight) maxRight = r.right;
      if (r.bottom > maxBottom) maxBottom = r.bottom;
    }
    if (!Number.isFinite(maxBottom)) maxBottom = panelRect.bottom;
    if (!Number.isFinite(minLeft)) minLeft = panelRect.left;
    if (!Number.isFinite(maxRight)) maxRight = panelRect.right;

    const singleVisualCard = contentKids.length === 1 && hasVisualCardChrome(contentKids[0]) ? contentKids[0] : null;
    return {
      listContainer,
      visualCard: singleVisualCard || (hasVisualCardChrome(listContainer) ? listContainer : null),
      contentBottom: maxBottom,
      contentLeft: minLeft,
      contentRight: maxRight,
      contentWidth: Math.max(0, maxRight - minLeft),
      hasSpaceBelow: vh > 0 && (vh - maxBottom) >= 90
    };
  }

  function resolveDockableContainer(candidateEl, { isCompactCard = false, contentSummary = null } = {}) {
    // If this is a right rail holding stacked cards with vertical room below, prefer docking as a stacked card inside the rail!
    if (contentSummary?.hasSpaceBelow && contentSummary.listContainer && !hasVisualCardChrome(contentSummary.listContainer)) {
      if (isVerticalFlexContainer(contentSummary.listContainer) || isVerticallyStackedBlock(contentSummary.listContainer)) {
        return { container: contentSummary.listContainer, dockStyle: 'stack' };
      }
    }

    let cur = candidateEl;
    let blockFallback = null;
    const allowBlock = Boolean(isCompactCard || contentSummary?.hasSpaceBelow);
    for (let depth = 0; depth <= 5 && cur; depth++) {
      if (isVerticalFlexContainer(cur)) {
        if (allowBlock && !hasVisualCardChrome(cur)) {
          const kids = Array.from(cur.children || []).filter(ch => ch && ch.getAttribute?.('data-t3tools') !== '1' && isVisibleElement(ch));
          if (kids.length === 1 && hasVisualCardChrome(kids[0]) && (isVerticalFlexContainer(kids[0]) || isVerticallyStackedBlock(kids[0]))) {
            return { container: kids[0], dockStyle: 'flush' };
          }
        }
        return { container: cur, dockStyle: contentSummary?.hasSpaceBelow && !hasVisualCardChrome(cur) ? 'stack' : 'flush' };
      }
      if (allowBlock && isVerticallyStackedBlock(cur)) {
        if (hasVisualCardChrome(cur) || !blockFallback) {
          blockFallback = cur;
        }
      }
      const parentRect = getElementRect(cur);
      const kids = Array.from(cur.children || []).filter(ch => {
        if (!ch || ch.getAttribute?.('data-t3tools') === '1') return false;
        return isVisibleElement(ch);
      });
      if (!kids.length) break;
      let dominant = null;
      if (kids.length === 1) {
        dominant = kids[0];
      } else if (parentRect) {
        dominant = kids.find(ch => {
          const r = getElementRect(ch);
          return r && r.width >= parentRect.width * 0.85 && r.height >= parentRect.height * 0.85;
        }) || null;
      }
      if (!dominant) break;
      const tag = String(dominant.tagName || '').toUpperCase();
      if (EXCLUDED_DOCK_TAGS.has(tag)) break;
      cur = dominant;
    }
    if (allowBlock && blockFallback) {
      return {
        container: blockFallback,
        dockStyle: hasVisualCardChrome(blockFallback) ? 'flush' : 'stack'
      };
    }
    return null;
  }

  function findInnerChatAnchor() {
    return (
      findVisibleAnchor('composerCard') ||
      findVisibleAnchor('composerHost') ||
      findVisibleAnchor('composerFooter') ||
      findVisibleAnchor('assistantMessages') ||
      findVisibleAnchor('chatHeader') ||
      null
    );
  }

  function isCompactTopRightCardRect(rect, vw, vh) {
    if (!rect || vw <= 0 || vh <= 0) return false;
    return (
      rect.width >= 180 &&
      rect.width <= Math.min(540, vw * 0.58) &&
      rect.height >= 72 &&
      rect.height < Math.max(360, vh * 0.72) &&
      rect.top >= 0 &&
      rect.top <= 180 &&
      rect.right >= vw - 64 &&
      rect.right <= vw + 24 &&
      rect.left >= vw * 0.35
    );
  }

  function isTallRightPanelRect(rect, refLeftBound, convRect, vw, vh, isOverlay) {
    if (!rect || vw <= 0 || vh <= 0) return false;
    if (rect.width < 180 || rect.width > vw * 0.78) return false;
    if (rect.height < Math.min(220, vh * 0.35)) return false;
    if (rect.left < Math.max(vw * 0.24, refLeftBound)) return false;
    if (rect.right > vw + 24 || rect.right < vw - 80) return false;
    if (convRect && convRect.height > 0) {
      const overlapY = Math.min(rect.bottom, convRect.bottom) - Math.max(rect.top, convRect.top);
      if (overlapY < Math.min(160, convRect.height * 0.35)) return false;
      if (!isOverlay && convRect.right < vw - 160) {
        if (rect.left < convRect.right - 36) return false;
      }
    }
    return true;
  }

  function isModalOrPopupNode(el, rect, vw, vh) {
    if (!el) return true;
    if (el.closest?.(TRANSIENT_POPUP_SELECTOR)) return true;
    const dialogAncestor = el.closest?.('[role="dialog"],[aria-modal="true"]');
    if (dialogAncestor) {
      const dRect = getElementRect(dialogAncestor) || rect;
      const isRightDrawer = Boolean(
        dRect &&
        dRect.right >= vw - 48 &&
        dRect.left >= vw * 0.25 &&
        dRect.width <= vw * 0.75 &&
        (dRect.height >= Math.min(320, vh * 0.55) || isCompactTopRightCardRect(dRect, vw, vh))
      );
      if (!isRightDrawer) return true;
    }
    return false;
  }

  function containsChatStreamContent(el) {
    if (!el) return false;
    if (el.closest?.(CHAT_STREAM_NODE_SELECTOR)) return true;
    try {
      if (typeof el.querySelector === 'function' && el.querySelector(CHAT_STREAM_NODE_SELECTOR)) return true;
    } catch {}
    return false;
  }

  function isExcludedRightPanelCandidate(el, chatAnchorEl, convEl, sidebarEl, rect, vw, vh) {
    if (!el || !isVisibleElement(el)) return true;
    if (el === document.body || el === document.documentElement || el === sidebarEl) return true;
    if (chatAnchorEl && (el === chatAnchorEl || el.contains?.(chatAnchorEl) || chatAnchorEl.contains?.(el))) return true;
    if (convEl && (el === convEl || el.contains?.(convEl))) return true;
    if (sidebarEl && (el.contains?.(sidebarEl) || sidebarEl.contains?.(el))) return true;
    if (containsChatStreamContent(el)) return true;
    const tag = String(el.tagName || '').toUpperCase();
    if (EXCLUDED_DOCK_TAGS.has(tag)) return true;
    if (isModalOrPopupNode(el, rect, vw, vh)) return true;
    return false;
  }

  function hasPositionedAncestor(el, stopAt) {
    let cur = el;
    for (let depth = 0; depth < 6 && cur && cur !== stopAt && cur !== document.documentElement; depth++) {
      const pos = String(safeComputedStyle(cur)?.position || '');
      if (pos === 'fixed' || pos === 'absolute' || pos === 'sticky') return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function detectWorkspaceLayout(convEl, sidebarEl, vw, vh) {
    const convRect = getElementRect(convEl);
    const sidebarRect = getElementRect(sidebarEl);
    const chatAnchorEl = findInnerChatAnchor();
    const minPanelLeft = sidebarRect && sidebarRect.right < vw * 0.45
      ? Math.round(sidebarRect.right) + 140
      : 0;

    if (vw <= 0 || vh <= 0) {
      return { effectiveConvEl: convEl, effectiveConvRect: convRect, rightPanelInfo: null };
    }

    const candidates = [];
    const seen = new Set();
    let splitConvEl = null;
    let splitConvRect = null;

    const probeDiag = [];
    const addCandidate = (el, priority, matchedConvEl = null, matchedConvRect = null, { allowCompact = true } = {}) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      const rect = getElementRect(el);
      if (!rect) return;
      if (isExcludedRightPanelCandidate(el, chatAnchorEl, convEl, sidebarEl, rect, vw, vh)) {
        if (priority === 0 && probeDiag.length < 3) probeDiag.push({ tag: el.tagName, w: Math.round(rect.width), h: Math.round(rect.height), reason: 'excluded' });
        return;
      }
      const cs = safeComputedStyle(el);
      const pos = String(cs?.position || '');
      const isOverlay = pos === 'fixed' || pos === 'absolute' || hasPositionedAncestor(el, document.body);
      const refConvRect = matchedConvRect || convRect;
      const isCompactCard = Boolean(
        allowCompact &&
        isCompactTopRightCardRect(rect, vw, vh) &&
        (vh - rect.bottom) >= 90 &&
        (isOverlay || hasVisualCardChrome(el) || Boolean(matchedConvEl) || priority === 0)
      );
      const isTall = !isCompactCard && isTallRightPanelRect(rect, minPanelLeft, refConvRect, vw, vh, isOverlay);
      if (!isTall && !isCompactCard) {
        if (priority === 0 && probeDiag.length < 3) probeDiag.push({ tag: el.tagName, l: Math.round(rect.left), t: Math.round(rect.top), r: Math.round(rect.right), b: Math.round(rect.bottom), w: Math.round(rect.width), h: Math.round(rect.height), reason: 'geometry' });
        return;
      }
      const isModal = Boolean(el.closest?.('[aria-modal="true"]'));
      const contentSummary = findPanelContentSummary(el, vh);
      const hasVerticalStackRoom = Boolean(
        rect.width <= Math.min(540, vw * 0.58) &&
        (isCompactCard || contentSummary?.hasSpaceBelow)
      );
      const dockMatch = isModal ? null : resolveDockableContainer(el, { isCompactCard, contentSummary });
      candidates.push({
        panelEl: el,
        dockContainer: dockMatch?.container || null,
        dockStyle: dockMatch?.dockStyle || 'flush',
        contentSummary,
        hasVerticalStackRoom,
        rect,
        isOverlay,
        isCompactCard,
        isModal,
        priority,
        matchedConvEl,
        matchedConvRect
      });
    };

    // 1. Walk UP from inner chat anchor (composer / messages / header) to find true chat column & right sibling
    const walkStart = chatAnchorEl || convEl;
    if (walkStart) {
      let cur = walkStart;
      for (let depth = 0; depth < 10 && cur && cur.parentElement && cur.parentElement !== document.documentElement; depth++) {
        const parent = cur.parentElement;
        const curRect = getElementRect(cur);
        if (curRect && curRect.width >= 180 && curRect.height >= Math.min(220, vh * 0.35)) {
          for (const sib of Array.from(parent.children || [])) {
            if (sib === cur) continue;
            const sibRect = getElementRect(sib);
            if (!sibRect || sibRect.width < 180 || sibRect.left < curRect.right - 36) continue;
            const overlapY = Math.min(sibRect.bottom, curRect.bottom) - Math.max(sibRect.top, curRect.top);
            if (overlapY < Math.min(100, curRect.height * 0.25)) continue;
            if (!splitConvEl && sibRect.height >= Math.min(220, vh * 0.35)) {
              splitConvEl = cur;
              splitConvRect = curRect;
            }
            addCandidate(sib, 1 + depth * 0.1, cur, curRect);
          }
        }
        cur = parent;
      }
    }

    // 2. Explicit configurable rightPanel selectors
    for (const sel of (selectors.anchors?.rightPanel || [])) {
      try {
        const nodes = typeof document.querySelectorAll === 'function'
          ? document.querySelectorAll(sel)
          : (document.querySelector?.(sel) ? [document.querySelector(sel)] : []);
        for (const el of nodes) addCandidate(el, 0, splitConvEl, splitConvRect);
      } catch {}
    }

    // 3. Universal right-edge & top-right card hit-testing via elementsFromPoint
    if (typeof document.elementsFromPoint === 'function') {
      const probePoints = [
        // Top-right zone (catches compact workspace/git/scripts cards like T3 Code's [≡] card at any resolution)
        [Math.max(0, vw - 40), 64],
        [Math.max(0, vw - 60), 80],
        [Math.max(0, vw - 140), 110],
        [Math.max(0, vw - 180), 140],
        [Math.max(0, vw - 60), 170],
        [Math.max(0, vw - 140), 220],
        // Mid & lower right zone (catches full-height Diff / Preview / Files panels)
        [Math.max(0, vw - 60), Math.round(vh * 0.45)],
        [Math.max(0, vw - 60), Math.round(vh * 0.72)]
      ];
      for (const [px, py] of probePoints) {
        if (py <= 0 || py >= vh) continue;
        let hits = [];
        try { hits = document.elementsFromPoint(px, py) || []; } catch { hits = []; }
        for (const hit of hits) {
          if (!hit || hit.closest?.('[data-t3tools]') || hit.closest?.(CHAT_STREAM_NODE_SELECTOR)) continue;
          let bestPanel = null;
          let cur = hit;
          for (let depth = 0; depth < 14 && cur && cur !== document.body && cur !== document.documentElement; depth++) {
            if (chatAnchorEl && (cur === chatAnchorEl || cur.contains?.(chatAnchorEl))) break;
            if (convEl && (cur === convEl || cur.contains?.(convEl))) break;
            if (sidebarEl && (cur === sidebarEl || cur.contains?.(sidebarEl))) break;
            if (containsChatStreamContent(cur)) break;
            const r = getElementRect(cur);
            if (r && !EXCLUDED_DOCK_TAGS.has(String(cur.tagName || '').toUpperCase())) {
              const cs = safeComputedStyle(cur);
              const pos = String(cs?.position || '');
              const isOverlay = pos === 'fixed' || pos === 'absolute' || hasPositionedAncestor(cur, document.body);
              const validCompact = isCompactTopRightCardRect(r, vw, vh) && (vh - r.bottom) >= 90 && (isOverlay || hasVisualCardChrome(cur));
              const validTall = !validCompact && isTallRightPanelRect(r, minPanelLeft, splitConvRect || convRect, vw, vh, isOverlay);
              if (!isModalOrPopupNode(cur, r, vw, vh) && (validTall || validCompact)) {
                // For compact floating cards, prefer the actual card with visible chrome over a bare positioning wrapper
                if (!bestPanel || !validCompact || hasVisualCardChrome(cur) || !hasVisualCardChrome(bestPanel)) {
                  bestPanel = cur;
                }
              }
            }
            cur = cur.parentElement;
          }
          if (bestPanel) addCandidate(bestPanel, 2.5, splitConvEl, splitConvRect);
        }
      }
    }

    if (!candidates.length) {
      return {
        effectiveConvEl: splitConvEl || convEl,
        effectiveConvRect: splitConvRect || convRect,
        rightPanelInfo: null,
        probeDiag
      };
    }

    candidates.sort((a, b) => {
      // Prefer a card directly occupying the top-right slot where the overview card lives, then dockability
      const dockDiff = (b.dockContainer ? 1 : 0) - (a.dockContainer ? 1 : 0);
      if (dockDiff !== 0) return dockDiff;
      const modalDiff = (a.isModal ? 1 : 0) - (b.isModal ? 1 : 0);
      if (modalDiff !== 0) return modalDiff;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return b.rect.height - a.rect.height;
    });

    const chosen = candidates[0];
    return {
      effectiveConvEl: chosen.matchedConvEl || splitConvEl || convEl,
      effectiveConvRect: chosen.matchedConvRect || splitConvRect || convRect,
      rightPanelInfo: chosen,
      probeDiag
    };
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
  let settingsRevision = 0;
  let lastTodayUsage = null;
  let lastSidebarUsage = null;
  let lastRuntimeUpdates = null;
  let lastAppUpdate = null;
  let dismissedRuntimeUpdateSig = '';
  let dismissedAppUpdateVer = '';
  try { dismissedRuntimeUpdateSig = localStorage.getItem('t3tools.dismissedRuntimeUpdateSig') || ''; } catch {}
  try { dismissedAppUpdateVer = localStorage.getItem('t3tools.dismissedAppUpdateVer') || ''; } catch {}
  let activeThreadId = detectActiveThreadId();
  let lastRouteHref = String(location.href || '');

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
  let overviewPlacementMode = 'float'; // 'docked' | 'avoid' | 'float' | 'fixed'
  let overviewDockStyle = 'flush'; // 'flush' | 'stack'
  let lastOverviewHtml = '';
  let narrowAutoCollapsed = false;
  let narrowExpandOverride = false;
  let layoutRafId = 0;
  let layoutRecheckTimer = null;
  let layoutResizeObserver = null;
  const observedLayoutEls = new Set();
  let lastLayoutDebug = { mode: 'float', docked: false, narrowAutoCollapsed: false, hasRightPanel: false, hasDockContainer: false };
  let sidebarMount = null;
  let lastSidebarHtml = '';
  let overlayMount = null;

  const COMPOSER_INLINE_HOST_STYLE = 'display:inline-flex;align-items:center;position:relative;z-index:20;min-width:0;flex:0 1 auto;overflow:visible;margin-right:6px;';
  const COMPOSER_BLOCK_HOST_STYLE = 'display:block;width:100%;flex:none;overflow:visible;';
  const OVERVIEW_FLOAT_INIT_STYLE = 'position:fixed;top:56px;right:18px;z-index:35;';

  function updateLayoutResizeTargets(nextTargets) {
    if (typeof ResizeObserver !== 'function') return;
    if (!layoutResizeObserver) {
      layoutResizeObserver = new ResizeObserver(() => scheduleOverviewLayout());
    }
    const nextSet = new Set(nextTargets.filter(Boolean));
    for (const oldEl of observedLayoutEls) {
      if (!nextSet.has(oldEl)) {
        try { layoutResizeObserver.unobserve(oldEl); } catch {}
        observedLayoutEls.delete(oldEl);
      }
    }
    for (const el of nextSet) {
      if (!observedLayoutEls.has(el)) {
        try {
          layoutResizeObserver.observe(el);
          observedLayoutEls.add(el);
        } catch {}
      }
    }
  }

  function scheduleOverviewLayout({ withDelayedRecheck = false } = {}) {
    if (disposed) return;
    if (!layoutRafId) {
      if (typeof requestAnimationFrame === 'function') {
        layoutRafId = requestAnimationFrame(() => {
          layoutRafId = 0;
          if (!disposed) reconcileOverviewLayout({ allowRender: true });
        });
      } else {
        reconcileOverviewLayout({ allowRender: true });
      }
    }
    if (withDelayedRecheck) {
      clearTimeout(layoutRecheckTimer);
      layoutRecheckTimer = setTimeout(() => {
        layoutRecheckTimer = null;
        if (!disposed) reconcileOverviewLayout({ allowRender: true });
      }, 240);
    }
  }

  function applyFloatingHostStyle(host, topPx, rightPx, displayVal, { widthPx = 0, bodyMaxH = 0 } = {}) {
    host.style.position = 'fixed';
    host.style.top = `${topPx}px`;
    host.style.right = `${rightPx}px`;
    host.style.bottom = '';
    host.style.left = '';
    host.style.marginTop = '';
    host.style.width = widthPx > 0 ? `${widthPx}px` : '';
    host.style.flex = '';
    host.style.zIndex = '35';
    host.style.boxSizing = '';
    host.style.display = displayVal;
    if (widthPx > 0) host.style.setProperty('--pt-ov-width', `${widthPx}px`);
    else host.style.removeProperty?.('--pt-ov-width');
    if (bodyMaxH > 0) host.style.setProperty('--pt-ov-body-max-h', `${bodyMaxH}px`);
    else host.style.removeProperty?.('--pt-ov-body-max-h');
  }

  function applyDockedHostStyle(host, displayVal, { compact = false, dockStyle = 'flush', bodyMaxH = 0 } = {}) {
    const isRelativeStack = compact || dockStyle === 'stack';
    host.style.position = isRelativeStack ? 'relative' : 'sticky';
    host.style.top = '';
    host.style.right = '';
    host.style.bottom = isRelativeStack ? '' : '0px';
    host.style.left = '';
    host.style.marginTop = dockStyle === 'stack' ? '10px' : '';
    host.style.width = '100%';
    host.style.flex = 'none';
    host.style.zIndex = '5';
    host.style.boxSizing = 'border-box';
    host.style.display = displayVal;
    host.style.removeProperty?.('--pt-ov-width');
    if (bodyMaxH > 0) host.style.setProperty('--pt-ov-body-max-h', `${bodyMaxH}px`);
    else host.style.removeProperty?.('--pt-ov-body-max-h');
  }

  function getEffectiveOverviewCollapsed() {
    if (overviewPlacementMode === 'docked') return overviewCollapsed;
    return narrowAutoCollapsed ? true : overviewCollapsed;
  }

  function reconcileOverviewLayout({ allowRender = false } = {}) {
    if (disposed || !overviewMount) return false;
    const cfg = lastSettings || lastLive?.settings || {};
    const modeSetting = ['adaptive', 'avoid', 'fixed'].includes(cfg.overviewMode) ? cfg.overviewMode : 'adaptive';
    const baseTop = Number.isFinite(Number(cfg.overviewPosition?.top)) ? Number(cfg.overviewPosition.top) : 56;
    const baseRight = Number.isFinite(Number(cfg.overviewPosition?.right)) ? Number(cfg.overviewPosition.right) : 18;
    const hidden = cfg.enabled === false || cfg.showOverviewCard === false;
    const host = overviewMount.host;
    const prevMode = overviewPlacementMode;
    const prevEffectiveCollapsed = getEffectiveOverviewCollapsed();

    if (hidden) {
      if (host.parentElement !== document.body || !host.isConnected) {
        document.body.appendChild(host);
      }
      applyFloatingHostStyle(host, baseTop, baseRight, 'none');
      overviewPlacementMode = modeSetting === 'fixed' ? 'fixed' : 'float';
      updateLayoutResizeTargets([]);
      return false;
    }

    const vw = Number(window.innerWidth) || 0;
    const vh = Number(window.innerHeight) || 0;
    const rawConvEl = modeSetting !== 'fixed' ? findVisibleAnchor('conversationArea') : null;
    const sidebarEl = modeSetting !== 'fixed' ? findVisibleAnchor('sidebar') : null;
    const detected = (modeSetting !== 'fixed' && vw > 0 && vh > 0)
      ? detectWorkspaceLayout(rawConvEl, sidebarEl, vw, vh)
      : { effectiveConvEl: rawConvEl, effectiveConvRect: getElementRect(rawConvEl), rightPanelInfo: null };
    const convEl = detected.effectiveConvEl;
    const convRect = detected.effectiveConvRect;
    const rightPanelInfo = detected.rightPanelInfo;
    let headerEl = modeSetting !== 'fixed' ? findVisibleAnchor('chatHeader') : null;
    if (!headerEl && convEl && typeof convEl.querySelector === 'function') {
      const candidateHeader = convEl.querySelector('header');
      if (isVisibleElement(candidateHeader)) headerEl = candidateHeader;
    }
    const headerRect = getElementRect(headerEl);

    updateLayoutResizeTargets([rawConvEl, convEl, headerEl, rightPanelInfo?.panelEl, rightPanelInfo?.dockContainer]);

    // Mode A: Adaptive vertical merge into T3 Code's open right panel / right-rail card
    let dockedSuccessfully = false;
    let nextDockStyle = 'flush';
    const prevDockStyle = overviewDockStyle;
    if (modeSetting === 'adaptive' && rightPanelInfo?.dockContainer) {
      const dockEl = rightPanelInfo.dockContainer;
      nextDockStyle = rightPanelInfo.dockStyle || 'flush';
      const contentBottom = rightPanelInfo.contentSummary?.contentBottom ?? rightPanelInfo.rect.bottom;
      const dockBodyMaxH = rightPanelInfo.hasVerticalStackRoom && vh > 0
        ? Math.max(110, Math.min(340, Math.round(vh - contentBottom - 76)))
        : 250;
      if (host.parentElement !== dockEl || host.nextElementSibling !== null || !host.isConnected) {
        dockEl.appendChild(host);
      }
      applyDockedHostStyle(host, 'block', {
        compact: Boolean(rightPanelInfo.isCompactCard || rightPanelInfo.hasVerticalStackRoom),
        dockStyle: nextDockStyle,
        bodyMaxH: dockBodyMaxH
      });
      // Safety check: in real browser layouts, verify the docked card wasn't clipped off-screen by overflow:hidden
      const dockRect = getElementRect(dockEl);
      const hostRect = getElementRect(host);
      const clippedOffscreen = Boolean(
        dockRect && dockRect.height > 0 &&
        hostRect && hostRect.width > 0 &&
        (hostRect.top >= Math.min(vh, dockRect.bottom) - 4 || hostRect.bottom > vh + 12)
      );
      if (!clippedOffscreen) {
        dockedSuccessfully = true;
        overviewPlacementMode = 'docked';
        overviewDockStyle = nextDockStyle;
        narrowAutoCollapsed = false;
        narrowExpandOverride = false;
      }
    }

    if (!dockedSuccessfully) {
      // Fallback / Avoid / Fixed: float on document.body
      if (host.parentElement !== document.body || !host.isConnected) {
        document.body.appendChild(host);
      }
      overviewDockStyle = 'flush';
      let computedTop = baseTop;
      let computedRight = baseRight;
      let computedWidth = 0;
      let computedBodyMaxH = 0;
      let nextMode = modeSetting === 'fixed' ? 'fixed' : 'float';

      if (modeSetting !== 'fixed' && vw > 0 && vh > 0 && (convRect || rightPanelInfo?.rect)) {
        const contentBottom = rightPanelInfo?.contentSummary?.contentBottom ?? rightPanelInfo?.rect?.bottom ?? 0;
        const contentRight = rightPanelInfo?.contentSummary?.contentRight ?? rightPanelInfo?.rect?.right ?? vw;
        const contentWidth = rightPanelInfo?.contentSummary?.contentWidth ?? rightPanelInfo?.rect?.width ?? 0;
        const canStackVerticallyBelow = Boolean(
          rightPanelInfo?.hasVerticalStackRoom &&
          contentBottom > 0 &&
          (vh - contentBottom) >= 90
        );

        if (canStackVerticallyBelow) {
          // Always prefer vertical top-bottom layout directly beneath T3 Code's right card (never left-right!)
          narrowAutoCollapsed = false;
          narrowExpandOverride = false;
          computedTop = Math.min(Math.round(contentBottom) + 10, Math.max(baseTop, Math.round(vh - 72)));
          computedRight = Math.max(12, Math.round(vw - contentRight));
          if (contentWidth >= 220 && contentWidth <= 420) {
            computedWidth = Math.round(contentWidth);
          }
          computedBodyMaxH = Math.max(100, Math.min(380, Math.round(vh - computedTop - 68)));
          nextMode = 'avoid';
        } else {
          // Full-height non-dockable panel (no vertical space below): stay strictly to its left
          const freeRight = Math.min(
            convRect ? convRect.right : vw,
            rightPanelInfo?.rect ? rightPanelInfo.rect.left : vw
          );
          const convLeft = convRect ? convRect.left : 0;
          const usableConvWidth = Math.max(0, freeRight - convLeft);
          if (usableConvWidth > 0 && usableConvWidth < 660) {
            narrowAutoCollapsed = !narrowExpandOverride;
          } else if (usableConvWidth >= 700) {
            narrowExpandOverride = false;
            narrowAutoCollapsed = false;
          } else if (narrowExpandOverride) {
            narrowAutoCollapsed = false;
          }

          const estWidth = (overviewCollapsed || narrowAutoCollapsed) ? 210 : 304;
          const rightOffset = Math.max(baseRight, Math.round(vw - freeRight) + 14);
          const minLeftBound = Math.max(12, Math.round(convLeft) + 12);
          const maxRightInConv = Math.round(vw - minLeftBound - estWidth);
          if (maxRightInConv >= 12) {
            computedRight = Math.min(rightOffset, maxRightInConv);
          } else {
            computedRight = Math.max(12, Math.min(rightOffset, Math.max(12, Math.round(vw - estWidth - 12))));
          }

          const headerBottom = headerRect ? Math.round(headerRect.bottom) + 8 : 0;
          const convTopBound = convRect && convRect.top > 0 ? Math.round(convRect.top) + 10 : 0;
          const rawTop = Math.max(baseTop, headerBottom, convTopBound);
          computedTop = Math.min(rawTop, Math.max(baseTop, Math.round(vh - 80)));

          if (rightOffset > baseRight || rightPanelInfo) {
            nextMode = 'avoid';
          }
        }
      } else {
        narrowAutoCollapsed = false;
        narrowExpandOverride = false;
      }

      applyFloatingHostStyle(host, computedTop, computedRight, 'block', {
        widthPx: computedWidth,
        bodyMaxH: computedBodyMaxH
      });
      overviewPlacementMode = nextMode;
    }

    const summarizeRect = r => r ? {
      left: Math.round(r.left),
      top: Math.round(r.top),
      right: Math.round(r.right),
      bottom: Math.round(r.bottom),
      width: Math.round(r.width),
      height: Math.round(r.height)
    } : null;

    lastLayoutDebug = {
      mode: overviewPlacementMode,
      docked: overviewPlacementMode === 'docked',
      dockStyle: overviewDockStyle,
      narrowAutoCollapsed,
      hasRightPanel: Boolean(rightPanelInfo),
      isCompactCard: Boolean(rightPanelInfo?.isCompactCard),
      hasVerticalStackRoom: Boolean(rightPanelInfo?.hasVerticalStackRoom),
      hasDockContainer: Boolean(rightPanelInfo?.dockContainer),
      viewport: vw > 0 && vh > 0 ? { width: vw, height: vh } : null,
      convRect: summarizeRect(convRect),
      rightPanelRect: summarizeRect(rightPanelInfo?.rect),
      contentBottom: rightPanelInfo?.contentSummary?.contentBottom != null ? Math.round(rightPanelInfo.contentSummary.contentBottom) : null,
      rightPanelTag: rightPanelInfo?.panelEl?.tagName || null,
      dockTag: rightPanelInfo?.dockContainer?.tagName || null,
      probeDiag: detected.probeDiag || []
    };

    const changed = prevMode !== overviewPlacementMode || prevDockStyle !== overviewDockStyle || prevEffectiveCollapsed !== getEffectiveOverviewCollapsed();
    if (changed && allowRender) {
      renderLiveWidgets();
    }
    return changed;
  }

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

    let createdOverview = false;
    if (!overviewMount) {
      overviewMount = createShadowMount('t3tools-overview', OVERVIEW_FLOAT_INIT_STYLE);
      overviewMount.contentEl.addEventListener('click', onWidgetClick);
      lastOverviewHtml = '';
      createdOverview = true;
    }
    const layoutChanged = reconcileOverviewLayout({ allowRender: false });
    if (createdOverview || layoutChanged) {
      renderLiveWidgets();
    }

    const sidebar = findAnchor('sidebar');
    if (sidebar) {
      let createdSidebar = false;
      if (!sidebarMount || !sidebarMount.host.isConnected) {
        destroyMount(sidebarMount);
        sidebarMount = createShadowMount('t3tools-sidebar-btn', 'display:block;width:100%;flex:none;');
        sidebarMount.contentEl.addEventListener('click', onWidgetClick);
        lastSidebarHtml = '';
        createdSidebar = true;
      }
      if (!sidebar.contains(sidebarMount.host)) {
        sidebar.appendChild(sidebarMount.host);
      }
      if (createdSidebar) {
        renderSidebarWidget();
      }
    }
  }

  function renderSidebarWidget() {
    if (!sidebarMount) return;
    const cfg = lastSettings || lastLive?.settings || {};
    sidebarMount.host.style.display = cfg.enabled === false ? 'none' : 'block';
    const badgeStatus = transportState === 'connected' ? 'attached' : transportState;
    const activeRange = cfg.sidebarUsageRange || 'today';
    if (lastSidebarUsage?.preset !== activeRange) lastSidebarUsage = null;
    const nextHtml = renderSidebarTriggerHtml(
      {
        settings: cfg,
        todayUsage: activeRange === 'today' ? lastTodayUsage : null,
        sidebarUsage: lastSidebarUsage,
        runtimeUpdates: lastLive?.runtimeUpdates ?? lastRuntimeUpdates,
        appUpdate: lastLive?.appUpdate ?? lastAppUpdate
      },
      {
        dismissedUpdateSig: dismissedRuntimeUpdateSig,
        dismissedAppUpdateVer,
        status: badgeStatus
      }
    );
    if (nextHtml !== lastSidebarHtml) {
      sidebarMount.contentEl.innerHTML = nextHtml;
      lastSidebarHtml = nextHtml;
    }
  }

  function navigateToProviderSettings() {
    if (dashboardOpen) {
      closePtPopMenu();
      dashboardOpen = false;
      renderDashboardOverlay();
    }
    const targetPath = '/settings/providers';
    if (String(location.hash || '').startsWith('#/') || location.protocol === 't3code:') {
      location.hash = `#${targetPath}`;
    } else {
      history.pushState({}, '', targetPath);
      window.dispatchEvent(new PopStateEvent('popstate'));
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
    const cfg = lastSettings || lastLive?.settings || {};
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
    renderSidebarWidget();
    if (overviewMount) {
      reconcileOverviewLayout({ allowRender: false });
      const docked = overviewPlacementMode === 'docked';
      const effectiveCollapsed = getEffectiveOverviewCollapsed();
      const nextOverviewHtml = renderOverviewCardHtml(effectiveLive, effectiveCollapsed, showAllSteps, { docked, dockStyle: overviewDockStyle });
      if (nextOverviewHtml !== lastOverviewHtml) {
        overviewMount.contentEl.innerHTML = nextOverviewHtml;
        lastOverviewHtml = nextOverviewHtml;
      }
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
    const initialSettings = lastSettings;
    const revision = settingsRevision;
    try {
      const st = await callRpc('getStatus');
      if (disposed) return;
      lastStatus = st;
      if (st?.settings && revision === settingsRevision && lastSettings === initialSettings) lastSettings = st.settings;
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
      if(badge){
        const anomTotal=Number(lastDash?.anomalySummary?.total || 0);
        badge.textContent=anomTotal>0?String(anomTotal):'';
        badge.setAttribute('data-tone',anomTotal>0?'danger':'muted');
        badge.style.display=anomTotal>0?'':'none';
        badge.hidden=anomTotal<=0;
      }
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
      fallbackSettings: lastSettings || lastLive?.settings,
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
      const effectiveCollapsed = getEffectiveOverviewCollapsed();
      const nextCollapsed = !effectiveCollapsed;
      if (overviewPlacementMode !== 'docked' && narrowAutoCollapsed && !nextCollapsed) {
        narrowExpandOverride = true;
        narrowAutoCollapsed = false;
        overviewCollapsed = false;
      } else {
        narrowExpandOverride = false;
        overviewCollapsed = nextCollapsed;
      }
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
    } else if (action === 'open-provider-settings') {
      navigateToProviderSettings();
    } else if (action === 'dismiss-runtime-update') {
      const sig = btn.getAttribute('data-pt-update-sig') || '';
      if (sig) {
        dismissedRuntimeUpdateSig = sig;
        try { localStorage.setItem('t3tools.dismissedRuntimeUpdateSig', sig); } catch {}
        renderSidebarWidget();
      }
    } else if (action === 'dismiss-app-update') {
      const ver = btn.getAttribute('data-pt-app-ver') || '';
      if (ver) {
        dismissedAppUpdateVer = ver;
        try { localStorage.setItem('t3tools.dismissedAppUpdateVer', ver); } catch {}
        renderSidebarWidget();
      }
    } else if (action === 'install-app-update') {
      const upd = lastLive?.appUpdate ?? lastAppUpdate;
      if (upd && !upd.canAutoUpdate) {
        if (upd.releaseUrl) window.open(upd.releaseUrl, '_blank', 'noopener,noreferrer');
      } else {
        callRpc('installAppUpdate', {}).then(res => {
          if (res?.status) {
            lastAppUpdate = res.status;
            if (lastLive) lastLive.appUpdate = res.status;
            renderSidebarWidget();
          }
          if (res?.ok === false && res.error) {
            showOverlayToast(res.error);
          }
        }).catch(err => {
          showOverlayToast(err?.message || '启动自动更新失败');
        });
      }
    }
  }

  function applyAlertCounts(counts) {
    if (!counts || typeof counts.unreadCount !== 'number') return;
    const nextCounts = {
      unreadCount: counts.unreadCount,
      unreadRecoveredCount: counts.unreadRecoveredCount ?? 0,
      unreadIncidents: counts.unreadIncidents ?? (counts.unreadCount + (counts.unreadRecoveredCount ?? 0)),
      activeBrokenThreads: counts.activeBrokenThreads ?? 0
    };
    lastStatus = lastStatus
      ? { ...lastStatus, alerts: { ...(lastStatus.alerts || {}), ...nextCounts } }
      : { alerts: nextCounts };
    if (lastLive?.globalAlerts) {
      lastLive = { ...lastLive, globalAlerts: { ...lastLive.globalAlerts, ...nextCounts } };
    }
  }

  async function onDashboardClick(e) {
    // Capture the inner element before the first await retargets the Shadow DOM event.
    const target = e.target;
    const toast = showOverlayToast;
    try {
      if (await handleErrorClick(e,dashState,{toast,current:()=>dashState.tab,
        rpc:async (action,params)=>{
          const res = await callRpc(action,params);
          if (['ackErrors','resolveErrors'].includes(action)) {
            applyAlertCounts(res);
            fetchOverlayStatus();
          }
          return res;
        },
        close:()=>{dashboardOpen=false;renderDashboardOverlay();},
        open:async (view, opts = {})=>{
          dashState.tab = view;
          await refreshDashboard();
          if (view === 'models' && opts.scroll !== false) overlayMount?.contentEl.querySelector('[data-error-center]')?.scrollIntoView();
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
      if (action === 'check-runtime-updates') {
        try {
          const updates = await callRpc('checkRuntimeUpdates', {});
          if (updates) {
            lastRuntimeUpdates = updates;
            if (lastStatus) lastStatus.runtimeUpdates = updates;
            if (lastLive) lastLive.runtimeUpdates = updates;
            renderSidebarWidget();
            renderDashboardOverlay();
          }
          showOverlayToast(updates?.hasUpdates ? `发现 ${updates.updateCount} 个运行环境可更新` : '当前运行环境已是最新版本');
        } catch (err) {
          showOverlayToast(err?.message || '检查运行环境更新失败');
        }
        return;
      }
      if (action === 'open-provider-settings') {
        navigateToProviderSettings();
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
          settingsRevision++;
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
      const val = settingEl.type === 'checkbox' ? Boolean(settingEl.checked) : settingEl.value;
      try {
        const updated = await callRpc('updateSettings', { [key]: val });
        if (updated) {
          settingsRevision++;
          lastSettings = updated;
          if (lastLive) lastLive.settings = updated;
          if (lastStatus) lastStatus.settings = updated;
          renderLiveWidgets();
          if (key === 'sidebarUsageRange') pollLive({ force: true });
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
    const settingsAtStart = settingsRevision;
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
      if (live?.settings && settingsAtStart === settingsRevision) {
        if (!lastSettings && typeof live.settings.overviewCollapsed === 'boolean') {
          overviewCollapsed = live.settings.overviewCollapsed;
        }
        lastSettings = live.settings;
      }
      const prevAlerts = lastLive?.globalAlerts;
      const nextAlerts = live?.globalAlerts;
      const alertsChanged = Boolean(
        nextAlerts && (
          prevAlerts?.unreadCount !== nextAlerts.unreadCount ||
          prevAlerts?.unreadRecoveredCount !== nextAlerts.unreadRecoveredCount ||
          prevAlerts?.unreadIncidents !== nextAlerts.unreadIncidents
        )
      );
      if (nextAlerts) applyAlertCounts(nextAlerts);
      if (dashboardOpen && alertsChanged) {
        if (dashState.tab === 'models') refreshDashboard();
        else renderDashboardOverlay();
      }
      if (live?.todayUsage) lastTodayUsage = live.todayUsage;
      if (live?.sidebarUsage) lastSidebarUsage = live.sidebarUsage;
      if (live?.runtimeUpdates) lastRuntimeUpdates = live.runtimeUpdates;
      if (live?.appUpdate) lastAppUpdate = live.appUpdate;
      lastLive = live;
      lastLiveThreadId = (!live?.thread?.unresolved && live?.thread?.threadId) ? String(live.thread.threadId) : '';
      renderLiveWidgets();
    } catch {
      if (disposed || reqSeq !== liveRequestSeq) return;
      renderSidebarWidget();
      const nowThreadId = detectActiveThreadId();
      if (nowThreadId !== activeThreadId) {
        syncActiveThread({ triggerPoll: true });
        return;
      }
      // Clear stale snapshot on daemon disconnect/timeout or when switching to a thread that fails to load
      if (transportState === 'disconnected' || lastLiveThreadId !== nowThreadId) {
        lastLive = null;
        lastLiveThreadId = '';
        renderLiveWidgets();
      }
    } finally {
      inFlightPolls = Math.max(0, inFlightPolls - 1);
    }
  }

  const domObserver = new MutationObserver(mutations => {
    if (disposed) return;
    if (Array.isArray(mutations) && mutations.length > 0) {
      const hasForeignMutation = mutations.some(m => {
        const nodes = [...(m.addedNodes || []), ...(m.removedNodes || [])];
        if (!nodes.length) return true;
        return nodes.some(n => !n?.getAttribute || n.getAttribute('data-t3tools') !== '1');
      });
      if (!hasForeignMutation) return;
    }
    syncActiveThread({ triggerPoll: true });
    ensureMounts();
    scheduleOverviewLayout({ withDelayedRecheck: true });
  });
  domObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['hidden', 'data-state', 'aria-expanded', 'aria-hidden', 'open']
  });

  const onViewportResize = () => {
    if (!disposed) scheduleOverviewLayout();
  };
  const onTransitionEnd = () => {
    if (!disposed) scheduleOverviewLayout();
  };
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
      if (!disposed) {
        syncActiveThread({ triggerPoll: true });
        scheduleOverviewLayout({ withDelayedRecheck: true });
      }
    });
  };
  window.addEventListener('resize', onViewportResize);
  window.addEventListener('transitionend', onTransitionEnd, true);
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
    }, (lastSettings || lastLive?.settings)?.pollIntervalMs || 2500);
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
      return {
        threadId: detectActiveThreadId(),
        lastLiveThreadId,
        anchors: report,
        overviewLayout: { ...lastLayoutDebug }
      };
    },
    dispose() {
      disposed = true;
      for (const controller of httpRequests) controller.abort();
      dashboardOpen = false;
      dashRequestSeq++;
      liveRequestSeq++;
      lastLive = null;
      lastLiveThreadId = '';
      closePtPopMenu();
      clearTimeout(pollTimer);
      clearTimeout(searchTimer);
      clearTimeout(overlayToastTimer);
      clearTimeout(layoutRecheckTimer);
      layoutRecheckTimer = null;
      if (layoutRafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(layoutRafId);
      }
      layoutRafId = 0;
      try { layoutResizeObserver?.disconnect(); } catch {}
      layoutResizeObserver = null;
      observedLayoutEls.clear();
      for (const entry of pendingRpc.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('实例已重载'));
      }
      pendingRpc.clear();
      domObserver.disconnect();
      window.removeEventListener('resize', onViewportResize);
      window.removeEventListener('transitionend', onTransitionEnd, true);
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
      lastOverviewHtml = '';
      lastSidebarHtml = '';
      lastTodayUsage = null;
      lastSidebarUsage = null;
      lastRuntimeUpdates = null;
      lastAppUpdate = null;
      themeSync.dispose();
      if (globalThis.__t3Tools) globalThis.__t3Tools.healthy = false;
    }
  };
})(__T3TOOLS_CONFIG__);
