import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const uiDir = dirname(fileURLToPath(import.meta.url));

function escapeHtml(val) {
  return String(val ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeJsonForHtmlScript(obj) {
  return JSON.stringify(obj)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function extractSharedCss(sharedViewsSrc) {
  const m = sharedViewsSrc.match(/const PT_SHARED_CSS = `([\s\S]*?)`;/);
  return m ? m[1] : '';
}

/**
 * Independent localhost Web Fallback dashboard (http://127.0.0.1:17373).
 * Fixes from Codex Astra review:
 * - Explicit thread picker for live composer/progress preview (P1 #2)
 * - Partial table rendering + monotonic response sequence so search input never loses focus (P2 #20)
 * - Explicit data-theme="dark|light" toggle so switching to light mode works immediately (P3)
 * - HTML-safe escaping of version & config JSON in a dedicated application/json script tag (P3)
 * - Sends per-daemon X-T3Tools-Token on POST /api/sync (P1 #5)
 */
export function buildFallbackHtml({ version = '0.1.0', apiBase = '', authToken = '' } = {}) {
  const themeSyncSrc = readFileSync(join(uiDir, 'theme-sync.js'), 'utf8');
  const sharedViewsSrc = readFileSync(join(uiDir, 'shared-views.js'), 'utf8');
  const sharedCss = extractSharedCss(sharedViewsSrc);
  const safeVersion = escapeHtml(version);
  const bootConfig = safeJsonForHtmlScript({ apiBase, authToken });

  return `<!doctype html>
<html lang="zh-CN" class="dark" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>T3Tools v${safeVersion}</title>
  <style>
    body {
      margin: 0;
      padding: 0 16px 32px;
      background: var(--pt-bg, #0b0c0f);
      color: var(--pt-fg, #f3f4f6);
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .pt-live-strip {
      width: min(1240px, 100%);
      margin: 14px auto 0;
      display: grid;
      grid-template-columns: 1fr 336px;
      gap: 12px;
      align-items: start;
    }
    #live-composer {
      padding: 6px 10px 8px;
      border-radius: var(--pt-radius, 10px);
      background: var(--pt-card, #14161b);
      border: 1px solid var(--pt-border, rgba(255,255,255,0.1));
    }
    .pt-thread-bar {
      width: min(1240px, 100%);
      margin: 12px auto 0;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
    }
    @media (max-width: 960px) {
      .pt-live-strip { grid-template-columns: 1fr; }
    }
    ${sharedCss}
  </style>
</head>
<body class="pt-root">
  <div class="pt-thread-bar">
    <span class="pt-muted">实时监控会话：</span>
    <select id="live-thread-picker" class="pt-select" style="min-width:260px;">
      <option value="">自动跟踪最近活跃会话</option>
    </select>
  </div>
  <div class="pt-live-strip">
    <div id="live-composer"></div>
    <div id="live-overview"></div>
  </div>
  <div id="dashboard-root"></div>

  <script id="pt-boot-config" type="application/json">${bootConfig}</script>
  <script>
    ${themeSyncSrc}
    ${sharedViewsSrc}

    (() => {
      const boot = JSON.parse(document.getElementById('pt-boot-config').textContent || '{}');
      const apiBase = boot.apiBase || '';
      const authToken = boot.authToken || '';

      const themeSync = createThemeSynchronizer({ darkClass: 'dark', cssVars: [] });
      themeSync.start();
      themeSync.register(document.body);

      let liveData = null;
      let dashData = null;
      let collapsed = false;
      let showAllSteps = false;
      let selectedThreadId = '';
      let liveReqSeq = 0;
      let dashReqSeq = 0;

      const state = {
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

      const pickerEl = document.getElementById('live-thread-picker');
      const composerEl = document.getElementById('live-composer');
      const overviewEl = document.getElementById('live-overview');
      const dashEl = document.getElementById('dashboard-root');

      function syncThreadPicker(threads) {
        if (!Array.isArray(threads)) return;
        const curKey = threads.map(t => t.threadId).join(',');
        if (pickerEl.dataset.key === curKey) return;
        pickerEl.dataset.key = curKey;
        const opts = ['<option value="">自动跟踪最近活跃会话</option>']
          .concat(threads.map(t =>
            '<option value="' + esc(t.threadId) + '"' + (selectedThreadId === t.threadId ? ' selected' : '') + '>' +
            esc(t.title || t.threadId.slice(0, 12)) + (t.accountId ? ' [' + esc(t.accountId) + ']' : '') +
            '</option>'
          ));
        pickerEl.innerHTML = opts.join('');
      }

      function renderLive() {
        if (!liveData) return;
        syncThreadPicker(liveData.thread?.recentThreads || []);
        composerEl.innerHTML = renderComposerBarHtml(liveData);
        overviewEl.innerHTML = renderOverviewCardHtml(liveData, collapsed, showAllSteps);
      }

      function renderDash({ partialRequestsOnly = false } = {}) {
        if (!dashData) return;
        if (partialRequestsOnly && state.tab === 'requests') {
          const card = dashEl.querySelector('[data-pt-requests-card]');
          if (card) {
            card.innerHTML = renderRequestsTableCardHtml(dashData);
            const anomCount = dashData.anomalySummary?.total || 0;
            const c1 = dashEl.querySelector('[data-pt-anomaly-count]');
            const c2 = dashEl.querySelector('[data-pt-tab-anom-count]');
            const cn = dashEl.querySelector('[data-pt-compaction-note]');
            if (c1) c1.textContent = String(anomCount);
            if (c2) c2.textContent = String(anomCount);
            if (cn) cn.textContent = '已排除冷启动及 ' + (dashData.anomalySummary?.excludedCompactions || 0) + ' 次上下文压缩误报';
            return;
          }
        }
        dashEl.innerHTML = renderDashboardHtml(dashData, state, { standalone: true });
      }

      async function fetchLive() {
        const reqSeq = ++liveReqSeq;
        const reqThread = selectedThreadId;
        try {
          const qs = reqThread
            ? ('?threadId=' + encodeURIComponent(reqThread) + '&allowFallback=0')
            : '';
          const r = await fetch(apiBase + '/api/live' + qs);
          const j = await r.json();
          if (reqSeq !== liveReqSeq || selectedThreadId !== reqThread) return;
          if (j.ok) {
            liveData = j.data;
            renderLive();
          }
        } catch {}
      }

      async function fetchDash({ force = false, partialRequestsOnly = false } = {}) {
        const seq = ++dashReqSeq;
        try {
          if (force) {
            await fetch(apiBase + '/api/sync', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(authToken ? { 'X-T3Tools-Token': authToken } : {})
              },
              body: '{}'
            }).catch(() => {});
          }
          const sp = new URLSearchParams();
          const skip = new Set(['tab', 'heatmapMetric', 'quotaDriver', 'quotaSort', 'quotaView', 'hideEmail']);
          for (const [k, v] of Object.entries(state)) {
            if (!skip.has(k) && v !== '' && v !== null && v !== undefined) sp.set(k, String(v));
          }
          const r = await fetch(apiBase + '/api/dashboard?' + sp.toString());
          const j = await r.json();
          if (seq !== dashReqSeq) return;
          if (j.ok) {
            dashData = j.data;
            renderDash({ partialRequestsOnly });
          }
        } catch {}
      }

      pickerEl.addEventListener('change', () => {
        selectedThreadId = pickerEl.value;
        fetchLive();
      });

      document.body.addEventListener('click', e => {
        const act = e.target.closest?.('[data-pt-action]')?.getAttribute('data-pt-action');
        if (act === 'toggle-overview') { collapsed = !collapsed; renderLive(); return; }
        if (act === 'toggle-all-steps') { showAllSteps = !showAllSteps; renderLive(); return; }
        if (act === 'open-quotas') {
          state.tab = 'quotas';
          renderDash();
          dashEl.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
          return;
        }
        if (act === 'open-dashboard') {
          dashEl.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
          return;
        }
        if (act === 'toggle-hide-email') {
          state.hideEmail = !state.hideEmail;
          renderDash();
          return;
        }
        if (act === 'refresh') { fetchLive(); fetchDash({ force: true }); return; }
        if (act === 'toggle-theme') {
          const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
          const next = isDark ? 'light' : 'dark';
          document.documentElement.setAttribute('data-theme', next);
          document.documentElement.classList.toggle('dark', next === 'dark');
          document.documentElement.classList.toggle('light', next === 'light');
          themeSync.syncAll();
          return;
        }
        const qDriver = e.target.closest?.('[data-pt-quota-driver]')?.getAttribute('data-pt-quota-driver');
        if (qDriver) { state.quotaDriver = qDriver; renderDash(); return; }
        const qView = e.target.closest?.('[data-pt-quota-view]')?.getAttribute('data-pt-quota-view');
        if (qView) { state.quotaView = qView; renderDash(); return; }
        const inspectAcc = e.target.closest?.('[data-pt-inspect-account]')?.getAttribute('data-pt-inspect-account');
        if (inspectAcc) {
          state.account = inspectAcc;
          state.tab = 'overview';
          state.page = 1;
          fetchDash();
          return;
        }
        const tab = e.target.closest?.('[data-pt-tab]')?.getAttribute('data-pt-tab');
        if (tab) { state.tab = tab; renderDash(); return; }
        const hm = e.target.closest?.('[data-pt-heatmap]')?.getAttribute('data-pt-heatmap');
        if (hm) { state.heatmapMetric = hm; renderDash(); return; }
        const pgEl = e.target.closest?.('[data-pt-page]');
        if (pgEl && !pgEl.disabled) {
          state.page = Number(pgEl.getAttribute('data-pt-page')) || 1;
          fetchDash({ partialRequestsOnly: true });
        }
      });

      document.body.addEventListener('change', e => {
        const sortEl = e.target.closest?.('[data-pt-quota-sort]');
        if (sortEl) {
          state.quotaSort = sortEl.value || 'remaining';
          renderDash();
          return;
        }
        const el = e.target.closest?.('[data-pt-filter]');
        if (!el) return;
        const k = el.getAttribute('data-pt-filter');
        state[k] = k === 'onlyAnomalies' ? Boolean(el.checked) : el.value;
        state.page = 1;
        const partial = state.tab === 'requests' && (k === 'model' || k === 'status' || k === 'onlyAnomalies');
        fetchDash({ partialRequestsOnly: partial });
      });

      let searchTimer = null;
      document.body.addEventListener('input', e => {
        const el = e.target.closest?.('[data-pt-filter="session"]');
        if (!el) return;
        state.session = el.value;
        state.page = 1;
        dashReqSeq++;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => fetchDash({ partialRequestsOnly: true }), 260);
      });

      fetchLive();
      fetchDash({ force: true });
      setInterval(fetchLive, 3000);
    })();
  </script>
</body>
</html>`;
}
