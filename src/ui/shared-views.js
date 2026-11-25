/**
 * Shared pure-DOM/SVG views & styles used by BOTH:
 * 1. The Shadow DOM injected client inside Windows T3 Code
 * 2. The standalone Web Fallback dashboard (http://127.0.0.1:17373)
 */

function esc(val) {
  return String(val ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fmtTokens(n) {
  if (n == null || !Number.isFinite(Number(n))) return '-';
  const v = Number(n);
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e5 ? 0 : 1) + 'k';
  return String(Math.round(v));
}

function fmtUsd(n) {
  if (n == null || !Number.isFinite(Number(n))) return '-';
  const v = Number(n);
  if (v === 0) return '$0.00';
  if (v < 0.01) return '$' + v.toFixed(4);
  return '$' + v.toFixed(2);
}

function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(Number(ms)) || ms < 0) return '-';
  const v = Number(ms);
  if (v < 1000) return `${Math.round(v)}ms`;
  const s = v / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const remS = Math.round(s % 60);
  return `${m}m${String(remS).padStart(2, '0')}s`;
}

function fmtCountdown(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '-';
  if (ms <= 0) return '即将重置';
  const totalMins = Math.floor(ms / 60000);
  const days = Math.floor(totalMins / 1440);
  const hours = Math.floor((totalMins % 1440) / 60);
  const mins = totalMins % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${Math.max(1, mins)}m`;
}

function fmtAge(ms) {
  if (ms == null || !Number.isFinite(Number(ms)) || ms < 0) return '';
  if (ms < 60000) return '刚刚';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h前`;
  return `${Math.floor(hrs / 24)}d前`;
}

