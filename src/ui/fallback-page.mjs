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
 * Magpie-style Multi-View Desktop & Web UI:
 * - Left grouped sidebar (Insights / Footer Settings + live T3 Code attach pill)
 * - Clean top bar with contextual controls per view (never crams everything onto one screen)
 * - 5 dedicated views: 用量概览 (overview), 账号额度 (quotas), 模型分析 (models), 请求明细 (requests), 设置 (settings)
 * - Shares 100% of PT_SHARED_CSS, theme-sync tokens, and shared-views renderers.
 */
export function buildFallbackHtml({ version = '0.1.0', apiBase = '', authToken = '', theme = 'dark' } = {}) {
  const themeSyncSrc = readFileSync(join(uiDir, 'theme-sync.js'), 'utf8');
  const sharedViewsSrc = readFileSync(join(uiDir, 'shared-views.js'), 'utf8');
  const sharedCss = extractSharedCss(sharedViewsSrc);
  const safeVersion = escapeHtml(version);
  const initialTheme = theme === 'light' ? 'light' : 'dark';
  const bootConfig = safeJsonForHtmlScript({ apiBase, authToken, version, theme: initialTheme });

  return `<!doctype html>
<html lang="zh-CN" class="${initialTheme}" data-theme="${initialTheme}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="${initialTheme === 'light' ? 'light dark' : 'dark light'}" />
  <title>T3Tools v${safeVersion}</title>
  <style>
    :root, html[data-theme="dark"] {
      color-scheme: dark;
      --pt-bg: #0b0c0f;
      --pt-card: #14161b;
      --pt-surface: #1b1e25;
      --pt-fg: #f3f4f6;
      --pt-muted: #9ca3af;
      --pt-border: rgba(255, 255, 255, 0.10);
      --pt-accent: #6366f1;
      --pt-accent-fg: #ffffff;
      --pt-success: #22c55e;
      --pt-warning: #f59e0b;
      --pt-danger: #ef4444;
      --pt-chart-1: #6366f1;
      --pt-chart-2: #22c55e;
      --pt-chart-3: #f59e0b;
      --pt-chart-4: #06b6d4;
      --pt-chart-5: #ec4899;
      --pt-chart-6: #a855f7;
      --pt-radius: 10px;
      --pt-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
    }
    html[data-theme="light"] {
      color-scheme: light;
      --pt-bg: #ffffff;
      --pt-card: #f8fafc;
      --pt-surface: #f1f5f9;
      --pt-fg: #111827;
      --pt-muted: #64748b;
      --pt-border: rgba(15, 23, 42, 0.12);
      --pt-accent: #4f46e5;
      --pt-accent-fg: #ffffff;
      --pt-success: #16a34a;
      --pt-warning: #d97706;
      --pt-danger: #dc2626;
      --pt-chart-1: #4f46e5;
      --pt-chart-2: #16a34a;
      --pt-chart-3: #d97706;
      --pt-chart-4: #0891b2;
      --pt-chart-5: #db2777;
      --pt-chart-6: #9333ea;
      --pt-radius: 10px;
      --pt-shadow: 0 10px 28px rgba(15, 23, 42, 0.14);
    }
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      overflow: hidden;
      background: var(--pt-bg, #0b0c0f);
      color: var(--pt-fg, #f3f4f6);
      font-family: var(--pt-font-sans, "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif);
      -webkit-font-smoothing: antialiased;
    }

    .pt-desktop-only { display: none !important; }
    body[data-desktop="true"] .pt-desktop-only { display: inline-flex !important; }
    .pt-desktop-only-row { display: none !important; }
    body[data-desktop="true"] .pt-desktop-only-row { display: flex !important; }

    /* App self-update banner & settings progress */
    .side-ver-dot {
      display: none;
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--pt-accent, #6366f1);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--pt-accent, #6366f1) 24%, transparent);
      margin-left: 2px;
      flex: none;
    }
    .side-ver-dot.visible { display: inline-block; }
    .pt-update-banner {
      display: none;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 18px;
      background: color-mix(in srgb, var(--pt-accent, #6366f1) 12%, var(--pt-card, #14161b));
      border-bottom: 1px solid color-mix(in srgb, var(--pt-accent, #6366f1) 30%, var(--pt-border, rgba(255,255,255,.1)));
      font-size: 12px;
      line-height: 1.4;
      flex: none;
    }
    .pt-update-banner.visible { display: flex; }
    .pt-update-banner-main {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      flex: 1;
    }
    .pt-update-pill {
      display: inline-flex;
      align-items: center;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      background: var(--pt-accent, #6366f1);
      color: var(--pt-accent-fg, #fff);
      flex: none;
    }
    .pt-update-summary {
      color: var(--pt-fg, #f3f4f6);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .pt-update-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: none;
    }
    .pt-update-progress {
      width: 110px;
      height: 6px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--pt-fg, #fff) 14%, transparent);
      overflow: hidden;
      flex: none;
    }
    .pt-update-progress-fill {
      height: 100%;
      width: 0%;
      border-radius: 999px;
      background: var(--pt-accent, #6366f1);
      transition: width 180ms ease;
    }
    .pt-update-notes {
      margin-top: 8px;
      padding: 8px 10px;
      border-radius: 8px;
      background: var(--pt-surface, #1b1e25);
      border: 1px solid var(--pt-border, rgba(255,255,255,.1));
      color: var(--pt-muted, #9ca3af);
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      max-height: 120px;
      overflow: auto;
    }
    .pt-mode-chip {
      display: inline-flex;
      align-items: center;
      margin-left: 6px;
      padding: 1px 6px;
      border-radius: 999px;
      font-size: 10.5px;
      font-weight: 500;
      background: color-mix(in srgb, var(--pt-fg, #fff) 8%, transparent);
      color: var(--pt-muted, #9ca3af);
    }

    /* Custom subtle scrollbars */
    ::-webkit-scrollbar { width: 7px; height: 7px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb {
      background: color-mix(in srgb, var(--pt-fg, #fff) 16%, transparent);
      border-radius: 999px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: color-mix(in srgb, var(--pt-fg, #fff) 28%, transparent);
    }

    ${sharedCss}
  </style>
</head>
<body class="pt-root">
  <div class="app-shell" id="app-shell" data-side-collapsed="false">
    <!-- Left Navigation Sidebar (Magpie style) -->
    <aside class="app-side" id="app-side">
      <div class="side-head">
        <span class="side-brand">
          <span class="side-logo">T3</span>
          <span>T3Tools</span>
          <span class="side-ver">v${safeVersion}</span>
          <span class="side-ver-dot" id="side-update-dot" title="发现新版本，点击前往设置更新"></span>
        </span>
      </div>

      <nav class="side-scroll" aria-label="主导航">
        <div class="nav-group-label">分析</div>
        <button type="button" class="nav-item active" data-view="overview">
          <svg class="nav-ic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="6" height="6" rx="1.4"/><rect x="11" y="3" width="6" height="6" rx="1.4"/><rect x="3" y="11" width="6" height="6" rx="1.4"/><rect x="11" y="11" width="6" height="6" rx="1.4"/></svg>
          <span>用量概览</span>
        </button>
        <button type="button" class="nav-item" data-view="quotas">
          <svg class="nav-ic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="6.5"/><path d="M10 10V5.5M10 10l3.2 2"/></svg>
          <span>账号额度</span>
          <span class="nav-badge" id="nav-badge-quotas">0</span>
        </button>
        <button type="button" class="nav-item" data-view="models">
          <svg class="nav-ic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16V9M8 16V5M12 16v-5M16 16V7"/></svg>
          <span>模型分析</span><span class="nav-badge" id="nav-badge-errors" data-tone="danger" hidden></span>
        </button>
        <button type="button" class="nav-item" data-view="requests">
          <svg class="nav-ic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5h12M4 10h12M4 14.5h8"/></svg>
          <span>请求明细</span>
          <span class="nav-badge" id="nav-badge-anomalies" data-tone="danger" hidden style="display:none"></span>
        </button>
      </nav>

      <div class="side-foot">
        <button type="button" class="nav-item" data-view="settings">
          <svg class="nav-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          <span>设置</span>
        </button>
        <button type="button" class="side-attach" id="side-attach-pill" data-state="waiting" data-pt-action="goto-settings" title="T3 Code 连接状态">
          <span class="side-attach-dot"></span>
          <span class="side-attach-text" id="side-attach-text">检测 T3 Code...</span>
        </button>
      </div>
    </aside>

    <!-- Main Right Column -->
    <div class="app-main">
      <header class="app-top">
        <div class="top-left">
          <button type="button" class="icon-btn" data-pt-action="toggle-sidebar" title="折叠 / 展开侧边栏">
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2"/><path d="M6 2.75v10.5"/></svg>
          </button>
          <span class="top-title" id="top-view-title">用量概览</span>
          <div class="top-seg" id="top-seg">
            <button type="button" data-view="overview" class="active">概览</button>
            <button type="button" data-view="quotas">额度</button>
            <button type="button" data-view="models">模型</button>
            <button type="button" data-view="requests">明细</button>
            <button type="button" data-view="settings">设置</button>
          </div>
        </div>

        <div class="top-right">
          <span class="top-toast" id="pt-shell-toast"></span>
        </div>
      </header>

      <div class="pt-update-banner" id="pt-app-update-banner" role="status" aria-live="polite">
        <div class="pt-update-banner-main">
          <span class="pt-update-pill" id="pt-update-banner-pill">新版本</span>
          <span class="pt-update-summary" id="pt-update-banner-text">发现 T3Tools 新版本</span>
          <div class="pt-update-progress" id="pt-update-banner-progress" style="display:none;">
            <div class="pt-update-progress-fill" id="pt-update-banner-fill"></div>
          </div>
        </div>
        <div class="pt-update-actions">
          <button type="button" class="pt-btn pt-btn-accent" id="pt-update-banner-install" data-pt-action="install-app-update">立即更新</button>
          <button type="button" class="pt-btn" id="pt-update-banner-notes" data-pt-action="open-release-url">更新说明</button>
          <button type="button" class="pt-btn" id="pt-update-banner-skip" data-pt-action="skip-app-update">跳过</button>
          <button type="button" class="icon-btn" id="pt-update-banner-dismiss" data-pt-action="dismiss-app-update" title="本次暂不提醒" aria-label="本次暂不提醒">×</button>
        </div>
      </div>

      <div class="app-viewport" id="app-viewport">
        <!-- Magpie-style contextual page toolbar for data views (overview / models / requests) -->
        <div class="view-data-head" id="view-data-head"></div>

        <!-- View 1: Usage Overview (KPIs + Quick Quotas + 53-Week Heatmap) -->
        <section class="app-view active" id="view-overview"></section>

        <!-- View 2: All-Accounts Quotas -->
        <section class="app-view" id="view-quotas"></section>

        <!-- View 3: Model Comparison & Health -->
        <section class="app-view" id="view-models"></section>

        <!-- View 4: Requests & Cache Anomalies -->
        <section class="app-view" id="view-requests"></section>

        <!-- View 5: Settings (Clean Magpie-style dedicated settings view) -->
        <section class="app-view" id="view-settings">
          <div class="settings-wrap">
            <div class="settings-group-title">外观</div>
            <div class="pt-card">
              <div class="setting-row">
                <div>
                  <div class="setting-label">界面主题</div>
                  <div class="setting-desc">切换深色或浅色外观</div>
                </div>
                <div class="pt-segs" id="settings-theme-segs" role="radiogroup" aria-label="界面主题">
                  <span class="pt-segs-thumb" aria-hidden="true"></span>
                  <button type="button" class="pt-seg-opt" role="radio" data-pt-theme="dark">深色</button>
                  <button type="button" class="pt-seg-opt" role="radio" data-pt-theme="light">浅色</button>
                </div>
              </div>
              <div class="setting-row">
                <div>
                  <div class="setting-label">左下角用量统计时间</div>
                  <div class="setting-desc">选择 T3 Code 侧边栏左下角展示的 tokens 与费用统计周期</div>
                </div>
                <select class="pt-select" aria-label="左下角用量统计时间" data-pt-setting="sidebarUsageRange" style="max-width:290px;">
                  <option value="today">今日</option>
                  <option value="24h">近 24 小时</option>
                  <option value="weeklyQuota">本周限额周期</option>
                  <option value="week">本周（自然周）</option>
                  <option value="7d">近 7 天</option>
                  <option value="30d">近 30 天</option>
                  <option value="all">全部历史</option>
                </select>
              </div>
            </div>

            <div class="settings-group-title">异常通知</div>
            <div class="pt-card">
              <div class="setting-row">
                <div>
                  <div class="setting-label">开启异常告警</div>
                  <div class="setting-desc">后台增量检测新产生的模型或会话失败</div>
                </div>
                <label class="pt-switch">
                  <input type="checkbox" data-alert-setting="enabled" checked />
                  <span class="pt-switch-track"></span>
                </label>
              </div>
              <div class="setting-row">
                <div>
                  <div class="setting-label">告警策略</div>
                  <div class="setting-desc">控制通知频率，避免偶发抖动刷屏</div>
                </div>
                <select class="pt-select" aria-label="告警模式" data-alert-setting="mode" style="max-width:320px;">
                  <option value="smart">智能聚合（限流/权限/会话失败立即提醒）</option>
                  <option value="every">每次失败立即提醒</option>
                  <option value="quiet">安静模式（仅独立端计数，不弹通知）</option>
                </select>
              </div>
              <div class="setting-row">
                <div>
                  <div class="setting-label">聚合与冷却</div>
                  <div class="setting-desc">同模型在窗口内达阈值即提醒，冷却期内合并</div>
                </div>
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                  <label class="pt-muted" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;">次数 <input class="pt-input pt-mono" type="number" min="1" max="20" data-alert-setting="burstThreshold" style="width:58px;" /></label>
                  <label class="pt-muted" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;">窗口(秒) <input class="pt-input pt-mono" type="number" min="60" max="1800" step="10" data-alert-setting="burstWindowMs" style="width:68px;" /></label>
                  <label class="pt-muted" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;">冷却(秒) <input class="pt-input pt-mono" type="number" min="15" max="1800" step="10" data-alert-setting="cooldownMs" style="width:68px;" /></label>
                </div>
              </div>
              <div class="setting-row">
                <div>
                  <div class="setting-label">系统托盘弹窗通知</div>
                  <div class="setting-desc">最小化到托盘时弹出通知，点击打开「模型分析」</div>
                </div>
                <label class="pt-switch">
                  <input type="checkbox" data-alert-setting="desktopNotification" checked />
                  <span class="pt-switch-track"></span>
                </label>
              </div>
              <div class="setting-row">
                <div>
                  <div class="setting-label">测试通知</div>
                  <div class="setting-desc">发送一条测试通知以验证托盘弹窗</div>
                </div>
                <button type="button" class="pt-btn" data-pt-action="test-alert">发送测试</button>
              </div>
            </div>
            <div class="settings-group-title">T3 Code 吸附</div>
            <div class="pt-card">
              <div class="setting-row">
                <div>
                  <div class="setting-label">
                    <span class="side-attach-dot" id="live-attach-dot"></span>
                    <span id="live-attach-heading">正在检测 T3 Code...</span>
                  </div>
                  <div class="setting-desc" id="live-attach-sub">自动连接本地 T3 Code 并挂载状态栏与悬浮卡</div>
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
                  <button type="button" class="pt-btn pt-btn-accent" id="pt-t3-primary-btn" data-pt-action="t3-primary" style="display:none;"></button>
                  <button type="button" class="pt-btn" data-pt-action="reattach-cdp">重新吸附</button>
                </div>
              </div>
              <div class="setting-row">
                <div>
                  <div class="setting-label">自动吸附到 T3 Code</div>
                  <div class="setting-desc">检测到 T3 Code 后自动挂载状态栏与悬浮卡</div>
                </div>
                <label class="pt-switch">
                  <input type="checkbox" data-pt-setting="autoAttachT3" checked />
                  <span class="pt-switch-track"></span>
                </label>
              </div>
              <div class="setting-row">
                <div>
                  <div class="setting-label">自动配置快捷方式调试参数</div>
                  <div class="setting-desc">仅追加 --remote-debugging-port=0，不改动安装文件</div>
                </div>
                <label class="pt-switch">
                  <input type="checkbox" data-pt-setting="autoPatchLauncher" checked />
                  <span class="pt-switch-track"></span>
                </label>
              </div>
              <div class="setting-row">
                <div>
                  <div class="setting-label">快捷方式修复</div>
                  <div class="setting-desc">T3 Code 更新后可一键重新注入调试启动参数</div>
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                  <button type="button" class="pt-btn" data-pt-action="patch-debug">修复快捷方式</button>
                </div>
              </div>
            </div>

            <div class="settings-group-title pt-desktop-only-row">托盘与窗口</div>
            <div class="pt-card pt-desktop-only-row" style="flex-direction:column;">
              <div class="setting-row" style="width:100%;">
                <div>
                  <div class="setting-label">关闭或最小化时缩放到托盘</div>
                  <div class="setting-desc">隐藏主窗口并保持后台吸附</div>
                </div>
                <label class="pt-switch">
                  <input type="checkbox" data-pt-setting="minimizeToTray" checked />
                  <span class="pt-switch-track"></span>
                </label>
              </div>
              <div class="setting-row" style="width:100%;">
                <div>
                  <div class="setting-label">启动时静默缩放到托盘</div>
                  <div class="setting-desc">不弹出主窗口，后台自动吸附 T3 Code</div>
                </div>
                <label class="pt-switch">
                  <input type="checkbox" data-pt-setting="startMinimizedToTray" />
                  <span class="pt-switch-track"></span>
                </label>
              </div>
              <div class="setting-row" style="width:100%;">
                <div>
                  <div class="setting-label">开机自启（托盘模式）</div>
                  <div class="setting-desc">随系统登录静默启动到托盘</div>
                </div>
                <label class="pt-switch">
                  <input type="checkbox" data-pt-host-setting="launchOnStartup" />
                  <span class="pt-switch-track"></span>
                </label>
              </div>
              <div class="setting-row" style="width:100%;">
                <div>
                  <div class="setting-label">隐藏到系统托盘</div>
                  <div class="setting-desc">立即收起主窗口到托盘</div>
                </div>
                <button type="button" class="pt-btn" data-pt-action="hide-to-tray">隐藏到托盘</button>
              </div>
            </div>

            <div class="settings-group-title">应用更新</div>
            <div class="pt-card">
              <div class="setting-row" style="align-items:flex-start;">
                <div style="min-width:0;flex:1;">
                  <div class="setting-label">
                    <span id="settings-update-heading">T3Tools v${safeVersion}</span>
                    <span class="pt-mode-chip" id="settings-install-mode">检测中</span>
                  </div>
                  <div class="setting-desc" id="settings-update-sub">自动从 GitHub Releases 检查更新，点击即可完成校验与重启升级</div>
                  <div class="pt-update-progress" id="settings-update-progress" style="display:none;width:220px;margin-top:8px;">
                    <div class="pt-update-progress-fill" id="settings-update-fill"></div>
                  </div>
                  <div class="pt-update-notes" id="settings-update-notes" style="display:none;"></div>
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;flex:none;">
                  <button type="button" class="pt-btn pt-btn-accent" id="settings-update-install-btn" data-pt-action="install-app-update" style="display:none;">立即更新</button>
                  <button type="button" class="pt-btn" id="settings-update-check-btn" data-pt-action="check-app-update">检查更新</button>
                  <button type="button" class="pt-btn" id="settings-update-release-btn" data-pt-action="open-release-url" style="display:none;">Release 页面</button>
                </div>
              </div>
              <div class="setting-row">
                <div>
                  <div class="setting-label">启动及后台自动检查更新</div>
                  <div class="setting-desc">每隔 6 小时静默检查 GitHub Releases，发现新版本时通过托盘和顶栏通知</div>
                </div>
                <label class="pt-switch">
                  <input type="checkbox" data-app-update-setting="autoCheck" checked />
                  <span class="pt-switch-track"></span>
                </label>
              </div>
            </div>

            <div class="settings-group-title">服务与控制</div>
            <div class="pt-card">
              <div class="setting-row">
                <div>
                  <div class="setting-label">本地服务</div>
                  <div class="setting-desc pt-mono" id="settings-daemon-info">http://127.0.0.1:17373</div>
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                  <button type="button" class="pt-btn pt-desktop-only" data-pt-action="open-external">浏览器打开</button>
                  <button type="button" class="pt-btn pt-btn-danger pt-desktop-only" data-pt-action="exit-app">退出 T3Tools</button>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>

  <script id="pt-boot-config" type="application/json">${bootConfig}</script>
  <script>
    ${themeSyncSrc}
    ${sharedViewsSrc}

    (() => {
      const boot = JSON.parse(document.getElementById('pt-boot-config').textContent || '{}');
      const apiBase = boot.apiBase || '';
      const authToken = boot.authToken || '';
      const urlParams = new URLSearchParams(location.search);
      const hasWebViewBridge = Boolean(window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === 'function');
      const isDesktop = hasWebViewBridge || urlParams.get('desktop') === '1';
      if (isDesktop) document.body.setAttribute('data-desktop', 'true');

      function postHostMessage(payload) {
        if (hasWebViewBridge) {
          try { window.chrome.webview.postMessage(JSON.stringify(payload)); } catch {}
        }
      }

      const themeSync = createThemeSynchronizer({ darkClass: 'dark', cssVars: [] });
      themeSync.start();
      themeSync.register(document.body);

      let lastThemeMutationAt = 0;
      const settingsThemeSegsEl = document.getElementById('settings-theme-segs');
      function syncSettingsThemeSegs({ animate = false } = {}) {
        if (!settingsThemeSegsEl) return;
        const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
        for (const btn of settingsThemeSegsEl.querySelectorAll('[data-pt-theme]')) {
          const on = btn.getAttribute('data-pt-theme') === cur;
          btn.classList.toggle('on', on);
          btn.setAttribute('aria-checked', on ? 'true' : 'false');
        }
        positionSegsThumb(settingsThemeSegsEl, { animate });
      }
      function applyTheme(nextTheme, { notifyHost = false, animate = false } = {}) {
        const normalized = nextTheme === 'light' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', normalized);
        document.documentElement.classList.toggle('dark', normalized === 'dark');
        document.documentElement.classList.toggle('light', normalized === 'light');
        const metaScheme = document.querySelector('meta[name="color-scheme"]');
        if (metaScheme) {
          metaScheme.setAttribute('content', normalized === 'light' ? 'light dark' : 'dark light');
        }
        themeSync.syncAll();
        syncSettingsThemeSegs({ animate });
        try { localStorage.setItem('t3tools.theme', normalized); } catch {}
        if (notifyHost) postHostMessage({ action: 'setTheme', theme: normalized });
        return normalized;
      }

      let initialTheme = boot.theme === 'light' || boot.theme === 'dark' ? boot.theme : '';
      if (!initialTheme) {
        try {
          const storedTheme = localStorage.getItem('t3tools.theme');
          if (storedTheme === 'light' || storedTheme === 'dark') initialTheme = storedTheme;
        } catch {}
      }
      applyTheme(initialTheme || 'dark', { notifyHost: true });

      const VIEW_TITLES = {
        overview: '用量概览',
        quotas: '账号额度',
        models: '模型分析',
        requests: '请求明细',
        settings: '设置'
      };
      const VIEWS_WITH_FILTERS = new Set(['overview', 'models', 'requests']);

      let savedView = 'overview';
      try {
        const stored = localStorage.getItem('t3tools.lastView');
        if (stored && VIEW_TITLES[stored]) savedView = stored;
      } catch {}

      let activeView = urlParams.get('view') && VIEW_TITLES[urlParams.get('view')] ? urlParams.get('view') : savedView;
      let sideCollapsed = false;
      try { sideCollapsed = localStorage.getItem('t3tools.sideCollapsed') === '1'; } catch {}

      let dashData = null;
      let focusErrorsOnRender = false;
      let statusData = null;
      let settingsSeq = 0;
      let statusSeq = 0;
      let saveQueue = Promise.resolve();
      const pendingSettings = new Map();
      let hostState = { t3UiRunning: false, launchOnStartup: false };
      let dashReqSeq = 0;
      let isRefreshing = false;
      let toastTimer = null;

      let initialPreset = 'weeklyQuota';
      try {
        const storedPreset = localStorage.getItem('t3tools.usagePeriod');
        if (storedPreset && isKeptPeriod(storedPreset)) initialPreset = storedPreset;
      } catch {}
      let initialHeatmapMetric = 'tokens';
      try {
        const storedHm = localStorage.getItem('t3tools.heatmapMetric');
        if (storedHm) initialHeatmapMetric = normalizeHeatmapMetric(storedHm);
      } catch {}

      const state = {
        tab: activeView,
        preset: initialPreset,
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

      const shellEl = document.getElementById('app-shell');
      const viewportEl = document.getElementById('app-viewport');
      const topTitleEl = document.getElementById('top-view-title');
      const viewDataHeadEl = document.getElementById('view-data-head');
      const shellToastEl = document.getElementById('pt-shell-toast');

      const sideAttachPill = document.getElementById('side-attach-pill');
      const sideAttachText = document.getElementById('side-attach-text');
      const liveAttachDot = document.getElementById('live-attach-dot');
      const liveAttachHeading = document.getElementById('live-attach-heading');
      const liveAttachSub = document.getElementById('live-attach-sub');
      const t3PrimaryBtn = document.getElementById('pt-t3-primary-btn');
      const settingsDaemonInfo = document.getElementById('settings-daemon-info');
      const badgeQuotasEl = document.getElementById('nav-badge-quotas');
      const badgeAnomEl = document.getElementById('nav-badge-anomalies');
      const sideUpdateDotEl = document.getElementById('side-update-dot');
      const updateBannerEl = document.getElementById('pt-app-update-banner');
      const updateBannerPillEl = document.getElementById('pt-update-banner-pill');
      const updateBannerTextEl = document.getElementById('pt-update-banner-text');
      const updateBannerProgEl = document.getElementById('pt-update-banner-progress');
      const updateBannerFillEl = document.getElementById('pt-update-banner-fill');
      const updateBannerInstallEl = document.getElementById('pt-update-banner-install');
      const updateBannerSkipEl = document.getElementById('pt-update-banner-skip');
      const updateBannerDismissEl = document.getElementById('pt-update-banner-dismiss');
      const settingsUpdHeadEl = document.getElementById('settings-update-heading');
      const settingsUpdModeEl = document.getElementById('settings-install-mode');
      const settingsUpdSubEl = document.getElementById('settings-update-sub');
      const settingsUpdProgEl = document.getElementById('settings-update-progress');
      const settingsUpdFillEl = document.getElementById('settings-update-fill');
      const settingsUpdNotesEl = document.getElementById('settings-update-notes');
      const settingsUpdInstallBtn = document.getElementById('settings-update-install-btn');
      const settingsUpdCheckBtn = document.getElementById('settings-update-check-btn');
      const settingsUpdReleaseBtn = document.getElementById('settings-update-release-btn');
      let dismissedBannerVersion = '';
      let fastUpdatePollTimer = null;
      let shownJustUpdated = '';

      const viewOverviewEl = document.getElementById('view-overview');
      const viewQuotasEl = document.getElementById('view-quotas');
      const viewModelsEl = document.getElementById('view-models');
      const viewRequestsEl = document.getElementById('view-requests');

      shellEl.setAttribute('data-side-collapsed', sideCollapsed ? 'true' : 'false');

      function showToast(msg) {
        if (!shellToastEl) return;
        shellToastEl.textContent = msg || '';
        clearTimeout(toastTimer);
        if (msg) toastTimer = setTimeout(() => { shellToastEl.textContent = ''; }, 3200);
      }

      async function postApi(path, body = {}) {
        const r = await fetch(apiBase + path, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(authToken ? { 'X-T3Tools-Token': authToken } : {})
          },
          body: JSON.stringify(body)
        });
        return r.json();
      }

      function setRefreshBusy(busy) {
        isRefreshing = Boolean(busy);
        for (const btn of document.querySelectorAll('.pt-head-refresh')) {
          btn.classList.toggle('busy', isRefreshing);
        }
      }

      function syncDataHead({ animate = false } = {}) {
        if (!viewDataHeadEl) return;
        const show = VIEWS_WITH_FILTERS.has(activeView);
        viewDataHeadEl.classList.toggle('active', show);
        if (!show) return;

        if (!viewDataHeadEl.querySelector('[data-pt-period-segs]')) {
          viewDataHeadEl.innerHTML = renderViewToolbarHtml(dashData, state, { busy: isRefreshing });
          positionSegsThumb(viewDataHeadEl, { animate: false });
          return;
        }

        const preset = String(state.preset || 'weeklyQuota');
        const isCustom = !PT_PERIOD_PRESET_KEYS.has(preset);
        for (const btn of viewDataHeadEl.querySelectorAll('[data-pt-period]')) {
          const on = btn.getAttribute('data-pt-period') === preset;
          btn.classList.toggle('on', on);
          btn.setAttribute('aria-selected', on ? 'true' : 'false');
        }
        const rangeBtn = viewDataHeadEl.querySelector('[data-pt-range-trigger]');
        if (rangeBtn) {
          rangeBtn.classList.toggle('on', isCustom);
          rangeBtn.setAttribute('aria-selected', isCustom ? 'true' : 'false');
          const span = rangeBtn.querySelector('span');
          if (span) span.textContent = isCustom ? formatPeriodRangeLabel(preset) : '自定义';
        }
        const accBtn = viewDataHeadEl.querySelector('[data-pt-account-trigger]');
        if (accBtn) {
          const acc = String(state.account || 'all');
          const isSet = acc !== 'all';
          accBtn.classList.toggle('set', isSet);
          let dot = accBtn.querySelector('.pt-pick-dot');
          if (isSet && !dot) {
            dot = document.createElement('span');
            dot.className = 'pt-pick-dot';
            dot.setAttribute('aria-hidden', 'true');
            accBtn.prepend(dot);
          } else if (!isSet && dot) {
            dot.remove();
          }
          const lbl = accBtn.querySelector('.pt-pick-btn-label');
          if (lbl) lbl.textContent = isSet ? acc : '全部账号';
        }
        const refBtn = viewDataHeadEl.querySelector('.pt-head-refresh');
        if (refBtn) refBtn.classList.toggle('busy', isRefreshing);
        positionSegsThumb(viewDataHeadEl, { animate });
      }

      function applyPeriodChoice(nextPreset) {
        if (!nextPreset) return;
        closePtPopMenu();
        state.preset = nextPreset;
        state.day = '';
        state.page = 1;
        if (isKeptPeriod(nextPreset)) {
          try { localStorage.setItem('t3tools.usagePeriod', nextPreset); } catch {}
        }
        syncDataHead({ animate: true });
        fetchDash();
      }

      function applyAccountChoice(nextAccount) {
        closePtPopMenu();
        state.account = nextAccount || 'all';
        state.page = 1;
        syncDataHead({ animate: false });
        fetchDash();
      }

      function switchView(nextView, { resetScroll = true } = {}) {
        if (!VIEW_TITLES[nextView]) return;
        closePtPopMenu();
        activeView = nextView;
        state.tab = nextView;
        try { localStorage.setItem('t3tools.lastView', nextView); } catch {}

        topTitleEl.textContent = VIEW_TITLES[nextView];
        syncDataHead({ animate: false });

        for (const el of document.querySelectorAll('.app-view')) {
          el.classList.toggle('active', el.id === 'view-' + nextView);
        }
        for (const btn of document.querySelectorAll('[data-view]')) {
          btn.classList.toggle('active', btn.getAttribute('data-view') === nextView);
        }
        if (resetScroll && viewportEl) viewportEl.scrollTop = 0;

        renderActiveView();
        if (nextView === 'settings') {
          syncSettingsThemeSegs({ animate: false });
          fetchStatus();
          postHostMessage({ action: 'getHostState' });
        }
      }

      function renderShellStatus() {
        const cdp = statusData?.cdp || {};
        const cfg = statusData?.settings || {};
        const unreadFailed = statusData?.alerts?.unreadCount || 0;
        const unreadRecovered = statusData?.alerts?.unreadRecoveredCount || 0;
        const unread = statusData?.alerts?.unreadIncidents ?? (unreadFailed + unreadRecovered);
        const badge = document.getElementById('nav-badge-errors');
        if (badge) {
          badge.textContent = String(unread);
          badge.setAttribute('data-tone', unreadFailed > 0 ? 'danger' : unreadRecovered > 0 ? 'warning' : 'muted');
          badge.title = unread ? ('今日未读：失败 ' + unreadFailed + ' · 重试恢复 ' + unreadRecovered) : '';
          badge.style.display = unread ? '' : 'none';
          badge.hidden = !unread;
        }
        for (const el of document.querySelectorAll('[data-alert-setting]')) {
          const key = el.dataset.alertSetting;
          if (cfg.alertConfig) {
            if (pendingSettings.has('alert.' + key) || (el.type === 'number' && el === document.activeElement)) continue;
            if (el.type === 'number') el.value = cfg.alertConfig[key] / (key.endsWith('Ms') ? 1000 : 1);
            else if (key === 'mode') el.value = cfg.alertConfig[key];
            else el.checked = cfg.alertConfig[key];
          }
        }
        const autoAttach = cfg.autoAttachT3 !== false && cdp.enabled !== false;

        if (settingsDaemonInfo && statusData) {
          settingsDaemonInfo.textContent =
            (statusData.httpUrl || location.origin) +
            ' · PID ' + (statusData.pid || '-') +
            (cdp.connected ? (' · CDP :' + cdp.devToolsPort) : '');
        }

        for (const el of document.querySelectorAll('[data-pt-setting]')) {
          const key = el.getAttribute('data-pt-setting');
          if (!pendingSettings.has(key) && Object.prototype.hasOwnProperty.call(cfg, key)) {
            if (el.type === 'checkbox') el.checked = Boolean(cfg[key]);
            else el.value = String(cfg[key] ?? '');
          }
        }
        const autoStartEl = document.querySelector('[data-pt-host-setting="launchOnStartup"]');
        if (autoStartEl && !pendingSettings.has('launchOnStartup')) autoStartEl.checked = Boolean(hostState.launchOnStartup);

        if (!pendingSettings.has('theme') && (cfg.theme === 'light' || cfg.theme === 'dark') && Date.now() - lastThemeMutationAt > 2500) {
          const curTheme = document.documentElement.getAttribute('data-theme');
          if (curTheme !== cfg.theme) {
            applyTheme(cfg.theme, { notifyHost: true });
          }
        }

        let pillState = 'waiting';
        let sideLabel = '等待 T3 Code...';
        let heading = '等待 T3 Code 启动';
        let sub = cdp.message || '检测到 T3 Code 启动后将自动吸附';

        if (!autoAttach) {
          pillState = 'paused';
          sideLabel = '自动吸附已暂停';
          heading = '自动吸附已暂停';
          sub = '独立窗口仍可正常查看；开启后自动挂载 T3 Code';
          t3PrimaryBtn.style.display = 'inline-flex';
          t3PrimaryBtn.className = 'pt-btn pt-btn-accent';
          t3PrimaryBtn.textContent = '开启自动吸附';
          t3PrimaryBtn.dataset.mode = 'enable-attach';
        } else if (cdp.connected) {
          const n = Math.max(1, Number(cdp.attachedTargets || 1));
          pillState = 'attached';
          sideLabel = '已吸附 T3 Code (:' + (cdp.devToolsPort || '-') + ')';
          heading = '已吸附 T3 Code（' + n + ' 个窗口）';
          sub = '调试端口 :' + (cdp.devToolsPort || '-') + ' · 状态栏与悬浮卡运行中';
          t3PrimaryBtn.style.display = 'none';
          t3PrimaryBtn.dataset.mode = 'attached';
        } else if (hostState.t3UiRunning) {
          pillState = 'needs-restart';
          sideLabel = 'T3 Code 未开调试端口';
          heading = 'T3 Code 运行中，未开启调试端口';
          sub = '点击重启 T3 Code 并自动吸附（会话不会丢失）';
          t3PrimaryBtn.style.display = 'inline-flex';
          t3PrimaryBtn.className = 'pt-btn pt-btn-warn';
          t3PrimaryBtn.textContent = '重启并吸附';
          t3PrimaryBtn.dataset.mode = 'relaunch';
        } else {
          t3PrimaryBtn.style.display = 'inline-flex';
          t3PrimaryBtn.className = 'pt-btn pt-btn-accent';
          t3PrimaryBtn.textContent = '启动 T3 Code';
          t3PrimaryBtn.dataset.mode = 'launch';
        }

        sideAttachPill.setAttribute('data-state', pillState);
        sideAttachText.textContent = sideLabel;
        liveAttachHeading.textContent = heading;
        liveAttachSub.textContent = sub;
        if (liveAttachDot) {
          liveAttachDot.style.background = pillState === 'attached'
            ? 'var(--pt-success, #22c55e)'
            : pillState === 'needs-restart'
              ? 'var(--pt-warning, #f59e0b)'
              : pillState === 'waiting'
                ? 'var(--pt-accent, #6366f1)'
                : 'var(--pt-muted, #9ca3af)';
        }
        renderAppUpdateUi(statusData?.appUpdate, cfg.appUpdates);
      }

      function formatUpdateBytes(bytes) {
        const n = Number(bytes) || 0;
        if (n <= 0) return '';
        if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
        return (n / (1024 * 1024)).toFixed(1) + ' MB';
      }

      function openReleaseUrl(url) {
        const target = String(url || statusData?.appUpdate?.releaseUrl || 'https://github.com/LionKo/t3tools/releases');
        if (hasWebViewBridge) {
          postHostMessage({ action: 'openUrl', url: target });
        } else {
          window.open(target, '_blank', 'noopener,noreferrer');
        }
      }

      function syncFastUpdatePoll(upd) {
        const busy = upd && (upd.status === 'downloading' || upd.status === 'verifying' || upd.status === 'ready' || upd.status === 'checking');
        if (busy && !fastUpdatePollTimer) {
          let inFlight = false;
          let consecutiveErrors = 0;
          const scheduleNext = () => {
            if (!fastUpdatePollTimer) return;
            const delay = consecutiveErrors > 0 ? Math.min(5000, 800 * (consecutiveErrors + 1)) : 650;
            fastUpdatePollTimer = setTimeout(async () => {
              if (!fastUpdatePollTimer) return;
              if (document.hidden || inFlight) { scheduleNext(); return; }
              inFlight = true;
              try {
                await fetchStatus();
                consecutiveErrors = 0;
              } catch {
                consecutiveErrors++;
              } finally {
                inFlight = false;
                scheduleNext();
              }
            }, delay);
          };
          fastUpdatePollTimer = setTimeout(() => {}, 0);
          clearTimeout(fastUpdatePollTimer);
          fastUpdatePollTimer = 1;
          scheduleNext();
        } else if (!busy && fastUpdatePollTimer) {
          clearTimeout(fastUpdatePollTimer);
          fastUpdatePollTimer = null;
        }
      }
      window.addEventListener('beforeunload', () => {
        if (fastUpdatePollTimer) { clearTimeout(fastUpdatePollTimer); fastUpdatePollTimer = null; }
      });

      function renderAppUpdateUi(upd, updCfg) {
        const autoCheckEl = document.querySelector('[data-app-update-setting="autoCheck"]');
        if (autoCheckEl && !pendingSettings.has('appUpdates.autoCheck')) {
          autoCheckEl.checked = updCfg ? updCfg.autoCheck !== false : (upd ? upd.autoCheck !== false : true);
        }
        syncFastUpdatePoll(upd);
        if (!upd) return;

        if (upd.justUpdated?.toVersion && shownJustUpdated !== upd.justUpdated.toVersion) {
          shownJustUpdated = upd.justUpdated.toVersion;
          showToast('已自动更新至 T3Tools v' + upd.justUpdated.toVersion);
        }

        const hasNew = Boolean(upd.hasUpdate && upd.latestVersion);
        const busy = upd.status === 'downloading' || upd.status === 'verifying' || upd.status === 'ready';
        const modeLabel = upd.installMode === 'installed' ? '安装版' : upd.installMode === 'portable' ? '便携版' : '开发模式';
        const sizeHint = formatUpdateBytes(upd.downloadSize);
        const pct = Math.max(0, Math.min(100, Number(upd.progressPercent) || 0));

        if (sideUpdateDotEl) {
          sideUpdateDotEl.classList.toggle('visible', hasNew && !upd.isSkipped);
        }

        // 1. Top Update Banner
        const showBanner = Boolean(
          busy || (hasNew && !upd.isSkipped && dismissedBannerVersion !== upd.latestVersion)
        );
        if (updateBannerEl) {
          updateBannerEl.classList.toggle('visible', showBanner);
          if (showBanner) {
            if (upd.status === 'downloading') {
              updateBannerPillEl.textContent = '下载中 ' + pct + '%';
              updateBannerTextEl.textContent = '正在下载 T3Tools v' + upd.latestVersion + (sizeHint ? '（' + sizeHint + '）' : '') + '...';
              updateBannerProgEl.style.display = 'block';
              updateBannerFillEl.style.width = pct + '%';
              updateBannerInstallEl.disabled = true;
              updateBannerInstallEl.textContent = '下载中...';
              updateBannerSkipEl.style.display = 'none';
              updateBannerDismissEl.style.display = 'none';
            } else if (upd.status === 'verifying') {
              updateBannerPillEl.textContent = '校验中';
              updateBannerTextEl.textContent = '正在校验 SHA-256 完整性...';
              updateBannerProgEl.style.display = 'block';
              updateBannerFillEl.style.width = '98%';
              updateBannerInstallEl.disabled = true;
              updateBannerInstallEl.textContent = '校验中...';
              updateBannerSkipEl.style.display = 'none';
              updateBannerDismissEl.style.display = 'none';
            } else if (upd.status === 'ready') {
              updateBannerPillEl.textContent = '即将重启';
              updateBannerTextEl.textContent = 'T3Tools v' + upd.latestVersion + ' 已校验就绪，正在自动替换并重启...';
              updateBannerProgEl.style.display = 'block';
              updateBannerFillEl.style.width = '100%';
              updateBannerInstallEl.disabled = true;
              updateBannerInstallEl.textContent = '正在重启...';
              updateBannerSkipEl.style.display = 'none';
              updateBannerDismissEl.style.display = 'none';
            } else {
              updateBannerPillEl.textContent = 'v' + upd.latestVersion;
              const firstNote = String(upd.releaseNotes || '').split(/\\r?\\n/).map(s => s.trim()).find(Boolean) || '';
              updateBannerTextEl.textContent =
                '发现新版本 v' + upd.latestVersion +
                (sizeHint ? '（' + sizeHint + '）' : '') +
                (firstNote ? ' · ' + firstNote : '');
              updateBannerProgEl.style.display = 'none';
              updateBannerInstallEl.disabled = false;
              updateBannerInstallEl.textContent = upd.canAutoUpdate ? '立即更新' : '前往下载';
              updateBannerSkipEl.style.display = '';
              updateBannerDismissEl.style.display = '';
            }
          }
        }

        // 2. Settings Update Card
        if (settingsUpdHeadEl) {
          settingsUpdHeadEl.textContent = 'T3Tools v' + (upd.currentVersion || boot.version);
        }
        if (settingsUpdModeEl) {
          settingsUpdModeEl.textContent = modeLabel + (upd.hasBundledNode ? ' · 内置 Node' : '');
        }
        if (settingsUpdSubEl) {
          if (upd.status === 'checking') {
            settingsUpdSubEl.textContent = '正在检查 GitHub Releases 最新版本...';
          } else if (upd.status === 'downloading') {
            settingsUpdSubEl.textContent = '正在下载 v' + upd.latestVersion + '：' + pct + '%' + (sizeHint ? ' / ' + sizeHint : '');
          } else if (upd.status === 'verifying') {
            settingsUpdSubEl.textContent = '下载完成，正在校验 SHA-256 哈希...';
          } else if (upd.status === 'ready') {
            settingsUpdSubEl.textContent = '更新包已就绪，托盘程序正在接管替换并重启...';
          } else if (upd.status === 'error' && upd.lastError) {
            settingsUpdSubEl.textContent = '更新状态异常：' + upd.lastError;
          } else if (hasNew) {
            settingsUpdSubEl.textContent =
              '发现新版本 v' + upd.latestVersion +
              (sizeHint ? '（' + (upd.packageKind === 'full' ? '完整包 ' : '轻量更新 ') + sizeHint + '）' : '') +
              (upd.canAutoUpdate ? ' · 点击「立即更新」自动升级并重启' : ' · ' + (upd.cannotUpdateReason || '请前往 GitHub 下载'));
          } else if (upd.checkedAtMs) {
            const t = new Date(upd.checkedAtMs);
            const hh = String(t.getHours()).padStart(2, '0');
            const mm = String(t.getMinutes()).padStart(2, '0');
            settingsUpdSubEl.textContent = '已是最新版本（上次检查 ' + hh + ':' + mm + '）';
          } else {
            settingsUpdSubEl.textContent = upd.canAutoUpdate
              ? '已启用自动更新，点击「检查更新」可立即检测最新版本'
              : (upd.cannotUpdateReason || '点击「检查更新」检测 GitHub Releases 最新版本');
          }
        }
        if (settingsUpdProgEl) {
          settingsUpdProgEl.style.display = busy ? 'block' : 'none';
          if (busy) settingsUpdFillEl.style.width = (upd.status === 'verifying' ? 98 : upd.status === 'ready' ? 100 : pct) + '%';
        }
        if (settingsUpdNotesEl) {
          if (hasNew && upd.releaseNotes) {
            settingsUpdNotesEl.textContent = upd.releaseNotes;
            settingsUpdNotesEl.style.display = 'block';
          } else {
            settingsUpdNotesEl.style.display = 'none';
          }
        }
        if (settingsUpdInstallBtn) {
          settingsUpdInstallBtn.style.display = hasNew ? 'inline-flex' : 'none';
          settingsUpdInstallBtn.disabled = busy;
          settingsUpdInstallBtn.textContent = busy
            ? (upd.status === 'downloading' ? '下载中 ' + pct + '%' : '正在更新...')
            : (upd.canAutoUpdate ? '立即更新到 v' + upd.latestVersion : '前往下载');
        }
        if (settingsUpdCheckBtn) {
          settingsUpdCheckBtn.disabled = busy || upd.status === 'checking';
          settingsUpdCheckBtn.textContent = upd.status === 'checking' ? '检查中...' : '检查更新';
        }
        if (settingsUpdReleaseBtn) {
          settingsUpdReleaseBtn.style.display = hasNew ? 'inline-flex' : 'none';
        }
      }

      function syncNavBadges() {
        if (!dashData) return;
        const qSum = getQuotaGroupsSummary(dashData.quotas);
        if (badgeQuotasEl) {
          badgeQuotasEl.textContent = String(qSum.totalAccounts || 0);
          badgeQuotasEl.setAttribute(
            'data-tone',
            qSum.criticalAccounts > 0 ? 'danger' : qSum.warningAccounts > 0 ? 'warning' : qSum.readyAccounts > 0 ? 'success' : 'muted'
          );
        }
        const anomTotal = dashData.anomalySummary?.total || 0;
        if (badgeAnomEl) {
          badgeAnomEl.textContent = anomTotal > 0 ? String(anomTotal) : '';
          badgeAnomEl.setAttribute('data-tone', anomTotal > 0 ? 'danger' : 'muted');
          badgeAnomEl.style.display = anomTotal > 0 ? '' : 'none';
          badgeAnomEl.hidden = anomTotal <= 0;
        }
      }

      function renderActiveView({ partialRequestsOnly = false } = {}) {
        if (!dashData) return;
        syncDataHead({ animate: false });
        syncNavBadges();

        if (activeView === 'overview') {
          viewOverviewEl.innerHTML = renderOverviewCoreHtml(dashData, state);
          bindOverview(viewOverviewEl, dashData, state, {
            render: renderActiveView,
            applyAccount: applyAccountChoice,
            openView: (view, { fetch: shouldFetch = false } = {}) => {
              switchView(view);
              if (shouldFetch) fetchDash();
            }
          });
        } else if (activeView === 'quotas') {
          viewQuotasEl.innerHTML = renderQuotasTabHtml(dashData, state);
        } else if (activeView === 'models') {
          viewModelsEl.innerHTML = renderModelsAnalysisHtml(dashData,state);
          if (focusErrorsOnRender) {
            focusErrorsOnRender = false;
            viewModelsEl.querySelector('[data-error-center]')?.scrollIntoView({behavior:'smooth'});
          }
        } else if (activeView === 'requests') {
          if (!(partialRequestsOnly && refreshLedgerResults(viewRequestsEl,dashData,state))) {
            viewRequestsEl.innerHTML = renderRequestsViewHtml(dashData,state);
          }
          bindLedger(viewRequestsEl,dashData,state,fetchDash,renderActiveView,async ()=>{
            const sp = new URLSearchParams();
            const skip = new Set(['tab', 'heatmapMetric', 'quotaDriver', 'quotaSort', 'quotaView', 'hideEmail', 'detailId', 'ledgerScroll', 'ledgerFocus', 'speedSort', 'speedDir', 'modelSort', 'modelSortDir', '_chartW']);
            for (const [k, v] of Object.entries(state)) {
              if (!skip.has(k) && v !== '' && v !== null && v !== undefined) sp.set(k, String(v));
            }
            const res=await fetch(apiBase+'/api/requests.csv?'+sp.toString());
            if(!res.ok)throw new Error('CSV HTTP '+res.status);
            ledgerDownload(await res.blob(),'t3tools-requests.csv');
          },showToast);
        }
      }

      function saveSetting(key, patch) {
        const seq = ++settingsSeq;
        pendingSettings.set(key, seq);
        const write = saveQueue.then(async () => {
          try {
            const res = await postApi('/api/settings', patch);
            if (!res?.ok) throw new Error(res?.error || '保存失败');
            statusData = { ...statusData, settings: res.data };
            postHostMessage({ action: 'settingsChanged', settings: res.data });
            return true;
          } catch (error) {
            showToast(error.message || '保存失败');
            return false;
          } finally {
            if (pendingSettings.get(key) === seq) pendingSettings.delete(key);
            settingsSeq++;
            renderShellStatus();
          }
        });
        saveQueue = write.catch(() => {});
        return write;
      }

      async function fetchStatus() {
        const seq = ++statusSeq;
        const settingsAtStart = settingsSeq;
        try {
          const r = await fetch(apiBase + '/api/status');
          const j = await r.json();
          if (j.ok && seq === statusSeq) {
            if (statusData?.settings && (settingsAtStart !== settingsSeq || pendingSettings.size)) {
              j.data.settings = statusData.settings;
            }
            const changed = statusData && (
              statusData.alerts?.unreadCount !== j.data.alerts?.unreadCount ||
              statusData.alerts?.unreadIncidents !== j.data.alerts?.unreadIncidents
            );
            statusData = j.data;
            renderShellStatus();
            if (changed && activeView === 'models') fetchDash();
          }
        } catch {}
      }

      async function fetchDash({ force = false, partialRequestsOnly = false } = {}) {
        const seq = ++dashReqSeq;
        try {
          if (force) await postApi('/api/sync', {});
          const sp = new URLSearchParams();
          const skip = new Set(['tab', 'heatmapMetric', 'quotaDriver', 'quotaSort', 'quotaView', 'hideEmail', 'detailId', 'ledgerScroll', 'ledgerFocus', 'speedSort', 'speedDir', 'modelSort', 'modelSortDir', '_chartW']);
          for (const [k, v] of Object.entries(state)) {
            if (!skip.has(k) && v !== '' && v !== null && v !== undefined) sp.set(k, String(v));
          }
          const r = await fetch(apiBase + '/api/dashboard?' + sp.toString());
          const j = await r.json();
          if (seq !== dashReqSeq) return;
          if (j.ok) {
            dashData = j.data;
            resolveLedgerStep(dashData,state);
            renderActiveView({ partialRequestsOnly });
          }
        } catch (err) { if (force && seq === dashReqSeq) showToast(err.message); }
      }

      if (hasWebViewBridge && typeof window.chrome.webview.addEventListener === 'function') {
        window.chrome.webview.addEventListener('message', ev => {
          let msg = ev.data;
          if (typeof msg === 'string') {
            try { msg = JSON.parse(msg); } catch { return; }
          }
          if (!msg || typeof msg !== 'object') return;
          if (msg.type === 'hostState') {
            hostState = { ...hostState, ...msg };
            renderShellStatus();
          } else if (msg.type === 'toast' && msg.message) {
            showToast(msg.message);
          } else if (msg.type === 'navigate' && msg.view && VIEW_TITLES[msg.view]) {
            switchView(msg.view);
            if (msg.focusErrors) {
              focusErrorsOnRender = true;
              Object.assign(state,{preset:'all',account:'all',day:'',errorCode:'all',errorModel:'',errorSession:''});
              fetchDash();
            }
          } else if (msg.type === 'refresh') {
            fetchStatus();
            fetchDash();
          }
        });
        postHostMessage({ action: 'getHostState' });
      }

      document.body.addEventListener('click', async e => {
        const target = e.target;
        const open = async (view, opts = {}) => {
          switchView(view); await fetchDash();
          if (view === 'models' && opts.scroll !== false) viewModelsEl.querySelector('[data-error-center]')?.scrollIntoView({behavior:'smooth'});
        };
        try {
          if (await handleErrorClick(e,state,{open,current:()=>activeView,toast:showToast,close:()=>{},rpc:async (action,params)=>{
            const pathMap = {
              ackErrors: '/api/errors/ack',
              resolveErrors: '/api/errors/resolve',
              focusThread: '/api/t3/focus-thread'
            };
            const res = await postApi(pathMap[action] || '/api/t3/focus-thread',params);
            if (!res.ok) throw new Error(res.error);
            if (['ackErrors','resolveErrors'].includes(action)) {
              if (res.data && typeof res.data.unreadCount === 'number') {
                statusData = {
                  ...(statusData || {}),
                  alerts: {
                    ...(statusData?.alerts || {}),
                    unreadCount: res.data.unreadCount,
                    unreadRecoveredCount: res.data.unreadRecoveredCount ?? 0,
                    unreadIncidents: res.data.unreadIncidents ?? (res.data.unreadCount + (res.data.unreadRecoveredCount ?? 0)),
                    activeBrokenThreads: res.data.activeBrokenThreads ?? 0
                  }
                };
                renderShellStatus();
              }
              await fetchStatus();
            }
            return res.data;
          }})) return;
        } catch (err) { showToast(err.message); return; }
        const navBtn = target.closest?.('[data-view]');
        if (navBtn) {
          switchView(navBtn.getAttribute('data-view'));
          return;
        }

        const periodBtn = target.closest?.('[data-pt-period]');
        if (periodBtn) {
          applyPeriodChoice(periodBtn.getAttribute('data-pt-period'));
          return;
        }
        const rangeBtn = target.closest?.('[data-pt-range-trigger]');
        if (rangeBtn) {
          openPtRangeMenu(rangeBtn, state.preset, applyPeriodChoice);
          return;
        }
        const accBtn = target.closest?.('[data-pt-account-trigger]');
        if (accBtn) {
          openPtAccountMenu(accBtn, dashData?.facets?.accounts || [], state.account, applyAccountChoice);
          return;
        }
        const themeBtn = target.closest?.('[data-pt-theme]');
        if (themeBtn) {
          const next = themeBtn.getAttribute('data-pt-theme') === 'light' ? 'light' : 'dark';
          lastThemeMutationAt = Date.now();
          applyTheme(next, { notifyHost: true, animate: true });
          if (!await saveSetting('theme', { theme: next }) && !pendingSettings.has('theme')) {
            applyTheme(statusData?.settings?.theme || boot.theme, { notifyHost: true });
          }
          return;
        }

        const act = target.closest?.('[data-pt-action]')?.getAttribute('data-pt-action');
        if (act === 'toggle-sidebar') {
          sideCollapsed = !sideCollapsed;
          shellEl.setAttribute('data-side-collapsed', sideCollapsed ? 'true' : 'false');
          try { localStorage.setItem('t3tools.sideCollapsed', sideCollapsed ? '1' : '0'); } catch {}
          setTimeout(() => {
            positionSegsThumb(viewDataHeadEl, { animate: false });
            positionSegsThumb(settingsThemeSegsEl, { animate: false });
          }, 200);
          return;
        }
        if (act === 'test-alert') { const res = await postApi('/api/alerts/test',{}); showToast(res.ok ? '已发送测试告警' : res.error); return; }
        if (act === 'check-app-update') {
          showToast('正在检查新版本...');
          const res = await postApi('/api/app-update/check', {}).catch(() => null);
          if (res?.ok && res.data) {
            statusData = { ...(statusData || {}), appUpdate: res.data };
            dismissedBannerVersion = '';
            renderShellStatus();
            if (res.data.lastError) showToast(res.data.lastError);
            else if (res.data.hasUpdate) showToast('发现新版本 v' + res.data.latestVersion);
            else showToast('当前已是最新版本');
          } else {
            showToast(res?.error || '检查更新失败');
          }
          return;
        }
        if (act === 'install-app-update') {
          const upd = statusData?.appUpdate;
          if (upd && !upd.canAutoUpdate) {
            openReleaseUrl(upd.releaseUrl);
            return;
          }
          showToast('正在下载并校验更新...');
          const res = await postApi('/api/app-update/install', {}).catch(() => null);
          const payload = res?.data;
          if (payload?.status) {
            statusData = { ...(statusData || {}), appUpdate: payload.status };
            renderShellStatus();
          }
          if (!res?.ok || payload?.ok === false) {
            showToast(payload?.error || res?.error || '启动更新失败');
          }
          return;
        }
        if (act === 'skip-app-update') {
          const ver = statusData?.appUpdate?.latestVersion || '';
          const res = await postApi('/api/app-update/skip', { version: ver }).catch(() => null);
          if (res?.ok && res.data) {
            statusData = { ...(statusData || {}), appUpdate: res.data };
            renderShellStatus();
            showToast('已跳过版本 v' + ver);
          }
          return;
        }
        if (act === 'dismiss-app-update') {
          dismissedBannerVersion = statusData?.appUpdate?.latestVersion || '';
          renderShellStatus();
          return;
        }
        if (act === 'open-release-url') {
          openReleaseUrl(statusData?.appUpdate?.releaseUrl);
          return;
        }
        if (act === 'open-errors') {
          Object.assign(state,{errorSession:'',preset:'all',errorModel:'',errorCode:'all',day:'',account:'all'});
          await open('models'); return;
        }
        if (act === 'goto-settings') { switchView('settings'); return; }
        if (act === 'hide-to-tray') { postHostMessage({ action: 'hideToTray' }); return; }
        if (act === 'open-external') { postHostMessage({ action: 'openExternal' }); return; }
        if (act === 'exit-app') { postHostMessage({ action: 'exitApp' }); return; }
        if (act === 'reattach-cdp') {
          showToast('正在重新探测并吸附...');
          await postApi('/api/cdp/reattach', {}).catch(() => {});
          await fetchStatus();
          showToast('已完成重新探测');
          return;
        }
        if (act === 'patch-debug') {
          const res = await postApi('/api/launcher/patch-debug', {}).catch(() => null);
          showToast(res?.ok ? '快捷方式调试参数已就绪' : (res?.error || '快捷方式配置失败'));
          return;
        }
        if (act === 't3-primary') {
          const mode = t3PrimaryBtn?.dataset?.mode;
          if (mode === 'enable-attach') {
            await postApi('/api/cdp/toggle', { enabled: true }).catch(() => {});
            await fetchStatus();
            showToast('已开启自动吸附');
          } else if (mode === 'relaunch') {
            if (hasWebViewBridge) {
              postHostMessage({ action: 'confirmRelaunchT3' });
            } else if (confirm('将优雅重启 T3 Code 并自动吸附，是否继续？')) {
              showToast('正在重启 T3 Code 并吸附...');
              await postApi('/api/t3/relaunch', {}).catch(() => {});
              setTimeout(fetchStatus, 2500);
            }
          } else if (mode === 'launch') {
            showToast('正在以吸附模式启动 T3 Code...');
            await postApi('/api/t3/launch', {}).catch(() => {});
            setTimeout(fetchStatus, 2500);
          }
          return;
        }
        if (act === 'open-quotas') { switchView('quotas'); return; }
        if (act === 'open-dashboard') { switchView('overview'); return; }
        if (act === 'toggle-hide-email') { state.hideEmail = !state.hideEmail; renderActiveView(); return; }
        if (act === 'refresh') {
          setRefreshBusy(true);
          showToast('正在刷新数据...');
          try {
            await Promise.all([fetchStatus(), fetchDash({ force: true })]);
            showToast('数据已更新');
          } finally {
            setRefreshBusy(false);
          }
          return;
        }
        if (act === 'toggle-theme') {
          const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
          const next = isDark ? 'light' : 'dark';
          lastThemeMutationAt = Date.now();
          applyTheme(next, { notifyHost: true, animate: true });
          if (!await saveSetting('theme', { theme: next }) && !pendingSettings.has('theme')) {
            applyTheme(statusData?.settings?.theme || boot.theme, { notifyHost: true });
          }
          return;
        }

        const qDriver = target.closest?.('[data-pt-quota-driver]')?.getAttribute('data-pt-quota-driver');
        if (qDriver) { state.quotaDriver = qDriver; renderActiveView(); return; }
        const qView = target.closest?.('[data-pt-quota-view]')?.getAttribute('data-pt-quota-view');
        if (qView) { state.quotaView = qView; renderActiveView(); return; }
        const inspectAcc = target.closest?.('[data-pt-inspect-account]')?.getAttribute('data-pt-inspect-account');
        if (inspectAcc) {
          state.account = inspectAcc;
          state.page = 1;
          switchView('overview');
          fetchDash();
          return;
        }
        const modelSort = target.closest?.('[data-pt-model-sort]')?.getAttribute('data-pt-model-sort');
        if (modelSort) {
          const prev = state.modelSort || 'totalTokens';
          state.modelSortDir = prev === modelSort ? -(state.modelSortDir || -1) : (modelSort === 'modelId' ? 1 : -1);
          state.modelSort = modelSort;
          renderActiveView();
          return;
        }
        const modelReq = target.closest?.('[data-pt-model-requests]')?.getAttribute('data-pt-model-requests');
        if (modelReq) {
          Object.assign(state, {
            model: modelReq,
            driver: 'all',
            sourceGroup: 'all',
            errorCode: 'all',
            status: 'all',
            onlyAnomalies: false,
            day: '',
            session: '',
            detailId: '',
            requestId: '',
            page: 1
          });
          switchView('requests');
          fetchDash();
          return;
        }
        const tab = target.closest?.('[data-pt-tab]')?.getAttribute('data-pt-tab');
        if (tab) { switchView(tab); return; }
        const hm = target.closest?.('[data-pt-heatmap]')?.getAttribute('data-pt-heatmap');
        if (hm) {
          state.heatmapMetric = normalizeHeatmapMetric(hm);
          try { localStorage.setItem('t3tools.heatmapMetric', state.heatmapMetric); } catch {}
          renderActiveView();
          return;
        }
        const pgEl = target.closest?.('[data-pt-page]');
        if (pgEl && !pgEl.disabled) {
          state.page = Number(pgEl.getAttribute('data-pt-page')) || 1;
          fetchDash({ partialRequestsOnly: true });
        }
      });

      document.body.addEventListener('change', async e => {
        if (e.target.dataset.alertSetting) {
          const key = e.target.dataset.alertSetting;
          const value = e.target.type === 'number' ? e.target.valueAsNumber * (key.endsWith('Ms') ? 1000 : 1)
            : key === 'mode' ? e.target.value : e.target.checked;
          const saved = await saveSetting('alert.' + key, { alertConfig: { [key]: value } });
          if (saved) showToast('设置已保存');
          else if (e.target.type === 'number' && statusData?.settings?.alertConfig) {
            e.target.value = statusData.settings.alertConfig[key] / (key.endsWith('Ms') ? 1000 : 1);
          }
          return;
        }
        if (e.target.dataset.appUpdateSetting) {
          const key = e.target.dataset.appUpdateSetting;
          const value = Boolean(e.target.checked);
          if (await saveSetting('appUpdates.' + key, { appUpdates: { [key]: value } })) showToast('设置已保存');
          return;
        }
        const settingEl = e.target.closest?.('[data-pt-setting]');
        if (settingEl) {
          const key = settingEl.getAttribute('data-pt-setting');
          const val = settingEl.type === 'checkbox' ? Boolean(settingEl.checked) : settingEl.value;
          if (await saveSetting(key, { [key]: val })) showToast('设置已保存');
          return;
        }
        const hostSettingEl = e.target.closest?.('[data-pt-host-setting="launchOnStartup"]');
        if (hostSettingEl) {
          const val = Boolean(hostSettingEl.checked);
          if (!await saveSetting('launchOnStartup', { launchOnStartup: val })) return;
          hostSettingEl.checked = val;
          postHostMessage({ action: 'setAutoStart', enabled: val });
          showToast(val ? '已开启开机自动启动' : '已关闭开机自动启动');
          return;
        }
        const sortEl = e.target.closest?.('[data-pt-quota-sort]');
        if (sortEl) {
          state.quotaSort = sortEl.value || 'remaining';
          renderActiveView();
          return;
        }
        const el = e.target.closest?.('[data-pt-filter]');
        if (!el) return;
        const k = el.getAttribute('data-pt-filter');
    if (k === 'session') return;
        state[k] = (k === 'onlyAnomalies' || k === 'includeRetried' || k === 'errorOnlyToday') ? Boolean(el.checked) : el.value;
        state.page = 1;
        const partial = activeView === 'requests' && (k === 'model' || k === 'status' || k === 'errorCode' || k === 'onlyAnomalies');
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
        searchTimer = setTimeout(() => fetchDash({ partialRequestsOnly: true }), 250);
      });

      document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          if (closePtPopMenu()) { e.preventDefault(); return; }
          if (activeView === 'requests' && state.detailId) {
            const back = viewRequestsEl.querySelector('[data-pt-led-back]');
            if (back) { e.preventDefault(); back.click(); }
          }
        }
      });

      window.addEventListener('resize', () => {
        positionSegsThumb(viewDataHeadEl, { animate: false });
        positionSegsThumb(settingsThemeSegsEl, { animate: false });
      });

      // Boot
      switchView(activeView, { resetScroll: false });
      fetchStatus();
      fetchDash({ force: true });
      setInterval(() => {
        if (!document.hidden) {
          fetchStatus();
        }
      }, 3000);
    })();
  </script>
</body>
</html>`;
}