function fmtTime(ms) {
  if (!Number.isFinite(Number(ms)) || ms <= 0) return '-';
  const d = new Date(Number(ms));
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function fmtTimeShort(ms) {
  if (!Number.isFinite(Number(ms)) || ms <= 0) return '-';
  const d = new Date(Number(ms));
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

function fmtDateShort(ms) {
  if (!Number.isFinite(Number(ms)) || ms <= 0) return '-';
  const d = new Date(Number(ms));
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}-${dd}`;
}

function maskEmail(email) {
  const s = String(email || '').trim();
  const at = s.indexOf('@');
  if (at <= 0) return s;
  const local = s.slice(0, at);
  const domain = s.slice(at);
  if (local.length <= 2) return `${local[0] || '*'}***${domain}`;
  return `${local.slice(0, 2)}***${local.slice(-2)}${domain}`;
}

function driverMeta(driver = '', accentColor = '') {
  const d = String(driver || '').toLowerCase();
  if (d === 'antigravity') return { abbr: 'AG', label: 'Antigravity', color: accentColor || '#8b5cf6' };
  if (d === 'codex') return { abbr: 'CX', label: 'Codex', color: accentColor || '#10b981' };
  if (d === 'claudeagent' || d === 'claude') return { abbr: 'CL', label: 'Claude', color: accentColor || '#f59e0b' };
  if (d === 'cursor') return { abbr: 'CU', label: 'Cursor', color: accentColor || '#06b6d4' };
  if (d === 'grok') return { abbr: 'GK', label: 'Grok', color: accentColor || '#ec4899' };
  if (d === 'kiro') return { abbr: 'KR', label: 'Kiro', color: accentColor || '#6366f1' };
  if (d === 'opencode') return { abbr: 'OC', label: 'OpenCode', color: accentColor || '#14b8a6' };
  const abbr = (String(driver || 'AI').replace(/[^a-z0-9]/gi, '').slice(0, 2) || 'AI').toUpperCase();
  return { abbr, label: driver || 'Provider', color: accentColor || '#6366f1' };
}

function quotaToneColor(tone) {
  if (tone === 'danger') return 'var(--pt-danger, #ef4444)';
  if (tone === 'warning') return 'var(--pt-warning, #f59e0b)';
  if (tone === 'success') return 'var(--pt-success, #22c55e)';
  return 'var(--pt-muted, #9ca3af)';
}

function renderQuotaRingSvg(remainingPct, tone) {
  const size = 38;
  const stroke = 3.5;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const val = remainingPct == null ? 0 : Math.min(100, Math.max(0, Number(remainingPct)));
  const dashOffset = circ * (1 - val / 100);
  const color = quotaToneColor(tone);
  const label = remainingPct == null ? '-' : `${Math.round(val)}%`;
  return `
    <div class="pt-quota-ring" title="${remainingPct != null ? `最低池剩余 ${remainingPct}%` : '暂无可用额度'}">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="color-mix(in srgb, var(--pt-fg, #fff) 12%, transparent)" stroke-width="${stroke}" />
        <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
          stroke-linecap="round" stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${dashOffset.toFixed(1)}"
          transform="rotate(-90 ${size / 2} ${size / 2})" />
      </svg>
      <span class="pt-quota-ring-val pt-mono" style="color:${color};">${label}</span>
    </div>
  `;
}

function fmtPct(v) {
  return v == null || !Number.isFinite(Number(v)) ? '-' : `${Number(v).toFixed(1)}%`;
}

function quotaTone(remainingPct) {
  if (remainingPct == null) return 'muted';
  if (remainingPct <= 15) return 'danger';
  if (remainingPct <= 40) return 'warning';
  return 'success';
}

function contextTone(usedPct) {
  if (usedPct == null) return 'accent';
  if (usedPct >= 85) return 'danger';
  if (usedPct >= 65) return 'warning';
  return 'accent';
}

const ERROR_CODE_LABELS = {
  'rate-limit': '429 限流',
  unavailable: '503 繁忙',
  timeout: '请求超时',
  eof: '连接中断 (EOF)',
  connection: '网络异常',
  region: '权限/地区受限',
  other: '其他错误'
};

const CHART_COLORS = [
  'var(--pt-chart-1, #6366f1)',
  'var(--pt-chart-2, #22c55e)',
  'var(--pt-chart-3, #f59e0b)',
  'var(--pt-chart-4, #06b6d4)',
  'var(--pt-chart-5, #ec4899)',
  'var(--pt-chart-6, #a855f7)'
];

const PT_SHARED_CSS = `
:host, .pt-root {
  font-family: var(--pt-font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
  color: var(--pt-fg, #f3f4f6);
  font-size: 12px;
  line-height: 1.45;
  box-sizing: border-box;
}
*, *::before, *::after { box-sizing: border-box; }
.pt-mono { font-family: var(--pt-font-mono, ui-monospace, Consolas, monospace); font-variant-numeric: tabular-nums; }
.pt-muted { color: var(--pt-muted, #9ca3af); }

.pt-usage-bar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 2px;
  box-sizing: border-box;
  padding: 2px 4px;
  border-radius: calc(var(--pt-radius, 10px) - 2px);
  background: color-mix(in srgb, var(--pt-surface, #1b1e25) 72%, transparent);
  border: 1px solid color-mix(in srgb, var(--pt-border, rgba(255,255,255,0.1)) 78%, transparent);
  font-family: var(--pt-font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
  font-size: 11.5px;
  line-height: 1;
  color: var(--pt-fg, #f3f4f6);
  user-select: none;
  cursor: default;
  overflow: visible;
}
.pt-usage-bar:not(.pt-usage-inline) {
  display: flex;
  width: fit-content;
  max-width: 100%;
  margin: 6px auto 2px;
}
.pt-usage-bar.pt-usage-inline {
  justify-content: flex-start;
  flex-wrap: nowrap;
  height: 26px;
  margin: 0;
  padding: 0 3px;
}
.pt-usage-bar[data-hidden="true"] {
  display: none;
}
.pt-usage-sep {
  width: 1px;
  height: 11px;
  flex: none;
  margin: 0 1px;
  background: color-mix(in srgb, var(--pt-fg, #fff) 11%, transparent);
}
.pt-usage-item {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 6px;
  border-radius: 5px;
  white-space: nowrap;
  color: color-mix(in srgb, var(--pt-fg, #f3f4f6) 86%, transparent);
  transition: background-color 0.14s ease, color 0.14s ease, opacity 0.2s ease;
}
.pt-usage-item:hover {
  background: color-mix(in srgb, var(--pt-fg, #fff) 7%, transparent);
  color: var(--pt-fg, #f3f4f6);
}
.pt-usage-icon {
  flex: 0 0 auto;
  color: var(--pt-muted, #9ca3af);
  transition: color 0.14s ease;
}
.pt-usage-item:hover .pt-usage-icon {
  color: var(--pt-fg, #f3f4f6);
}
.pt-usage-item[data-live="true"] .pt-usage-icon {
  color: var(--pt-accent, #6366f1);
  animation: ptPulse 1.4s infinite ease-in-out;
}
.pt-usage-label {
  font-size: 11px;
  font-weight: 400;
  color: var(--pt-muted, #9ca3af);
}
.pt-usage-value {
  font-family: var(--pt-font-mono, ui-monospace, Consolas, monospace);
  font-variant-numeric: tabular-nums;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.pt-usage-unit {
  font-family: var(--pt-font-mono, ui-monospace, Consolas, monospace);
  font-size: 10.5px;
  font-weight: 500;
  color: var(--pt-muted, #9ca3af);
  margin-left: 1px;
}
.pt-usage-bar[data-stale="true"] .pt-usage-item[data-usage="speed"] {
  opacity: 0.5;
}
.pt-usage-tip {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 9px);
  transform: translateX(-50%) translateY(4px);
  z-index: 9995;
  pointer-events: none;
  opacity: 0;
  visibility: hidden;
  min-width: 152px;
  padding: 7px 10px;
  border-radius: calc(var(--pt-radius, 10px) - 2px);
  background: var(--pt-card, #14161b);
  color: var(--pt-fg, #f3f4f6);
  border: 1px solid var(--pt-border, rgba(255,255,255,0.12));
  box-shadow: var(--pt-shadow, 0 10px 28px rgba(0,0,0,0.35));
  backdrop-filter: blur(12px);
  text-align: left;
  white-space: nowrap;
  transition: opacity 0.14s ease, transform 0.16s cubic-bezier(0.2, 0.8, 0.2, 1), visibility 0.14s;
}
.pt-usage-tip::after {
  content: "";
  position: absolute;
  left: 50%;
  bottom: -4px;
  width: 7px;
  height: 7px;
  background: var(--pt-card, #14161b);
  border-right: 1px solid var(--pt-border, rgba(255,255,255,0.12));
  border-bottom: 1px solid var(--pt-border, rgba(255,255,255,0.12));
  transform: translateX(-50%) rotate(45deg);
}
.pt-usage-item[data-usage="speed"] .pt-usage-tip {
  left: 0;
  transform: translateY(4px);
}
.pt-usage-item[data-usage="speed"] .pt-usage-tip::after {
  left: 22px;
  transform: rotate(45deg);
}
.pt-usage-item:hover .pt-usage-tip {
  opacity: 1;
  visibility: visible;
  transform: translateX(-50%) translateY(0);
}
.pt-usage-item[data-usage="speed"]:hover .pt-usage-tip {
  transform: translateY(0);
}
.pt-usage-tip-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  line-height: 1.25;
}
.pt-usage-tip-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--pt-fg, #f3f4f6);
}
.pt-usage-tip-tag {
  font-family: var(--pt-font-mono, ui-monospace, Consolas, monospace);
  font-variant-numeric: tabular-nums;
  font-size: 10px;
  font-weight: 500;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--pt-surface, #1b1e25);
  color: var(--pt-muted, #9ca3af);
}
.pt-usage-tip-desc {
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--pt-muted, #9ca3af);
  margin-top: 3px;
}
.pt-composer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 10px;
  margin-bottom: 6px;
  border-radius: calc(var(--pt-radius, 10px) - 2px);
  background: var(--pt-card, #14161b);
  border: 1px solid var(--pt-border, rgba(255,255,255,0.1));
  color: var(--pt-fg, #f3f4f6);
  font-size: 11.5px;
  flex-wrap: wrap;
}
.pt-composer-metrics {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.pt-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--pt-surface, #1b1e25);
  border: 1px solid var(--pt-border, rgba(255,255,255,0.08));
  white-space: nowrap;
}
.pt-bar-mini {
  width: 44px;
  height: 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--pt-fg, #fff) 14%, transparent);
  overflow: hidden;
  display: inline-block;
}
.pt-bar-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  transition: width 0.25s ease;
}
.pt-tone-accent { background: var(--pt-accent, #6366f1); }
.pt-tone-success { background: var(--pt-success, #22c55e); }
.pt-tone-warning { background: var(--pt-warning, #f59e0b); }
.pt-tone-danger { background: var(--pt-danger, #ef4444); }
.pt-tone-muted { background: var(--pt-muted, #9ca3af); }
.pt-text-success { color: var(--pt-success, #22c55e); }
.pt-text-warning { color: var(--pt-warning, #f59e0b); }
.pt-text-danger { color: var(--pt-danger, #ef4444); }
.pt-text-accent { color: var(--pt-accent, #6366f1); }

.pt-btn {
  appearance: none;
  border: 1px solid var(--pt-border, rgba(255,255,255,0.12));
  background: var(--pt-surface, #1b1e25);
  color: var(--pt-fg, #f3f4f6);
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 11px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: opacity 0.15s ease, border-color 0.15s ease;
}
.pt-btn:hover:not(:disabled) { border-color: var(--pt-accent, #6366f1); }
.pt-btn:disabled { opacity: 0.45; cursor: default; }

.pt-overview-card {
  width: 304px;
  max-width: calc(100vw - 32px);
  border-radius: var(--pt-radius, 10px);
  background: var(--pt-card, #14161b);
  border: 1px solid var(--pt-border, rgba(255,255,255,0.12));
  box-shadow: var(--pt-shadow, 0 10px 30px rgba(0,0,0,0.45));
  overflow: hidden;
  backdrop-filter: blur(10px);
}
.pt-overview-card.collapsed { width: auto; min-width: 196px; }
.pt-overview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  user-select: none;
  background: var(--pt-surface, #1b1e25);
  border-bottom: 1px solid transparent;
}
.pt-overview-card:not(.collapsed) .pt-overview-header {
  border-bottom-color: var(--pt-border, rgba(255,255,255,0.08));
}
.pt-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  display: inline-block;
  flex: none;
}
.pt-dot-pulse { animation: ptPulse 1.4s infinite ease-in-out; }
@keyframes ptPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(0.82); }
}
.pt-overview-body {
  padding: 7px 9px;
  max-height: 420px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.pt-section-title {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--pt-muted, #9ca3af);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-bottom: 3px;
}
.pt-step-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 150px;
  overflow-y: auto;
}
.pt-step-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 3px 6px;
  border-radius: 6px;
  background: var(--pt-surface, #1b1e25);
  font-size: 11px;
}
.pt-step-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pt-ov-quota-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px;
}
.pt-ov-quota-grid.single {
  grid-template-columns: 1fr;
}
.pt-ov-pool {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 5px 7px;
  border-radius: 7px;
  background: var(--pt-surface, #1b1e25);
  border: 1px solid color-mix(in srgb, var(--pt-border, rgba(255,255,255,0.08)) 85%, transparent);
  min-width: 0;
}
.pt-ov-pool.active {
  border-color: color-mix(in srgb, var(--pt-accent, #6366f1) 52%, var(--pt-border, rgba(255,255,255,0.1)));
  background: color-mix(in srgb, var(--pt-accent, #6366f1) 6%, var(--pt-surface, #1b1e25));
}
.pt-ov-pool-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  line-height: 1.25;
}
.pt-ov-pool-name {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--pt-fg, #f3f4f6);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.pt-ov-pool-reset {
  font-size: 9.5px;
  color: var(--pt-muted, #9ca3af);
  white-space: nowrap;
  flex: none;
}
.pt-ov-win-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.pt-ov-win-list.cols-2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}
.pt-ov-win {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 15px;
  font-size: 10px;
}
.pt-ov-win-k {
  flex: none;
  width: 15px;
  color: var(--pt-muted, #9ca3af);
  font-size: 9.5px;
  line-height: 1;
}
.pt-ov-bar {
  flex: 1;
  min-width: 24px;
  height: 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--pt-fg, #fff) 13%, transparent);
  overflow: hidden;
}
.pt-ov-win-v {
  flex: none;
  min-width: 31px;
  text-align: right;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
}
.pt-ov-empty {
  padding: 5px 7px;
  border-radius: 6px;
  background: var(--pt-surface, #1b1e25);
  font-size: 10.5px;
  color: var(--pt-muted, #9ca3af);
}

.pt-overlay-backdrop {
  position: fixed;
  inset: 0;
  z-index: 99998;
  background: rgba(0, 0, 0, 0.56);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.pt-dashboard {
  width: min(1160px, 100%);
  max-height: 92vh;
  background: var(--pt-bg, #0b0c0f);
  color: var(--pt-fg, #f3f4f6);
  border: 1px solid var(--pt-border, rgba(255,255,255,0.12));
  border-radius: calc(var(--pt-radius, 10px) + 2px);
  box-shadow: var(--pt-shadow, 0 18px 50px rgba(0,0,0,0.55));
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.pt-dashboard.standalone {
  width: min(1240px, 100%);
  max-height: none;
  min-height: calc(100vh - 32px);
  margin: 16px auto;
}
.pt-dash-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  background: var(--pt-card, #14161b);
  border-bottom: 1px solid var(--pt-border, rgba(255,255,255,0.1));
  flex-wrap: wrap;
}
.pt-dash-tabs {
  display: inline-flex;
  background: var(--pt-surface, #1b1e25);
  border: 1px solid var(--pt-border, rgba(255,255,255,0.08));
  border-radius: 8px;
  padding: 2px;
  gap: 2px;
}
.pt-tab {
  border: none;
  background: transparent;
  color: var(--pt-muted, #9ca3af);
  padding: 5px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
}
.pt-tab.active {
  background: var(--pt-accent, #6366f1);
  color: var(--pt-accent-fg, #fff);
}
.pt-dash-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.pt-select, .pt-input {
  background: var(--pt-surface, #1b1e25);
  color: var(--pt-fg, #f3f4f6);
  border: 1px solid var(--pt-border, rgba(255,255,255,0.12));
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 12px;
  outline: none;
}
.pt-select:focus, .pt-input:focus { border-color: var(--pt-accent, #6366f1); }
.pt-dash-body {
  padding: 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.pt-kpi-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
@media (max-width: 820px) {
  .pt-kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
.pt-card {
  background: var(--pt-card, #14161b);
  border: 1px solid var(--pt-border, rgba(255,255,255,0.1));
  border-radius: var(--pt-radius, 10px);
  padding: 12px 14px;
}
.pt-kpi-label { font-size: 11px; color: var(--pt-muted, #9ca3af); margin-bottom: 4px; }
.pt-kpi-val { font-size: 20px; font-weight: 700; letter-spacing: -0.02em; }
.pt-kpi-sub { font-size: 11px; color: var(--pt-muted, #9ca3af); margin-top: 4px; }

.pt-two-col {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
@media (max-width: 900px) {
  .pt-two-col { grid-template-columns: 1fr; }
}
.pt-stacked-bar {
  display: flex;
  height: 12px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--pt-surface, #1b1e25);
  margin: 8px 0;
}
.pt-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  font-size: 11px;
}
.pt-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.pt-swatch {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  display: inline-block;
}

.pt-table-wrap {
  width: 100%;
  overflow-x: auto;
}
.pt-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11.5px;
}
.pt-table th {
  text-align: left;
  padding: 7px 8px;
  font-weight: 600;
  color: var(--pt-muted, #9ca3af);
  border-bottom: 1px solid var(--pt-border, rgba(255,255,255,0.1));
  white-space: nowrap;
}
.pt-table td {
  padding: 7px 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--pt-border, rgba(255,255,255,0.08)) 65%, transparent);
  vertical-align: middle;
}
.pt-table tr.pt-row-anomaly {
  background: color-mix(in srgb, var(--pt-danger, #ef4444) 11%, transparent);
}
.pt-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
}
.pt-badge-ok { background: color-mix(in srgb, var(--pt-success, #22c55e) 18%, transparent); color: var(--pt-success, #22c55e); }
.pt-badge-warn { background: color-mix(in srgb, var(--pt-warning, #f59e0b) 20%, transparent); color: var(--pt-warning, #f59e0b); }
.pt-badge-err { background: color-mix(in srgb, var(--pt-danger, #ef4444) 20%, transparent); color: var(--pt-danger, #ef4444); }
.pt-badge-muted { background: var(--pt-surface, #1b1e25); color: var(--pt-muted, #9ca3af); }

.pt-heatmap-wrap {
  overflow-x: auto;
  padding-bottom: 4px;
}
.pt-filter-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.pt-cycle-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--pt-surface, #1b1e25);
  border: 1px solid var(--pt-border, rgba(255,255,255,0.08));
  font-size: 11.5px;
  flex-wrap: wrap;
}
.pt-pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 10px;
  font-size: 11.5px;
}
.pt-sidebar-trigger {
  width: calc(100% - 16px);
  margin: 6px 8px;
  padding: 7px 10px;
  border-radius: 8px;
  border: 1px solid var(--pt-border, rgba(255,255,255,0.12));
  background: var(--pt-card, #14161b);
  color: var(--pt-fg, #f3f4f6);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.pt-sidebar-trigger:hover { border-color: var(--pt-accent, #6366f1); }

/* ===== Account Quotas Panel (EasyCLIProxyAPI-inspired + T3Tools) ===== */
.pt-quota-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px;
  border-radius: var(--pt-radius, 10px);
  background: var(--pt-card, #14161b);
  border: 1px solid var(--pt-border, rgba(255,255,255,0.1));
  flex-wrap: wrap;
}
.pt-quota-strip-list {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  flex: 1;
  min-width: 0;
}
.pt-quota-chip {
  appearance: none;
  border: 1px solid var(--pt-border, rgba(255,255,255,0.1));
  background: var(--pt-surface, #1b1e25);
  color: var(--pt-fg, #f3f4f6);
  border-radius: 8px;
  padding: 5px 9px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  transition: border-color 0.15s ease, transform 0.12s ease;
}
.pt-quota-chip:hover {
  border-color: var(--pt-accent, #6366f1);
  transform: translateY(-1px);
}
.pt-quota-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.pt-pill-group {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}
.pt-filter-pill {
  appearance: none;
  border: 1px solid var(--pt-border, rgba(255,255,255,0.1));
  background: var(--pt-surface, #1b1e25);
  color: var(--pt-muted, #9ca3af);
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  transition: all 0.15s ease;
}
.pt-filter-pill:hover {
  color: var(--pt-fg, #f3f4f6);
  border-color: var(--pt-accent, #6366f1);
}
.pt-filter-pill.active {
  background: var(--pt-accent, #6366f1);
  border-color: var(--pt-accent, #6366f1);
  color: var(--pt-accent-fg, #ffffff);
}
.pt-quota-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 12px;
}
@media (max-width: 740px) {
  .pt-quota-grid { grid-template-columns: 1fr; }
}
.pt-acc-card {
  position: relative;
  background: var(--pt-card, #14161b);
  border: 1px solid var(--pt-border, rgba(255,255,255,0.1));
  border-radius: var(--pt-radius, 10px);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  transition: border-color 0.15s ease;
}
.pt-acc-card:hover {
  border-color: color-mix(in srgb, var(--pt-accent, #6366f1) 55%, var(--pt-border, rgba(255,255,255,0.12)));
}
.pt-acc-stripe {
  height: 3px;
  width: 100%;
  flex: none;
}
.pt-acc-inner {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1;
}
.pt-acc-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.pt-acc-identity {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
  flex: 1;
}
.pt-acc-avatar {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 0.03em;
  flex: none;
  border: 1px solid transparent;
}
.pt-acc-title-wrap {
  min-width: 0;
  flex: 1;
}
.pt-acc-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.pt-acc-name {
  font-size: 13.5px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pt-acc-sub {
  font-size: 11px;
  color: var(--pt-muted, #9ca3af);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pt-quota-ring {
  position: relative;
  width: 38px;
  height: 38px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.pt-quota-ring-val {
  position: absolute;
  font-size: 9.5px;
  font-weight: 700;
  line-height: 1;
}
.pt-pool-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
}
.pt-pool-block {
  background: var(--pt-surface, #1b1e25);
  border: 1px solid color-mix(in srgb, var(--pt-border, rgba(255,255,255,0.08)) 75%, transparent);
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pt-pool-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11.5px;
  font-weight: 600;
}
.pt-win-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pt-win-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
}
.pt-win-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  background: color-mix(in srgb, var(--pt-fg, #fff) 8%, transparent);
  color: var(--pt-fg, #f3f4f6);
}
.pt-win-bar {
  width: 100%;
  height: 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--pt-fg, #fff) 11%, transparent);
  overflow: hidden;
}
.pt-win-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 10.5px;
  color: var(--pt-muted, #9ca3af);
}
.pt-acc-extras {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.pt-credit-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 11px;
  background: color-mix(in srgb, var(--pt-accent, #6366f1) 14%, transparent);
  color: var(--pt-accent, #6366f1);
  border: 1px solid color-mix(in srgb, var(--pt-accent, #6366f1) 28%, transparent);
}
.pt-acc-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 8px;
  margin-top: auto;
  border-top: 1px solid color-mix(in srgb, var(--pt-border, rgba(255,255,255,0.08)) 70%, transparent);
  font-size: 11px;
  flex-wrap: wrap;
}
`;

const PT_USAGE_RING_CIRCUMFERENCE = 37.7;

function fmtUsageInteger(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return '--';
  try {
    return Math.round(num).toLocaleString();
  } catch {
    return String(Math.round(num));
  }
}

function resolveComposerSpeedDisplay(ctx) {
  const usable = v => v !== null && v !== undefined && Number.isFinite(Number(v)) && Number(v) >= 0;
  const round = v => String(Math.max(0, Math.round(Number(v))));
  if (ctx?.liveStreaming && usable(ctx.liveTps)) {
    return { value: round(ctx.liveTps), source: 'live-stream' };
  }
  if (usable(ctx?.decodeSpeed)) {
    return { value: round(ctx.decodeSpeed), source: 'decode' };
  }
  if (usable(ctx?.outputThroughput)) {
    return { value: round(ctx.outputThroughput), source: 'throughput' };
  }
  if (usable(ctx?.tps)) {
    return { value: round(ctx.tps), source: ctx.tpsKind === 'generation' ? 'decode' : 'throughput' };
  }
  return { value: '--', source: 'none' };
}

function renderUsageTipHtml(title, tag, desc, tagClass = '') {
  return `
    <span class="pt-usage-tip" role="tooltip">
      <span class="pt-usage-tip-head">
        <span class="pt-usage-tip-title">${esc(title)}</span>
        ${tag ? `<span class="pt-usage-tip-tag${tagClass ? ` ${tagClass}` : ''}">${esc(tag)}</span>` : ''}
      </span>
      <span class="pt-usage-tip-desc">${esc(desc)}</span>
    </span>
  `;
}

function renderComposerBarHtml(live, options = {}) {
  const hideWhenUnresolved = Boolean(options?.hideWhenUnresolved);
  const inline = Boolean(options?.inline);
  const barClass = inline ? 'pt-usage-bar pt-usage-inline' : 'pt-usage-bar';
  if (live?.thread?.unresolved) {
    if (hideWhenUnresolved) {
      return `<div class="${barClass}" role="status" data-hidden="true"></div>`;
    }
  }

  const ctx = live?.thread?.unresolved ? null : (live?.context || null);
  const speedDisplay = resolveComposerSpeedDisplay(ctx);
  const isLiveStream = speedDisplay.source === 'live-stream';

  const hasTtft = ctx?.ttftMs != null && Number.isFinite(Number(ctx.ttftMs)) && Number(ctx.ttftMs) >= 0;
  const ttftSecondsText = hasTtft ? `${(Math.max(0, Number(ctx.ttftMs)) / 1000).toFixed(1)}s` : '--';

  const hasCache = ctx?.cacheHitPercent != null && Number.isFinite(Number(ctx.cacheHitPercent));
  const cachePctNum = hasCache ? Math.min(100, Math.max(0, Number(ctx.cacheHitPercent))) : null;
  const cachePctText = cachePctNum != null ? `${cachePctNum.toFixed(1)}%` : '--';
  const cacheToneClass = cachePctNum == null
    ? 'pt-muted'
    : cachePctNum >= 60
      ? 'pt-text-success'
      : cachePctNum >= 25
        ? 'pt-text-warning'
        : 'pt-text-danger';

  const hasContext = ctx?.usedPercent != null && Number.isFinite(Number(ctx.usedPercent));
  const contextPct = hasContext ? Math.min(100, Math.max(0, Number(ctx.usedPercent))) : null;
  const contextValueText = contextPct != null ? `${Math.round(contextPct)}%` : '--';
  const ringFilled = contextPct != null ? (contextPct / 100) * PT_USAGE_RING_CIRCUMFERENCE : 0;
  const ctxTone = contextTone(contextPct);
  const ringColor = ctxTone === 'danger'
    ? 'var(--pt-danger, #ef4444)'
    : ctxTone === 'warning'
      ? 'var(--pt-warning, #f59e0b)'
      : 'var(--pt-accent, #6366f1)';

  const stale = Boolean(ctx?.stale && !ctx?.liveStreaming);

  const speedTip = speedDisplay.source === 'none'
    ? renderUsageTipHtml('生成速度', '', '暂无输出采样')
    : speedDisplay.source === 'live-stream'
      ? renderUsageTipHtml('实时速度', '流式估算', '生成中实时估算，完成后校准', 'pt-text-accent')
      : speedDisplay.source === 'throughput'
        ? renderUsageTipHtml('整轮吞吐', '近似估算', '含等待与工具调用耗时')
        : renderUsageTipHtml('解码速度', '近 10 次', '纯输出速率，不含首字等待');

  const ttftTip = !hasTtft
    ? renderUsageTipHtml('首字延迟', '', '当前数据源无首字计时')
    : renderUsageTipHtml('首字延迟', '近 10 次', '请求至首 Token 返回耗时');

  const cacheRead = Number(ctx?.cacheReadTokens) || 0;
  const totalIn = cacheRead + (Number(ctx?.inputTokens) || 0);
  const cacheTtlTag = ctx?.cacheRemainingMs > 0 ? `保活 ${fmtDuration(ctx.cacheRemainingMs)}` : '';
  const cacheTip = !hasCache
    ? renderUsageTipHtml('缓存命中', '', '本轮暂无缓存记录')
    : renderUsageTipHtml(
        '缓存命中',
        cacheTtlTag,
        totalIn > 0 ? `复用 ${fmtTokens(cacheRead)} / 输入 ${fmtTokens(totalIn)}` : '本轮输入复用缓存比例',
        cacheTtlTag ? 'pt-text-success' : ''
      );

  const maxTokens = Number(ctx?.maxTokens) || 0;
  const usedTokens = ctx?.usedTokens != null && Number.isFinite(Number(ctx.usedTokens)) ? Number(ctx.usedTokens) : null;
  const ctxTag = usedTokens != null && maxTokens > 0
    ? `${fmtTokens(usedTokens)} / ${fmtTokens(maxTokens)}`
    : (maxTokens > 0 ? `容量 ${fmtTokens(maxTokens)}` : '');
  const ctxDesc = contextPct == null
    ? '暂无上下文数据'
    : (ctx?.compactions > 0
      ? `已用 ${contextPct.toFixed(1)}% · 已压缩 ${ctx.compactions} 次`
      : `当前上下文已占用 ${contextPct.toFixed(1)}%`);
  const contextTip = renderUsageTipHtml('上下文窗口', ctxTag, ctxDesc);

  const ariaLabel = [
    '用量状态栏',
    `${speedDisplay.value} tok/s`,
    `首字 ${ttftSecondsText}`,
    `缓存 ${cachePctText}`,
    `上下文 ${contextValueText}`
  ].join(' · ');

  return `
    <div class="${barClass}" role="status" data-hidden="false" data-stale="${stale ? 'true' : 'false'}" aria-label="${esc(ariaLabel)}">
      <span class="pt-usage-item" data-usage="speed" data-live="${isLiveStream ? 'true' : 'false'}">
        <svg class="pt-usage-icon" viewBox="0 0 16 16" width="12.5" height="12.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M2 12.5a6 6 0 0 1 12 0" />
          <path d="M8 12.5 10.8 8.6" />
        </svg>
        <span class="pt-usage-value">${esc(speedDisplay.value)}<span class="pt-usage-unit">tok/s</span></span>
        ${speedTip}
      </span>
      <span class="pt-usage-sep" aria-hidden="true"></span>
      <span class="pt-usage-item" data-usage="ttft">
        <svg class="pt-usage-icon" viewBox="0 0 16 16" width="12.5" height="12.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="8" cy="8" r="5.8" />
          <path d="M8 4.5V8l2.4 1.6" />
        </svg>
        <span class="pt-usage-label">首字</span>
        <span class="pt-usage-value">${esc(ttftSecondsText)}</span>
        ${ttftTip}
      </span>
      <span class="pt-usage-sep" aria-hidden="true"></span>
      <span class="pt-usage-item" data-usage="cache">
        <svg class="pt-usage-icon" viewBox="0 0 16 16" width="12.5" height="12.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M8 2.2c2.5 0 4.5.8 4.5 1.8S10.5 5.8 8 5.8 3.5 5 3.5 4 5.5 2.2 8 2.2Z" />
          <path d="M3.5 4v8c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8V4" />
          <path d="M3.5 8c0 1 2 1.8 4.5 1.8S12.5 9 12.5 8" />
        </svg>
        <span class="pt-usage-label">缓存</span>
        <span class="pt-usage-value ${cacheToneClass}">${esc(cachePctText)}</span>
        ${cacheTip}
      </span>
      <span class="pt-usage-sep" aria-hidden="true"></span>
      <span class="pt-usage-item" data-usage="context">
        <svg class="pt-usage-icon" viewBox="0 0 16 16" width="12.5" height="12.5" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-opacity=".24" />
          <circle cx="8" cy="8" r="6" stroke="${ringColor}" stroke-dasharray="${ringFilled.toFixed(2)} ${PT_USAGE_RING_CIRCUMFERENCE}" transform="rotate(-90 8 8)" />
        </svg>
        <span class="pt-usage-value">${esc(contextValueText)}</span>
        ${contextTip}
      </span>
    </div>
  `;
}

function compactPoolTitle(poolLabel = '', poolKey = '') {
  if (poolKey === '3p' || /claude.*gpt/i.test(poolLabel)) return 'Claude/GPT';
  if (poolKey === 'gemini') return 'Gemini';
  if (poolKey === 'argon') return 'Argon';
  if (poolKey === 'codex') return 'Codex';
  return String(poolLabel || poolKey || '额度')
    .replace(/\s*\(shared\)/i, '')
    .replace(/^Codex\s*\((.+)\)$/i, '$1')
    .trim();
}

function compactWinTag(w) {
  if (w.kind === 'weekly' || (Number.isFinite(w.windowDurationMins) && w.windowDurationMins >= 1440)) {
    return '周';
  }
  if (Number.isFinite(w.windowDurationMins) && w.windowDurationMins >= 60) {
    return `${Math.round(w.windowDurationMins / 60)}h`;
  }
  return '短';
}

function fmtCompactPct(v) {
  if (v == null || !Number.isFinite(Number(v))) return '-';
  const n = Number(v);
  return Number.isInteger(n) ? `${n}%` : `${n.toFixed(1)}%`;
}

function renderCompactOverviewQuotasHtml(quotas, { preferredPool, now, unresolved, activeAccountId }) {
  if (!quotas.length) {
    const emptyMsg = unresolved
      ? '请打开具体会话查看当前账号剩余额度'
      : activeAccountId
        ? `暂无账号 ${activeAccountId} 的额度缓存`
        : '未检测到当前账号额度缓存';
    return `<div class="pt-ov-empty">${esc(emptyMsg)}</div>`;
  }

  const g = quotas[0];
  if (!g.windows.length) {
    const msg = g.unavailable?.message || '暂无可用额度数据';
    return `<div class="pt-ov-empty">${esc(msg.slice(0, 80))}</div>`;
  }

  const pools = getAccountPools(g).slice();
  // Put the active model's pool first so it is always top-left
  if (preferredPool) {
    pools.sort((a, b) => (b.poolKey === preferredPool ? 1 : 0) - (a.poolKey === preferredPool ? 1 : 0));
  }

  const isSinglePool = pools.length === 1;
  const tilesHtml = pools.map(p => {
    const isActive = Boolean(preferredPool && p.poolKey === preferredPool);
    const shortName = compactPoolTitle(p.poolLabel, p.poolKey);
    const futureResets = p.windows
      .map(w => (w.resetsAtMs != null && w.resetsAtMs > now) ? w.resetsAtMs : (w.remainingTimeMs != null && w.remainingTimeMs > 0 ? now + w.remainingTimeMs : null))
      .filter(ms => ms != null && ms > now);
    const soonestMs = futureResets.length ? Math.min(...futureResets) : null;
    const allFullIdle = p.windows.every(w => w.remainingPercent === 100 && w.resetsAtMs == null && w.remainingTimeMs == null);
    const resetHint = soonestMs != null ? `↻ ${fmtCountdown(soonestMs - now)}` : (allFullIdle ? '满额' : '');

    const useTwoCols = isSinglePool && p.windows.length === 2;
    const hideRedundantHead = isSinglePool && shortName.toLowerCase() === String(g.driverLabel || g.driver || '').toLowerCase();
    const winsHtml = p.windows.map(w => {
      const rem = w.remainingPercent;
      const tone = quotaTone(rem);
      const tag = compactWinTag(w);
      const remTimeMs = w.resetsAtMs != null ? Math.max(0, w.resetsAtMs - now) : w.remainingTimeMs;
      const resetTip = w.resetsAtMs != null
        ? ` · ${remTimeMs > 0 ? `${fmtCountdown(remTimeMs)} 后重置 (${fmtTimeShort(w.resetsAtMs)})` : '已到重置点'}`
        : (remTimeMs != null ? ` · ${fmtCountdown(remTimeMs)} 后重置` : (rem === 100 ? ' · 满额待触发' : ''));
      const ageTip = w.source === 'codex-rollout' && w.observationAgeMs != null ? ` · rollout ${fmtAge(w.observationAgeMs)}` : '';
      const tip = `${w.label || p.poolLabel} · 剩余 ${fmtCompactPct(rem)}${w.usedPercent != null ? ` (已用 ${w.usedPercent}%)` : ''}${resetTip}${ageTip}`;
      const inlineReset = hideRedundantHead && !useTwoCols && remTimeMs != null && remTimeMs > 0
        ? `<span class="pt-ov-pool-reset pt-mono">↻ ${esc(fmtCountdown(remTimeMs))}</span>`
        : '';
      return `
        <div class="pt-ov-win" title="${esc(tip)}">
          <span class="pt-ov-win-k pt-mono">${esc(tag)}</span>
          <span class="pt-ov-bar"><span class="pt-bar-fill pt-tone-${tone}" style="width:${rem != null ? Math.min(100, Math.max(0, rem)) : 0}%"></span></span>
          <span class="pt-ov-win-v pt-mono pt-text-${tone}">${esc(fmtCompactPct(rem))}</span>
          ${inlineReset}
        </div>
      `;
    }).join('');

    return `
      <div class="pt-ov-pool${isActive ? ' active' : ''}" title="${esc(p.poolLabel)}">
        ${hideRedundantHead ? '' : `
          <div class="pt-ov-pool-head">
            <span class="pt-ov-pool-name">
              ${isActive ? '<span class="pt-dot pt-tone-accent" style="width:5px;height:5px;"></span>' : ''}
              <span style="overflow:hidden;text-overflow:ellipsis;">${esc(shortName)}</span>
            </span>
            ${resetHint ? `<span class="pt-ov-pool-reset pt-mono">${esc(resetHint)}</span>` : ''}
          </div>
        `}
        <div class="pt-ov-win-list${useTwoCols ? ' cols-2' : ''}">${winsHtml}</div>
      </div>
    `;
  }).join('');

  return `<div class="pt-ov-quota-grid${isSinglePool ? ' single' : ''}">${tilesHtml}</div>`;
}

function renderOverviewCardHtml(live, collapsed, showAllSteps = false) {
  const thread = live?.thread;
  const unresolved = Boolean(thread?.unresolved);
  const activeAccountId = !unresolved
    ? String(thread?.accountId || live?.context?.accountId || '').trim()
    : '';
  const allQuotas = live?.quotas?.groups || [];
  const quotas = activeAccountId
    ? allQuotas.filter(g => g.accountId === activeAccountId)
    : [];
  const activeGroup = quotas[0] || null;
  const now = live?.quotas?.updatedAtMs || live?.updatedAtMs || Date.now();
  const isRunning = !unresolved && thread?.run?.status === 'running';
  const phaseLabel = unresolved ? '未选中会话' : (thread?.phaseLabel || '空闲');
  const phaseTone = unresolved ? 'muted'
    : thread?.phase === 'waiting_approval' ? 'warning'
    : thread?.phase === 'error' ? 'danger'
    : isRunning ? 'accent'
    : 'success';

  const activeModelLower = String(live?.context?.modelId || thread?.selectedModel || '').toLowerCase();
  const preferredPool = /argon/.test(activeModelLower) ? 'argon'
    : /gemini/.test(activeModelLower) ? 'gemini'
    : /claude|gpt/.test(activeModelLower) ? '3p'
    : '';
  const activeWins = quotas.flatMap(g => g.windows);
  const firstWin = (preferredPool && activeWins.find(w => w.poolKey === preferredPool && w.kind === 'weekly'))
    || (preferredPool && activeWins.find(w => w.poolKey === preferredPool))
    || activeWins.find(w => w.kind === 'weekly')
    || activeWins[0];
  const collapsedQuota = firstWin && firstWin.remainingPercent != null
    ? ` · 剩 ${fmtCompactPct(firstWin.remainingPercent)}`
    : '';

  const allSteps = unresolved ? [] : (thread?.steps || []);
  const visibleSteps = showAllSteps ? allSteps.slice().reverse() : allSteps.slice(-10).reverse();
  const hasMoreSteps = allSteps.length > 10;

  const stepRowsHtml = unresolved
    ? `<div class="pt-muted" style="font-size:11px;padding:4px 2px;">${esc(thread?.reason || '请打开具体会话查看每步耗时')}</div>`
    : visibleSteps.length
      ? visibleSteps.map(s => {
          const sTone = s.status === 'running' ? 'accent' : s.status === 'failed' ? 'danger' : 'success';
          return `
            <div class="pt-step-row" title="${esc(s.title)}">
              <span class="pt-dot pt-tone-${sTone}${s.status === 'running' ? ' pt-dot-pulse' : ''}"></span>
              <span class="pt-muted" style="flex:none;">${esc(s.phaseLabel)}</span>
              <span class="pt-step-title">${esc(s.title)}</span>
              <span class="pt-mono pt-muted" style="flex:none;">${esc(fmtDuration(s.durationMs))}</span>
            </div>
          `;
        }).join('')
      : `<div class="pt-muted" style="font-size:11px;padding:4px 2px;">暂无步骤记录</div>`;

  const quotaSectionHtml = renderCompactOverviewQuotasHtml(quotas, {
    preferredPool,
    now,
    unresolved,
    activeAccountId
  });
  const quotaHeaderLabel = activeGroup
    ? activeGroup.displayName
    : '当前账号剩余额度';
  const creditTag = activeGroup?.resetCredits?.availableCount > 0
    ? `<span class="pt-badge pt-badge-ok pt-mono" style="font-size:9px;padding:0 5px;flex:none;" title="可用重置券">重置券×${activeGroup.resetCredits.availableCount}</span>`
    : '';

  const queuedBadge = !unresolved && thread?.queuedRuns > 0
    ? `<span class="pt-badge pt-badge-warn" style="margin-left:4px;">排队 ${thread.queuedRuns}</span>`
    : '';

  return `
    <div class="pt-overview-card${collapsed ? ' collapsed' : ''}">
      <div class="pt-overview-header" data-pt-action="toggle-overview" title="点击折叠或展开运行进度与额度">
        <div style="display:flex;align-items:center;gap:6px;min-width:0;">
          <span class="pt-dot pt-tone-${phaseTone}${isRunning ? ' pt-dot-pulse' : ''}"></span>
          <strong style="white-space:nowrap;">${esc(phaseLabel)}</strong>
          ${queuedBadge}
          <span class="pt-mono pt-muted" style="font-size:11px;white-space:nowrap;">
            ${!unresolved && thread?.run?.durationMs != null ? esc(fmtDuration(thread.run.durationMs)) : ''}${collapsed ? esc(collapsedQuota) : ''}
          </span>
        </div>
        <span class="pt-muted" style="font-size:10.5px;flex:none;">${collapsed ? '展开 ▾' : '收起 ▴'}</span>
      </div>
      ${collapsed ? '' : `
        <div class="pt-overview-body">
          <div>
            <div class="pt-section-title">
              <span>运行阶段 (${allSteps.length} 步)</span>
              <span style="display:flex;align-items:center;gap:5px;">
                ${hasMoreSteps ? `<button class="pt-btn" data-pt-action="toggle-all-steps" style="padding:1px 5px;font-size:10px;">${showAllSteps ? '近10步' : `全部 ${allSteps.length}`}</button>` : ''}
                <span class="pt-mono">${esc(!unresolved ? (thread?.accountId || '') : '')}</span>
              </span>
            </div>
            <div class="pt-step-list">${stepRowsHtml}</div>
          </div>
          <div>
            <div class="pt-section-title">
              <span style="display:inline-flex;align-items:center;gap:4px;min-width:0;overflow:hidden;">
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(quotaHeaderLabel)}">${esc(quotaHeaderLabel)}</span>
                ${creditTag}
              </span>
              <span style="display:flex;align-items:center;gap:4px;flex:none;">
                <button class="pt-btn" data-pt-action="open-quotas" style="padding:1px 5px;font-size:10px;" title="查看当前 T3 登录的全部账号额度">全部额度</button>
                <button class="pt-btn" data-pt-action="open-dashboard" style="padding:1px 5px;font-size:10px;">看板</button>
              </span>
            </div>
            ${quotaSectionHtml}
          </div>
        </div>
      `}
    </div>
  `;
}

function renderHeatmapSvg(heatmap, metric = 'tokens') {
  const days = heatmap?.days || [];
  if (!days.length) return `<div class="pt-muted">暂无历史记录</div>`;

  const cell = 11;
  const gap = 3;
  const step = cell + gap;
  const weeks = Math.ceil(days.length / 7);
  const width = weeks * step + 28;
  const height = 7 * step + 22;
  const maxVal = metric === 'requests' ? heatmap.maxRequests
    : metric === 'costUsd' ? heatmap.maxCost
    : heatmap.maxTokens;

  const levels = [
    'color-mix(in srgb, var(--pt-fg, #fff) 8%, transparent)',
    'color-mix(in srgb, var(--pt-accent, #6366f1) 30%, transparent)',
    'color-mix(in srgb, var(--pt-accent, #6366f1) 52%, transparent)',
    'color-mix(in srgb, var(--pt-accent, #6366f1) 76%, transparent)',
    'var(--pt-accent, #6366f1)'
  ];

  let rects = '';
  let monthLabels = '';
  let lastMonth = '';

  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const col = Math.floor(i / 7);
    const row = i % 7;
    const x = 24 + col * step;
    const y = 16 + row * step;
    const val = metric === 'requests' ? d.requests : metric === 'costUsd' ? d.costUsd : d.tokens;
    let lv = 0;
    if (val > 0 && maxVal > 0) {
      const ratio = val / maxVal;
      lv = ratio >= 0.75 ? 4 : ratio >= 0.45 ? 3 : ratio >= 0.18 ? 2 : 1;
    }
    const tip = `${d.date} · ${d.requests} 次请求 · ${fmtTokens(d.tokens)} tokens · ${fmtUsd(d.costUsd)}${d.errors ? ` · ${d.errors} 错误` : ''}`;
    rects += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2.5" fill="${levels[lv]}"><title>${esc(tip)}</title></rect>`;

    const monthKey = d.date.slice(0, 7);
    if (row === 0 && monthKey !== lastMonth) {
      lastMonth = monthKey;
      monthLabels += `<text x="${x}" y="11" fill="var(--pt-muted, #9ca3af)" font-size="9.5">${esc(d.date.slice(5, 7))}月</text>`;
    }
  }

  const dayLabels = [
    { row: 1, text: '一' },
    { row: 3, text: '三' },
    { row: 5, text: '五' }
  ].map(l => `<text x="2" y="${16 + l.row * step + 9}" fill="var(--pt-muted, #9ca3af)" font-size="9.5">${l.text}</text>`).join('');

  return `
    <div class="pt-heatmap-wrap">
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="53周用量热力图">
        ${monthLabels}
        ${dayLabels}
        ${rects}
      </svg>
    </div>
  `;
}

/**
 * Render ONLY the request table + pagination card so typing in the session search
 * input never loses focus during async refreshes (fixes P2 #20).
 */
function renderRequestsTableCardHtml(data) {
  const reqPage = data?.requests || { items: [], total: 0, page: 1, totalPages: 1 };
  return `
    <div class="pt-table-wrap">
      <table class="pt-table">
        <thead>
          <tr>
            <th>时间</th><th>账号</th><th>模型</th><th>会话</th>
            <th>输入 / 缓存 / 输出</th><th>命中率</th><th>速度 / 耗时</th><th>状态</th><th>缓存诊断</th>
          </tr>
        </thead>
        <tbody>
          ${reqPage.items.length ? reqPage.items.map(r => {
            const anom = r.cacheAnomaly;
            const statusBadge = r.status === 'error'
              ? `<span class="pt-badge pt-badge-err" title="${esc(r.errorText)}">失败${r.errorCode ? `·${esc(ERROR_CODE_LABELS[r.errorCode] || r.errorCode)}` : ''}</span>`
              : r.status === 'recorded' || r.outcomeKnown === false
                ? `<span class="pt-badge pt-badge-muted" title="仅包含用量记录，无结果状态">已记录</span>`
                : r.retries > 0
                  ? `<span class="pt-badge pt-badge-warn">重试×${r.retries}</span>`
                  : `<span class="pt-badge pt-badge-ok">成功</span>`;
            const cacheDiag = anom
              ? `<span class="pt-badge pt-badge-err" title="${esc(anom.reason)}">⚠ ${esc(anom.label)}</span>`
              : r.excludedCompaction
                ? `<span class="pt-badge pt-badge-muted" title="检测到上下文压缩，已自动排除掉缓存误报">压缩忽略</span>`
                : `<span class="pt-muted">-</span>`;
            const tpsLabel = r.tps != null
              ? `${r.tpsKind === 'e2e-estimate' ? '~' : ''}${r.tps} t/s`
              : '-';
            return `
              <tr class="${anom ? 'pt-row-anomaly' : ''}">
                <td class="pt-mono" style="white-space:nowrap;">${esc(fmtTime(r.timestampMs))}</td>
                <td class="pt-mono">${esc(r.accountId)}</td>
                <td class="pt-mono">${esc(r.modelId)}</td>
                <td style="max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(r.t3ThreadTitle || r.nativeSessionId)}">${esc(r.t3ThreadTitle || r.nativeSessionId.slice(0, 14))}</td>
                <td class="pt-mono" style="white-space:nowrap;">${fmtTokens(r.inputTokens)} / <span class="pt-text-success">${fmtTokens(r.cacheReadTokens)}</span> / ${fmtTokens(r.outputTokens)}</td>
                <td class="pt-mono">${fmtPct(r.cacheHitPercent)}</td>
                <td class="pt-mono" style="white-space:nowrap;" title="${r.tpsKind === 'e2e-estimate' ? '端到端估算速率' : '生成速率'}">${tpsLabel} <span class="pt-muted">· ${fmtDuration(r.durationMs)}</span></td>
                <td>${statusBadge}</td>
                <td>${cacheDiag}</td>
              </tr>
            `;
          }).join('') : '<tr><td colspan="9" class="pt-muted" style="text-align:center;padding:24px;">无匹配请求记录</td></tr>'}
        </tbody>
      </table>
    </div>
    <div class="pt-pagination">
      <span class="pt-muted">共 ${reqPage.total} 条记录 · 第 ${reqPage.page} / ${reqPage.totalPages} 页</span>
      <div style="display:flex;gap:6px;">
        <button class="pt-btn" data-pt-page="${Math.max(1, reqPage.page - 1)}"${reqPage.page <= 1 ? ' disabled' : ''}>上一页</button>
        <button class="pt-btn" data-pt-page="${Math.min(reqPage.totalPages, reqPage.page + 1)}"${reqPage.page >= reqPage.totalPages ? ' disabled' : ''}>下一页</button>
      </div>
    </div>
  `;
}

function getQuotaGroupsSummary(quotas) {
  const groups = Array.isArray(quotas?.groups) ? quotas.groups : [];
  if (quotas?.summary) return quotas.summary;
  const driverMap = new Map();
  let healthyAccounts = 0;
  let warningAccounts = 0;
  let criticalAccounts = 0;
  let unknownAccounts = 0;
  let lowestWindow = null;
  let soonestResetWindow = null;
  const now = quotas?.updatedAtMs || Date.now();
  for (const g of groups) {
    const remVals = (g.windows || []).map(w => w.remainingPercent).filter(v => v != null && Number.isFinite(v));
    const minRem = g.minRemainingPercent != null ? g.minRemainingPercent : (remVals.length ? Math.min(...remVals) : null);
    const health = g.health || (minRem == null ? 'unknown' : minRem <= 15 ? 'critical' : minRem <= 40 ? 'warning' : 'healthy');
    if (health === 'healthy') healthyAccounts++;
    else if (health === 'warning') warningAccounts++;
    else if (health === 'critical') criticalAccounts++;
    else unknownAccounts++;
    const dEntry = driverMap.get(g.driver) || { driver: g.driver, label: g.driverLabel || driverMeta(g.driver).label, count: 0 };
    dEntry.count++;
    driverMap.set(g.driver, dEntry);
    for (const w of g.windows || []) {
      if (w.remainingPercent != null && (!lowestWindow || w.remainingPercent < lowestWindow.remainingPercent)) {
        lowestWindow = { accountId: g.accountId, displayName: g.displayName, driver: g.driver, ...w };
      }
      if (w.resetsAtMs != null && w.resetsAtMs > now && (!soonestResetWindow || w.resetsAtMs < soonestResetWindow.resetsAtMs)) {
        soonestResetWindow = { accountId: g.accountId, displayName: g.displayName, driver: g.driver, ...w };
      }
    }
  }
  return {
    totalAccounts: groups.length,
    readyAccounts: groups.filter(g => (g.windows || []).length > 0).length,
    healthyAccounts,
    warningAccounts,
    criticalAccounts,
    unknownAccounts,
    drivers: [...driverMap.values()],
    lowestWindow,
    soonestResetWindow
  };
}

function getAccountPools(g) {
  if (Array.isArray(g.pools) && g.pools.length) return g.pools;
  const byPool = new Map();
  for (const w of g.windows || []) {
    const key = w.poolKey || w.windowId || 'default';
    let pool = byPool.get(key);
    if (!pool) {
      pool = { poolKey: key, poolLabel: w.poolLabel || w.label || key, windows: [], minRemainingPercent: null };
      byPool.set(key, pool);
    }
    pool.windows.push(w);
    if (w.remainingPercent != null) {
      pool.minRemainingPercent = pool.minRemainingPercent == null ? w.remainingPercent : Math.min(pool.minRemainingPercent, w.remainingPercent);
    }
  }
  return [...byPool.values()];
}

function renderOverviewQuotaStripHtml(data) {
  const groups = Array.isArray(data?.quotas?.groups) ? data.quotas.groups : [];
  if (!groups.length) return '';
  const chipsHtml = groups.map(g => {
    const remVals = (g.windows || []).map(w => w.remainingPercent).filter(v => v != null && Number.isFinite(v));
    const minRem = g.minRemainingPercent != null ? g.minRemainingPercent : (remVals.length ? Math.min(...remVals) : null);
    const tone = quotaTone(minRem);
    const meta = driverMeta(g.driver, g.accentColor);
    return `
      <button class="pt-quota-chip" data-pt-tab="quotas" title="点击进入全账号额度面板查看 ${esc(g.displayName)} 详细额度">
        <span class="pt-dot" style="background:${esc(meta.color)};"></span>
        <span style="font-weight:600;">${esc(g.shortName || g.accountId)}</span>
        <span class="pt-bar-mini"><span class="pt-bar-fill pt-tone-${tone}" style="width:${minRem != null ? Math.min(100, Math.max(0, minRem)) : 0}%"></span></span>
        <span class="pt-mono pt-text-${tone}" style="font-weight:600;">${minRem != null ? `${minRem}%` : '-'}</span>
      </button>
    `;
  }).join('');

  return `
    <div class="pt-quota-strip">
      <div style="display:flex;align-items:center;gap:6px;flex:none;">
        <span class="pt-muted" style="font-size:11px;font-weight:600;">全账号额度速览</span>
        <span class="pt-badge pt-badge-muted pt-mono">${groups.length}</span>
      </div>
      <div class="pt-quota-strip-list">${chipsHtml}</div>
      <button class="pt-btn" data-pt-tab="quotas">展开额度面板 →</button>
    </div>
  `;
}

function renderQuotaWindowRowHtml(w, now) {
  const rem = w.remainingPercent;
  const used = w.usedPercent;
  const tone = quotaTone(rem);
  const tag = w.windowTag || (w.kind === 'weekly' ? '周额度' : '5h 窗口');
  const ageHint = w.source === 'codex-rollout' && w.observationAgeMs != null ? ` · rollout ${fmtAge(w.observationAgeMs)}` : '';

  let resetText = '';
  if (w.resetsAtMs != null) {
    const leftMs = Math.max(0, w.resetsAtMs - now);
    if (leftMs <= 0) {
      resetText = `已到重置点 (${fmtTimeShort(w.resetsAtMs)}) · 待刷新`;
    } else {
      resetText = `↻ ${fmtCountdown(leftMs)} 后重置 · ${fmtTimeShort(w.resetsAtMs)}`;
    }
  } else if (used === 0 || w.isIdleFull) {
    resetText = '满额未消耗 · 首次调用后开始计时';
  } else {
    resetText = '未返回重置时间';
  }

  return `
    <div class="pt-win-row">
      <div class="pt-win-top">
        <span style="display:inline-flex;align-items:center;gap:6px;min-width:0;">
          <span class="pt-win-tag">${esc(tag)}</span>
          <span class="pt-muted" style="font-size:10.5px;">${used != null ? `已用 ${used}%` : ''}${esc(ageHint)}</span>
        </span>
        <span class="pt-mono pt-text-${tone}" style="font-weight:700;font-size:12px;">
          ${rem != null ? `剩 ${rem}%` : '-'}
        </span>
      </div>
      <div class="pt-win-bar">
        <div class="pt-bar-fill pt-tone-${tone}" style="width:${rem != null ? Math.min(100, Math.max(0, rem)) : 0}%"></div>
      </div>
      <div class="pt-win-bottom">
        <span class="pt-mono">${esc(resetText)}</span>
      </div>
    </div>
  `;
}

function renderAccountQuotaCardHtml(g, { now, hideEmail, usage }) {
  const meta = driverMeta(g.driver, g.accentColor);
  const remVals = (g.windows || []).map(w => w.remainingPercent).filter(v => v != null && Number.isFinite(v));
  const minRem = g.minRemainingPercent != null ? g.minRemainingPercent : (remVals.length ? Math.min(...remVals) : null);
  const tone = quotaTone(minRem);
  const healthBadge = g.health === 'critical'
    ? '<span class="pt-badge pt-badge-err">告急</span>'
    : g.health === 'warning'
      ? '<span class="pt-badge pt-badge-warn">偏紧</span>'
      : g.health === 'healthy'
        ? '<span class="pt-badge pt-badge-ok">健康</span>'
        : '<span class="pt-badge pt-badge-muted">无数据</span>';

  const auth = g.auth || {};
  const emailShown = auth.email ? (hideEmail ? maskEmail(auth.email) : auth.email) : '';
  const authParts = [
    auth.label || (auth.status === 'authenticated' ? '已登录' : ''),
    emailShown,
    (!emailShown && auth.type) ? auth.type : ''
  ].filter(Boolean);
  const subtitle = authParts.join(' · ') || `实例 ID: ${g.accountId}`;

  const pools = getAccountPools(g);
  const bodyHtml = pools.length
    ? pools.map(p => {
        const showPoolHeader = pools.length > 1 || (p.poolLabel && p.poolLabel.toLowerCase() !== String(g.driverLabel || g.driver || '').toLowerCase());
        return `
          <div class="pt-pool-block">
            ${showPoolHeader ? `
              <div class="pt-pool-head">
                <span>${esc(p.poolLabel)}</span>
                <span class="pt-mono pt-text-${quotaTone(p.minRemainingPercent)}" style="font-size:10.5px;">
                  ${p.minRemainingPercent != null ? `最低 ${p.minRemainingPercent}%` : ''}
                </span>
              </div>
            ` : ''}
            ${p.windows.map(w => renderQuotaWindowRowHtml(w, now)).join('')}
          </div>
        `;
      }).join('')
    : `
      <div class="pt-pool-block">
        <div class="pt-muted" style="font-size:11px;padding:4px 0;">
          ${esc(g.unavailable?.message || '当前账号暂无可用额度窗口缓存（可能尚未触发查询或该驱动暂不支持额度上报）')}
        </div>
      </div>
    `;

  const extrasHtml = g.resetCredits?.availableCount > 0
    ? `
      <div class="pt-acc-extras">
        <span class="pt-credit-chip pt-mono" title="T3 Code 缓存上报的可用额度重置券">
          🎟 重置券 ×${g.resetCredits.availableCount}${g.resetCredits.nextExpiresAtMs ? ` · 有效期至 ${fmtDateShort(g.resetCredits.nextExpiresAtMs)}` : ''}
        </span>
      </div>
    `
    : '';

  const checkedAge = g.checkedAtMs ? fmtAge(Math.max(0, now - g.checkedAtMs)) : '';
  const usageNote = usage && usage.requests > 0
    ? `本周期 ${usage.requests} 次 · ${fmtTokens(usage.totalTokens)}${usage.costUsd > 0 ? ` · ${fmtUsd(usage.costUsd)}` : ''}`
    : '本周期暂无请求';

  return `
    <div class="pt-acc-card">
      <div class="pt-acc-stripe" style="background:${esc(meta.color)};"></div>
      <div class="pt-acc-inner">
        <div class="pt-acc-head">
          <div class="pt-acc-identity">
            <span class="pt-acc-avatar pt-mono" style="background:color-mix(in srgb, ${esc(meta.color)} 18%, transparent);color:${esc(meta.color)};border-color:color-mix(in srgb, ${esc(meta.color)} 35%, transparent);">${esc(meta.abbr)}</span>
            <div class="pt-acc-title-wrap">
              <div class="pt-acc-title-row">
                <span class="pt-acc-name" title="${esc(g.displayName)}">${esc(g.shortName || g.accountId)}</span>
                <span class="pt-badge pt-badge-muted">${esc(g.driverLabel || meta.label)}</span>
                ${healthBadge}
              </div>
              <div class="pt-acc-sub" title="${esc(subtitle)}">${esc(subtitle)}</div>
            </div>
          </div>
          ${renderQuotaRingSvg(minRem, tone)}
        </div>

        <div class="pt-pool-list">
          ${bodyHtml}
        </div>

        ${extrasHtml}

        <div class="pt-acc-footer">
          <span class="pt-muted pt-mono" title="缓存更新时间: ${esc(fmtTime(g.checkedAtMs))}">
            ${g.modelsCount ? `${g.modelsCount} 模型 · ` : ''}${checkedAge ? `同步 ${esc(checkedAge)} · ` : ''}${esc(usageNote)}
          </span>
          <button class="pt-btn" data-pt-inspect-account="${esc(g.accountId)}" title="按此账号筛选用量概览">查看用量 →</button>
        </div>
      </div>
    </div>
  `;
}

function renderQuotaMatrixTableHtml(groups, { now, hideEmail, accountUsage }) {
  const rows = [];
  for (const g of groups) {
    const meta = driverMeta(g.driver, g.accentColor);
    const auth = g.auth || {};
    const emailShown = auth.email ? (hideEmail ? maskEmail(auth.email) : auth.email) : '';
    const credSub = [auth.label, emailShown].filter(Boolean).join(' · ');
    const usage = accountUsage[g.accountId];
    const pools = getAccountPools(g);
    const healthBadge = g.health === 'critical'
      ? '<span class="pt-badge pt-badge-err">告急</span>'
      : g.health === 'warning'
        ? '<span class="pt-badge pt-badge-warn">偏紧</span>'
        : g.health === 'healthy'
          ? '<span class="pt-badge pt-badge-ok">健康</span>'
          : '<span class="pt-badge pt-badge-muted">无数据</span>';

    const renderCellWin = w => {
      if (!w) return '<span class="pt-muted">-</span>';
      const tone = quotaTone(w.remainingPercent);
      const resetSub = w.resetsAtMs != null
        ? (w.resetsAtMs > now ? `↻ ${fmtCountdown(w.resetsAtMs - now)}` : '待刷新')
        : (w.usedPercent === 0 ? '满额待触发' : '');
      return `
        <div style="display:flex;flex-direction:column;gap:2px;min-width:110px;">
          <div style="display:flex;align-items:center;gap:6px;">
            <span class="pt-bar-mini"><span class="pt-bar-fill pt-tone-${tone}" style="width:${w.remainingPercent != null ? Math.min(100, Math.max(0, w.remainingPercent)) : 0}%"></span></span>
            <strong class="pt-mono pt-text-${tone}">${w.remainingPercent != null ? `${w.remainingPercent}%` : '-'}</strong>
          </div>
          ${resetSub ? `<span class="pt-mono pt-muted" style="font-size:10px;">${esc(resetSub)}</span>` : ''}
        </div>
      `;
    };

    if (!pools.length) {
      rows.push(`
        <tr>
          <td>
            <div style="display:flex;align-items:center;gap:6px;">
              <span class="pt-dot" style="background:${esc(meta.color)};"></span>
              <strong>${esc(g.shortName || g.accountId)}</strong>
            </div>
            ${credSub ? `<div class="pt-muted" style="font-size:10.5px;">${esc(credSub)}</div>` : ''}
          </td>
          <td><span class="pt-badge pt-badge-muted">${esc(g.driverLabel || meta.label)}</span></td>
          <td>${healthBadge}</td>
          <td colspan="3" class="pt-muted">${esc(g.unavailable?.message || '暂无可用额度窗口')}</td>
          <td class="pt-mono pt-muted">${usage?.requests ? `${usage.requests} 次 / ${fmtTokens(usage.totalTokens)}` : '-'}</td>
          <td><button class="pt-btn" data-pt-inspect-account="${esc(g.accountId)}">用量 →</button></td>
        </tr>
      `);
      continue;
    }

    pools.forEach((p, idx) => {
      const sessionWin = p.windows.find(w => w.kind === 'session' || (w.windowDurationMins && w.windowDurationMins < 1440));
      const weeklyWin = p.windows.find(w => w.kind === 'weekly' || (w.windowDurationMins && w.windowDurationMins >= 1440));
      const futureResets = p.windows.map(w => w.resetsAtMs).filter(ms => ms != null && ms > now);
      const nextReset = futureResets.length ? Math.min(...futureResets) : null;
      rows.push(`
        <tr>
          <td>
            ${idx === 0 ? `
              <div style="display:flex;align-items:center;gap:6px;">
                <span class="pt-dot" style="background:${esc(meta.color)};"></span>
                <strong>${esc(g.shortName || g.accountId)}</strong>
                ${g.resetCredits?.availableCount ? `<span class="pt-badge pt-badge-ok" title="可用重置券">🎟×${g.resetCredits.availableCount}</span>` : ''}
              </div>
              ${credSub ? `<div class="pt-muted" style="font-size:10.5px;">${esc(credSub)}</div>` : ''}
            ` : `<span class="pt-muted" style="padding-left:14px;">↳</span>`}
          </td>
          <td>${idx === 0 ? `<span class="pt-badge pt-badge-muted">${esc(g.driverLabel || meta.label)}</span>` : ''}</td>
          <td>${idx === 0 ? healthBadge : ''}</td>
          <td style="font-weight:500;">${esc(p.poolLabel)}</td>
          <td>${renderCellWin(sessionWin)}</td>
          <td>${renderCellWin(weeklyWin)}</td>
          <td class="pt-mono pt-muted" style="white-space:nowrap;">${nextReset ? `${fmtCountdown(nextReset - now)} (${fmtTimeShort(nextReset)})` : '-'}</td>
          <td class="pt-mono pt-muted" style="white-space:nowrap;">${idx === 0 ? (usage?.requests ? `${usage.requests} 次 · ${fmtTokens(usage.totalTokens)}` : '-') : ''}</td>
          <td>${idx === 0 ? `<button class="pt-btn" data-pt-inspect-account="${esc(g.accountId)}">用量 →</button>` : ''}</td>
        </tr>
      `);
    });
  }

  return `
    <div class="pt-card">
      <div class="pt-table-wrap">
        <table class="pt-table">
          <thead>
            <tr>
              <th>账号 / 凭据</th><th>驱动</th><th>健康</th><th>模型额度池</th>
              <th>短周期 (5h)</th><th>周额度 (7d)</th><th>最近重置</th><th>本周期用量</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${rows.length ? rows.join('') : '<tr><td colspan="9" class="pt-muted" style="text-align:center;padding:24px;">无匹配账号</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderQuotasTabHtml(data, uiState) {
  const quotas = data?.quotas || { groups: [], updatedAtMs: Date.now() };
  const now = quotas.updatedAtMs || Date.now();
  const allGroups = Array.isArray(quotas.groups) ? quotas.groups : [];
  const summary = getQuotaGroupsSummary(quotas);
  const accountUsage = data?.accountUsage || {};

  const selectedDriver = uiState.quotaDriver || 'all';
  const sortMode = uiState.quotaSort || 'remaining';
  const viewMode = uiState.quotaView || 'cards';
  const hideEmail = Boolean(uiState.hideEmail);

  const filtered = allGroups
    .filter(g => selectedDriver === 'all' || g.driver === selectedDriver)
    .slice()
    .sort((a, b) => {
      if (sortMode === 'name') {
        return String(a.accountId).localeCompare(String(b.accountId));
      }
      if (sortMode === 'reset') {
        const ra = a.nextResetMs ?? Number.MAX_SAFE_INTEGER;
        const rb = b.nextResetMs ?? Number.MAX_SAFE_INTEGER;
        return ra - rb || String(a.accountId).localeCompare(String(b.accountId));
      }
      // default: lowest remaining percent first (tightest accounts surface first!)
      const ma = a.minRemainingPercent != null ? a.minRemainingPercent : 999;
      const mb = b.minRemainingPercent != null ? b.minRemainingPercent : 999;
      return ma - mb || String(a.accountId).localeCompare(String(b.accountId));
    });

  const driverDistText = summary.drivers.length
    ? summary.drivers.map(d => `${d.label} ${d.count}`).join(' · ')
    : '未检测到已启用账号';

  const lowest = summary.lowestWindow;
  const lowestTone = lowest ? quotaTone(lowest.remainingPercent) : 'muted';
  const soonest = summary.soonestResetWindow;

  const hasAnyEmail = allGroups.some(g => g.auth?.email);

  const driverPillsHtml = `
    <button class="pt-filter-pill${selectedDriver === 'all' ? ' active' : ''}" data-pt-quota-driver="all">
      全部账号 <span class="pt-mono">(${summary.totalAccounts})</span>
    </button>
    ${summary.drivers.map(d => {
      const dm = driverMeta(d.driver);
      return `
        <button class="pt-filter-pill${selectedDriver === d.driver ? ' active' : ''}" data-pt-quota-driver="${esc(d.driver)}">
          <span class="pt-dot" style="background:${selectedDriver === d.driver ? 'currentColor' : esc(dm.color)};"></span>
          ${esc(d.label)} <span class="pt-mono">(${d.count})</span>
        </button>
      `;
    }).join('')}
  `;

  const mainContentHtml = !allGroups.length
    ? `
      <div class="pt-card" style="text-align:center;padding:36px 20px;">
        <div style="font-size:14px;font-weight:600;margin-bottom:6px;">未检测到已启用的 T3 Code 登录账号</div>
        <div class="pt-muted">请确认已在 T3 Code 设置中启用并登录至少一个 Provider（如 Antigravity / Codex），然后点击右上角「刷新」。</div>
      </div>
    `
    : viewMode === 'table'
      ? renderQuotaMatrixTableHtml(filtered, { now, hideEmail, accountUsage })
      : `
        <div class="pt-quota-grid">
          ${filtered.length
            ? filtered.map(g => renderAccountQuotaCardHtml(g, { now, hideEmail, usage: accountUsage[g.accountId] })).join('')
            : '<div class="pt-card pt-muted" style="text-align:center;padding:28px;">当前筛选条件下无账号</div>'}
        </div>
      `;

  return `
    <div class="pt-kpi-grid">
      <div class="pt-card">
        <div class="pt-kpi-label">已登录 / 已启用账号</div>
        <div class="pt-kpi-val pt-mono">${summary.readyAccounts} <span class="pt-muted" style="font-size:13px;font-weight:500;">/ ${summary.totalAccounts} 有额度</span></div>
        <div class="pt-kpi-sub">${esc(driverDistText)}</div>
      </div>
      <div class="pt-card">
        <div class="pt-kpi-label">账号额度健康分布</div>
        <div class="pt-kpi-val" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:2px;">
          <span class="pt-badge pt-badge-ok pt-mono">健康 ${summary.healthyAccounts}</span>
          <span class="pt-badge pt-badge-warn pt-mono">偏紧 ${summary.warningAccounts}</span>
          <span class="pt-badge pt-badge-err pt-mono">告急 ${summary.criticalAccounts}</span>
        </div>
        <div class="pt-kpi-sub">按各账号最低池剩余：&gt;40% 健康 · ≤40% 偏紧 · ≤15% 告急</div>
      </div>
      <div class="pt-card">
        <div class="pt-kpi-label">最紧缺额度池</div>
        <div class="pt-kpi-val pt-mono pt-text-${lowestTone}">${lowest ? `${lowest.remainingPercent}%` : '-'}</div>
        <div class="pt-kpi-sub" title="${esc(lowest ? `${lowest.displayName} · ${lowest.label}` : '')}">
          ${lowest ? `${esc(lowest.accountId)} · ${esc(lowest.poolLabel || lowest.label)} (${esc(lowest.windowTag || lowest.kind)})` : '暂无可用额度数据'}
        </div>
      </div>
      <div class="pt-card">
        <div class="pt-kpi-label">最近一次重置</div>
        <div class="pt-kpi-val pt-mono">${soonest ? fmtCountdown(Math.max(0, soonest.resetsAtMs - now)) : '-'}</div>
        <div class="pt-kpi-sub">
          ${soonest ? `${esc(soonest.accountId)} · ${esc(soonest.poolLabel || soonest.label)} · ${fmtTimeShort(soonest.resetsAtMs)}` : '当前无倒计时中的额度窗口'}
        </div>
      </div>
    </div>

    <div class="pt-card">
      <div class="pt-quota-toolbar">
        <div class="pt-pill-group">${driverPillsHtml}</div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <select class="pt-select" data-pt-quota-sort="1" title="排序方式">
            <option value="remaining"${sortMode === 'remaining' ? ' selected' : ''}>按剩余最少优先</option>
            <option value="reset"${sortMode === 'reset' ? ' selected' : ''}>按最近重置优先</option>
            <option value="name"${sortMode === 'name' ? ' selected' : ''}>按账号名称</option>
          </select>
          <div class="pt-dash-tabs">
            <button class="pt-tab${viewMode === 'cards' ? ' active' : ''}" data-pt-quota-view="cards" style="padding:3px 9px;font-size:11px;">卡片视图</button>
            <button class="pt-tab${viewMode === 'table' ? ' active' : ''}" data-pt-quota-view="table" style="padding:3px 9px;font-size:11px;">矩阵对比表</button>
          </div>
          ${hasAnyEmail ? `<button class="pt-btn" data-pt-action="toggle-hide-email" title="隐藏或显示账号邮箱">${hideEmail ? '👁 显示邮箱' : '🙈 隐藏邮箱'}</button>` : ''}
        </div>
      </div>
    </div>

    ${mainContentHtml}
  `;
}

function renderDashboardHtml(data, uiState, { standalone = false } = {}) {
  const tab = uiState.tab || 'overview';
  const preset = uiState.preset || data?.range?.preset || 'weeklyQuota';
  const account = uiState.account || 'all';
  const model = uiState.model || 'all';
  const status = uiState.status || 'all';
  const session = uiState.session || '';
  const onlyAnomalies = Boolean(uiState.onlyAnomalies);
  const heatmapMetric = uiState.heatmapMetric || 'tokens';

  const kpis = data?.summary?.kpis || {};
  const models = data?.summary?.models || [];
  const facets = data?.facets || { accounts: [], models: [] };
  const range = data?.range || {};
  const anomalySummary = data?.anomalySummary || { total: 0, excludedCompactions: 0 };
  const quotaSummary = getQuotaGroupsSummary(data?.quotas);
  const quotaTabTone = quotaSummary.criticalAccounts > 0
    ? 'danger'
    : quotaSummary.warningAccounts > 0
      ? 'warning'
      : quotaSummary.readyAccounts > 0
        ? 'success'
        : 'muted';

  const cycleDesc = range.preset === 'weeklyQuota'
    ? (range.status === 'active'
      ? `本轮周限额周期：${fmtTime(range.start)} 起 · 距离下次重置约 ${fmtCountdown(range.resetsAtMs - Date.now())}`
      : `本轮周限额周期（未检测到活跃重置时间，已回退近 7 天：${fmtTime(range.start)} 起）`)
    : `统计范围：${range.start ? fmtTime(range.start) : '全部历史'} → ${fmtTime(range.end)}`;

  const topModels = models.slice(0, 6);
  const tokenBar = topModels.map((m, idx) =>
    m.tokenSharePercent > 0
      ? `<div style="width:${m.tokenSharePercent}%;background:${CHART_COLORS[idx % CHART_COLORS.length]}" title="${esc(m.modelId)}: ${m.tokenSharePercent}% (${fmtTokens(m.totalTokens)})"></div>`
      : ''
  ).join('');
  const costBar = topModels.map((m, idx) =>
    m.costSharePercent > 0
      ? `<div style="width:${m.costSharePercent}%;background:${CHART_COLORS[idx % CHART_COLORS.length]}" title="${esc(m.modelId)}: ${m.costSharePercent}% (${fmtUsd(m.costUsd)})"></div>`
      : ''
  ).join('');
  const legendHtml = topModels.map((m, idx) => `
    <span class="pt-legend-item">
      <span class="pt-swatch" style="background:${CHART_COLORS[idx % CHART_COLORS.length]}"></span>
      <span>${esc(m.modelId)}</span>
      <span class="pt-mono pt-muted">${m.tokenSharePercent}%</span>
    </span>
  `).join('');

  const overviewTabHtml = `
    <div class="pt-cycle-banner">
      <span>📅 ${esc(cycleDesc)}</span>
      <span class="pt-muted pt-mono">本范围异常掉缓存: <strong class="${kpis.anomalyCount ? 'pt-text-danger' : 'pt-text-success'}">${kpis.anomalyCount || 0}</strong> · 压缩误报已排除: ${anomalySummary.excludedCompactions || 0}</span>
    </div>

    ${renderOverviewQuotaStripHtml(data)}

    <div class="pt-kpi-grid">
      <div class="pt-card">
        <div class="pt-kpi-label">请求次数</div>
        <div class="pt-kpi-val pt-mono">${kpis.totalRequests ?? 0}</div>
        <div class="pt-kpi-sub">成功率 <span class="${kpis.successRate != null && kpis.successRate < 95 ? 'pt-text-warning' : 'pt-text-success'} pt-mono">${fmtPct(kpis.successRate)}</span> <span class="pt-mono">(${kpis.knownOutcomeCount ?? 0}/${kpis.totalRequests ?? 0} 已知)</span> · 重试 ${kpis.retryRequests ?? 0}</div>
      </div>
      <div class="pt-card">
        <div class="pt-kpi-label">总 Token 消耗</div>
        <div class="pt-kpi-val pt-mono">${fmtTokens(kpis.totalTokens)}</div>
        <div class="pt-kpi-sub pt-mono">输入 ${fmtTokens(kpis.inputTokens)} · 缓存 ${fmtTokens(kpis.cacheReadTokens)} · 输出 ${fmtTokens(kpis.outputTokens)}</div>
      </div>
      <div class="pt-card">
        <div class="pt-kpi-label">缓存命中率</div>
        <div class="pt-kpi-val pt-mono ${(kpis.cacheHitPercent ?? 0) >= 50 ? 'pt-text-success' : ''}">${fmtPct(kpis.cacheHitPercent)}</div>
        <div class="pt-kpi-sub">估算节省 <span class="pt-mono pt-text-success">${fmtUsd(kpis.savedUsd)}</span></div>
      </div>
      <div class="pt-card">
        <div class="pt-kpi-label">参考费用（按官方价估算）</div>
        <div class="pt-kpi-val pt-mono">${fmtUsd(kpis.costUsd)}</div>
        <div class="pt-kpi-sub">思考 Token ${fmtTokens(kpis.thinkingTokens)} · 缓存写入 ${fmtTokens(kpis.cacheWriteTokens)}</div>
      </div>
    </div>

    <div class="pt-card">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
        <div>
          <strong>53 周用量热力图</strong>
          <span class="pt-muted" style="margin-left:8px;font-size:11px;">活跃 ${data?.heatmap?.activeDays || 0} 天 (${esc(data?.heatmap?.startDate)} ~ ${esc(data?.heatmap?.endDate)})</span>
        </div>
        <div class="pt-dash-tabs">
          <button class="pt-tab${heatmapMetric === 'tokens' ? ' active' : ''}" data-pt-heatmap="tokens">Token</button>
          <button class="pt-tab${heatmapMetric === 'requests' ? ' active' : ''}" data-pt-heatmap="requests">请求数</button>
          <button class="pt-tab${heatmapMetric === 'costUsd' ? ' active' : ''}" data-pt-heatmap="costUsd">参考费用</button>
        </div>
      </div>
      ${renderHeatmapSvg(data?.heatmap, heatmapMetric)}
    </div>

    <div class="pt-two-col">
      <div class="pt-card">
        <div style="font-weight:600;margin-bottom:6px;">模型 Token 与费用占比对比</div>
        <div class="pt-muted" style="font-size:11px;">Token 占比</div>
        <div class="pt-stacked-bar">${tokenBar || '<div style="width:100%" class="pt-tone-muted"></div>'}</div>
        <div class="pt-muted" style="font-size:11px;margin-top:8px;">参考费用占比</div>
        <div class="pt-stacked-bar">${costBar || '<div style="width:100%" class="pt-tone-muted"></div>'}</div>
        <div class="pt-legend" style="margin-top:10px;">${legendHtml || '<span class="pt-muted">暂无模型数据</span>'}</div>
      </div>

      <div class="pt-card">
        <div style="font-weight:600;margin-bottom:8px;">模型健康状态</div>
        <div class="pt-table-wrap">
          <table class="pt-table">
            <thead>
              <tr><th>模型</th><th>状态</th><th>成功率 (已知)</th><th>重试率</th><th>错误分布</th></tr>
            </thead>
            <tbody>
              ${models.length ? models.map(m => {
                const badgeCls = m.healthStatus === 'healthy' ? 'pt-badge-ok'
                  : m.healthStatus === 'warning' ? 'pt-badge-warn'
                  : m.healthStatus === 'degraded' ? 'pt-badge-err'
                  : 'pt-badge-muted';
                const badgeText = m.healthStatus === 'healthy' ? '健康'
                  : m.healthStatus === 'warning' ? '波动'
                  : m.healthStatus === 'degraded' ? '异常'
                  : '仅用量';
                const errSummary = Object.entries(m.errorCodes || {})
                  .map(([k, v]) => `${ERROR_CODE_LABELS[k] || k}:${v}`)
                  .join(' / ') || '-';
                return `
                  <tr>
                    <td class="pt-mono">${esc(m.modelId)}</td>
                    <td><span class="pt-badge ${badgeCls}">${badgeText}</span></td>
                    <td class="pt-mono">${fmtPct(m.successRate)} <span class="pt-muted">(${m.knownOutcomeCount}/${m.requests})</span></td>
                    <td class="pt-mono">${fmtPct(m.retryRate)}</td>
                    <td class="pt-muted">${esc(errSummary)}</td>
                  </tr>
                `;
              }).join('') : '<tr><td colspan="5" class="pt-muted">当前周期无记录</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="pt-card">
      <div style="font-weight:600;margin-bottom:8px;">各模型详细指标对比（Token / 费用 / 缓存命中率 / 平均速度）</div>
      <div class="pt-table-wrap">
        <table class="pt-table">
          <thead>
            <tr>
              <th>模型</th><th>请求</th><th>总 Token (占比)</th><th>参考费用 (占比)</th>
              <th>缓存命中率</th><th>平均速度</th><th>峰值速度</th><th>平均 TTFT</th>
            </tr>
          </thead>
          <tbody>
            ${models.length ? models.map(m => {
              const tpsPrefix = m.avgTpsKind === 'e2e-estimate' ? '~' : '';
              const tpsNote = m.avgTpsKind === 'e2e-estimate' ? '端到端估算速度' : '纯生成流速度';
              return `
              <tr>
                <td class="pt-mono"><strong>${esc(m.modelId)}</strong></td>
                <td class="pt-mono">${m.requests}</td>
                <td class="pt-mono">${fmtTokens(m.totalTokens)} <span class="pt-muted">(${m.tokenSharePercent}%)</span></td>
                <td class="pt-mono">${fmtUsd(m.costUsd)} <span class="pt-muted">(${m.costSharePercent}%)</span></td>
                <td>
                  <div style="display:flex;align-items:center;gap:6px;">
                    <span class="pt-bar-mini"><span class="pt-bar-fill pt-tone-success" style="width:${Math.min(100, m.cacheHitPercent || 0)}%"></span></span>
                    <span class="pt-mono">${fmtPct(m.cacheHitPercent)}</span>
                  </div>
                </td>
                <td class="pt-mono" title="${tpsNote}">${m.avgTps != null ? `${tpsPrefix}${m.avgTps} tok/s` : '-'}</td>
                <td class="pt-mono pt-muted">${m.peakTps != null ? `${tpsPrefix}${m.peakTps} tok/s` : '-'}</td>
                <td class="pt-mono pt-muted">${fmtDuration(m.avgTtftMs)}</td>
              </tr>
            `;
            }).join('') : '<tr><td colspan="8" class="pt-muted">当前周期无模型请求</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;

  const requestsTabHtml = `
    <div class="pt-card">
      <div class="pt-filter-bar">
        <select class="pt-select" data-pt-filter="account" title="按账号/实例筛选">
          <option value="all"${account === 'all' ? ' selected' : ''}>全部账号/实例</option>
          ${facets.accounts.map(a => `<option value="${esc(a)}"${account === a ? ' selected' : ''}>${esc(a)}</option>`).join('')}
        </select>
        <select class="pt-select" data-pt-filter="model" title="按模型筛选">
          <option value="all"${model === 'all' ? ' selected' : ''}>全部模型</option>
          ${facets.models.map(m => `<option value="${esc(m)}"${model === m ? ' selected' : ''}>${esc(m)}</option>`).join('')}
        </select>
        <select class="pt-select" data-pt-filter="status" title="按状态筛选">
          <option value="all"${status === 'all' ? ' selected' : ''}>全部状态</option>
          <option value="success"${status === 'success' ? ' selected' : ''}>仅成功</option>
          <option value="error"${status === 'error' ? ' selected' : ''}>仅失败</option>
          <option value="retried"${status === 'retried' ? ' selected' : ''}>含重试</option>
        </select>
        <input class="pt-input" type="search" data-pt-filter="session" value="${esc(session)}" placeholder="筛选会话标题或 ID..." style="min-width:190px;" />
        <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;font-size:12px;">
          <input type="checkbox" data-pt-filter="onlyAnomalies"${onlyAnomalies ? ' checked' : ''} />
          <span>仅看异常掉缓存 (<strong class="pt-text-danger" data-pt-anomaly-count>${anomalySummary.total || 0}</strong>)</span>
        </label>
        <span class="pt-muted" style="font-size:11px;margin-left:auto;" data-pt-compaction-note>已排除冷启动及 ${anomalySummary.excludedCompactions || 0} 次上下文压缩误报</span>
      </div>
    </div>

    <div class="pt-card" data-pt-requests-card>
      ${renderRequestsTableCardHtml(data)}
    </div>
  `;

  const quotasTabHtml = renderQuotasTabHtml(data, uiState);

  return `
    <div class="pt-dashboard${standalone ? ' standalone' : ''}">
      <div class="pt-dash-header">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
          <strong style="font-size:14px;">⚡ T3Tools</strong>
          <div class="pt-dash-tabs">
            <button class="pt-tab${tab === 'overview' ? ' active' : ''}" data-pt-tab="overview">用量概览 & 模型对比</button>
            <button class="pt-tab${tab === 'quotas' ? ' active' : ''}" data-pt-tab="quotas"><span class="pt-dot pt-tone-${quotaTabTone}" style="margin-right:5px;vertical-align:middle;"></span>账号额度 (${quotaSummary.totalAccounts})</button>
            <button class="pt-tab${tab === 'requests' ? ' active' : ''}" data-pt-tab="requests">请求明细 & 掉缓存 (<span data-pt-tab-anom-count>${anomalySummary.total || 0}</span>)</button>
          </div>
        </div>
        <div class="pt-dash-controls">
          <select class="pt-select" data-pt-filter="preset" title="统计周期">
            <option value="weeklyQuota"${preset === 'weeklyQuota' ? ' selected' : ''}>本轮周限额周期</option>
            <option value="today"${preset === 'today' ? ' selected' : ''}>今天</option>
            <option value="24h"${preset === '24h' ? ' selected' : ''}>近 24 小时</option>
            <option value="week"${preset === 'week' ? ' selected' : ''}>自然周</option>
            <option value="30d"${preset === '30d' ? ' selected' : ''}>近 30 天</option>
            <option value="all"${preset === 'all' ? ' selected' : ''}>全部历史</option>
          </select>
          <select class="pt-select" data-pt-filter="account" title="账号/实例">
            <option value="all"${account === 'all' ? ' selected' : ''}>全部账号</option>
            ${facets.accounts.map(a => `<option value="${esc(a)}"${account === a ? ' selected' : ''}>${esc(a)}</option>`).join('')}
          </select>
          <button class="pt-btn" data-pt-action="refresh">刷新</button>
          ${standalone
            ? `<button class="pt-btn" data-pt-action="toggle-theme">切换明暗主题</button>`
            : `<button class="pt-btn" data-pt-action="close-dashboard">关闭 ✕</button>`}
        </div>
      </div>
      <div class="pt-dash-body">
        ${tab === 'quotas' ? quotasTabHtml : tab === 'requests' ? requestsTabHtml : overviewTabHtml}
      </div>
    </div>
  `;
}
