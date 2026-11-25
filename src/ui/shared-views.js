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
    <div class="pt-quota-ring" title="${remainingPct != null ? `最低池剩余 ${esc(remainingPct)}%` : '暂无可用额度'}">
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
.pt-led-root{container-type:inline-size;color:var(--pt-fg);font-family:var(--pt-font-sans);font-variant-numeric:tabular-nums;min-width:0}
.pt-led .pt-row-anomaly{background:color-mix(in srgb,var(--pt-danger) 8%,var(--pt-card))}
.pt-led-wrap.tight2 .ttft{display:none}
.pt-led-hit.dim{fill:var(--pt-card);fill-opacity:.65}
.pt-led-legend{position:absolute;right:6px;top:2px;font-size:10px;color:var(--pt-muted)}
.pt-led .hit-high{color:var(--pt-success)}.pt-led .hit-mid{color:var(--pt-warning)}.pt-led .hit-low{color:var(--pt-danger)}
.pt-led-req h3{display:flex;gap:10px;align-items:center}.pt-led-req pre{padding:10px;background:var(--pt-surface)}
.pt-led-root *{box-sizing:border-box}.pt-led-root small{color:var(--pt-muted);font-size:11px}.pt-led-tools,.pt-led-tools>div,.pt-led-bar,.pt-led-head,.pt-led-pager{display:flex;align-items:center;flex-wrap:wrap;gap:7px}.pt-led-tools{margin-bottom:12px}.pt-led-tools label,.pt-led-bar span{font-size:12px;color:var(--pt-muted)}.pt-led-tools select{max-width:175px}.pt-led-tools input{flex:1;min-width:180px}.pt-led-root button{cursor:pointer}.pt-led-root button.on{background:var(--pt-surface);color:var(--pt-accent);border-color:var(--pt-accent)}.pt-led-root button:disabled{opacity:.45;cursor:default}
.pt-led-segs{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:7px;background:var(--pt-surface);border:1px solid var(--pt-border)}.pt-led-segs button{border:0;background:transparent;padding:3px 9px;border-radius:5px;color:var(--pt-muted)}.pt-led-segs button.on{background:var(--pt-card);color:var(--pt-fg);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.2)}
.pt-led-strip,.pt-led-trend,.pt-led-speed,.pt-led-vias,.pt-led-box,.pt-led-wrap{border:1px solid var(--pt-border);border-radius:var(--pt-radius,10px);background:var(--pt-card);margin-bottom:12px}.pt-led-strip{display:grid;grid-template-columns:repeat(5,minmax(0,1fr))}.pt-led-strip>div{padding:12px 14px;min-width:0;border-inline-end:1px solid var(--pt-border);transition:background-color .14s ease}.pt-led-strip>div:last-child{border-inline-end:0}.pt-led-strip>div[data-pt-ov-jump]{cursor:pointer}.pt-led-strip>div[data-pt-ov-jump]:hover{background:color-mix(in srgb,var(--pt-accent) 6%,var(--pt-card))}.pt-led-strip strong,.pt-led-strip small{display:block}.pt-led-strip strong{font-size:22px;letter-spacing:-.025em;margin:3px 0}.pt-led-cost,.duration-fast,.pt-led-st.success{color:var(--pt-success)}.duration-slow{color:var(--pt-warning)}.duration-long,.pt-led-st.error,.pt-led-jump[data-pt-led-jump=error],.pt-led-jump[data-pt-ov-jump=error]{color:var(--pt-danger)}.pt-led-root .pt-led-jump{background:none;border:0;padding:0;font-size:inherit;text-decoration:underline dotted;color:inherit;cursor:pointer}.pt-led-root .pt-led-jump:hover{color:var(--pt-accent)}.pt-led-meter{height:5px;border-radius:3px;overflow:hidden;background:var(--pt-surface);margin-top:7px}.pt-led-meter i,.pt-led-hscroll i{display:block;height:100%;background:var(--pt-success)}
.pt-ov-root{display:flex;flex-direction:column;gap:12px}.pt-ov-root .pt-led-strip,.pt-ov-root .pt-led-trend{margin-bottom:0}.pt-cycle-pill{appearance:none;border:1px solid var(--pt-border);background:var(--pt-card);color:var(--pt-fg);border-radius:999px;padding:2px 9px;font:inherit;font-size:11px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;transition:border-color .14s ease,background-color .14s ease}.pt-cycle-pill:hover{border-color:var(--pt-accent);background:color-mix(in srgb,var(--pt-accent) 10%,var(--pt-card))}.pt-quota-chip.active{border-color:var(--pt-accent);background:color-mix(in srgb,var(--pt-accent) 14%,var(--pt-surface));box-shadow:0 0 0 1px color-mix(in srgb,var(--pt-accent) 30%,transparent)}.pt-ov-hint{font-size:11px;color:var(--pt-muted);margin-inline-start:6px}.pt-led-head-card{border:1px solid var(--pt-border);border-radius:var(--pt-radius,10px);background:var(--pt-card);margin-bottom:10px}.pt-model-link{appearance:none;border:0;background:none;padding:0;color:var(--pt-fg);font:inherit;font-weight:700;cursor:pointer;text-align:left;text-decoration:underline dotted transparent;transition:color .14s ease,text-decoration-color .14s ease}.pt-model-link:hover{color:var(--pt-accent);text-decoration-color:var(--pt-accent)}.pt-sort-th{appearance:none;border:0;background:none;padding:0;color:inherit;font:inherit;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:3px}.pt-sort-th:hover,.pt-sort-th.on{color:var(--pt-fg)}
.pt-led-bar,.pt-led-head,.pt-led-speed h4{padding:9px 12px}.pt-led-bar span,.pt-led-head small:first-of-type{margin-inline-start:auto}.pt-led-body{display:grid;grid-template-columns:minmax(0,1fr) 272px;border-top:1px solid var(--pt-border)}.pt-led-chart{height:236px;position:relative}.pt-led-chart svg{display:block;width:100%;height:100%;font:11px var(--pt-font-sans);fill:var(--pt-muted)}.pt-led-hit{fill:transparent;cursor:pointer}.pt-led-hit:hover,.pt-led-hit.selected{fill:var(--pt-accent);fill-opacity:.14}.pt-led-tip{position:absolute;z-index:4;background:var(--pt-card);padding:8px 10px;border:1px solid var(--pt-border);border-radius:8px;box-shadow:var(--pt-shadow);pointer-events:none;font-size:11px;max-width:100%;max-height:100%;overflow:hidden}
.pt-led-rank{height:0;min-height:100%;overflow-y:auto;border-left:1px solid var(--pt-border);padding:5px}.pt-led-rank.more-below{mask-image:linear-gradient(#000 92%,transparent)}.pt-led-rank.more-above{mask-image:linear-gradient(transparent,#000 8%)}.pt-led-rank.more-above.more-below{mask-image:linear-gradient(transparent,#000 8%,#000 92%,transparent)}.pt-led-rank button{display:grid;width:100%;grid-template-columns:minmax(0,1fr) auto;gap:4px;text-align:left;padding:7px;border-radius:7px;background:none;border:0;color:inherit}.pt-led-rank b{color:var(--sw);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pt-led-rank i,.pt-led-rank small{grid-column:span 2}.pt-led-rank i{height:3px;background:var(--sw);border-radius:4px}.pt-led-rank button:hover,.pt-led tbody tr:hover{background:var(--pt-surface)}
.pt-led-speed>div{max-height:240px;overflow:auto}.pt-led-speed h4{margin:0}.pt-led-speed th{position:sticky;top:0;background:var(--pt-card)}.pt-led-speed table,.pt-led{width:100%;border-collapse:collapse;font-size:12px}.pt-led-speed th,.pt-led-speed td,.pt-led th,.pt-led td{padding:7px 9px;text-align:left;border-bottom:1px solid var(--pt-border)}.pt-led-wrap{overflow:auto;margin-bottom:0}.pt-led th,.pt-led td{white-space:nowrap}.pt-led td.session,.pt-led td.model,.pt-led td.where{max-width:170px;overflow:hidden;text-overflow:ellipsis}.pt-led td.n,.pt-led th.n{text-align:right}.pt-led td small{display:block}.pt-led tr{cursor:pointer}.pt-led-dot{display:inline-block;background:var(--pt-chart-1);width:6px;height:6px;border-radius:50%;vertical-align:middle;margin-right:5px}.pt-led-dot.cx{background:var(--pt-chart-2)}.pt-led-wrap.tight .lc-opt,.pt-led-wrap.tight2 .lc-opt2{display:none}.tight2 .duration:after{content:attr(data-ttft);display:block;font-size:10px;color:var(--pt-muted)}.pt-led-hscroll{overflow-x:auto;position:sticky;bottom:0;background:var(--pt-card);height:16px;z-index:2}.pt-led-hscroll i{height:1px;background:none}.pt-led-pager{justify-content:center;padding:12px}.pt-led-head{font-size:12px}
.pt-led-vias{display:flex;overflow:auto}.pt-led-vias button{position:relative;flex:1;min-width:120px;border:0;border-radius:0;background:none;padding:10px 14px;text-align:left;display:block}.pt-led-vias button+button{border-left:1px solid var(--pt-border)}.pt-led-vias button:hover{background:var(--pt-surface)}.pt-led-vias button.on{background:transparent;color:var(--pt-fg);font-weight:600}.pt-led-vias small{display:block;margin-top:2px;font-weight:400}.pt-led-vias .on:after{content:"";position:absolute;bottom:0;left:14px;right:14px;height:2px;border-radius:1px;background:var(--pt-accent)}.pt-led-box{padding:16px}.pt-led-dl{display:grid;grid-template-columns:minmax(110px,22%) 1fr;gap:0 12px}.pt-led-dl dt,.pt-led-dl dd{margin:0;padding:7px 0;border-bottom:1px solid var(--pt-border);overflow-wrap:anywhere}.pt-led-dl dt{color:var(--pt-muted)}.pt-led-req{animation:ptLedReqIn .18s cubic-bezier(.23,1,.32,1)}.pt-led-req pre{white-space:pre-wrap;overflow-wrap:anywhere;border-radius:8px;border:1px solid var(--pt-border)}.pt-led-root [hidden]{display:none}@keyframes ptLedReqIn{from{opacity:0;transform:translateX(10px)}}
@container(max-width:960px){.pt-led-strip{grid-template-columns:repeat(2,minmax(0,1fr))}.pt-led-strip>div:nth-child(even){border-inline-end:0}.pt-led-strip>div:last-child{grid-column:span 2;border-bottom:0}.pt-led-strip>div{border-bottom:1px solid var(--pt-border)}}
@container(max-width:860px){.pt-led-body{grid-template-columns:1fr}.pt-led-rank{height:auto;min-height:0;max-height:180px;border-left:0;border-top:1px solid var(--pt-border)}}

.pt-badge-btn {
  appearance: none;
  border: 1px solid transparent;
  cursor: pointer;
  font-family: inherit;
  transition: filter 0.14s ease, border-color 0.14s ease, transform 0.12s ease;
}
.pt-badge-btn:hover {
  filter: brightness(1.12);
  border-color: currentColor;
}
.pt-tracker {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.pt-tracker-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.pt-tracker-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.pt-tracker-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.pt-tracker-subhead {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--pt-muted, #9ca3af);
  margin: 0 0 6px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.pt-error-trend {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  min-height: 66px;
  padding: 8px 10px 6px;
  border-radius: 8px;
  background: var(--pt-surface, #1b1e25);
  border: 1px solid color-mix(in srgb, var(--pt-border, rgba(255,255,255,0.08)) 85%, transparent);
  overflow-x: auto;
}
.pt-error-trend button {
  appearance: none;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--pt-muted, #9ca3af);
  padding: 3px 4px;
  font: inherit;
  font-size: 10px;
  cursor: pointer;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  flex: none;
  transition: background-color 0.14s ease, border-color 0.14s ease, color 0.14s ease;
}
.pt-error-trend button:hover,
.pt-error-trend button.active {
  background: color-mix(in srgb, var(--pt-danger, #ef4444) 12%, transparent);
  border-color: color-mix(in srgb, var(--pt-danger, #ef4444) 42%, transparent);
  color: var(--pt-fg, #f3f4f6);
}
.pt-error-trend button span {
  display: flex;
  flex-direction: column;
  width: 16px;
  border-radius: 3px;
  overflow: hidden;
  min-height: 4px;
}
.pt-session-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(310px, 1fr));
  gap: 8px;
}
.pt-session-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--pt-surface, #1b1e25);
  border: 1px solid color-mix(in srgb, var(--pt-border, rgba(255,255,255,0.1)) 85%, transparent);
  overflow-wrap: anywhere;
}
.pt-session-card.failing {
  border-color: color-mix(in srgb, var(--pt-danger, #ef4444) 42%, var(--pt-border, rgba(255,255,255,0.1)));
  background: color-mix(in srgb, var(--pt-danger, #ef4444) 5%, var(--pt-surface, #1b1e25));
}
.pt-session-card.retried {
  border-color: color-mix(in srgb, var(--pt-warning, #f59e0b) 42%, var(--pt-border, rgba(255,255,255,0.1)));
  background: color-mix(in srgb, var(--pt-warning, #f59e0b) 5%, var(--pt-surface, #1b1e25));
}
.pt-error-detail.is-error {
  border-left: 3px solid var(--pt-danger, #ef4444);
}
.pt-error-detail.is-recovered {
  border-left: 3px solid var(--pt-warning, #f59e0b);
}
.pt-error-detail.is-resolved {
  border-left: 3px solid var(--pt-success, #22c55e);
  opacity: 0.84;
}
.pt-error-legend {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  color: var(--pt-muted, #9ca3af);
}
.pt-error-legend i {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 2px;
  margin-right: 4px;
  vertical-align: -1px;
}
.pt-session-top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.pt-session-title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.pt-session-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 2px;
}
.pt-error-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pt-error-detail {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--pt-surface, #1b1e25);
  border: 1px solid color-mix(in srgb, var(--pt-border, rgba(255,255,255,0.08)) 85%, transparent);
  overflow-wrap: anywhere;
}
.pt-table .pt-error-detail {
  max-width: 300px;
  min-width: 140px;
  margin-top: 4px;
  padding: 4px 7px;
  white-space: normal;
  background: color-mix(in srgb, var(--pt-bg, #0b0c0f) 55%, transparent);
}
.pt-error-detail summary {
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  list-style-position: inside;
}
.pt-error-detail pre {
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow: auto;
  background: var(--pt-bg, #0b0c0f);
  border: 1px solid color-mix(in srgb, var(--pt-border, rgba(255,255,255,0.08)) 80%, transparent);
  border-radius: 6px;
  padding: 8px 10px;
  margin: 8px 0 6px;
  font-family: var(--pt-font-mono, ui-monospace, Consolas, monospace);
  font-size: 11px;
  line-height: 1.45;
}
.pt-error-detail-meta {
  font-size: 11px;
  color: var(--pt-muted, #9ca3af);
  margin: 0 0 6px;
}
.pt-error-detail-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 6px;
}
[data-pt-heatmap-day] { cursor: pointer; }

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
  width: var(--pt-ov-width, 304px);
  max-width: calc(100vw - 32px);
  border-radius: var(--pt-radius, 10px);
  background: var(--pt-card, #14161b);
  border: 1px solid var(--pt-border, rgba(255,255,255,0.12));
  box-shadow: var(--pt-shadow, 0 10px 30px rgba(0,0,0,0.45));
  overflow: hidden;
  backdrop-filter: blur(10px);
}
.pt-overview-card.collapsed { width: var(--pt-ov-width, auto); min-width: 196px; }
.pt-overview-card.docked {
  width: 100%;
  max-width: none;
  border-radius: 0 0 var(--pt-radius, 10px) var(--pt-radius, 10px);
  border: 0;
  border-top: 1px solid var(--pt-border, rgba(255,255,255,0.12));
  box-shadow: none;
  backdrop-filter: none;
}
.pt-overview-card.docked.docked-stack {
  border-radius: var(--pt-radius, 12px);
  border: 1px solid var(--pt-border, rgba(255,255,255,0.12));
}
.pt-overview-card.docked.collapsed {
  width: 100%;
  min-width: 0;
}
.pt-overview-card.docked .pt-overview-body {
  max-height: var(--pt-ov-body-max-h, 250px);
}
.pt-overview-card.docked .pt-step-list {
  max-height: 112px;
}
.pt-overview-card.docked .pt-ov-quota-grid:not(.single) {
  grid-template-columns: repeat(auto-fit, minmax(118px, 1fr));
}
.pt-dock-pill {
  font-size: 9.5px;
  padding: 0 5px;
  border-radius: 999px;
  border: 1px solid var(--pt-border, rgba(255,255,255,0.12));
  color: var(--pt-muted, #9ca3af);
  background: var(--pt-card, #14161b);
  line-height: 1.5;
  flex: none;
}
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
  max-height: var(--pt-ov-body-max-h, 420px);
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
  width: min(1220px, calc(100vw - 40px));
  height: min(860px, calc(100vh - 40px));
  max-height: calc(100vh - 40px);
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
  height: auto;
  max-height: none;
  min-height: calc(100vh - 32px);
  margin: 16px auto;
}
.pt-dashboard .app-shell {
  width: 100%;
  height: 100%;
  min-height: 0;
}

/* Unified App Shell (shared by standalone window & T3-attached overlay) */
.app-shell {
  display: flex;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
  background: var(--pt-bg, #0b0c0f);
  color: var(--pt-fg, #f3f4f6);
  container-type: inline-size;
}
.app-side {
  width: 214px;
  flex: 0 0 214px;
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--pt-card, #14161b) 94%, var(--pt-bg, #0b0c0f));
  border-right: 1px solid var(--pt-border, rgba(255,255,255,0.09));
  user-select: none;
  transition: width 0.18s ease, flex-basis 0.18s ease;
}
.app-shell[data-side-collapsed="true"] .app-side {
  width: 0;
  flex-basis: 0;
  border-right-width: 0;
  overflow: hidden;
}
.side-head {
  height: 50px;
  padding: 0 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex: none;
  border-bottom: 1px solid color-mix(in srgb, var(--pt-border, rgba(255,255,255,0.08)) 65%, transparent);
}
.side-brand {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  font-weight: 700;
  font-size: 13.5px;
  letter-spacing: -0.01em;
  white-space: nowrap;
}
.side-logo {
  width: 24px;
  height: 24px;
  border-radius: 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, var(--pt-accent, #6366f1), color-mix(in srgb, var(--pt-accent, #6366f1) 62%, #312e81));
  color: #fff;
  font-size: 11px;
  font-weight: 800;
  box-shadow: 0 2px 10px color-mix(in srgb, var(--pt-accent, #6366f1) 36%, transparent);
  flex: none;
}
.side-ver {
  font-size: 10px;
  font-weight: 500;
  color: var(--pt-muted, #9ca3af);
  padding: 1px 5px;
  border-radius: 999px;
  background: var(--pt-surface, #1b1e25);
}
.side-scroll {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 12px 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nav-group-label {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--pt-muted, #9ca3af);
  padding: 10px 10px 4px;
  opacity: 0.8;
}
.nav-group-label:first-child { padding-top: 2px; }
.nav-item {
  appearance: none;
  width: 100%;
  border: 1px solid transparent;
  background: transparent;
  color: color-mix(in srgb, var(--pt-fg, #f3f4f6) 80%, var(--pt-muted, #9ca3af));
  border-radius: 8px;
  padding: 8px 10px;
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 9px;
  cursor: pointer;
  text-align: left;
  transition: background-color 0.14s ease, color 0.14s ease, border-color 0.14s ease;
}
.nav-item:hover {
  background: color-mix(in srgb, var(--pt-fg, #fff) 6%, transparent);
  color: var(--pt-fg, #f3f4f6);
}
.nav-item.active {
  background: color-mix(in srgb, var(--pt-accent, #6366f1) 15%, var(--pt-surface, #1b1e25));
  border-color: color-mix(in srgb, var(--pt-accent, #6366f1) 34%, transparent);
  color: var(--pt-fg, #f3f4f6);
  font-weight: 600;
}
.nav-item.active .nav-ic { color: var(--pt-accent, #6366f1); }
.nav-ic {
  width: 15px;
  height: 15px;
  flex: none;
  color: var(--pt-muted, #9ca3af);
  transition: color 0.14s ease;
}
.nav-badge {
  margin-left: auto;
  font-family: var(--pt-font-mono, ui-monospace, Consolas, monospace);
  font-size: 10.5px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--pt-surface, #1b1e25);
  color: var(--pt-muted, #9ca3af);
}
.nav-badge[data-tone="danger"] {
  background: color-mix(in srgb, var(--pt-danger, #ef4444) 16%, transparent);
  color: var(--pt-danger, #ef4444);
}
.nav-badge[data-tone="warning"] {
  background: color-mix(in srgb, var(--pt-warning, #f59e0b) 16%, transparent);
  color: var(--pt-warning, #f59e0b);
}
.nav-badge[data-tone="success"] {
  background: color-mix(in srgb, var(--pt-success, #22c55e) 16%, transparent);
  color: var(--pt-success, #22c55e);
}
.side-foot {
  flex: none;
  padding: 10px;
  border-top: 1px solid color-mix(in srgb, var(--pt-border, rgba(255,255,255,0.08)) 70%, transparent);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.side-attach {
  width: 100%;
  appearance: none;
  border: 1px solid var(--pt-border, rgba(255,255,255,0.1));
  background: var(--pt-surface, #1b1e25);
  color: var(--pt-fg, #f3f4f6);
  border-radius: 8px;
  padding: 7px 10px;
  font: inherit;
  font-size: 11.5px;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  text-align: left;
  transition: border-color 0.14s ease, background-color 0.14s ease;
}
.side-attach:hover { border-color: var(--pt-accent, #6366f1); }
.side-attach-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  flex: none;
  background: var(--pt-muted, #9ca3af);
}
.side-attach[data-state="attached"] {
  border-color: color-mix(in srgb, var(--pt-success, #22c55e) 32%, transparent);
  background: color-mix(in srgb, var(--pt-success, #22c55e) 10%, var(--pt-surface, #1b1e25));
}
.side-attach[data-state="attached"] .side-attach-dot {
  background: var(--pt-success, #22c55e);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--pt-success, #22c55e) 22%, transparent);
}
.side-attach[data-state="needs-restart"] {
  border-color: color-mix(in srgb, var(--pt-warning, #f59e0b) 38%, transparent);
  background: color-mix(in srgb, var(--pt-warning, #f59e0b) 10%, var(--pt-surface, #1b1e25));
}
.side-attach[data-state="needs-restart"] .side-attach-dot { background: var(--pt-warning, #f59e0b); }
.side-attach[data-state="waiting"] .side-attach-dot {
  background: var(--pt-accent, #6366f1);
  animation: ptPulse 1.6s infinite ease-in-out;
}
.side-attach-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 auto;
}
.app-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.app-top {
  height: 50px;
  flex: none;
  padding: 0 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--pt-border, rgba(255,255,255,0.08));
  background: color-mix(in srgb, var(--pt-bg, #0b0c0f) 94%, var(--pt-card, #14161b));
  user-select: none;
}
.top-left, .top-right {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.top-title {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
}
.top-toast {
  font-size: 11.5px;
  color: var(--pt-accent, #6366f1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 240px;
}
.icon-btn {
  appearance: none;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--pt-muted, #9ca3af);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background-color 0.14s ease, color 0.14s ease, border-color 0.14s ease;
}
.icon-btn:hover {
  background: var(--pt-surface, #1b1e25);
  border-color: var(--pt-border, rgba(255,255,255,0.1));
  color: var(--pt-fg, #f3f4f6);
}
.top-seg {
  display: none;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  background: var(--pt-surface, #1b1e25);
  border: 1px solid var(--pt-border, rgba(255,255,255,0.08));
}
.app-shell[data-side-collapsed="true"] .top-seg { display: inline-flex; }
.top-seg button {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--pt-muted, #9ca3af);
  padding: 4px 9px;
  border-radius: 6px;
  font: inherit;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}
.top-seg button.active {
  background: var(--pt-card, #14161b);
  color: var(--pt-fg, #f3f4f6);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0,0,0,0.25);
}
.app-viewport {
  flex: 1 1 auto;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 18px 20px 28px;
}
.app-view {
  width: min(1160px, 100%);
  margin: 0 auto;
  display: none;
  flex-direction: column;
  gap: 14px;
}
.app-view.active { display: flex; }
.view-data-head {
  width: min(1160px, 100%);
  margin: 0 auto 14px;
  display: none;
}
.view-data-head.active { display: block; }
.settings-wrap {
  width: min(760px, 100%);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.settings-group-title {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--pt-muted, #9ca3af);
  margin: 2px 0 -6px 2px;
}
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 11px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--pt-border, rgba(255,255,255,0.08)) 70%, transparent);
}
.setting-row:first-child { padding-top: 2px; }
.setting-row:last-child { border-bottom: none; padding-bottom: 2px; }
.setting-label {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--pt-fg, #f3f4f6);
  display: flex;
  align-items: center;
  gap: 8px;
}
.setting-desc {
  font-size: 11px;
  color: var(--pt-muted, #9ca3af);
  margin-top: 2px;
}
.pt-switch {
  position: relative;
  width: 36px;
  height: 20px;
  flex: none;
  display: inline-block;
  cursor: pointer;
}
.pt-switch input {
  opacity: 0;
  width: 0;
  height: 0;
  position: absolute;
}
.pt-switch-track {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--pt-fg, #fff) 16%, var(--pt-surface, #1b1e25));
  border: 1px solid var(--pt-border, rgba(255,255,255,0.12));
  transition: background-color 0.16s ease, border-color 0.16s ease;
}
.pt-switch-track::after {
  content: "";
  position: absolute;
  left: 2px;
  top: 2px;
  width: 14px;
  height: 14px;
  border-radius: 999px;
  background: var(--pt-fg, #f3f4f6);
  transition: transform 0.16s ease;
}
.pt-switch input:checked + .pt-switch-track {
  background: var(--pt-accent, #6366f1);
  border-color: var(--pt-accent, #6366f1);
}
.pt-switch input:checked + .pt-switch-track::after {
  transform: translateX(16px);
  background: #ffffff;
}
.pt-btn-accent {
  background: var(--pt-accent, #6366f1);
  border-color: transparent;
  color: var(--pt-accent-fg, #ffffff);
  font-weight: 600;
}
.pt-btn-accent:hover:not(:disabled) { opacity: 0.92; border-color: transparent; }
.pt-btn-warn {
  background: color-mix(in srgb, var(--pt-warning, #f59e0b) 16%, var(--pt-surface, #1b1e25));
  border-color: color-mix(in srgb, var(--pt-warning, #f59e0b) 42%, transparent);
  color: var(--pt-warning, #f59e0b);
  font-weight: 600;
}
.pt-btn-danger {
  background: color-mix(in srgb, var(--pt-danger, #ef4444) 14%, var(--pt-surface, #1b1e25));
  border-color: color-mix(in srgb, var(--pt-danger, #ef4444) 36%, transparent);
  color: var(--pt-danger, #ef4444);
}
@container (max-width: 780px) {
  .app-side { width: 0; flex-basis: 0; border-right-width: 0; overflow: hidden; }
  .top-seg { display: inline-flex; }
}
@media (max-width: 780px) {
  .app-side { width: 0; flex-basis: 0; border-right-width: 0; overflow: hidden; }
  .top-seg { display: inline-flex; }
}
.pt-heatmap-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
  font-size: 10.5px;
  color: var(--pt-muted, #9ca3af);
  flex-wrap: wrap;
}
.pt-heatmap-legend {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.pt-heatmap-swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  display: inline-block;
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
.pt-sidebar-stack {
  width: calc(100% - 16px);
  margin: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.pt-sidebar-update-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px 4px 8px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--pt-accent, #6366f1) 36%, var(--pt-border, rgba(255,255,255,0.12)));
  background: color-mix(in srgb, var(--pt-accent, #6366f1) 11%, var(--pt-card, #14161b));
  color: var(--pt-fg, #f3f4f6);
  font-size: 11px;
  line-height: 1.3;
}
.pt-sidebar-update-row:hover {
  border-color: var(--pt-accent, #6366f1);
}
.pt-sidebar-update-btn {
  appearance: none;
  border: 0;
  background: transparent;
  color: inherit;
  padding: 1px 0;
  margin: 0;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 5px;
  font: inherit;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
}
.pt-sidebar-update-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--pt-accent, #6366f1);
  flex: none;
}
.pt-sidebar-update-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pt-sidebar-update-dismiss {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--pt-muted, #9ca3af);
  width: 18px;
  height: 18px;
  border-radius: 4px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  flex: none;
}
.pt-sidebar-update-dismiss:hover {
  color: var(--pt-fg, #f3f4f6);
  background: color-mix(in srgb, var(--pt-fg, #fff) 10%, transparent);
}
.pt-sidebar-trigger {
  width: 100%;
  margin: 0;
  padding: 6px 9px;
  border-radius: 8px;
  border: 1px solid var(--pt-border, rgba(255,255,255,0.12));
  background: var(--pt-card, #14161b);
  color: var(--pt-fg, #f3f4f6);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 7px;
  transition: border-color .15s ease, background-color .15s ease;
}
.pt-sidebar-trigger:hover {
  border-color: var(--pt-accent, #6366f1);
}
.pt-sidebar-logo {
  position: relative;
  width: 21px;
  height: 21px;
  border-radius: 5.5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #1b1e25, #0b0c0f);
  border: 1.25px solid #6366f1;
  color: #f3f4f6;
  box-sizing: border-box;
  flex: none;
}
.pt-sidebar-logo-text {
  font-size: 9.5px;
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1;
  transform: translateY(-0.5px);
}
.pt-sidebar-status-dot {
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  box-sizing: border-box;
  border: 1.5px solid #0b0c0f;
  background: #9ca3af;
  transition: background-color .2s ease, box-shadow .2s ease;
}
.pt-sidebar-logo[data-state="attached"] .pt-sidebar-status-dot {
  background: #22c55e;
  box-shadow: 0 0 6px rgba(34, 197, 94, 0.8);
}
.pt-sidebar-logo[data-state="waiting"] .pt-sidebar-status-dot {
  background: #6366f1;
  box-shadow: 0 0 5px rgba(99, 102, 241, 0.7);
}
.pt-sidebar-logo[data-state="disconnected"] .pt-sidebar-status-dot {
  background: #9ca3af;
  box-shadow: none;
}
.pt-sidebar-today {
  font-size: 11px;
  font-weight: 500;
  color: var(--pt-muted, #9ca3af);
  white-space: nowrap;
  flex: none;
}
.pt-sidebar-metrics {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-evenly;
  gap: 6px;
}
.pt-sidebar-metric {
  display: inline-flex;
  align-items: baseline;
  justify-content: center;
  gap: 2.5px;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pt-sidebar-val {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--pt-fg, #f3f4f6);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.015em;
}
.pt-sidebar-unit {
  font-size: 10px;
  font-weight: 500;
  color: var(--pt-muted, #9ca3af);
}
.pt-sidebar-sep {
  width: 1px;
  height: 11px;
  background: var(--pt-border, rgba(255,255,255,0.14));
  flex: none;
}
.pt-sidebar-fallback {
  flex: 1;
  min-width: 0;
  text-align: left;
  font-size: 11px;
  color: var(--pt-muted, #9ca3af);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pt-sidebar-trigger:hover .pt-sidebar-today,
.pt-sidebar-trigger:hover .pt-sidebar-unit,
.pt-sidebar-trigger:hover .pt-sidebar-fallback {
  color: var(--pt-fg, #f3f4f6);
}

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

/* ===== Magpie-style View Toolbar, Period Segmented Strip & Popovers ===== */
.pt-view-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  width: 100%;
  min-height: 32px;
}
.pt-view-head-grow {
  flex: 1 1 auto;
  min-width: 8px;
}
.pt-view-head-right {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.pt-segs {
  position: relative;
  display: inline-flex;
  align-items: center;
  padding: 3px;
  border-radius: 10px;
  background: var(--pt-surface, #1b1e25);
  border: 1px solid var(--pt-border, rgba(255,255,255,0.10));
  max-width: 100%;
  overflow-x: auto;
  scrollbar-width: none;
  user-select: none;
}
.pt-segs::-webkit-scrollbar { display: none; }
.pt-segs-thumb {
  position: absolute;
  top: 3px;
  bottom: 3px;
  left: 0;
  border-radius: 7px;
  background: var(--pt-card, #14161b);
  border: 1px solid color-mix(in srgb, var(--pt-border, rgba(255,255,255,0.14)) 90%, transparent);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.22);
  pointer-events: none;
  opacity: 0;
  transition: transform 0.22s cubic-bezier(0.22, 1, 0.36, 1), width 0.22s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.14s ease;
}
.pt-segs.no-anim .pt-segs-thumb { transition: none; }
.pt-seg-opt {
  position: relative;
  z-index: 1;
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--pt-muted, #9ca3af);
  padding: 5px 11px;
  border-radius: 7px;
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.25;
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.14s ease;
}
.pt-seg-opt:hover { color: var(--pt-fg, #f3f4f6); }
.pt-seg-opt.on {
  color: var(--pt-fg, #f3f4f6);
  font-weight: 600;
}
.pt-segs:not([data-thumb-ready="1"]) .pt-seg-opt.on {
  background: var(--pt-card, #14161b);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.22);
}
.pt-range-opt {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.pt-range-opt svg {
  flex: none;
  opacity: 0.72;
}
.pt-range-opt.on svg {
  opacity: 1;
  color: var(--pt-accent, #6366f1);
}
.pt-pick-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px 0 11px;
  border-radius: 8px;
  border: 1px solid var(--pt-border, rgba(255,255,255,0.10));
  background: var(--pt-card, #14161b);
  color: var(--pt-fg, #f3f4f6);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  max-width: 220px;
  transition: border-color 0.14s ease, background-color 0.14s ease, color 0.14s ease;
}
.pt-pick-btn:hover {
  border-color: color-mix(in srgb, var(--pt-accent, #6366f1) 48%, var(--pt-border, rgba(255,255,255,0.14)));
  background: var(--pt-surface, #1b1e25);
}
.pt-pick-btn.set {
  border-color: color-mix(in srgb, var(--pt-accent, #6366f1) 42%, transparent);
  background: color-mix(in srgb, var(--pt-accent, #6366f1) 12%, var(--pt-card, #14161b));
}
.pt-pick-btn-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pt-pick-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--pt-accent, #6366f1);
  flex: none;
}
.pt-pick-chev {
  color: var(--pt-muted, #9ca3af);
  transition: transform 0.16s ease;
  flex: none;
}
.pt-pick-btn[aria-expanded="true"] .pt-pick-chev { transform: rotate(180deg); }
.pt-head-refresh {
  appearance: none;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid var(--pt-border, rgba(255,255,255,0.10));
  background: var(--pt-card, #14161b);
  color: var(--pt-muted, #9ca3af);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex: none;
  transition: background-color 0.14s ease, border-color 0.14s ease, color 0.14s ease;
}
.pt-head-refresh:hover {
  background: var(--pt-surface, #1b1e25);
  border-color: color-mix(in srgb, var(--pt-accent, #6366f1) 45%, var(--pt-border, rgba(255,255,255,0.14)));
  color: var(--pt-fg, #f3f4f6);
}
.pt-head-refresh.busy svg {
  animation: ptSpin 0.75s linear infinite;
  color: var(--pt-accent, #6366f1);
}
@keyframes ptSpin { to { transform: rotate(360deg); } }

/* Popover menus (Account dropdown & Magpie-style Custom Range Picker) */
.pt-pop-menu, .pt-range-menu {
  position: fixed;
  z-index: 100020;
  background: var(--pt-card, #14161b);
  color: var(--pt-fg, #f3f4f6);
  border: 1px solid color-mix(in srgb, var(--pt-border, rgba(255,255,255,0.14)) 120%, transparent);
  border-radius: 12px;
  box-shadow: var(--pt-shadow, 0 12px 32px rgba(0, 0, 0, 0.45));
  font-family: var(--pt-font-sans, "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif);
  font-size: 12px;
  animation: ptPopIn 0.14s cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes ptPopIn {
  from { opacity: 0; transform: translateY(-4px) scale(0.985); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.pt-pop-menu {
  min-width: 196px;
  max-width: 280px;
  max-height: 320px;
  overflow-y: auto;
  padding: 5px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pt-pop-head {
  padding: 5px 9px 4px;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--pt-muted, #9ca3af);
  letter-spacing: 0.02em;
}
.pt-pop-item {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--pt-fg, #f3f4f6);
  border-radius: 8px;
  padding: 6px 9px;
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  transition: background-color 0.12s ease;
}
.pt-pop-item:hover {
  background: color-mix(in srgb, var(--pt-fg, #fff) 7%, transparent);
}
.pt-pop-item.on {
  background: color-mix(in srgb, var(--pt-accent, #6366f1) 14%, transparent);
  color: var(--pt-fg, #f3f4f6);
  font-weight: 600;
}
.pt-pop-item-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pt-pop-tick {
  color: var(--pt-accent, #6366f1);
  font-weight: 700;
  flex: none;
}
.pt-range-menu {
  width: 286px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  user-select: none;
}
.pt-rm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
}
.pt-rm-hint {
  font-size: 11px;
  font-weight: 500;
  color: var(--pt-muted, #9ca3af);
}
.pt-rm-hint.picking {
  color: var(--pt-accent, #6366f1);
}
.pt-rm-hours {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 9px;
  background: var(--pt-surface, #1b1e25);
  border: 1px solid var(--pt-border, rgba(255,255,255,0.08));
  font-size: 11.5px;
  color: var(--pt-muted, #9ca3af);
}
.pt-rm-hours input {
  width: 54px;
  padding: 3px 6px;
  border-radius: 6px;
  border: 1px solid var(--pt-border, rgba(255,255,255,0.14));
  background: var(--pt-card, #14161b);
  color: var(--pt-fg, #f3f4f6);
  font-family: var(--pt-font-mono, ui-monospace, Consolas, monospace);
  font-size: 12px;
  text-align: center;
  outline: none;
}
.pt-rm-hours input:focus {
  border-color: var(--pt-accent, #6366f1);
}
.pt-rm-apply {
  margin-left: auto;
  appearance: none;
  border: 1px solid color-mix(in srgb, var(--pt-accent, #6366f1) 42%, transparent);
  background: color-mix(in srgb, var(--pt-accent, #6366f1) 16%, transparent);
  color: var(--pt-fg, #f3f4f6);
  border-radius: 6px;
  padding: 3px 8px;
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.pt-rm-apply:hover {
  background: var(--pt-accent, #6366f1);
  color: var(--pt-accent-fg, #ffffff);
}
.pt-rm-quick {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.pt-rm-span {
  appearance: none;
  border: 1px solid var(--pt-border, rgba(255,255,255,0.10));
  background: var(--pt-surface, #1b1e25);
  color: var(--pt-muted, #9ca3af);
  border-radius: 7px;
  padding: 4px 8px;
  font: inherit;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: border-color 0.12s ease, color 0.12s ease, background-color 0.12s ease;
}
.pt-rm-span:hover {
  color: var(--pt-fg, #f3f4f6);
  border-color: color-mix(in srgb, var(--pt-accent, #6366f1) 45%, var(--pt-border, rgba(255,255,255,0.14)));
}
.pt-rm-span.on {
  border-color: color-mix(in srgb, var(--pt-accent, #6366f1) 50%, transparent);
  background: color-mix(in srgb, var(--pt-accent, #6366f1) 16%, var(--pt-surface, #1b1e25));
  color: var(--pt-fg, #f3f4f6);
  font-weight: 600;
}
.pt-rm-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding-top: 2px;
}
.pt-rm-month {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.pt-rm-step {
  appearance: none;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--pt-muted, #9ca3af);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 13px;
}
.pt-rm-step:hover:not(:disabled) {
  background: var(--pt-surface, #1b1e25);
  border-color: var(--pt-border, rgba(255,255,255,0.10));
  color: var(--pt-fg, #f3f4f6);
}
.pt-rm-step:disabled {
  opacity: 0.32;
  cursor: not-allowed;
}
.pt-rm-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 2px;
}
.pt-rm-wd {
  text-align: center;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--pt-muted, #9ca3af);
  padding: 2px 0 4px;
}
.pt-rm-day {
  appearance: none;
  height: 30px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--pt-fg, #f3f4f6);
  font-family: var(--pt-font-mono, ui-monospace, Consolas, monospace);
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.1s ease, color 0.1s ease, border-color 0.1s ease;
}
.pt-rm-day:hover:not(:disabled) {
  background: color-mix(in srgb, var(--pt-fg, #fff) 9%, transparent);
}
.pt-rm-day.today {
  border-color: color-mix(in srgb, var(--pt-accent, #6366f1) 55%, transparent);
  color: var(--pt-accent, #6366f1);
  font-weight: 700;
}
.pt-rm-day.in, .pt-rm-day.preview {
  background: color-mix(in srgb, var(--pt-accent, #6366f1) 18%, transparent);
  color: var(--pt-fg, #f3f4f6);
}
.pt-rm-day.end {
  background: var(--pt-accent, #6366f1);
  border-color: var(--pt-accent, #6366f1);
  color: var(--pt-accent-fg, #ffffff);
  font-weight: 700;
}
.pt-rm-day:disabled {
  opacity: 0.28;
  cursor: not-allowed;
}
.pt-rm-times {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid color-mix(in srgb, var(--pt-border, rgba(255,255,255,0.10)) 80%, transparent);
  font-size: 11px;
  color: var(--pt-muted, #9ca3af);
}
.pt-rm-time {
  width: 60px;
  padding: 3px 6px;
  border-radius: 6px;
  border: 1px solid var(--pt-border, rgba(255,255,255,0.14));
  background: var(--pt-surface, #1b1e25);
  color: var(--pt-fg, #f3f4f6);
  font-family: var(--pt-font-mono, ui-monospace, Consolas, monospace);
  font-size: 11.5px;
  text-align: center;
  outline: none;
}
.pt-rm-time:focus { border-color: var(--pt-accent, #6366f1); }
.pt-rm-time.err { border-color: var(--pt-danger, #ef4444); }
`;

const PT_USAGE_RING_CIRCUMFERENCE = 37.7;

const PT_PERIOD_PRESETS = [
  ['weeklyQuota', '本周限额'],
  ['today', '今天'],
  ['24h', '24 小时'],
  ['7d', '7 天'],
  ['30d', '30 天'],
  ['all', '全部']
];
const PT_PERIOD_PRESET_KEYS = new Set(PT_PERIOD_PRESETS.map(p => p[0]));
const PT_REFRESH_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3"/></svg>';
const PT_CALENDAR_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 6.5h12M5.5 1.8v2.2M10.5 1.8v2.2"/></svg>';
const PT_CHEVRON_SVG = '<svg class="pt-pick-chev" viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5l3 3 3-3"/></svg>';

function ptPad2(n) { return String(n).padStart(2, '0'); }
function ptFormatYmd(d) { return d.getFullYear() + '-' + ptPad2(d.getMonth() + 1) + '-' + ptPad2(d.getDate()); }
function ptTodayYmd(now = Date.now()) { return ptFormatYmd(new Date(now)); }
function ptShiftYmd(ymd, deltaDays) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(y, m - 1, d + deltaDays, 0, 0, 0, 0);
  return ptFormatYmd(dt);
}
function parsePeriodHours(p) {
  const m = String(p || '').match(/^last:(\d+)h$/);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 && n <= 720 ? n : 0;
}
function parsePeriodRange(p) {
  const m = String(p || '').match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?\.\.(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?$/);
  if (!m) return null;
  return { from: m[1], to: m[3], t1: m[2] || '', t2: m[4] || '' };
}
function isKeptPeriod(p) {
  const s = String(p || '');
  return PT_PERIOD_PRESET_KEYS.has(s) || s === 'week' || parsePeriodHours(s) > 0;
}
function parseTypedTime(raw, isEnd = false) {
  const s = String(raw || '').trim();
  if (!s) return isEnd ? '24:00' : '00:00';
  let h = -1, m = 0;
  let match = s.match(/^(\d{1,2}):(\d{2})$/);
  if (match) {
    h = Number(match[1]);
    m = Number(match[2]);
  } else if ((match = s.match(/^(\d{1,2})(\d{2})$/))) {
    h = Number(match[1]);
    m = Number(match[2]);
  } else if ((match = s.match(/^(\d{1,2})$/))) {
    h = Number(match[1]);
    m = 0;
  } else {
    return null;
  }
  if (isEnd && h === 24 && m === 0) return '24:00';
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return ptPad2(h) + ':' + ptPad2(m);
}
function buildRangePresetSpec(from, to, t1 = '', t2 = '') {
  const norm1 = t1 && t1 !== '00:00' ? 'T' + t1 : '';
  const norm2 = t2 && t2 !== '24:00' ? 'T' + t2 : '';
  return from + norm1 + '..' + to + norm2;
}
function formatPeriodRangeLabel(p) {
  const hours = parsePeriodHours(p);
  if (hours) return '近 ' + hours + ' 小时';
  if (p === 'week') return '自然周';
  const r = parsePeriodRange(p);
  if (!r) return '自定义';
  const curYear = new Date().getFullYear();
  const fmtDay = (ymd, showYear) => {
    const [y, m, d] = ymd.split('-').map(Number);
    return showYear ? (y + '/' + m + '/' + d) : (m + '月' + d + '日');
  };
  const y1 = Number(r.from.slice(0, 4));
  const y2 = Number(r.to.slice(0, 4));
  const showYear = y1 !== curYear || y2 !== curYear;
  const hasTime = Boolean((r.t1 && r.t1 !== '00:00') || (r.t2 && r.t2 !== '24:00'));
  if (r.from === r.to) {
    if (hasTime) return fmtDay(r.from, showYear) + ' ' + (r.t1 || '00:00') + '–' + (r.t2 || '24:00');
    return fmtDay(r.from, showYear);
  }
  const a = fmtDay(r.from, showYear) + (r.t1 && r.t1 !== '00:00' ? ' ' + r.t1 : '');
  const b = fmtDay(r.to, showYear) + (r.t2 && r.t2 !== '24:00' ? ' ' + r.t2 : '');
  return a + ' – ' + b;
}

function renderViewToolbarHtml(data, uiState, opts = {}) {
  const showFilters = opts.showFilters !== false;
  const showAccount = opts.showAccount !== false;
  const showRefresh = opts.showRefresh !== false;
  const busy = Boolean(opts.busy);
  const preset = String(uiState?.preset || data?.range?.preset || 'weeklyQuota');
  const account = String(uiState?.account || 'all');
  const isCustomActive = !PT_PERIOD_PRESET_KEYS.has(preset);
  const rangeLabel = isCustomActive ? formatPeriodRangeLabel(preset) : '自定义';

  const segsHtml = showFilters ? `
    <div class="pt-segs" data-pt-period-segs="1" role="tablist" aria-label="统计周期">
      <span class="pt-segs-thumb" aria-hidden="true"></span>
      ${PT_PERIOD_PRESETS.map(([id, label]) => `
        <button type="button" class="pt-seg-opt${preset === id ? ' on' : ''}" role="tab" aria-selected="${preset === id ? 'true' : 'false'}" data-pt-period="${esc(id)}">${esc(label)}</button>
      `).join('')}
      <button type="button" class="pt-seg-opt pt-range-opt${isCustomActive ? ' on' : ''}" role="tab" aria-selected="${isCustomActive ? 'true' : 'false'}" aria-haspopup="dialog" aria-expanded="false" data-pt-range-trigger="1" title="自定义时间范围">${PT_CALENDAR_SVG}<span>${esc(rangeLabel)}</span></button>
    </div>
  ` : '';

  const accLabel = account === 'all' ? '全部账号' : account;
  const accountBtnHtml = showAccount ? `
    <button type="button" class="pt-pick-btn${account !== 'all' ? ' set' : ''}" aria-haspopup="menu" aria-expanded="false" data-pt-account-trigger="1" title="筛选账号">
      ${account !== 'all' ? '<span class="pt-pick-dot" aria-hidden="true"></span>' : ''}
      <span class="pt-pick-btn-label">${esc(accLabel)}</span>
      ${PT_CHEVRON_SVG}
    </button>
  ` : '';

  const refreshBtnHtml = showRefresh ? `
    <button type="button" class="pt-head-refresh${busy ? ' busy' : ''}" data-pt-action="refresh" title="刷新" aria-label="刷新数据">${PT_REFRESH_SVG}</button>
  ` : '';

  return `
    <div class="pt-view-head">
      ${segsHtml}
      <span class="pt-view-head-grow"></span>
      <div class="pt-view-head-right">
        ${opts.extraRightHtml || ''}
        ${accountBtnHtml}
        ${refreshBtnHtml}
      </div>
    </div>
  `;
}

function positionSegsThumb(root, { animate = true } = {}) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const list = root.matches?.('.pt-segs') ? [root] : Array.from(root.querySelectorAll('.pt-segs'));
  for (const segs of list) {
    const thumb = segs.querySelector('.pt-segs-thumb');
    const active = segs.querySelector('.pt-seg-opt.on');
    if (!thumb) continue;
    if (!active) {
      thumb.style.opacity = '0';
      continue;
    }
    const apply = () => {
      const w = active.offsetWidth;
      if (!w) return false;
      if (!animate) segs.classList.add('no-anim');
      thumb.style.width = w + 'px';
      thumb.style.transform = 'translateX(' + active.offsetLeft + 'px)';
      thumb.style.opacity = '1';
      segs.dataset.thumbReady = '1';
      if (!animate) {
        void thumb.offsetWidth;
        segs.classList.remove('no-anim');
      }
      return true;
    };
    if (!apply() && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => apply());
    }
  }
}

let ptActivePop = null;

function closePtPopMenu() {
  if (!ptActivePop) return false;
  const cur = ptActivePop;
  ptActivePop = null;
  try { cur.cleanup?.(); } catch {}
  try { cur.menu?.remove(); } catch {}
  if (cur.anchor) cur.anchor.setAttribute('aria-expanded', 'false');
  return true;
}

function mountPtPopover(anchor, menu, align = 'left') {
  const host = anchor.closest?.('.pt-root') || document.body;
  host.appendChild(menu);
  anchor.setAttribute('aria-expanded', 'true');

  const place = () => {
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth || 260;
    const mh = menu.offsetHeight || 220;
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    let left = align === 'right' ? (r.right - mw) : r.left;
    left = Math.max(8, Math.min(left, vw - mw - 8));
    let top = r.bottom + 6;
    if (top + mh > vh - 8 && r.top - mh - 6 >= 8) {
      top = r.top - mh - 6;
    } else {
      top = Math.max(8, Math.min(top, vh - mh - 8));
    }
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';
  };
  place();

  const onPointerDown = e => {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
    if (path.includes(menu) || path.includes(anchor)) return;
    closePtPopMenu();
  };
  const onKeyDown = e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePtPopMenu();
      anchor.focus?.({ preventScroll: true });
    }
  };
  const onResize = () => place();

  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', onResize);

  ptActivePop = {
    anchor,
    menu,
    place,
    cleanup() {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onResize);
    }
  };
}

function openPtAccountMenu(anchor, accounts, activeAccount, onPick) {
  if (ptActivePop?.anchor === anchor) {
    closePtPopMenu();
    return;
  }
  closePtPopMenu();
  const list = Array.isArray(accounts) ? accounts : [];
  const items = [['all', '全部账号'], ...list.map(a => [a, a])];
  const menu = document.createElement('div');
  menu.className = 'pt-pop-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = '<div class="pt-pop-head">账号 / 实例</div>' + items.map(([val, label]) => `
    <button type="button" class="pt-pop-item${activeAccount === val ? ' on' : ''}" role="menuitemradio" aria-checked="${activeAccount === val ? 'true' : 'false'}" data-pt-pop-val="${esc(val)}">
      <span class="pt-pop-item-name">${esc(label)}</span>
      ${activeAccount === val ? '<span class="pt-pop-tick">✓</span>' : ''}
    </button>
  `).join('');

  menu.addEventListener('click', e => {
    const btn = e.target.closest?.('[data-pt-pop-val]');
    if (!btn) return;
    const val = btn.getAttribute('data-pt-pop-val') || 'all';
    closePtPopMenu();
    if (typeof onPick === 'function') onPick(val);
  });

  mountPtPopover(anchor, menu, 'right');
}

function openPtRangeMenu(anchor, currentPreset, onPick) {
  if (ptActivePop?.anchor === anchor) {
    closePtPopMenu();
    return;
  }
  closePtPopMenu();

  const today = ptTodayYmd();
  const [ty, tm] = today.split('-').map(Number);
  const curRange = parsePeriodRange(currentPreset);
  const curHours = parsePeriodHours(currentPreset);
  let savedHours = 6;
  try {
    const raw = Number(localStorage.getItem('t3tools.lastHours'));
    if (Number.isInteger(raw) && raw >= 1 && raw <= 720) savedHours = raw;
  } catch {}
  const initialHours = curHours || savedHours;

  const focusYmd = curRange ? curRange.to : today;
  let viewY = Number(focusYmd.slice(0, 4));
  let viewM = Number(focusYmd.slice(5, 7)); // 1..12
  let pickStart = '';
  let hoverYmd = '';

  const yesterday = ptShiftYmd(today, -1);
  const monthStart = ty + '-' + ptPad2(tm) + '-01';
  const prevMonthEndDate = new Date(ty, tm - 1, 0);
  const prevMonthStart = prevMonthEndDate.getFullYear() + '-' + ptPad2(prevMonthEndDate.getMonth() + 1) + '-01';
  const prevMonthEnd = ptFormatYmd(prevMonthEndDate);
  const last90Start = ptShiftYmd(today, -89);

  const quickSpans = [
    ['昨天', yesterday + '..' + yesterday],
    ['自然周', 'week'],
    ['本月', monthStart + '..' + today],
    ['上个月', prevMonthStart + '..' + prevMonthEnd],
    ['近 90 天', last90Start + '..' + today]
  ];

  const menu = document.createElement('div');
  menu.className = 'pt-range-menu';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', '自定义统计周期');

  function renderCalendarPart() {
    const hintEl = menu.querySelector('[data-rm-hint]');
    if (hintEl) {
      hintEl.textContent = pickStart ? '再选最后一天' : '先选第一天，再选最后一天';
      hintEl.classList.toggle('picking', Boolean(pickStart));
    }
    const monthEl = menu.querySelector('[data-rm-month]');
    if (monthEl) monthEl.textContent = viewY + ' 年 ' + viewM + ' 月';
    const nextBtn = menu.querySelector('[data-rm-step="1"]');
    if (nextBtn) nextBtn.disabled = viewY > ty || (viewY === ty && viewM >= tm);

    const gridEl = menu.querySelector('[data-rm-grid]');
    if (!gridEl) return;

    const firstWeekday = (new Date(viewY, viewM - 1, 1).getDay() + 6) % 7; // Mon=0..Sun=6
    const daysInMonth = new Date(viewY, viewM, 0).getDate();
    let lo = curRange ? curRange.from : '';
    let hi = curRange ? curRange.to : '';
    let isPreview = false;
    if (pickStart) {
      const other = hoverYmd || pickStart;
      lo = pickStart <= other ? pickStart : other;
      hi = pickStart <= other ? other : pickStart;
      isPreview = true;
    }

    let html = ['一', '二', '三', '四', '五', '六', '日'].map(w => '<span class="pt-rm-wd">' + w + '</span>').join('');
    for (let i = 0; i < firstWeekday; i++) html += '<span></span>';
    for (let day = 1; day <= daysInMonth; day++) {
      const ymd = viewY + '-' + ptPad2(viewM) + '-' + ptPad2(day);
      const disabled = ymd > today;
      const cls = ['pt-rm-day'];
      if (ymd === today) cls.push('today');
      if (lo && hi && ymd >= lo && ymd <= hi) {
        cls.push(isPreview ? 'preview' : 'in');
        if (ymd === lo || ymd === hi) cls.push('end');
      }
      html += '<button type="button" class="' + cls.join(' ') + '" data-rm-day="' + ymd + '"' + (disabled ? ' disabled' : '') + '>' + day + '</button>';
    }
    gridEl.innerHTML = html;
  }

  function applyHours() {
    const input = menu.querySelector('[data-rm-hours]');
    if (!input) return;
    const n = Math.round(Number(input.value));
    if (!Number.isInteger(n) || n < 1 || n > 720) {
      input.style.borderColor = 'var(--pt-danger, #ef4444)';
      return;
    }
    try { localStorage.setItem('t3tools.lastHours', String(n)); } catch {}
    closePtPopMenu();
    if (typeof onPick === 'function') onPick('last:' + n + 'h');
  }

  function applyTimes() {
    if (!curRange) return;
    const t1El = menu.querySelector('[data-rm-time="start"]');
    const t2El = menu.querySelector('[data-rm-time="end"]');
    const t1 = parseTypedTime(t1El?.value, false);
    const t2 = parseTypedTime(t2El?.value, true);
    t1El?.classList.toggle('err', !t1);
    t2El?.classList.toggle('err', !t2);
    if (!t1 || !t2) return;
    if (curRange.from === curRange.to && t1 >= t2) {
      t1El?.classList.add('err');
      t2El?.classList.add('err');
      return;
    }
    const spec = buildRangePresetSpec(curRange.from, curRange.to, t1, t2);
    closePtPopMenu();
    if (typeof onPick === 'function') onPick(spec);
  }

  menu.innerHTML = `
    <div class="pt-rm-head">
      <span>选择日期</span>
      <span class="pt-rm-hint" data-rm-hint="1">先选第一天，再选最后一天</span>
    </div>
    <div class="pt-rm-hours">
      <span>最近</span>
      <input type="number" min="1" max="720" inputmode="numeric" value="${esc(initialHours)}" data-rm-hours="1" aria-label="最近小时数" />
      <span>小时内</span>
      <button type="button" class="pt-rm-apply" data-rm-apply-hours="1">应用</button>
    </div>
    <div class="pt-rm-quick">
      ${quickSpans.map(([label, val]) => `
        <button type="button" class="pt-rm-span${currentPreset === val ? ' on' : ''}" data-rm-quick="${esc(val)}">${esc(label)}</button>
      `).join('')}
    </div>
    <div class="pt-rm-nav">
      <button type="button" class="pt-rm-step" data-rm-step="-1" title="上个月" aria-label="上个月">‹</button>
      <span class="pt-rm-month" data-rm-month="1"></span>
      <button type="button" class="pt-rm-step" data-rm-step="1" title="下个月" aria-label="下个月">›</button>
    </div>
    <div class="pt-rm-grid" data-rm-grid="1"></div>
    ${curRange ? `
      <div class="pt-rm-times">
        <span>时段</span>
        <input type="text" class="pt-rm-time" data-rm-time="start" value="${esc(curRange.t1 || '00:00')}" placeholder="00:00" aria-label="开始时间" />
        <span>–</span>
        <input type="text" class="pt-rm-time" data-rm-time="end" value="${esc(curRange.t2 || '24:00')}" placeholder="24:00" aria-label="结束时间" />
        <button type="button" class="pt-rm-apply" data-rm-apply-times="1">应用</button>
      </div>
    ` : ''}
  `;

  renderCalendarPart();

  menu.addEventListener('click', e => {
    const applyH = e.target.closest?.('[data-rm-apply-hours]');
    if (applyH) { applyHours(); return; }
    const applyT = e.target.closest?.('[data-rm-apply-times]');
    if (applyT) { applyTimes(); return; }
    const quick = e.target.closest?.('[data-rm-quick]');
    if (quick) {
      const val = quick.getAttribute('data-rm-quick');
      closePtPopMenu();
      if (val && typeof onPick === 'function') onPick(val);
      return;
    }
    const stepBtn = e.target.closest?.('[data-rm-step]');
    if (stepBtn && !stepBtn.disabled) {
      const delta = Number(stepBtn.getAttribute('data-rm-step')) || 0;
      const dt = new Date(viewY, viewM - 1 + delta, 1);
      viewY = dt.getFullYear();
      viewM = dt.getMonth() + 1;
      renderCalendarPart();
      return;
    }
    const dayBtn = e.target.closest?.('[data-rm-day]');
    if (dayBtn && !dayBtn.disabled) {
      const ymd = dayBtn.getAttribute('data-rm-day');
      if (!pickStart) {
        pickStart = ymd;
        hoverYmd = ymd;
        renderCalendarPart();
      } else {
        const from = pickStart <= ymd ? pickStart : ymd;
        const to = pickStart <= ymd ? ymd : pickStart;
        closePtPopMenu();
        if (typeof onPick === 'function') onPick(from + '..' + to);
      }
    }
  });

  menu.addEventListener('pointerover', e => {
    if (!pickStart) return;
    const dayBtn = e.target.closest?.('[data-rm-day]');
    if (!dayBtn || dayBtn.disabled) return;
    const ymd = dayBtn.getAttribute('data-rm-day');
    if (ymd && ymd !== hoverYmd) {
      hoverYmd = ymd;
      renderCalendarPart();
    }
  });

  menu.addEventListener('keydown', e => {
    if (e.target.matches?.('[data-rm-hours]') && e.key === 'Enter') {
      e.preventDefault();
      applyHours();
      return;
    }
    if (e.target.matches?.('[data-rm-time]') && e.key === 'Enter') {
      e.preventDefault();
      applyTimes();
      return;
    }
    const dayBtn = e.target.closest?.('[data-rm-day]');
    if (dayBtn && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      const delta = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' ? -7 : 7;
      const nextYmd = ptShiftYmd(dayBtn.getAttribute('data-rm-day'), delta);
      if (nextYmd > today) return;
      const ny = Number(nextYmd.slice(0, 4));
      const nm = Number(nextYmd.slice(5, 7));
      if (ny !== viewY || nm !== viewM) {
        viewY = ny;
        viewM = nm;
      }
      if (pickStart) hoverYmd = nextYmd;
      renderCalendarPart();
      menu.querySelector('[data-rm-day="' + nextYmd + '"]')?.focus();
    }
  });

  mountPtPopover(anchor, menu, 'left');
}

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
    ? renderUsageTipHtml('生成速度', '', '暂无数据')
    : speedDisplay.source === 'live-stream'
      ? renderUsageTipHtml('实时速度', '估算', '生成中估算，完成后校准', 'pt-text-accent')
      : speedDisplay.source === 'throughput'
        ? renderUsageTipHtml('整轮吞吐', '估算', '含等待与工具耗时')
        : renderUsageTipHtml('解码速度', '近 10 次', '纯输出速率，不含首字等待');

  const ttftTip = !hasTtft
    ? renderUsageTipHtml('首字延迟', '', '暂无首字数据')
    : renderUsageTipHtml('首字延迟', '近 10 次', '请求到首字耗时');

  const cacheRead = Number(ctx?.cacheReadTokens) || 0;
  const totalIn = cacheRead + (Number(ctx?.inputTokens) || 0);
  const cacheTtlTag = ctx?.cacheRemainingMs > 0 ? `保活 ${fmtDuration(ctx.cacheRemainingMs)}` : '';
  const cacheTip = !hasCache
    ? renderUsageTipHtml('缓存命中', '', '暂无缓存数据')
    : renderUsageTipHtml(
        '缓存命中',
        cacheTtlTag,
        totalIn > 0 ? `复用 ${fmtTokens(cacheRead)} / 输入 ${fmtTokens(totalIn)}` : '输入缓存复用率',
        cacheTtlTag ? 'pt-text-success' : ''
      );

  const maxTokens = Number(ctx?.maxTokens) || 0;
  const usedTokens = ctx?.usedTokens != null && Number.isFinite(Number(ctx.usedTokens)) ? Number(ctx.usedTokens) : null;
  const ctxTag = usedTokens != null && maxTokens > 0
    ? `${fmtTokens(usedTokens)} / ${fmtTokens(maxTokens)}`
    : (maxTokens > 0 ? `容量 ${fmtTokens(maxTokens)}` : '');
  const ctxDesc = contextPct == null
    ? '暂无数据'
    : (ctx?.compactions > 0
      ? `已用 ${contextPct.toFixed(1)}% · 已压缩 ${ctx.compactions} 次`
      : `已用 ${contextPct.toFixed(1)}%`);
  const contextTip = renderUsageTipHtml('上下文', ctxTag, ctxDesc);

  const ariaLabel = [
    '状态栏',
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

function formatRuntimeUpdateSignature(updatable = []) {
  return updatable
    .map(it => `${it.driver}:${it.latestVersion}`)
    .sort()
    .join('|');
}

const SIDEBAR_USAGE_RANGE_META = {
  today: { short: '今日', full: '今日' },
  '24h': { short: '24h', full: '近 24 小时' },
  weeklyQuota: { short: '本周期', full: '本周限额周期' },
  week: { short: '本周', full: '本周' },
  '7d': { short: '7天', full: '近 7 天' },
  '30d': { short: '30天', full: '近 30 天' },
  all: { short: '累计', full: '全部历史' }
};

function resolveSidebarRangeMeta(preset) {
  return SIDEBAR_USAGE_RANGE_META[String(preset || '')] || SIDEBAR_USAGE_RANGE_META.today;
}

function resolveSidebarBadgeState(live = null, options = {}) {
  const explicit = String(options?.status || '').trim();
  if (explicit === 'attached' || explicit === 'waiting' || explicit === 'disconnected') {
    return explicit;
  }
  if (!live || typeof live !== 'object') return 'waiting';
  return 'attached';
}

function renderSidebarTriggerHtml(live = null, options = {}) {
  const dismissedSig = String(options?.dismissedUpdateSig || '');
  const badgeState = resolveSidebarBadgeState(live, options);
  const usage = (live?.sidebarUsage && typeof live.sidebarUsage === 'object')
    ? live.sidebarUsage
    : (live?.todayUsage && typeof live.todayUsage === 'object' ? live.todayUsage : null);
  const rangePreset = String(live?.sidebarUsage?.preset || (usage ? 'today' : live?.settings?.sidebarUsageRange) || 'today');
  const rangeMeta = resolveSidebarRangeMeta(rangePreset);
  const hasUsageCost = usage?.costUsd != null && Number.isFinite(Number(usage.costUsd));
  const hasUsageTokens = usage?.totalTokens != null && Number.isFinite(Number(usage.totalTokens));
  const hasUsage = hasUsageCost || hasUsageTokens;
  const costText = hasUsageCost ? fmtUsd(usage.costUsd) : '-';
  const reqs = hasUsage ? (Number(usage.requests) || 0) : 0;
  const tokens = hasUsageTokens ? (Number(usage.totalTokens) || 0) : 0;
  const tokensText = hasUsageTokens ? fmtTokens(tokens) : '-';

  const runtimeUpdates = live?.runtimeUpdates && typeof live.runtimeUpdates === 'object' ? live.runtimeUpdates : null;
  const runtimeItems = Array.isArray(runtimeUpdates?.items) ? runtimeUpdates.items : [];
  const updatable = runtimeItems.filter(it => it && it.hasUpdate && it.latestVersion);
  const updateSig = formatRuntimeUpdateSignature(updatable);
  const showUpdateBanner = updatable.length > 0 && (!dismissedSig || dismissedSig !== updateSig);

  const versionSummary = runtimeItems
    .filter(it => it && it.currentVersion)
    .map(it => `${it.displayName} ${it.currentVersion}${it.hasUpdate && it.latestVersion ? ` → ${it.latestVersion}` : ''}`)
    .join(' · ');

  const statusText = badgeState === 'disconnected'
    ? '服务未连接'
    : badgeState === 'waiting'
      ? '正在连接'
      : '已连接';

  const triggerTitleParts = [`打开 T3Tools 看板（${statusText}）`];
  if (hasUsage) {
    triggerTitleParts.push(`${rangeMeta.full} ${tokensText} tokens · 费用 ${costText}（${reqs} 次）`);
  }
  if (versionSummary) {
    triggerTitleParts.push(versionSummary);
  }

  const appUpdate = live?.appUpdate && typeof live.appUpdate === 'object' ? live.appUpdate : null;
  const dismissedAppVer = String(options.dismissedAppUpdateVer || '').trim();
  const appUpdateBusy = Boolean(appUpdate && ['downloading', 'verifying', 'ready'].includes(appUpdate.status));
  const showAppUpdateBanner = Boolean(
    appUpdate &&
    appUpdate.hasUpdate &&
    appUpdate.latestVersion &&
    (appUpdateBusy || (!appUpdate.isSkipped && dismissedAppVer !== appUpdate.latestVersion))
  );

  let appUpdateRowHtml = '';
  if (showAppUpdateBanner) {
    const ver = String(appUpdate.latestVersion);
    const pct = Math.max(0, Math.min(100, Number(appUpdate.progressPercent) || 0));
    const appLabel = appUpdate.status === 'downloading'
      ? `T3Tools 更新中 ${pct}%`
      : (appUpdate.status === 'verifying' || appUpdate.status === 'ready')
        ? 'T3Tools 正在重启更新...'
        : `T3Tools v${ver} 可更新`;
    const appTip = appUpdate.canAutoUpdate
      ? `T3Tools v${appUpdate.currentVersion || '?'} → v${ver} · 点击立即自动更新并重启`
      : `T3Tools v${appUpdate.currentVersion || '?'} → v${ver} · 点击前往 GitHub Releases 下载`;
    const dismissBtn = appUpdateBusy
      ? ''
      : `<button type="button" class="pt-sidebar-update-dismiss" data-pt-action="dismiss-app-update" data-pt-app-ver="${esc(ver)}" title="忽略当前版本提醒" aria-label="忽略当前版本提醒">×</button>`;
    appUpdateRowHtml = `
      <div class="pt-sidebar-update-row" data-pt-app-update="${esc(ver)}">
        <button type="button" class="pt-sidebar-update-btn" data-pt-action="install-app-update" title="${esc(appTip)}">
          <span class="pt-sidebar-update-dot" aria-hidden="true"></span>
          <span class="pt-sidebar-update-text">${appUpdateBusy ? '↻' : '↑'} ${esc(appLabel)}</span>
        </button>
        ${dismissBtn}
      </div>
    `;
  }

  let updateRowHtml = '';
  if (showUpdateBanner) {
    const label = updatable.length === 1
      ? `${updatable[0].displayName} ${updatable[0].latestVersion} 可更新`
      : `${updatable.map(it => it.displayName).join(' / ')} 有更新`;
    const detailTip = updatable
      .map(it => `${it.displayName} ${it.currentVersion || '?'} → ${it.latestVersion}`)
      .join(' · ') + ' · 点击前往 T3 Code 运行环境更新';
    updateRowHtml = `
      <div class="pt-sidebar-update-row" data-pt-runtime-update="${esc(updateSig)}">
        <button type="button" class="pt-sidebar-update-btn" data-pt-action="open-provider-settings" title="${esc(detailTip)}">
          <span class="pt-sidebar-update-dot" aria-hidden="true"></span>
          <span class="pt-sidebar-update-text">↑ ${esc(label)}</span>
        </button>
        <button type="button" class="pt-sidebar-update-dismiss" data-pt-action="dismiss-runtime-update" data-pt-update-sig="${esc(updateSig)}" title="忽略当前版本提醒" aria-label="忽略当前版本提醒">×</button>
      </div>
    `;
  }

  const triggerTitle = triggerTitleParts.join(' · ');
  const bodyHtml = usage
    ? `
        <span class="pt-sidebar-today" data-pt-sidebar-range="${esc(rangePreset)}">${esc(rangeMeta.short)}</span>
        <span class="pt-sidebar-metrics">
          <span class="pt-sidebar-metric" data-pt-today-tokens="1">
            <span class="pt-sidebar-val pt-mono">${esc(tokensText)}</span>
            <span class="pt-sidebar-unit">tok</span>
          </span>
          <span class="pt-sidebar-sep" aria-hidden="true"></span>
          <span class="pt-sidebar-metric" data-pt-today-cost="1">
            <span class="pt-sidebar-val pt-mono">${esc(costText)}</span>
          </span>
        </span>
      `
    : `<span class="pt-sidebar-fallback">${esc(rangeMeta.short)}用量看板</span>`;

  return `
    <div class="pt-sidebar-stack">
      ${appUpdateRowHtml}
      ${updateRowHtml}
      <button type="button" class="pt-sidebar-trigger" data-pt-action="open-dashboard" title="${esc(triggerTitle)}" aria-label="${esc(triggerTitle)}">
        <span class="pt-sidebar-logo" data-state="${esc(badgeState)}" aria-hidden="true">
          <span class="pt-sidebar-logo-text">T3</span>
          <span class="pt-sidebar-status-dot"></span>
        </span>
        ${bodyHtml}
      </button>
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
      ? '打开会话查看额度'
      : '暂无额度';
    return `<div class="pt-ov-empty">${esc(emptyMsg)}</div>`;
  }

  const g = quotas[0];
  if (!g.windows.length) {
    return `<div class="pt-ov-empty">暂无额度</div>`;
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
        : (remTimeMs != null ? ` · ${fmtCountdown(remTimeMs)} 后重置` : (rem === 100 ? ' · 满额' : ''));
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

function renderOverviewCardHtml(live, collapsed, showAllSteps = false, options = {}) {
  const docked = Boolean(options?.docked);
  const dockStyle = options?.dockStyle === 'stack' ? 'stack' : 'flush';
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
  const phaseLabel = unresolved ? '未选会话'
    : thread?.phase === 'error' ? '已结束'
    : (thread?.phaseLabel || '空闲');
  const phaseTone = unresolved ? 'muted'
    : thread?.phase === 'waiting_approval' ? 'warning'
    : thread?.phase === 'error' ? 'muted'
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
    ? `<div class="pt-muted" style="font-size:11px;padding:4px 2px;">${esc(thread?.reason || '打开会话后显示')}</div>`
    : visibleSteps.length
      ? visibleSteps.map(s => {
          const sTone = s.status === 'running' ? 'accent' : s.status === 'failed' ? 'muted' : 'success';
          return `
            <div class="pt-step-row" title="${esc(s.title)}">
              <span class="pt-dot pt-tone-${sTone}${s.status === 'running' ? ' pt-dot-pulse' : ''}"></span>
              <span class="pt-muted" style="flex:none;">${esc(s.phaseLabel)}</span>
              <span class="pt-step-title">${esc(s.title)}</span>
              <span class="pt-mono pt-muted" style="flex:none;">${esc(fmtDuration(s.durationMs))}</span>
            </div>
          `;
        }).join('')
      : `<div class="pt-muted" style="font-size:11px;padding:4px 2px;">暂无步骤</div>`;

  const quotaSectionHtml = renderCompactOverviewQuotasHtml(quotas, {
    preferredPool,
    now,
    unresolved,
    activeAccountId
  });
  const quotaHeaderLabel = activeGroup
    ? activeGroup.displayName
    : '当前额度';
  const creditTag = activeGroup?.resetCredits?.availableCount > 0
    ? `<span class="pt-badge pt-badge-ok pt-mono" style="font-size:9px;padding:0 5px;flex:none;" title="可用重置券">重置券×${esc(activeGroup.resetCredits.availableCount)}</span>`
    : '';

  const queuedBadge = !unresolved && thread?.queuedRuns > 0
    ? `<span class="pt-badge pt-badge-warn" style="margin-left:4px;">排队 ${esc(thread.queuedRuns)}</span>`
    : '';

  const headerTitle = docked ? '已合并到右侧面板 · 点击折叠 / 展开' : '折叠 / 展开';
  const dockPill = docked ? '<span class="pt-dock-pill">已合并</span>' : '';

  return `
    <div class="pt-overview-card${collapsed ? ' collapsed' : ''}${docked ? (dockStyle === 'stack' ? ' docked docked-stack' : ' docked') : ''}" data-pt-overview-mode="${docked ? 'docked' : 'floating'}">
      <div class="pt-overview-header" data-pt-action="toggle-overview" title="${headerTitle}">
        <div style="display:flex;align-items:center;gap:6px;min-width:0;">
          <span class="pt-dot pt-tone-${phaseTone}${isRunning ? ' pt-dot-pulse' : ''}"></span>
          <strong style="white-space:nowrap;">${esc(phaseLabel)}</strong>
          ${queuedBadge}
          <span class="pt-mono pt-muted" style="font-size:11px;white-space:nowrap;">
            ${!unresolved && thread?.run?.durationMs != null ? esc(fmtDuration(thread.run.durationMs)) : ''}${collapsed ? esc(collapsedQuota) : ''}
          </span>
        </div>
        <span style="display:inline-flex;align-items:center;gap:6px;flex:none;">
          ${dockPill}
          <span class="pt-muted" style="font-size:10.5px;flex:none;">${collapsed ? '展开 ▾' : '收起 ▴'}</span>
        </span>
      </div>
      ${collapsed ? '' : `
        <div class="pt-overview-body">
          <div>
            <div class="pt-section-title">
              <span>步骤 (${allSteps.length})</span>
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
                <button class="pt-btn" data-pt-action="open-quotas" style="padding:1px 5px;font-size:10px;" title="全部账号额度">额度</button>
                <button class="pt-btn" data-pt-action="open-dashboard" style="padding:1px 5px;font-size:10px;" title="打开 T3Tools">看板</button>
              </span>
            </div>
            ${quotaSectionHtml}
          </div>
        </div>
      `}
    </div>
  `;
}

function renderHeatmapSvg(heatmap, metric = 'tokens', range = null) {
  const days = heatmap?.days || [];
  if (!days.length) return `<div class="pt-muted">暂无历史记录</div>`;

  const cell = 11;
  const gap = 3;
  const step = cell + gap;
  const weeks = Math.ceil(days.length / 7);
  const width = weeks * step + 28;
  const height = 7 * step + 22;
  const maxVal = metric === 'errors' ? heatmap.maxErrors : metric === 'requests' ? heatmap.maxRequests
    : metric === 'costUsd' ? heatmap.maxCost
    : heatmap.maxTokens;

  const hasRangeBox = Boolean(range && range.preset !== 'all' && Number.isFinite(range.start) && Number.isFinite(range.end));
  const rangeStartDay = hasRangeBox ? ptFormatYmd(new Date(range.start)) : '';
  const rangeEndDay = hasRangeBox ? ptFormatYmd(new Date(range.end)) : '';

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
    const val = metric === 'errors' ? d.errors : metric === 'requests' ? d.requests : metric === 'costUsd' ? d.costUsd : d.tokens;
    let lv = 0;
    if (val > 0 && maxVal > 0) {
      const ratio = val / maxVal;
      lv = ratio >= 0.75 ? 4 : ratio >= 0.45 ? 3 : ratio >= 0.18 ? 2 : 1;
    }
    const clickable = metric === 'errors' ? d.errors > 0 : d.requests > 0;
    const inRange = hasRangeBox && d.date >= rangeStartDay && d.date <= rangeEndDay;
    const actionHint = clickable ? (metric === 'errors' ? ' · 点击排查当日错误' : ' · 点击查看当日明细') : '';
    const tip = `${d.date} · ${d.requests} 次请求 · ${fmtTokens(d.tokens)} tokens · ${fmtUsd(d.costUsd)}${d.errors ? ` · ${d.errors} 错误` : ''}${actionHint}`;
    const strokeAttr = inRange ? ' stroke="color-mix(in srgb, var(--pt-accent, #6366f1) 55%, transparent)" stroke-width="0.9"' : '';
    rects += `<rect ${clickable ? `data-pt-heatmap-day="${esc(d.date)}"` : ''} x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2.5" fill="${metric === 'errors' ? levels[lv].replace('--pt-accent, #6366f1','--pt-danger, #ef4444') : levels[lv]}"${strokeAttr}><title>${esc(tip)}</title></rect>`;

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

function renderOverviewQuotaStripHtml(data, uiState = {}) {
  const groups = Array.isArray(data?.quotas?.groups) ? data.quotas.groups : [];
  if (!groups.length) return '';
  const activeAccount = String(uiState?.account || 'all');
  const chipsHtml = groups.map(g => {
    const remVals = (g.windows || []).map(w => w.remainingPercent).filter(v => v != null && Number.isFinite(v));
    const minRem = g.minRemainingPercent != null ? g.minRemainingPercent : (remVals.length ? Math.min(...remVals) : null);
    const tone = quotaTone(minRem);
    const meta = driverMeta(g.driver, g.accentColor);
    const isActive = activeAccount === g.accountId;
    const tip = isActive
      ? `已按 ${g.displayName} 筛选概览 · 点击恢复全部账号`
      : `点击按账号 ${g.displayName} 筛选用量概览（最低剩余 ${minRem != null ? minRem + '%' : '-'}）`;
    return `
      <button type="button" class="pt-quota-chip${isActive ? ' active' : ''}" data-pt-ov-account="${esc(g.accountId)}" aria-pressed="${isActive ? 'true' : 'false'}" title="${esc(tip)}">
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
        <span class="pt-muted" style="font-size:11px;font-weight:600;">账号额度</span>
        <span class="pt-badge pt-badge-muted pt-mono">${groups.length}</span>
      </div>
      <div class="pt-quota-strip-list">${chipsHtml}</div>
      <button type="button" class="pt-btn" data-pt-tab="quotas">全部 →</button>
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
    resetText = '满额 · 首次调用后计时';
  } else {
    resetText = '暂无重置时间';
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
          ${esc(g.unavailable?.message || '暂无额度数据')}
        </div>
      </div>
    `;

  const extrasHtml = g.resetCredits?.availableCount > 0
    ? `
      <div class="pt-acc-extras">
        <span class="pt-credit-chip pt-mono" title="T3 Code 缓存上报的可用额度重置券">
          🎟 重置券 ×${esc(g.resetCredits.availableCount)}${g.resetCredits.nextExpiresAtMs ? ` · 有效期至 ${fmtDateShort(g.resetCredits.nextExpiresAtMs)}` : ''}
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
            ${g.modelsCount ? `${esc(g.modelsCount)} 模型 · ` : ''}${checkedAge ? `同步 ${esc(checkedAge)} · ` : ''}${esc(usageNote)}
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
            <strong class="pt-mono pt-text-${tone}">${w.remainingPercent != null ? `${esc(w.remainingPercent)}%` : '-'}</strong>
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
                ${g.resetCredits?.availableCount ? `<span class="pt-badge pt-badge-ok" title="可用重置券">🎟×${esc(g.resetCredits.availableCount)}</span>` : ''}
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
        <div style="font-size:14px;font-weight:600;margin-bottom:6px;">未检测到已登录账号</div>
        <div class="pt-muted">请先在 T3 Code 登录并启用至少一个账号，再点击刷新。</div>
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
        <div class="pt-kpi-label">账号</div>
        <div class="pt-kpi-val pt-mono">${summary.readyAccounts} <span class="pt-muted" style="font-size:13px;font-weight:500;">/ ${summary.totalAccounts} 有额度</span></div>
        <div class="pt-kpi-sub">${esc(driverDistText)}</div>
      </div>
      <div class="pt-card">
        <div class="pt-kpi-label">健康分布</div>
        <div class="pt-kpi-val" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:2px;">
          <span class="pt-badge pt-badge-ok pt-mono">健康 ${summary.healthyAccounts}</span>
          <span class="pt-badge pt-badge-warn pt-mono">偏紧 ${summary.warningAccounts}</span>
          <span class="pt-badge pt-badge-err pt-mono">告急 ${summary.criticalAccounts}</span>
        </div>
        <div class="pt-kpi-sub">&gt;40% 健康 · ≤40% 偏紧 · ≤15% 告急</div>
      </div>
      <div class="pt-card">
        <div class="pt-kpi-label">最低剩余</div>
        <div class="pt-kpi-val pt-mono pt-text-${lowestTone}">${lowest ? `${lowest.remainingPercent}%` : '-'}</div>
        <div class="pt-kpi-sub" title="${esc(lowest ? `${lowest.displayName} · ${lowest.label}` : '')}">
          ${lowest ? `${esc(lowest.accountId)} · ${esc(lowest.poolLabel || lowest.label)} (${esc(lowest.windowTag || lowest.kind)})` : '暂无数据'}
        </div>
      </div>
      <div class="pt-card">
        <div class="pt-kpi-label">下次重置</div>
        <div class="pt-kpi-val pt-mono">${soonest ? fmtCountdown(Math.max(0, soonest.resetsAtMs - now)) : '-'}</div>
        <div class="pt-kpi-sub">
          ${soonest ? `${esc(soonest.accountId)} · ${esc(soonest.poolLabel || soonest.label)} · ${fmtTimeShort(soonest.resetsAtMs)}` : '暂无重置倒计时'}
        </div>
      </div>
    </div>

    <div class="pt-card">
      <div class="pt-quota-toolbar">
        <div class="pt-pill-group">${driverPillsHtml}</div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <select class="pt-select" data-pt-quota-sort="1" title="排序">
            <option value="remaining"${sortMode === 'remaining' ? ' selected' : ''}>剩余最少</option>
            <option value="reset"${sortMode === 'reset' ? ' selected' : ''}>最近重置</option>
            <option value="name"${sortMode === 'name' ? ' selected' : ''}>账号名称</option>
          </select>
          <div class="pt-dash-tabs">
            <button class="pt-tab${viewMode === 'cards' ? ' active' : ''}" data-pt-quota-view="cards" style="padding:3px 9px;font-size:11px;">卡片</button>
            <button class="pt-tab${viewMode === 'table' ? ' active' : ''}" data-pt-quota-view="table" style="padding:3px 9px;font-size:11px;">表格</button>
          </div>
          ${hasAnyEmail ? `<button class="pt-btn" data-pt-action="toggle-hide-email" title="切换邮箱显示">${hideEmail ? '显示邮箱' : '隐藏邮箱'}</button>` : ''}
          <button type="button" class="pt-head-refresh" data-pt-action="refresh" title="刷新" aria-label="刷新数据">${PT_REFRESH_SVG}</button>
        </div>
      </div>
    </div>

    ${mainContentHtml}
  `;
}

function overviewFallbackTotals(data) {
  const k = data?.summary?.kpis || {};
  const a = data?.anomalySummary || {};
  return {
    calls: k.totalRequests ?? 0,
    knownOutcomeCount: k.knownOutcomeCount ?? 0,
    successCount: k.successCount ?? 0,
    errors: k.errorCount ?? 0,
    retried: k.retryRequests ?? 0,
    anomalies: k.anomalyCount ?? a.total ?? 0,
    excludedCompactions: a.excludedCompactions ?? 0,
    inputTokens: k.inputTokens ?? 0,
    outputTokens: k.outputTokens ?? 0,
    cacheReadTokens: k.cacheReadTokens ?? 0,
    cacheWriteTokens: k.cacheWriteTokens ?? 0,
    thinkingTokens: k.thinkingTokens ?? 0,
    totalTokens: k.totalTokens ?? 0,
    costUsd: k.costUsd ?? 0,
    savedUsd: k.savedUsd ?? 0,
    unpricedCount: 0,
    cacheHitPercent: k.cacheHitPercent ?? null,
    decodeN: 0,
    floorN: 0,
    ttftCount: 0,
    avgTtftMs: null
  };
}

const PT_HEATMAP_METRICS = [
  ['tokens', 'Token'],
  ['requests', '请求数'],
  ['costUsd', '参考费用'],
  ['errors', '错误数']
];
const PT_HEATMAP_METRIC_KEYS = new Set(PT_HEATMAP_METRICS.map(m => m[0]));

function normalizeHeatmapMetric(raw) {
  const m = String(raw || '').trim();
  return PT_HEATMAP_METRIC_KEYS.has(m) ? m : 'tokens';
}

function renderHeatmapCardHtml(data, uiState = {}) {
  const heatmap = data?.heatmap || {};
  const range = data?.range || null;
  const heatmapMetric = normalizeHeatmapMetric(uiState?.heatmapMetric);
  const peakText = heatmapMetric === 'requests'
    ? `峰值 ${fmtUsageInteger(heatmap.maxRequests || 0)} 次/日`
    : heatmapMetric === 'costUsd'
      ? `峰值 ${fmtUsd(heatmap.maxCost || 0)}/日`
      : heatmapMetric === 'errors'
        ? `峰值 ${fmtUsageInteger(heatmap.maxErrors || 0)} 错误/日`
        : `峰值 ${fmtTokens(heatmap.maxTokens || 0)} tokens/日`;
  const toneVar = heatmapMetric === 'errors' ? 'var(--pt-danger, #ef4444)' : 'var(--pt-accent, #6366f1)';
  const legendSwatches = [
    'color-mix(in srgb, var(--pt-fg, #fff) 8%, transparent)',
    `color-mix(in srgb, ${toneVar} 30%, transparent)`,
    `color-mix(in srgb, ${toneVar} 52%, transparent)`,
    `color-mix(in srgb, ${toneVar} 76%, transparent)`,
    toneVar
  ].map(c => `<span class="pt-heatmap-swatch" style="background:${c};"></span>`).join('');
  const activeHint = heatmapMetric === 'errors' ? '点击有错误的日期排查异常' : '点击日期看明细';

  return `
      <div class="pt-card" data-pt-heatmap-card="1">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
          <div>
            <strong>活跃热力图</strong>
            <span class="pt-muted" style="margin-left:8px;font-size:11px;">活跃 ${heatmap.activeDays || 0} 天 (${esc(heatmap.startDate)} ~ ${esc(heatmap.endDate)}) · ${esc(activeHint)}</span>
          </div>
          <div class="pt-dash-tabs" role="tablist" aria-label="热力图指标">
            ${PT_HEATMAP_METRICS.map(([id, label]) => `
              <button type="button" class="pt-tab${heatmapMetric === id ? ' active' : ''}" role="tab" aria-selected="${heatmapMetric === id ? 'true' : 'false'}" data-pt-heatmap="${esc(id)}">${esc(label)}</button>
            `).join('')}
          </div>
        </div>
        ${renderHeatmapSvg(heatmap, heatmapMetric, range)}
        <div class="pt-heatmap-foot">
          <span class="pt-mono">${esc(peakText)}</span>
          <span class="pt-heatmap-legend"><span>少</span>${legendSwatches}<span>多</span></span>
        </div>
      </div>
  `;
}

function renderOverviewCoreHtml(data, uiState = {}) {
  const range = data?.range || {};
  const ovLedger = data?.overviewLedger || data?.requestsLedger || null;
  const totals = ovLedger?.totals || overviewFallbackTotals(data);

  const rollingHours = parsePeriodHours(range.preset);
  const cycleDesc = range.preset === 'weeklyQuota'
    ? (range.status === 'active'
      ? `本周限额：${fmtTime(range.start)} 起 · 距重置 ${fmtCountdown(range.resetsAtMs - Date.now())}`
      : `近 7 天（未检测到周限额重置）：${fmtTime(range.start)} 起`)
    : rollingHours
      ? `近 ${rollingHours} 小时：${fmtTime(range.start)} → ${fmtTime(range.end)}`
      : `范围：${range.start ? fmtTime(range.start) : '全部'} → ${fmtTime(range.end)}`;

  const anomCount = totals.anomalies || 0;
  const errCount = totals.errors || 0;
  const exclCount = totals.excludedCompactions || data?.anomalySummary?.excludedCompactions || 0;

  return `
    <div class="pt-ov-root pt-led-root" data-pt-overview-root="1">
      <div class="pt-cycle-banner">
        <span>${esc(cycleDesc)}</span>
        <span style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;">
          <button type="button" class="pt-cycle-pill" data-pt-ov-jump="anomaly" title="查看异常掉缓存记录">
            掉缓存 <strong class="pt-mono ${anomCount ? 'pt-text-danger' : 'pt-text-success'}">${anomCount}</strong>
          </button>
          <button type="button" class="pt-cycle-pill" data-pt-ov-jump="error" title="查看失败请求">
            失败 <strong class="pt-mono ${errCount ? 'pt-text-danger' : 'pt-muted'}">${errCount}</strong>
          </button>
          <span class="pt-muted pt-mono" title="上下文压缩导致的缓存重置已自动排除">压缩排除 ${exclCount}</span>
          <button type="button" class="pt-btn" data-pt-ov-jump="all" title="查看请求明细">明细 →</button>
        </span>
      </div>

      ${renderOverviewQuotaStripHtml(data, uiState)}

      ${ledStrip(totals)}

      ${ovLedger ? ledTrend(ovLedger, uiState) : ''}

      ${renderHeatmapCardHtml(data, uiState)}
    </div>
  `;
}

function renderModelsAnalysisHtml(data, uiState = {}) {
  const models = data?.summary?.models || [];
  const ovLedger = data?.overviewLedger || data?.requestsLedger || null;
  const speedMap = new Map((ovLedger?.speeds?.items || []).map(item => [item.modelId, item]));
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

  const sortKey = uiState.modelSort || 'totalTokens';
  const sortDir = uiState.modelSortDir || -1;
  const enrichedModels = models.map(m => {
    const sp = speedMap.get(m.modelId);
    const medianTps = sp?.medianTps ?? m.avgTps ?? null;
    const medianTtftMs = sp?.medianTtftMs ?? m.avgTtftMs ?? null;
    return {
      ...m,
      medianTps,
      medianIsFloor: sp ? Boolean(sp.isFloor) : m.avgTpsKind === 'e2e-estimate',
      medianTtftMs,
      speedSamples: sp?.speedSamples ?? 0,
      ttftSamples: sp?.ttftSamples ?? 0,
      hasMedianSpeed: Boolean(sp && sp.medianTps != null),
      hasMedianTtft: Boolean(sp && sp.medianTtftMs != null)
    };
  }).sort((a, b) => {
    const va = a[sortKey];
    const vb = b[sortKey];
    if (va == null && vb == null) return a.modelId.localeCompare(b.modelId);
    if (va == null) return 1;
    if (vb == null) return -1;
    if (sortKey === 'modelId') return sortDir * a.modelId.localeCompare(b.modelId);
    return sortDir * (va - vb) || a.modelId.localeCompare(b.modelId);
  });

  const sortTh = (key, label) => {
    const on = sortKey === key;
    const arrow = on ? (sortDir === 1 ? ' ↑' : ' ↓') : '';
    return `<th aria-sort="${!on ? 'none' : sortDir === 1 ? 'ascending' : 'descending'}"><button type="button" class="pt-sort-th${on ? ' on' : ''}" data-pt-model-sort="${esc(key)}">${esc(label)}${arrow}</button></th>`;
  };

  return `
    <div class="pt-two-col">
      <div class="pt-card">
        <div style="font-weight:600;margin-bottom:6px;">Token 与费用占比</div>
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
                const failPills = Object.entries(m.errorCodes || {})
                  .map(([k,v]) => `<button class="pt-badge pt-badge-btn pt-badge-err" type="button" title="最终失败 · 点击按此模型与错误类型下钻排查" data-error-action="drill" data-pt-drill-error-model="${esc(m.modelId)}" data-pt-drill-error-code="${esc(k)}">${esc(ERROR_CODE_LABELS[k] || k)}:${v}</button>`);
                const retryPills = Object.entries(m.retryErrorCodes || {})
                  .map(([k,v]) => `<button class="pt-badge pt-badge-btn pt-badge-warn" type="button" title="重试后恢复 · 点击按此模型与错误类型下钻排查" data-error-action="drill" data-pt-drill-error-model="${esc(m.modelId)}" data-pt-drill-error-code="${esc(k)}">${esc(ERROR_CODE_LABELS[k] || k)} ↻:${v}</button>`);
                const errSummary = failPills.concat(retryPills).join(' ') || '-';
                return `
                  <tr>
                    <td class="pt-mono"><button type="button" class="pt-model-link" data-pt-model-requests="${esc(m.modelId)}" title="在请求明细中查看该模型全部请求">${esc(m.modelId)}</button></td>
                    <td><button class="pt-badge pt-badge-btn ${badgeCls}" type="button" title="点击筛选该模型的错误记录" data-error-action="drill" data-pt-drill-error-model="${esc(m.modelId)}">${badgeText}</button></td>
                    <td class="pt-mono">${fmtPct(m.successRate)} <span class="pt-muted">(${m.knownOutcomeCount}/${m.requests})</span></td>
                    <td class="pt-mono">${fmtPct(m.retryRate)}</td>
                    <td class="pt-muted">${errSummary}</td>
                  </tr>
                `;
              }).join('') : '<tr><td colspan="5" class="pt-muted">当前周期无记录</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    ${renderErrorTracker(data, uiState)}
    <div class="pt-card">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
        <div style="font-weight:600;">性能与速度排行</div>
        <span class="pt-muted" style="font-size:11px;">点表头排序 · 点模型看明细</span>
      </div>
      <div class="pt-table-wrap">
        <table class="pt-table">
          <thead>
            <tr>
              ${sortTh('modelId', '模型')}
              ${sortTh('requests', '请求')}
              ${sortTh('totalTokens', '总 Token (占比)')}
              ${sortTh('costUsd', '参考费用 (占比)')}
              ${sortTh('cacheHitPercent', '缓存命中率')}
              ${sortTh('medianTps', '中位速度')}
              <th>峰值速度</th>
              ${sortTh('medianTtftMs', '中位首字')}
              <th>有效样本</th>
            </tr>
          </thead>
          <tbody>
            ${enrichedModels.length ? enrichedModels.map(m => {
              const tpsPrefix = m.medianIsFloor ? '≥' : '';
              const avgPrefix = m.avgTpsKind === 'e2e-estimate' ? '~' : '';
              const speedTip = [
                m.hasMedianSpeed ? (m.medianIsFloor ? '端到端耗时推算速度下限（中位数）' : '流式生成实测速度（中位数）') : '均速回退',
                m.avgTps != null ? `均速 ${avgPrefix}${m.avgTps} tok/s` : '',
                m.peakTps != null ? `峰值 ${avgPrefix}${m.peakTps} tok/s` : ''
              ].filter(Boolean).join(' · ');
              const ttftTip = m.avgTtftMs != null ? `平均首字 ${fmtDuration(m.avgTtftMs)}` : '暂无首字计时';
              return `
              <tr>
                <td class="pt-mono"><button type="button" class="pt-model-link" data-pt-model-requests="${esc(m.modelId)}" title="点击在请求明细中筛选该模型">${esc(m.modelId)}</button></td>
                <td class="pt-mono">${m.requests}</td>
                <td class="pt-mono">${fmtTokens(m.totalTokens)} <span class="pt-muted">(${m.tokenSharePercent}%)</span></td>
                <td class="pt-mono">${fmtUsd(m.costUsd)} <span class="pt-muted">(${m.costSharePercent}%)</span></td>
                <td>
                  <div style="display:flex;align-items:center;gap:6px;">
                    <span class="pt-bar-mini"><span class="pt-bar-fill pt-tone-success" style="width:${Math.min(100, m.cacheHitPercent || 0)}%"></span></span>
                    <span class="pt-mono">${fmtPct(m.cacheHitPercent)}</span>
                  </div>
                </td>
                <td class="pt-mono" title="${esc(speedTip)}">${m.medianTps != null ? `${tpsPrefix}${Math.round(m.medianTps)} tok/s` : '-'}</td>
                <td class="pt-mono pt-muted">${m.peakTps != null ? `${avgPrefix}${m.peakTps} tok/s` : '-'}</td>
                <td class="pt-mono pt-muted" title="${esc(ttftTip)}">${fmtDuration(m.medianTtftMs)}</td>
                <td class="pt-mono pt-muted">${m.speedSamples || m.ttftSamples ? `${m.speedSamples} 速度 · ${m.ttftSamples} 首字` : '-'}</td>
              </tr>
            `;
            }).join('') : '<tr><td colspan="9" class="pt-muted">当前周期无模型请求</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

const ledLabels = { antigravity:'Antigravity 对话库',codex:'Codex Rollout',t3scan:'T3 扫描缓存',other:'其他来源' };
const ledStatus = r => ({success:'成功',error:'失败',recorded:'已记录'}[r.status] || '未知');
const ledPct = n => n == null ? '—' : (n>99.94 && n<100 ? Math.min(99.99,n).toFixed(2) : n.toFixed(1))+'%';
const ledBtn = (key,val,label,on=false,extra='') => '<button type="button" class="pt-btn '+(on?'on ':'')+extra+'" data-pt-led-'+key+'="'+esc(val)+'">'+label+'</button>';
const ledSpeedParts = s => ['decode','floor'].filter(k=>s[k+'N']).sort((a,b)=>s[b+'N']-s[a+'N']).map(k=>({
  value:1000*s[k+'Out']/s[k+'Ms'],label:(k==='floor'?'≥':'')+Math.round(1000*s[k+'Out']/s[k+'Ms'])+' tok/s',count:s[k+'N']+(k==='floor'?' 次估算':' 次实测')}));
const ledPreferences = Object.create(null);
const ledDims = {model:'模型',modelAt:'模型 · 账号',account:'账号',driver:'驱动'};
const ledMetrics = {tokens:'Token',cost:'费用',calls:'请求',speed:'速度'};
function ledPref(k,choices) {
  try { const v=localStorage.getItem('t3tools.requests.'+k); if(Object.hasOwn(choices,v)) return v; } catch {}
  return ledPreferences[k] || Object.keys(choices)[0];
}
function ledSelect(k,label,items,active='all') {
  return '<label>'+label+' <select class="pt-select" data-pt-filter="'+k+'">'+[['all','全部'],...items].map(([v,n])=>'<option value="'+esc(v)+'" '+(v===active?'selected':'')+'>'+esc(n)+'</option>').join('')+'</select></label>';
}
function ledControls(data,s) {
  const f=data?.facets || {}, l=data?.requestsLedger, models=new Map((l?.modelsByTokens || l?.chartBy.model || []).map(r=>[r.id,r.tokens]));
  for(const m of f.models || []) if(!models.has(m)) models.set(m,0);
  const codes=new Set(Object.keys(data?.errorInsights?.summary?.byCode || {}));
  if(s.errorCode && s.errorCode!=='all') codes.add(s.errorCode);
  const active=s.onlyAnomalies?'anomaly':s.status || 'all';
  return ((f.drivers?.length>1 || (s.driver && s.driver!=='all'))?ledSelect('driver','驱动',(f.drivers || []).map(d=>[d,d]),s.driver):'')+
    ledSelect('model','模型',[...models].map(([m,n])=>[m,m+' · '+fmtTokens(n)]),s.model)+
    (codes.size?ledSelect('errorCode','错误类型',[...codes].map(c=>[c,ERROR_CODE_LABELS[c] || c]),s.errorCode):'')+
    '<span class="pt-led-segs">'+[['all','全部'],['error','失败'],['retried','重试'],['anomaly','掉缓存 <b data-pt-anomaly-count>'+Number(data?.anomalySummary?.total || 0)+'</b>']].map(([v,n])=>ledBtn('status',v,n,active===v)).join('')+'</span>'+
    ['day','errorCode','status','requestId'].filter(k=>s[k] && s[k]!=='all' && (k!=='status' || ['success','error_or_retried'].includes(s[k]))).map(k=>ledBtn('clear',k,esc(({success:'成功',error_or_retried:'失败或重试'}[s[k]] || s[k]))+' ×')).join('');
}
function ledStrip(t) {
  const speed=ledSpeedParts(t), prompt=t.totalTokens-t.outputTokens;
  const ovJump = (val, label, cls='') => '<button type="button" class="pt-btn pt-led-jump '+cls+'" data-pt-ov-jump="'+esc(val)+'">'+label+'</button>';
  const cell=(title,value,sub,tip='',cls='',jump='')=>'<div '+(jump?'data-pt-ov-jump="'+esc(jump)+'" tabindex="0" ':'')+'title="'+esc(tip)+'"><small>'+title+'</small><strong class="'+cls+'">'+value+'</strong><small>'+sub+'</small></div>';
  return '<section class="pt-led-strip">'+cell('Tokens',fmtTokens(t.totalTokens),'输入 '+fmtTokens(t.inputTokens)+' · 输出 '+fmtTokens(t.outputTokens)+'<br>缓存 '+fmtTokens(t.cacheReadTokens+t.cacheWriteTokens),t.totalTokens+' · 点击查看请求明细','','all')+
    cell('请求数',t.calls,ovJump('error',t.errors+' 失败')+' · 成功率 '+ledPct(t.knownOutcomeCount?100*t.successCount/t.knownOutcomeCount:null)+'<br>'+ovJump('retried',t.retried+' 次重试')+' · '+ovJump('anomaly',t.anomalies+' 次掉缓存'),'点击查看本周期全部请求明细','','all')+
    cell('参考费用',t.costUsd==null?'—':fmtUsd(t.costUsd),'按官方参考价<br>'+(t.unpricedCount?t.unpricedCount+' 次未计价':'缓存省 '+fmtUsd(t.savedUsd)),'仅汇总已计价请求 · 点击前往模型分析看费用占比','pt-led-cost','models')+
    cell('缓存命中率',ledPct(t.cacheHitPercent),'复用 '+fmtTokens(t.cacheReadTokens)+' / 输入 '+fmtTokens(prompt)+'<div class="pt-led-meter"><i style="width:'+(t.cacheHitPercent || 0)+'%"></i></div>',t.anomalies?'点击查看异常掉缓存记录':'点击查看请求明细','',t.anomalies?'anomaly':'all')+
    cell('输出速度',speed[0]?.label || '—',(speed[0]?.count || '')+(speed[1]?' · '+speed[1].label+' '+speed[1].count:'')+'<br>'+(t.ttftCount?'平均首字 '+fmtDuration(t.avgTtftMs)+' · '+t.ttftCount+' 次计时':'暂无首字计时'),'点击前往模型分析查看速度与首字排行','','models')+'</section>';
}
function ledValue(m,r) { return m==='speed'?ledSpeedParts(r)[0]?.value : m==='cost'?r.costUsd:r[m]; }
function ledMetricText(m,r) { const v=ledValue(m,r);return v==null?'—':m==='cost'?fmtUsd(v):m==='speed'?ledSpeedParts(r)[0].label:fmtTokens(v); }
function ledCurve(points) {
  if (!points.length) return '';
  const slopes=points.slice(1).map(([x,y],i)=>(y-points[i][1])/(x-points[i][0]));
  const tangents=points.map((_,i)=>i===0?slopes[0]:i===points.length-1?slopes[i-1]:slopes[i]*slopes[i-1]<=0?0:2/(1/slopes[i]+1/slopes[i-1]));
  return 'M'+points[0].join(' ')+points.slice(1).map(([x,y],i)=>{
    const [px,py]=points[i], dx=(x-px)/3;
    return ' C'+[px+dx,py+dx*tangents[i],x-dx,y-dx*tangents[i+1],x,y].join(' ');
  }).join('');
}
function ledTrend(l,s) {
  const m=ledPref('metric',ledMetrics),dim=ledPref('split',ledDims),style=ledPref('style',{bars:1,line:1});
  const sorted=rows=>rows.slice().sort((a,b)=>(ledValue(m,b)||0)-(ledValue(m,a)||0));
  const top=sorted(l.chartBy[dim]).slice(0,6),ids=top.map(r=>r.id),color=i=>i<0 || i===6?'var(--pt-muted)':'var(--pt-chart-'+(i+1)+')';
  const W=Math.max(360,Math.round(s._chartW || 600));
  const pts=l.series, slot=(W-70)/Math.max(1,pts.length),x=i=>58+(i+.5)*slot, w=Math.min(30,slot*.7);
  const vals=pts.map(p=>{
    const values=Array(7).fill(null);
    for (const r of p.by[dim]) {
      const idx=ids.indexOf(r.id), i=idx<0?6:idx,v=ledValue(m,r);
      if(v!=null && (m!=='speed' || idx>=0)) values[i]=(values[i] || 0)+v;
    }
    return values;
  });
  const max=pts.reduce((a,p,i)=>Math.max(a,ledValue(m,p)||0,...vals[i].map(v=>v||0)),0);
  const unit=10**Math.floor(Math.log10((max||4)/4)), axis=4*unit*([1,2,2.5,5,10].find(v=>4*v*unit>=max)||10);
  const y=v=>203-188*v/axis, speed=m==='speed';
  let svg='';
  for(let j=0;j<=4;j++) {
    const v=axis*j/4;
    svg+='<path d="M56 '+y(v)+'H'+(W-10)+'" stroke="var(--pt-border)" stroke-dasharray="3 4"/><text x="51" y="'+(y(v)+4)+'" text-anchor="end">'+(m==='cost'?fmtUsd(v):fmtTokens(v))+'</text>';
  }
  const stacks=pts.map(()=>0);
  const line=(arr,stroke,i,base)=>{
    let out='',seg=[],bottom=[];
    function flush(){
      if(!seg.length)return;
      const path=ledCurve(seg);
      if(base)out+='<path data-series="'+i+'" fill="'+stroke+'" fill-opacity=".14" d="'+path+' '+ledCurve(bottom.reverse()).replace('M','L')+'Z"/>';
      out+=seg.length===1?'<circle data-series="'+i+'" cx="'+seg[0][0]+'" cy="'+seg[0][1]+'" r="3" fill="'+stroke+'"/>':'<path data-series="'+i+'" d="'+path+'" fill="none" stroke="'+stroke+'" stroke-width="2" '+(i===-1?'stroke-dasharray="4 3"':'')+'/>';
      seg=[];bottom=[];
    }
    arr.forEach((v,j)=>{if(v==null){flush();return;}seg.push([x(j),y(v)]);if(base)bottom.push([x(j),y(base[j])]);});flush();return out;
  };
  if(speed && style==='line')svg+=line(pts.map(p=>ledValue(m,p)),'var(--pt-muted)',-1);
  if(speed && style==='bars')pts.forEach((p,j)=>{const h=y(ledValue(m,p)||0);svg+='<rect x="'+(x(j)-w/2)+'" y="'+h+'" width="'+w+'" height="'+(203-h)+'" fill="var(--pt-muted)" opacity=".25"/>';});
  for(let i=0;i<7;i++) {
    const base=stacks.slice();
    const curve=vals.map((v,j)=>{
      const n=v[i];if(n==null)return speed?null:(stacks[j] || 0);
      const upper=speed?n:(stacks[j]+=n);
      if(style==='bars'){
        if(speed && upper>(ledValue(m,pts[j])||0))svg+='<path data-series="'+i+'" d="M'+x(j)+' '+y(upper)+'V'+y(ledValue(m,pts[j])||0)+'" stroke="'+color(i)+'" stroke-dasharray="2 3"/>';
        svg+='<rect data-series="'+i+'" x="'+(x(j)-w/2)+'" y="'+y(upper)+'" width="'+w+'" height="'+(speed?3:y(base[j])-y(upper))+'" rx="2" fill="'+color(i)+'"/>';
      }
      return upper;
    });
    if(style==='line' && vals.some(v=>v[i]!=null))svg+=line(curve,color(i),i,speed?null:base);
  }
  pts.forEach((p,j)=>{
    if(j%Math.max(1,Math.ceil(pts.length/8))===0){const date=new Date(p.timeMs);svg+='<text text-anchor="middle" x="'+x(j)+'" y="226">'+(l.bucket==='hour'?date.toTimeString().slice(0,5):(date.getMonth()+1)+'/'+date.getDate())+'</text>';}
    svg+='<rect data-point="'+j+'" class="pt-led-hit '+(l.day===p.dayKey?'selected':l.day && l.bucket==='day'?'dim':'')+'" '+(l.bucket==='day'?'data-pt-led-day="'+esc(p.dayKey)+'" tabindex="0" role="button"':'')+' x="'+(x(j)-slot/2)+'" y="6" width="'+slot+'" height="202"/>';
  });
  const rank=sorted(l.by[dim]),sum=rank.reduce((a,r)=>a+(speed?r.calls:ledValue(m,r)||0),0);
  const rows=rank.map(r=>{
    const i=ids.indexOf(r.id),n=ledValue(m,r)||0,chosen=dim==='account' && s.account===r.id;
    return '<button type="button" class="'+(chosen?'on':'')+'" data-pt-led-rank="'+esc(r.id)+'" data-index="'+i+'" style="--sw:'+color(i)+'" title="点击在请求明细中下钻查看该项请求"><b>● '+esc([r.name,r.sub].filter(Boolean).join(' · '))+'</b><strong>'+ledMetricText(m,r)+'</strong><i style="width:'+100*n/(ledValue(m,rank[0]) || 1)+'%"></i><small>'+r.calls+' 次请求 · '+fmtTokens(r.tokens)+' tokens · '+fmtUsd(r.costUsd)+' · '+ledMetricText('speed',r)+' · 首字 '+fmtDuration(r.avgTtftMs)+' · 命中率 '+ledPct(r.cacheHitPercent)+' · 占比 '+ledPct(sum?100*(speed?r.calls:n)/sum:null)+(r.errors?' · '+r.errors+' 失败':'')+'</small></button>';
  }).join('');
  const buttons=(k,choices,v)=>Object.entries(choices).map(([id,label])=>{
    const icon = k === 'style' ? '<span aria-label="'+(id==='bars'?'柱状图':'折线图')+'" title="'+(id==='bars'?'柱状图':'折线图')+'">'+label+'</span>' : label;
    return ledBtn(k,id,icon,id===v);
  }).join('');
  const legend = l.chartBy[dim].length > 6 && !speed
    ? '<small class="pt-led-legend">● 其他</small>' : '';
  return `<section class="pt-led-trend">
    <div class="pt-led-bar">
      ${buttons('metric',ledMetrics,m)}
      ${buttons('style',{bars:'▥',line:'∿'},style)}
      <small class="pt-ov-hint">点击${l.bucket==='day'?'柱状或':''}排行看明细</small>
      <span>维度</span>${buttons('split',ledDims,dim)}
    </div>
    <div class="pt-led-body">
      <div class="pt-led-chart">
        <svg viewBox="0 0 ${W} 236" data-w="${W}" aria-label="用量趋势">${svg}</svg>
        ${legend}<div class="pt-led-tip" hidden></div>
      </div>
      <aside class="pt-led-rank">${rows || '<div class="pt-muted" style="padding:12px 8px;">当前周期无匹配数据</div>'}</aside>
    </div>
  </section>`;
}
function renderRequestsTableCardHtml(data,s={}) {
  const p=data?.requests || {items:[],total:0,page:1,totalPages:1},l=data?.requestsLedger,t=l?.totals;
  const cols=[['时间','when'],['账号 / 来源','where'],['模型','model'],['推理','lc-opt'],['会话','session'],['输入','n'],['输出','n'],['缓存写','n lc-opt'],['缓存读','n lc-opt'],['命中率','n lc-opt2'],['费用','n cost'],['首字响应','n ttft lc-opt2'],['耗时','n duration'],['速度','n speed'],['状态','st']];
  const rows=p.items.map((r,i)=>{
    const ttft=r.ttftMs!=null?'首字响应 '+fmtDuration(r.ttftMs)+(r.streamingMs!=null?' · 流式生成 '+fmtDuration(r.streamingMs):''):'当前数据源无首字计时';
    const source={antigravity:'AG',codex:'CX',t3scan:'扫描缓存'}[r.sourceGroup] || '其他';
    const values=[esc(fmtTime(r.timestampMs)), '<i class="pt-led-dot '+(r.providerDriver==='codex'?'cx':'')+'"></i>'+esc(r.accountId)+' <small>'+source+' '+esc(r.role)+'</small>',
      esc(r.modelId),esc(r.effort || '—'),esc(r.t3ThreadTitle || r.nativeSessionId?.slice(0,14) || '—'),fmtTokens(r.inputTokens),fmtTokens(r.outputTokens),fmtTokens(r.cacheWriteTokens),fmtTokens(r.cacheReadTokens),ledPct(r.cacheHitPercent),fmtUsd(r.costUsd),fmtDuration(r.ttftMs),fmtDuration(r.durationMs),r.tps!=null?(r.tpsEstimated || r.tpsKind==='e2e-estimate'?'≥':'')+Math.round(r.tps)+' tok/s':'—',
      '<b class="pt-led-st '+esc(r.status)+'">● '+ledStatus(r)+'</b>'+[r.retries?'重试 '+r.retries:'',r.cacheAnomaly?.label,r.excludedCompaction?'压缩排除':''].filter(Boolean).map(b=>'<small>'+esc(b)+'</small>').join('')];
    const tip={2:r.modelRaw,4:r.t3ThreadTitle || r.nativeSessionId,6:'思考 '+fmtTokens(r.thinkingTokens),11:ttft,12:(r.durationMs ?? '—')+' ms · ≤10s 快 · 10–30s 中 · >30s 慢 · '+ttft,13:r.tpsKind==='generation'?'流式生成实测':r.tpsKind==='e2e-estimate'?'端到端耗时推算的速度下限':'暂无计时'};
    return '<tr tabindex="0" data-pt-led-row="'+i+'" class="'+(r.cacheAnomaly?'pt-row-anomaly':'')+'">'+cols.map(([,cls],j)=>'<td class="'+cls+(j===9 && r.cacheHitPercent!=null?' hit-'+(r.cacheHitPercent>=80?'high':r.cacheHitPercent>=40?'mid':'low'):'')+(j===12 && r.durationMs!=null?' duration-'+(r.durationMs<=10000?'fast':r.durationMs<=30000?'slow':'long'):'')+'" '+(j===12?'data-ttft="'+(r.ttftMs==null?'':'首字 '+fmtDuration(r.ttftMs))+'" ':'')+'title="'+esc(tip[j] ?? '')+'">'+values[j]+'</td>').join('')+'</tr>';
  }).join('');
  const quickJumps = t ? [
    t.errors ? ledBtn('jump','error',t.errors+' 失败',s.status==='error','pt-led-jump') : '',
    t.retried ? ledBtn('jump','retried',t.retried+' 重试',s.status==='retried','pt-led-jump') : '',
    t.anomalies ? ledBtn('jump','anomaly',t.anomalies+' 掉缓存',Boolean(s.onlyAnomalies),'pt-led-jump') : ''
  ].filter(Boolean).join(' · ') : '';
  const summary = t
    ? '共 <b>'+t.calls+'</b> 条请求 · '+fmtTokens(t.totalTokens)+' tokens（入 '+fmtTokens(t.inputTokens)+' / 缓 '+fmtTokens(t.cacheReadTokens)+' / 出 '+fmtTokens(t.outputTokens)+'）· 命中率 '+ledPct(t.cacheHitPercent)+(t.costUsd!=null?' · 参考费用 <span class="pt-led-cost">'+fmtUsd(t.costUsd)+'</span>':'')+(quickJumps?' · '+quickJumps:'')
    : '共 '+p.total+' 条请求';
  const source=(id,label,r)=>ledBtn('source',id,esc(label)+'<small>'+r.calls+' 次 · '+fmtTokens(r.tokens)+' tokens</small>',(s.sourceGroup || 'all')===id);
  return '<div class="pt-led-head-card"><div class="pt-led-head"><span title="'+esc(t?[t.inputTokens,t.outputTokens,t.cacheWriteTokens,t.cacheReadTokens].join(' / '):'')+'">'+summary+'</span><small data-pt-compaction-note>已排除 '+(t?.excludedCompactions || 0)+' 次上下文压缩</small><small class="pt-led-tight" hidden>更多列见请求详情</small></div></div>'+
    (l && (l.sources.items.length>1 || s.sourceGroup && s.sourceGroup!=='all')?'<div class="pt-led-vias">'+source('all','全部请求',l.sources.all)+l.sources.items.map(r=>source(r.id,r.label,r)).join('')+'</div>':'')+
    '<div class="pt-led-wrap"><table class="pt-led"><thead><tr>'+cols.map(([label,c])=>'<th class="'+c+'">'+label+'</th>').join('')+'</tr></thead><tbody>'+(rows || '<tr><td colspan="15">无匹配请求记录</td></tr>')+'</tbody></table></div><div class="pt-led-hscroll" hidden><i></i></div><div class="pt-led-pager"><button class="pt-btn" data-pt-page="'+(p.page-1)+'" '+(p.page<=1?'disabled':'')+'>较新</button> 第 '+(p.total?(p.page-1)*(p.pageSize||50)+1:0)+'–'+Math.min(p.total,p.page*(p.pageSize||50))+' 条，共 '+p.total+' 条 <button class="pt-btn" data-pt-page="'+(p.page+1)+'" '+(p.page>=p.totalPages?'disabled':'')+'>较早</button> <select class="pt-select" aria-label="每页条数" data-pt-filter="pageSize">'+[...new Set([50,100,Number(p.pageSize)||50])].map(n=>'<option '+(n===Number(p.pageSize)?'selected':'')+'>'+n+'</option>').join('')+'</select></div>';
}
function ledDetail(r,p,data) {
  const i=p.items.indexOf(r),session=r.t3ThreadId || r.nativeSessionId;
  const dt=(k,v)=>'<dt>'+k+'</dt><dd>'+esc(v ?? '—')+'</dd>';
  const pairs=[['时间',new Date(r.timestampMs).toLocaleString()],['计费时间',r.billingTsMs!=null?new Date(r.billingTsMs).toLocaleString():null],['驱动 / 账号',[r.providerDriver,r.accountId].join(' / ')],['数据来源',(ledLabels[r.sourceGroup] || '其他')+' · '+r.sourceKey],['模型 / 原始模型名',[r.modelId,r.modelRaw].join(' / ')],['推理强度 / 角色',[r.effort,r.role].filter(Boolean).join(' / ') || '—'],['所属会话',[r.t3ThreadTitle,r.t3ThreadId].filter(Boolean).join(' · ') || '—'],['原生会话 ID',r.nativeSessionId],['状态 / 重试',ledStatus(r)+' · '+r.retries+' 次重试'],['Token 拆解',[['输入',r.inputTokens],['输出',r.outputTokens],['缓存读',r.cacheReadTokens],['缓存写',r.cacheWriteTokens],['思考',r.thinkingTokens]].map(([k,v])=>k+' '+(v??'—')).join(' · ')],['上下文窗口',(r.contextUsedTokens??'—')+' / '+(r.contextMaxTokens??'—')+' · '+ledPct(r.contextMaxTokens && r.contextUsedTokens!=null?100*r.contextUsedTokens/r.contextMaxTokens:null)],['缓存命中率',ledPct(r.cacheHitPercent)],['缓存诊断',r.cacheAnomaly?r.cacheAnomaly.reason+' · 间隔 '+fmtDuration(r.cacheAnomaly.gapMs)+' · '+ledPct(r.cacheAnomaly.prevHit)+' → '+ledPct(r.cacheAnomaly.curHit)+' · 缓存 '+r.cacheAnomaly.prevCache+' → '+r.cacheAnomaly.curCache:r.excludedCompaction?'上下文压缩已排除':'—'],['参考费用 / 缓存节省',fmtUsd(r.costUsd)+' / '+fmtUsd(r.savedUsd)],['耗时拆解','总耗时 '+fmtDuration(r.durationMs)+' · 首字 '+fmtDuration(r.ttftMs)+' · 流式生成 '+fmtDuration(r.streamingMs)],['输出速度',r.tps!=null?(r.tpsEstimated?'≥':'')+r.tps+' tok/s · '+(r.tpsKind==='generation'?'流式生成实测':'端到端估算'):'—'],['请求 ID',r.id],['去重键',r.dedupeKey]];
  const canStep=j=>Boolean(p.items[j] || (j<0 ? p.page>1 : p.page<p.totalPages));
  const step=(j,label)=>'<button class="pt-btn" data-pt-led-row="'+j+'" '+(!canStep(j)?'disabled':'')+'>'+label+'</button>';
  return '<article class="pt-led-req"><div class="pt-led-bar">'+ledBtn('back',1,'‹ 返回请求明细')+step(i-1,'← 上一条')+step(i+1,'下一条 →')+(r.t3ThreadId?errorButton('focus','前往 T3 Code 对话',{thread:r.t3ThreadId,title:r.t3ThreadTitle}):'')+(session?ledBtn('session',session,'筛选此会话'):'')+errorButton('copy','复制诊断摘要',{text:pairs.map(([k,v])=>k+' '+(v??'—')).concat(r.errorText || '').join('\n')})+'</div><h3>'+esc(r.modelId || r.modelRaw)+' <small class="pt-led-st '+esc(r.status)+'">● '+ledStatus(r)+(r.cacheAnomaly?.label?' · '+esc(r.cacheAnomaly.label):'')+'</small></h3><div class="pt-led-box"><dl class="pt-led-dl">'+pairs.map(([k,v])=>dt(k,v)).join('')+'</dl>'+((r.retries || r.status==='error')?'<h4>'+esc(ERROR_CODE_LABELS[r.errorCode] || r.errorCode || '错误信息')+'</h4><pre>'+esc(r.errorText || '未记录错误文本')+'</pre><p>健康替代模型 · '+esc(data?.errorInsights?.healthyAlternatives?.filter(m=>m!==r.modelId).join('、') || '暂无')+'</p>':'')+'</div></article>';
}
function renderRequestsViewHtml(data,s={}) {
  const row=s.detailId && data?.requests?.items?.find(r=>r.id===s.detailId);
  return '<div class="pt-led-root">'+(row?ledDetail(row,data.requests,data):'<div class="pt-led-tools"><div data-led-controls>'+ledControls(data,s)+'</div><input type="search" class="pt-input" data-pt-filter="session" placeholder="搜索模型、账号、会话或请求 ID..." value="'+esc(s.session)+'"><button class="pt-btn" data-pt-led-export="1" '+(!data?.requests?.total?'disabled':'')+'>导出 CSV</button></div><div data-pt-requests-card>'+renderRequestsTableCardHtml(data,s)+'</div>')+'</div>';
}
function fitRequestsTable(root) {
  const wrap=root.querySelector('.pt-led-wrap');if(!wrap)return;
  const overflow=()=>wrap.scrollWidth>wrap.clientWidth+1;
  wrap.classList.remove('tight','tight2');
  wrap.classList.toggle('tight',overflow());wrap.classList.toggle('tight2',overflow());
  const bar=root.querySelector('.pt-led-hscroll');bar.hidden=!overflow();bar.firstChild.style.width=wrap.scrollWidth+'px';
  root.querySelector('.pt-led-tight').hidden=!wrap.classList.contains('tight');
  wrap.onscroll=()=>{if(bar.scrollLeft!==wrap.scrollLeft)bar.scrollLeft=wrap.scrollLeft;};
  bar.onscroll=()=>{if(wrap.scrollLeft!==bar.scrollLeft)wrap.scrollLeft=bar.scrollLeft;};
}
function bindOverview(host,data,s,{render,openView,applyAccount}) {
  const root=host.querySelector('[data-pt-overview-root]');if(!root)return;
  const l=data?.overviewLedger || data?.requestsLedger;
  const drillToRequests = patch => {
    Object.assign(s, {
      driver: 'all',
      model: 'all',
      sourceGroup: 'all',
      errorCode: 'all',
      status: 'all',
      onlyAnomalies: false,
      day: '',
      session: '',
      detailId: '',
      requestId: '',
      page: 1
    }, patch);
    openView('requests', { fetch: true });
  };
  const click = e => {
    const el = e.target.closest?.('[data-pt-heatmap],[data-pt-tab],[data-pt-ov-jump],[data-pt-ov-account],[data-pt-led-metric],[data-pt-led-style],[data-pt-led-split],[data-pt-led-day],[data-pt-led-rank]');
    if (!el || el.disabled) return;
    const hmMetric = el.getAttribute?.('data-pt-heatmap');
    if (hmMetric) {
      e.stopPropagation?.();
      const normalized = normalizeHeatmapMetric(hmMetric);
      if (normalized !== normalizeHeatmapMetric(s.heatmapMetric)) {
        s.heatmapMetric = normalized;
        try { localStorage.setItem('t3tools.heatmapMetric', normalized); } catch {}
        const card = root.querySelector('[data-pt-heatmap-card]');
        const prevWrap = card?.querySelector?.('.pt-heatmap-wrap');
        const prevScrollLeft = prevWrap ? prevWrap.scrollLeft : 0;
        if (card) {
          card.outerHTML = renderHeatmapCardHtml(data, s);
          const nextWrap = root.querySelector('[data-pt-heatmap-card] .pt-heatmap-wrap');
          if (nextWrap) nextWrap.scrollLeft = prevScrollLeft;
        } else {
          render();
        }
      }
      return;
    }
    const targetTab = el.getAttribute?.('data-pt-tab');
    if (targetTab) {
      e.stopPropagation?.();
      openView(targetTab);
      return;
    }
    const d = el.dataset;
    if (d.ptOvJump) {
      if (d.ptOvJump === 'models') { openView('models'); return; }
      const v = d.ptOvJump;
      drillToRequests({ status: v === 'anomaly' ? 'all' : v, onlyAnomalies: v === 'anomaly' });
      return;
    }
    if (d.ptOvAccount) {
      const next = s.account === d.ptOvAccount ? 'all' : d.ptOvAccount;
      applyAccount(next);
      return;
    }
    for (const k of ['metric','style','split']) {
      if (el.hasAttribute('data-pt-led-' + k)) {
        ledPreferences[k] = el.getAttribute('data-pt-led-' + k);
        try { localStorage.setItem('t3tools.requests.' + k, ledPreferences[k]); } catch {}
        render();
        return;
      }
    }
    if (d.ptLedDay) {
      drillToRequests({ day: d.ptLedDay });
      return;
    }
    if (d.ptLedRank) {
      const dim = ledPref('split', ledDims);
      if (dim === 'modelAt') {
        const [model, account] = JSON.parse(d.ptLedRank);
        drillToRequests({ model, account });
      } else {
        drillToRequests({ [dim]: d.ptLedRank });
      }
    }
  };
  root.onclick = click;
  root.onkeydown = e => {
    if (['Enter',' '].includes(e.key) && e.target.matches('[data-pt-led-day],[data-pt-ov-jump]')) {
      e.preventDefault();
      click(e);
    }
  };
  const syncChartWidth = () => {
    const ch = root.querySelector('.pt-led-chart');
    const svgEl = ch?.querySelector('svg');
    const w = ch ? Math.round(ch.clientWidth) : 0;
    if (w >= 240 && svgEl && Math.abs(w - (Number(svgEl.dataset.w) || 600)) > 24) {
      s._chartW = w;
      render();
      return true;
    }
    return false;
  };
  if (syncChartWidth()) return;
  if (host._ovResize) host._ovResize.disconnect();
  if (typeof ResizeObserver !== 'undefined') {
    let width = -1;
    host._ovResize = new ResizeObserver(entries => {
      const w = entries[0].contentRect.width;
      if (w !== width) { width = w; syncChartWidth(); }
    });
    host._ovResize.observe(root);
  }
  const chart = root.querySelector('.pt-led-chart'), rank = root.querySelector('.pt-led-rank');
  if (!chart || !rank || !l) return;
  const edges = () => { rank.classList.toggle('more-above', rank.scrollTop > 1); rank.classList.toggle('more-below', rank.scrollHeight - rank.scrollTop > rank.clientHeight + 1); };
  edges();
  rank.onscroll = edges;
  rank.onpointerover = e => { const btn = e.target.closest('[data-index]'); if (btn) chart.querySelectorAll('[data-series]').forEach(el => el.style.opacity = el.dataset.series === btn.dataset.index ? '1' : '.22'); };
  rank.onpointerleave = () => chart.querySelectorAll('[data-series]').forEach(el => el.style.opacity = '');
  const tip = chart.querySelector('.pt-led-tip');
  chart.onpointermove = e => {
    const el = e.target.closest('[data-point]'); if (!el) { tip.hidden = true; return; }
    chart.querySelector('.hot')?.classList.remove('hot'); el.classList.add('hot');
    const p = l.series[+el.dataset.point], m = ledPref('metric', ledMetrics), dim = ledPref('split', ledDims);
    tip.innerHTML = '<b>' + esc(l.bucket === 'hour' ? new Date(p.timeMs).toLocaleString() : p.dayKey + (l.bucket === 'week' ? ' 当周' : '')) + '</b>' + p.by[dim].slice().sort((a,b)=>(ledValue(m,b)||0)-(ledValue(m,a)||0)).map(r=>'<div>'+esc([r.name,r.sub].filter(Boolean).join(' · '))+'　'+ledMetricText(m,r)+(m==='speed'?' · 首字 '+fmtDuration(r.avgTtftMs):'')+'</div>').join('') + '<b>合计 ' + ledMetricText(m,p) + ' · ' + p.calls + ' 次请求</b>';
    tip.hidden = false;
    const rect = chart.getBoundingClientRect();
    tip.style.left = Math.max(0, Math.min(e.clientX - rect.left + 8, rect.width - tip.offsetWidth)) + 'px';
    tip.style.top = Math.max(0, Math.min(e.clientY - rect.top + 8, rect.height - tip.offsetHeight)) + 'px';
  };
  chart.onpointerleave = () => { tip.hidden = true; chart.querySelector('.hot')?.classList.remove('hot'); };
}
function bindLedger(host,data,s,refresh,render,download,toast) {
  const root=host.querySelector('.pt-led-root');if(!root)return;
  const scroll=root.closest('.pt-dash-body,.app-viewport') || root;
  const back=()=>{const id=s.ledgerFocus || s.detailId;delete s.ledgerFocus;delete s.detailId;render();const next=host.querySelector('.pt-led-root');const row=Array.from(next.querySelectorAll('[data-pt-led-row]')).find(el=>data.requests.items[+el.dataset.ptLedRow]?.id===id);row?.focus({preventScroll:true});(next.closest('.pt-dash-body,.app-viewport') || next).scrollTop=s.ledgerScroll || 0;};
  const filter=values=>{Object.assign(s,values,{page:1,detailId:'',requestId:''});refresh();};
  const click=async e=>{
    const el=e.target.closest('[data-pt-led-row],button');if(!el || el.disabled)return;
    const d=el.dataset;
    if(d.ptLedRow!=null){
      const index=Number(d.ptLedRow);
      if(s.detailId && !data.requests.items[index]){
        s.page=data.requests.page+(index<0?-1:1);
        s.stepTo=index<0?'last':'first';
        refresh();
        return;
      }
      if(!s.detailId && String(root.getRootNode().getSelection?.() || window.getSelection() || ''))return;
      if(!s.detailId){s.ledgerScroll=scroll.scrollTop;s.ledgerFocus=data.requests.items[+d.ptLedRow]?.id;}
      s.detailId=data.requests.items[+d.ptLedRow]?.id;render();const next=host.querySelector('.pt-led-req');next?.querySelector('button')?.focus({preventScroll:true});next?.scrollIntoView({block:'start'});return;
    }
    if(d.ptLedBack)return back();
    if(d.ptLedExport){try{await download();}catch(err){toast(err.message);}return;}
    if(d.ptLedClear)return filter({[d.ptLedClear]:['day','requestId'].includes(d.ptLedClear)?'':'all'});
    if(d.ptLedStatus || d.ptLedJump){let v=d.ptLedStatus || d.ptLedJump;if(d.ptLedJump && (v==='anomaly'?s.onlyAnomalies:s.status===v))v='all';return filter({status:v==='anomaly'?'all':v,onlyAnomalies:v==='anomaly'});}
    if(d.ptLedSource)return filter({sourceGroup:s.sourceGroup===d.ptLedSource?'all':d.ptLedSource});
    if(d.ptLedModel)return filter({model:s.model===d.ptLedModel?'all':d.ptLedModel});
    if(d.ptLedSession)return filter({session:d.ptLedSession});
  };
  root.onclick=click;
  root.onkeydown=e=>{
    if(e.key==='Escape' && (s.detailId || e.target.type==='search' && e.target.value)){
      e.preventDefault();e.stopPropagation();if(s.detailId)back();else{e.target.value='';e.target.dispatchEvent(new Event('input',{bubbles:true}));}
    }else if(['Enter',' '].includes(e.key) && e.target.matches('tr[data-pt-led-row]')){e.preventDefault();click(e);}
  };
  fitRequestsTable(root);
  if(host._ledResize)host._ledResize.disconnect();
  if(typeof ResizeObserver!=='undefined'){let width=-1;host._ledResize=new ResizeObserver(entries=>{const w=entries[0].contentRect.width;if(w!==width){width=w;fitRequestsTable(root);}});host._ledResize.observe(root);}
}
function resolveLedgerStep(data,s) {
  if (!s.stepTo) return;
  const row=data.requests.items.at(s.stepTo==='last'?-1:0);
  s.detailId=row?.id || '';
  s.ledgerFocus=s.detailId;
  s.ledgerScroll=0;
  delete s.stepTo;
}
function refreshLedgerResults(host,data,s) {
  const root=host.querySelector('.pt-led-root'),card=root?.querySelector('[data-pt-requests-card]');
  if(!card || !data?.requests || s.detailId)return false;
  card.innerHTML=renderRequestsTableCardHtml(data,s);
  root.querySelector('[data-led-controls]').innerHTML=ledControls(data,s);
  root.querySelector('[data-pt-led-export]').disabled=!data.requests.total;
  return true;
}
function ledgerDownload(blob,name) {
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);
}
const PT_VIEW_TITLES = {
  overview: '用量概览',
  quotas: '账号额度',
  models: '模型分析',
  requests: '请求明细',
  settings: '设置'
};
const PT_VIEWS_WITH_FILTERS = new Set(['overview', 'models', 'requests']);

function renderEmbeddedSettingsHtml(statusData = null, fallbackSettings = null) {
  const cfg = fallbackSettings || statusData?.settings || {};
  const alertCfg = cfg.alertConfig || {};
  const cdp = statusData?.cdp || {};
  const daemonInfo = statusData
    ? `${statusData.httpUrl || 'http://127.0.0.1:17373'} · PID ${statusData.pid || '-'}${cdp.connected ? ` · CDP :${cdp.devToolsPort}` : ''}`
    : '已通过本地 CDP 桥接连接 T3Tools 服务';
  const alertMode = alertCfg.mode || 'smart';
  const burstThreshold = Number.isFinite(Number(alertCfg.burstThreshold)) ? Number(alertCfg.burstThreshold) : 2;
  const burstWindowSec = Math.round((Number(alertCfg.burstWindowMs) || 300000) / 1000);
  const cooldownSec = Math.round((Number(alertCfg.cooldownMs) || 120000) / 1000);

  return `
    <div class="settings-wrap">
      <div class="settings-group-title">T3 Code 挂件与外观</div>
      <div class="pt-card">
        <div class="setting-row">
          <div>
            <div class="setting-label">界面主题</div>
            <div class="setting-desc">依附面板自动同步当前 T3 Code 深色 / 浅色主题</div>
          </div>
          <span class="pt-badge pt-badge-muted">跟随 T3 Code</span>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">显示输入框状态栏</div>
            <div class="setting-desc">在对话底部显示实时速度、首字延迟、缓存命中与上下文占用</div>
          </div>
          <label class="pt-switch">
            <input type="checkbox" data-pt-setting="showComposerBar" ${cfg.showComposerBar !== false ? 'checked' : ''} />
            <span class="pt-switch-track"></span>
          </label>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">显示运行进度与额度面板</div>
            <div class="setting-desc">展示当前会话步骤进度与账号额度池</div>
          </div>
          <label class="pt-switch">
            <input type="checkbox" data-pt-setting="showOverviewCard" ${cfg.showOverviewCard !== false ? 'checked' : ''} />
            <span class="pt-switch-track"></span>
          </label>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">右侧面板防遮挡策略</div>
            <div class="setting-desc">T3 Code 打开右侧面板时自动合体停靠，或贴齐对话区边界避让</div>
          </div>
          <select class="pt-select" aria-label="右侧面板防遮挡策略" data-pt-setting="overviewMode" style="max-width:290px;">
            <option value="adaptive"${(cfg.overviewMode || 'adaptive') === 'adaptive' ? ' selected' : ''}>自适应合并 + 自动避让（推荐）</option>
            <option value="avoid"${cfg.overviewMode === 'avoid' ? ' selected' : ''}>仅自动避让浮窗</option>
            <option value="fixed"${cfg.overviewMode === 'fixed' ? ' selected' : ''}>固定视口右上角</option>
          </select>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">左下角用量统计时间</div>
            <div class="setting-desc">选择侧边栏左下角展示的 tokens 与费用统计周期</div>
          </div>
          <select class="pt-select" aria-label="左下角用量统计时间" data-pt-setting="sidebarUsageRange" style="max-width:290px;">
            <option value="today"${(cfg.sidebarUsageRange || 'today') === 'today' ? ' selected' : ''}>今日</option>
            <option value="24h"${cfg.sidebarUsageRange === '24h' ? ' selected' : ''}>近 24 小时</option>
            <option value="weeklyQuota"${cfg.sidebarUsageRange === 'weeklyQuota' ? ' selected' : ''}>本周限额周期</option>
            <option value="week"${cfg.sidebarUsageRange === 'week' ? ' selected' : ''}>本周（自然周）</option>
            <option value="7d"${cfg.sidebarUsageRange === '7d' ? ' selected' : ''}>近 7 天</option>
            <option value="30d"${cfg.sidebarUsageRange === '30d' ? ' selected' : ''}>近 30 天</option>
            <option value="all"${cfg.sidebarUsageRange === 'all' ? ' selected' : ''}>全部历史</option>
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
            <input type="checkbox" data-alert-setting="enabled" ${alertCfg.enabled !== false ? 'checked' : ''} />
            <span class="pt-switch-track"></span>
          </label>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">告警策略</div>
            <div class="setting-desc">控制通知频率，避免偶发抖动刷屏</div>
          </div>
          <select class="pt-select" aria-label="告警模式" data-alert-setting="mode" style="max-width:320px;">
            <option value="smart"${alertMode === 'smart' ? ' selected' : ''}>智能聚合（限流/权限/会话失败立即提醒）</option>
            <option value="every"${alertMode === 'every' ? ' selected' : ''}>每次失败立即提醒</option>
            <option value="quiet"${alertMode === 'quiet' ? ' selected' : ''}>安静模式（仅独立端计数，不弹通知）</option>
          </select>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">聚合与冷却</div>
            <div class="setting-desc">同模型在窗口内达阈值即提醒，冷却期内合并</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <label class="pt-muted" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;">次数 <input class="pt-input pt-mono" type="number" min="1" max="20" value="${esc(burstThreshold)}" data-alert-setting="burstThreshold" style="width:58px;" /></label>
            <label class="pt-muted" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;">窗口(秒) <input class="pt-input pt-mono" type="number" min="60" max="1800" step="10" value="${esc(burstWindowSec)}" data-alert-setting="burstWindowMs" style="width:68px;" /></label>
            <label class="pt-muted" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;">冷却(秒) <input class="pt-input pt-mono" type="number" min="15" max="1800" step="10" value="${esc(cooldownSec)}" data-alert-setting="cooldownMs" style="width:68px;" /></label>
          </div>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">系统托盘弹窗通知</div>
            <div class="setting-desc">最小化到托盘时弹出通知，点击打开「模型分析」</div>
          </div>
          <label class="pt-switch">
            <input type="checkbox" data-alert-setting="desktopNotification" ${alertCfg.desktopNotification !== false ? 'checked' : ''} />
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

      <div class="settings-group-title">运行环境版本与更新</div>
      <div class="pt-card">
        ${(() => {
          const ru = statusData?.runtimeUpdates;
          const items = Array.isArray(ru?.items) ? ru.items : [];
          if (!items.length) {
            return `
              <div class="setting-row">
                <div>
                  <div class="setting-label">暂未检测到已启用的运行环境</div>
                  <div class="setting-desc">Codex 直接读取 T3 Code 缓存，Antigravity 自动比对官方版本清单</div>
                </div>
                <button type="button" class="pt-btn" data-pt-action="check-runtime-updates">检查更新</button>
              </div>
            `;
          }
          const rows = items.map(it => {
            const sourceText = it.source === 't3-cache'
              ? '来源：T3 Code 缓存'
              : it.source === 'antigravity-manifest'
                ? '来源：官方清单'
                : '来源：本地已安装版本';
            const badgeHtml = it.hasUpdate && it.latestVersion
              ? `<span class="pt-badge pt-badge-warn pt-mono">可更新至 ${esc(it.latestVersion)}</span>`
              : it.status === 'current'
                ? '<span class="pt-badge pt-badge-ok">最新</span>'
                : '<span class="pt-badge pt-badge-muted">未检查</span>';
            return `
              <div class="setting-row">
                <div>
                  <div class="setting-label">${esc(it.displayName)} <span class="pt-mono pt-muted" style="font-size:11px;font-weight:400;">${esc(it.currentVersion || '未知版本')}</span></div>
                  <div class="setting-desc">${esc(sourceText)}</div>
                </div>
                ${badgeHtml}
              </div>
            `;
          }).join('');
          return `
            ${rows}
            <div class="setting-row">
              <div>
                <div class="setting-label">更新操作</div>
                <div class="setting-desc">前往 T3 Code「运行环境」执行安全升级，避免与运行中会话冲突</div>
              </div>
              <div style="display:flex;align-items:center;gap:6px;">
                <button type="button" class="pt-btn" data-pt-action="check-runtime-updates">检查更新</button>
                <button type="button" class="pt-btn" data-pt-action="open-provider-settings">前往运行环境</button>
              </div>
            </div>
          `;
        })()}
      </div>

      <div class="settings-group-title">服务信息</div>
      <div class="pt-card">
        <div class="setting-row">
          <div>
            <div class="setting-label">本地服务</div>
            <div class="setting-desc pt-mono">${esc(daemonInfo)}</div>
          </div>
          <span class="pt-badge pt-badge-ok">已吸附</span>
        </div>
      </div>
    </div>
  `;
}

function renderDashboardHtml(data, uiState, {
  standalone = false,
  version = '0.1.0',
  sideCollapsed = false,
  statusData = null,
  fallbackSettings = null,
  loading = false,
  error = '',
  toastText = ''
} = {}) {
  const rawTab = uiState?.tab || 'overview';
  const tab = PT_VIEW_TITLES[rawTab] ? rawTab : 'overview';
  const anomalySummary = data?.anomalySummary || { total: 0, excludedCompactions: 0 };
  const quotaSummary = getQuotaGroupsSummary(data?.quotas);
  const quotaBadgeTone = quotaSummary.criticalAccounts > 0
    ? 'danger'
    : quotaSummary.warningAccounts > 0
      ? 'warning'
      : quotaSummary.readyAccounts > 0
        ? 'success'
        : 'muted';

  const errSummary = data?.errorInsights?.summary || {};
  const statusAlerts = statusData?.alerts || null;
  const unreadFailed = statusAlerts ? (statusAlerts.unreadCount || 0) : (errSummary.unreadCount || 0);
  const unreadRecovered = statusAlerts ? (statusAlerts.unreadRecoveredCount || 0) : (errSummary.unreadRecoveredCount || 0);
  const unreadIncidents = statusAlerts
    ? (statusAlerts.unreadIncidents ?? (unreadFailed + unreadRecovered))
    : (errSummary.unreadIncidents ?? errSummary.totalIncidents ?? 0);
  const errBadgeTone = unreadFailed > 0 ? 'danger' : unreadRecovered > 0 ? 'warning' : 'muted';
  const anomTotal = anomalySummary.total || 0;
  const cdpPort = statusData?.cdp?.devToolsPort;
  const attachLabel = cdpPort ? `已吸附 T3 Code (:${cdpPort})` : '已吸附 T3 Code';

  const showViewHead = Boolean(data) && PT_VIEWS_WITH_FILTERS.has(tab);
  const viewHeadHtml = showViewHead
    ? `<div class="view-data-head active">${renderViewToolbarHtml(data, uiState, { showFilters: true, showAccount: true, showRefresh: true, busy: loading })}</div>`
    : '';

  let activeBodyHtml = '';
  if (tab === 'settings') {
    activeBodyHtml = renderEmbeddedSettingsHtml(statusData, fallbackSettings);
  } else if (!data && loading) {
    activeBodyHtml = '<div class="pt-card" style="text-align:center;padding:36px;">正在加载数据...</div>';
  } else if (!data && error) {
    activeBodyHtml = `<div class="pt-card"><div class="pt-text-danger" style="font-weight:600;margin-bottom:6px;">暂未连接到本地服务</div><div class="pt-muted" style="margin-bottom:10px;">${esc(error)}</div><button type="button" class="pt-btn" data-pt-action="refresh">重试</button></div>`;
  } else if (tab === 'quotas') {
    activeBodyHtml = renderQuotasTabHtml(data, uiState);
  } else if (tab === 'requests') {
    activeBodyHtml = renderRequestsViewHtml(data, uiState);
  } else if (tab === 'models') {
    activeBodyHtml = renderModelsAnalysisHtml(data, uiState);
  } else {
    activeBodyHtml = renderOverviewCoreHtml(data, uiState);
  }

  return `
    <div class="pt-dashboard${standalone ? ' standalone' : ''}">
      <div class="app-shell" data-side-collapsed="${sideCollapsed ? 'true' : 'false'}">
        <aside class="app-side">
          <div class="side-head">
            <span class="side-brand">
              <span class="side-logo">T3</span>
              <span>T3Tools</span>
              <span class="side-ver">v${esc(version)}</span>
            </span>
          </div>

          <nav class="side-scroll" aria-label="主导航">
            <div class="nav-group-label">分析</div>
            <button type="button" class="nav-item${tab === 'overview' ? ' active' : ''}" data-pt-tab="overview">
              <svg class="nav-ic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="6" height="6" rx="1.4"/><rect x="11" y="3" width="6" height="6" rx="1.4"/><rect x="3" y="11" width="6" height="6" rx="1.4"/><rect x="11" y="11" width="6" height="6" rx="1.4"/></svg>
              <span>用量概览</span>
            </button>
            <button type="button" class="nav-item${tab === 'quotas' ? ' active' : ''}" data-pt-tab="quotas">
              <svg class="nav-ic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="6.5"/><path d="M10 10V5.5M10 10l3.2 2"/></svg>
              <span>账号额度</span>
              <span class="nav-badge" data-tone="${quotaBadgeTone}">${quotaSummary.totalAccounts}</span>
            </button>
            <button type="button" class="nav-item${tab === 'models' ? ' active' : ''}" data-pt-tab="models">
              <svg class="nav-ic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16V9M8 16V5M12 16v-5M16 16V7"/></svg>
              <span>模型分析</span>
              ${unreadIncidents > 0 ? `<span class="nav-badge" data-tone="${errBadgeTone}">${unreadIncidents}</span>` : ''}
            </button>
            <button type="button" class="nav-item${tab === 'requests' ? ' active' : ''}" data-pt-tab="requests">
              <svg class="nav-ic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5h12M4 10h12M4 14.5h8"/></svg>
              <span>请求明细</span>
              <span class="nav-badge" data-tone="${anomTotal > 0 ? 'danger' : 'muted'}" data-pt-tab-anom-count>${anomTotal}</span>
            </button>
          </nav>

          <div class="side-foot">
            <button type="button" class="nav-item${tab === 'settings' ? ' active' : ''}" data-pt-tab="settings">
              <svg class="nav-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              <span>设置</span>
            </button>
            <button type="button" class="side-attach" data-state="attached" data-pt-tab="settings" title="T3 Code 连接状态">
              <span class="side-attach-dot"></span>
              <span class="side-attach-text">${esc(attachLabel)}</span>
            </button>
          </div>
        </aside>

        <div class="app-main">
          <header class="app-top">
            <div class="top-left">
              <button type="button" class="icon-btn" data-pt-action="toggle-sidebar" title="折叠 / 展开侧边栏">
                <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2"/><path d="M6 2.75v10.5"/></svg>
              </button>
              <span class="top-title">${esc(PT_VIEW_TITLES[tab] || '用量概览')}</span>
              <div class="top-seg">
                <button type="button" data-pt-tab="overview" class="${tab === 'overview' ? 'active' : ''}">概览</button>
                <button type="button" data-pt-tab="quotas" class="${tab === 'quotas' ? 'active' : ''}">额度</button>
                <button type="button" data-pt-tab="models" class="${tab === 'models' ? 'active' : ''}">模型</button>
                <button type="button" data-pt-tab="requests" class="${tab === 'requests' ? 'active' : ''}">明细</button>
                <button type="button" data-pt-tab="settings" class="${tab === 'settings' ? 'active' : ''}">设置</button>
              </div>
            </div>
            <div class="top-right">
              <span class="top-toast" data-pt-overlay-toast="1">${esc(toastText)}</span>
              ${standalone
                ? '<button type="button" class="pt-btn" data-pt-action="toggle-theme">切换主题</button>'
                : '<button type="button" class="pt-btn" data-pt-action="close-dashboard">关闭</button>'}
            </div>
          </header>

          <div class="app-viewport">
            ${viewHeadHtml}
            <section class="app-view active">${activeBodyHtml}</section>
          </div>
        </div>
      </div>
    </div>
  `;
}
function errorButton(action, text, attrs = {}, extraClass = '', disabled = false) {
  const cls = extraClass ? 'pt-btn ' + extraClass : 'pt-btn';
  const attrStr = Object.entries(attrs).map(([k,v]) => 'data-' + k + '="' + esc(v || '') + '"').join(' ');
  return '<button type="button" class="' + cls + '" data-error-action="' + action + '"' +
    (attrStr ? ' ' + attrStr : '') + (disabled ? ' disabled' : '') + '>' + esc(text) + '</button>';
}
function errorDiagnostic(r, data, { compact = false } = {}) {
  const isFailed = r.status === 'error';
  const isResolved = Boolean(r.resolved);
  const label = ERROR_CODE_LABELS[r.errorCode] || r.errorCode || '其他错误';
  const statusTag = isFailed ? `失败 · ${label}` : `重试恢复×${r.retries || 1} · ${label}`;
  const session = r.t3ThreadId || r.nativeSessionId || '';
  const title = r.t3ThreadTitle || session;
  const metadata = [fmtTime(r.timestampMs), r.accountId, r.modelRaw || r.modelId, r.t3ThreadId, r.nativeSessionId,
    isFailed ? '结果: 失败' : '结果: 重试后恢复', isResolved ? '处理状态: 已解决' : '', '重试 ' + (r.retries || 0), '耗时 ' + fmtDuration(r.durationMs), '首字 ' + fmtDuration(r.ttftMs)].filter(Boolean).join(' · ');
  const alternatives = (data?.errorInsights?.healthyAlternatives || []).filter(m => m !== r.modelId);
  const advice = r.errorCode === 'rate-limit'
    ? `<span>触发限流，建议切换至有余量的账号：</span> ${errorButton('quotas','查看账号额度 →')}`
    : r.errorCode === 'region'
      ? '<span>账号权限或地区受限，请检查登录状态与代理出口地区。</span>'
      : alternatives.length
        ? `<span>建议检查网络/重试，或临时切换至健康模型：<strong class="pt-mono">${esc(alternatives.slice(0, 3).join('、'))}</strong></span>`
        : '<span>建议检查网络连接、代理节点与上游服务状态后重试。</span>';
  const preview = (r.errorText || '').slice(0, compact ? 64 : 110);
  const detailCls = isResolved ? 'is-resolved' : isFailed ? 'is-error' : 'is-recovered';
  const statusBadgeCls = isResolved ? 'pt-badge-muted' : isFailed ? 'pt-badge-err' : 'pt-badge-warn';
  const summaryHtml = compact
    ? `<summary title="展开查看完整报错与诊断">${esc(preview || '查看报错详情')}</summary>`
    : `<summary title="点击展开完整报错与诊断"><span class="pt-mono pt-muted">${esc(fmtTime(r.timestampMs))}</span> · <strong class="pt-mono">${esc(r.modelId)}</strong> · <span>${esc(title)}</span> ${isResolved ? '<span class="pt-badge pt-badge-ok">已解决</span> ' : ''}<span class="pt-badge ${statusBadgeCls}">${esc(statusTag)}</span> <span class="pt-muted">${esc(preview)}</span></summary>`;
  return `<details class="pt-error-detail ${detailCls}">${summaryHtml}
    <pre>${esc(r.errorText || '未记录错误文本')}</pre>
    <div class="pt-error-detail-meta pt-mono">${esc(metadata)}</div>
    <div class="pt-error-detail-meta">${advice}</div>
    <div class="pt-error-detail-actions">
      ${errorButton('copy','复制诊断摘要', { text: [metadata, title, statusTag, r.errorText].filter(Boolean).join('\n') })}
      ${errorButton('focus','前往 T3 Code 对话',{ thread: r.t3ThreadId, title })}
      ${compact ? '' : errorButton('record','在请求明细中查看',{ session, model: r.modelId, code: r.errorCode, id: r.id })}
      ${compact || !r.id || isResolved ? '' : errorButton('resolve-item','标记已解决',{ id: r.id })}
    </div>
  </details>`;
}
function renderErrorTracker(data, state = {}) {
  const info = data?.errorInsights;
  if (!info) return '';
  const { summary, dailyTrend = [], hourlyTrend = [], affectedSessions = [], recentErrors = [] } = info;
  const onlyToday = state.errorOnlyToday !== false && !state.day;
  const useHourly = Boolean(summary.scopeDay);
  const bars = useHourly ? hourlyTrend : dailyTrend;
  const peak = Math.max(1, ...bars.map(b => b.total));
  const chips = ['errorModel','errorCode','day','errorSession'].filter(k => state[k] && state[k] !== 'all')
    .map(k => errorButton('clear',(ERROR_CODE_LABELS[state[k]] || state[k]) + ' ×',{key:k})).join(' ');
  const scopeTitle = state.day
    ? `${state.day.slice(5)} 异常`
    : onlyToday
      ? `今日异常 (${(summary.todayDay || '').slice(5)})`
      : '周期异常';
  const totalIncidents = summary.totalIncidents ?? (summary.totalErrors + (summary.totalRetriedRecovered || 0));
  const recoveredTotal = summary.totalRetriedRecovered || 0;
  const unreadTotal = summary.unreadIncidents ?? summary.unreadCount ?? 0;
  const hasUnresolvedFailed = (summary.unreadCount || 0) > 0;
  const hasUnresolvedRecovered = (summary.unreadRecoveredCount || 0) > 0;
  const hasUnresolvedRuns = Boolean(info.failedRuns?.some(a => !a.resolved));
  const canResolveAll = unreadTotal > 0 || hasUnresolvedRuns;
  const unreadTone = hasUnresolvedFailed ? 'pt-badge-err' : unreadTotal > 0 ? 'pt-badge-warn' : 'pt-badge-ok';
  const unreadBadge = unreadTotal > 0
    ? `<span class="pt-badge ${unreadTone} pt-mono" title="待处理失败 ${summary.unreadCount || 0} · 待处理重试恢复 ${summary.unreadRecoveredCount || 0}">${unreadTotal} 待处理</span>`
    : `<span class="pt-badge pt-badge-ok">${totalIncidents > 0 ? '已全部解决' : '无异常'}</span>`;
  const countSplitBadges = `
    <span class="pt-badge pt-badge-muted pt-mono" title="失败与重试恢复合计（历史记录保留可查）">共 ${totalIncidents}</span>
    <span class="pt-badge ${hasUnresolvedFailed ? 'pt-badge-err' : 'pt-badge-muted'} pt-mono">失败 ${summary.totalErrors}</span>
    <span class="pt-badge ${hasUnresolvedRecovered ? 'pt-badge-warn' : 'pt-badge-muted'} pt-mono">重试恢复 ${recoveredTotal}</span>
  `;
  const emptyHint = onlyToday
    ? '今日暂无异常'
    : '当前范围暂无异常';

  return `<section class="pt-card pt-tracker" data-error-center>
    <div class="pt-tracker-head">
      <div class="pt-tracker-title">
        <strong>${esc(scopeTitle)}</strong>
        ${countSplitBadges}
        ${unreadBadge}
        ${summary.activeBrokenThreads > 0 ? `<span class="pt-badge pt-badge-err pt-mono">${summary.activeBrokenThreads} 对话持续异常</span>` : ''}
      </div>
      <div class="pt-tracker-tools">
        ${chips}
        <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;font-size:11.5px;">
          <input type="checkbox" data-pt-filter="errorOnlyToday" ${state.errorOnlyToday !== false ? 'checked' : ''} />
          <span>仅今日</span>
        </label>
        <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;font-size:11.5px;">
          <input type="checkbox" data-pt-filter="includeRetried" ${state.includeRetried !== false ? 'checked' : ''} />
          <span>含重试恢复</span>
        </label>
        ${errorButton('ack', canResolveAll ? '全部标记已解决' : '已全部解决', {}, canResolveAll ? 'pt-btn-accent' : '', !canResolveAll)}
        ${errorButton('requests','请求明细 →')}
      </div>
    </div>

    <div>
      <div class="pt-tracker-subhead">
        <span>${useHourly ? '分时分布' : '每日趋势'}</span>
        <span class="pt-error-legend">
          <span><i style="background:var(--pt-danger, #ef4444);"></i>失败 (${summary.totalErrors})</span>
          <span><i style="background:var(--pt-warning, #f59e0b);"></i>重试恢复 (${recoveredTotal})</span>
        </span>
      </div>
      <div class="pt-error-trend">${bars.map(b => {
        const labelText = useHourly ? b.label : b.date.slice(5);
        const tip = `${useHourly ? `${summary.scopeDay} ${b.label}` : b.date} · 共 ${b.total}（失败 ${b.failed || 0} · 重试恢复 ${b.recovered || 0}）` +
          (Object.keys(b.byCode || {}).length ? ' · ' + Object.entries(b.byCode).map(([k,v]) => (ERROR_CODE_LABELS[k] || k) + ' ×' + v).join(' / ') : '');
        const isSelected = !useHourly && state.day === b.date;
        const barSegments = [
          b.failed > 0 ? `<i style="flex:${b.failed};background:var(--pt-danger, #ef4444);"></i>` : '',
          b.recovered > 0 ? `<i style="flex:${b.recovered};background:var(--pt-warning, #f59e0b);"></i>` : ''
        ].filter(Boolean).join('');
        if (useHourly) {
          return `<button type="button" style="cursor:default;" title="${esc(tip)}"><span style="height:${Math.max(4, Math.round(48*b.total/peak))}px">${barSegments}</span><em class="pt-mono" style="font-style:normal;">${esc(labelText)}</em></button>`;
        }
        return `<button type="button" class="${isSelected ? 'active' : ''}" data-error-action="day" data-day="${esc(b.date)}" title="${esc(tip)}"><span style="height:${Math.max(4, Math.round(48*b.total/peak))}px">${barSegments}</span><em class="pt-mono" style="font-style:normal;">${esc(labelText)}</em></button>`;
      }).join('') || `<span class="pt-muted" style="padding:12px 4px;">${esc(emptyHint)}</span>`}</div>
    </div>

    <div>
      <div class="pt-tracker-subhead">
        <span>受影响对话 (${affectedSessions.length})</span>
        <span class="pt-muted">红：失败 · 黄：重试恢复</span>
      </div>
      ${affectedSessions.length ? `<div class="pt-session-list">${affectedSessions.map(s => {
        const isOnlyRetry = Boolean(s.onlyRecoveredRetry || (s.errorCount === 0 && (s.recoveredCount || 0) > 0));
        const isResolved = Boolean(s.resolved);
        const cardCls = isResolved ? '' : s.state === 'failing' ? 'failing' : isOnlyRetry ? 'retried' : '';
        const stateCls = isResolved ? 'pt-badge-ok' : s.state === 'failing' ? 'pt-badge-err' : isOnlyRetry ? 'pt-badge-warn' : 'pt-badge-ok';
        const stateText = isResolved ? '已解决' : s.state === 'failing' ? '持续异常中' : isOnlyRetry ? '重试恢复' : '已恢复';
        const sRecovered = s.recoveredCount || 0;
        const sTotal = s.incidentCount || (s.errorCount + sRecovered);
        const codeStats = s.errorCodeStats || {};
        const codeBadges = Object.entries(s.errorCodes || {}).map(([k, n]) => {
          const st = codeStats[k] || { failed: s.errorCount > 0 ? n : 0, recovered: 0, total: n };
          const cls = isResolved ? 'pt-badge-muted' : st.failed > 0 ? 'pt-badge-err' : 'pt-badge-warn';
          const text = st.failed > 0 && st.recovered > 0
            ? `${ERROR_CODE_LABELS[k] || k} ${st.failed}+${st.recovered}↻`
            : st.failed > 0
              ? `${ERROR_CODE_LABELS[k] || k} ×${st.failed}`
              : `${ERROR_CODE_LABELS[k] || k} ↻×${st.recovered}`;
          return `<span class="pt-badge ${cls}" title="失败 ${st.failed} · 重试恢复 ${st.recovered}">${esc(text)}</span>`;
        }).join('');
        return `<article class="pt-session-card ${cardCls}">
          <div class="pt-session-top">
            <span class="pt-badge ${stateCls}">${stateText}</span>
            <span class="pt-session-title" title="${esc(s.title)}">${esc(s.title)}</span>
            <span class="pt-mono pt-muted" style="font-size:10.5px;flex:none;">${esc(fmtAge(Date.now()-s.lastErrorAtMs))}</span>
          </div>
          <div class="pt-muted pt-mono" style="font-size:10.5px;">${esc(fmtTime(s.lastErrorAtMs))} · ${esc(s.models.join('、'))} · ${esc(s.accountId)} · 共 ${sTotal} 次</div>
          <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
            ${s.errorCount > 0 ? `<span class="pt-badge ${isResolved ? 'pt-badge-muted' : 'pt-badge-err'} pt-mono">失败 ${s.errorCount}</span>` : ''}
            ${sRecovered > 0 ? `<span class="pt-badge ${isResolved ? 'pt-badge-muted' : 'pt-badge-warn'} pt-mono">重试恢复 ${sRecovered}</span>` : ''}
            ${codeBadges}
          </div>
          ${s.latestErrorText ? `<div class="pt-muted" style="font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(s.latestErrorText)}">${esc(s.latestErrorText.slice(0,110))}</div>` : ''}
          <div class="pt-session-actions">
            ${errorButton('session','筛选报错',{session:s.sessionKey})}
            ${errorButton('focus','前往对话',{thread:s.t3ThreadId,title:s.title})}
            ${errorButton('all','查看全部请求',{session:s.sessionKey})}
            ${isResolved ? '' : errorButton('resolve-session','标记已解决',{session:s.sessionKey,thread:s.t3ThreadId || '',native:s.nativeSessionId || '',ts:String(s.lastErrorAtMs || 0)})}
          </div>
        </article>`;
      }).join('')}</div>` : `<div class="pt-muted" style="padding:6px 2px;">${esc(onlyToday ? '今日暂无受影响对话' : '暂无受影响对话')}</div>`}
    </div>

    ${info.failedRuns?.length ? `<div>
      <div class="pt-tracker-subhead"><span>T3 会话运行失败 (${info.failedRuns.length})</span></div>
      <div class="pt-session-list">${info.failedRuns.map(a => `<article class="pt-session-card ${a.resolved ? '' : 'failing'}">
        <div class="pt-session-top">
          <span class="pt-badge ${a.resolved ? 'pt-badge-ok' : 'pt-badge-err'}">${a.resolved ? '已解决' : '会话失败'}</span>
          <span class="pt-session-title">${esc(a.t3ThreadTitle || a.t3ThreadId)}</span>
        </div>
        <div class="pt-muted pt-mono" style="font-size:10.5px;">${esc(fmtTime(a.createdAtMs))} · ${esc(a.modelId || '未知模型')}</div>
        <div class="pt-session-actions">
          ${errorButton('focus','前往对话',{thread:a.t3ThreadId,title:a.t3ThreadTitle || a.t3ThreadId})}
          ${a.resolved ? '' : errorButton('resolve-item','标记已解决',{id:a.resolveId || a.id || ''})}
        </div>
      </article>`).join('')}</div>
    </div>` : ''}

    <div>
      <div class="pt-tracker-subhead">
        <span>异常明细 (${recentErrors.length})</span>
        <span class="pt-muted">点击展开详情</span>
      </div>
      <div class="pt-error-list">${recentErrors.map(r => errorDiagnostic(r, data)).join('') || `<div class="pt-muted" style="padding:6px 2px;">${esc(onlyToday ? '今日暂无匹配记录' : '暂无匹配记录')}</div>`}</div>
    </div>
  </section>`;
}

async function copyTextSafe(text) {
  const str = String(text ?? '');
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(str);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = str;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return Boolean(ok);
  } catch {
    return false;
  }
}

async function handleErrorClick(e, state, ui) {
  const el = e.target.closest?.('[data-error-action],[data-pt-heatmap-day]');
  if (!el) return false;
  if (el.disabled) return true;
  const d = el.dataset;
  const action = d.errorAction;
  let view = 'models';
  let scrollToErrorCenter = true;
  if (action === 'focus') {
    const result = d.thread ? await ui.rpc('focusThread',{threadId:d.thread,title:d.title}) : null;
    if (result?.focused) {
      ui.toast('已切换到对应 T3 Code 对话');
      ui.close();
    } else {
      const copied = await copyTextSafe(d.title || d.thread || '');
      ui.toast(copied ? '未吸附或未匹配到窗口，已复制对话标题' : (result?.reason || '无法定位对话'));
    }
    return true;
  }
  if (action === 'copy') {
    const copied = await copyTextSafe(d.text);
    ui.toast(copied ? '已复制诊断摘要' : '复制失败，请手动选中文本');
    return true;
  }
  if (action === 'ack') {
    await ui.rpc('ackErrors',{});
    ui.toast('已全部标记为已解决，红点已消除');
    scrollToErrorCenter = false;
  }
  if (action === 'resolve-session') {
    await ui.rpc('resolveErrors',{
      scope: 'session',
      sessionKey: d.session || '',
      t3ThreadId: d.thread || '',
      nativeSessionId: d.native || '',
      upToTsMs: Number(d.ts) || 0
    });
    ui.toast('已将该对话报错标记为已解决');
    scrollToErrorCenter = false;
  }
  if (action === 'resolve-item') {
    await ui.rpc('resolveErrors',{ scope: 'item', id: d.id || '' });
    ui.toast('已将该条报错标记为已解决');
    scrollToErrorCenter = false;
  }
  if (action === 'quotas') view = 'quotas';
  if (action !== 'clear' || d.key !== 'requestId') state.requestId = '';
  if (action === 'drill') Object.assign(state,{errorModel:d.ptDrillErrorModel,errorCode:d.ptDrillErrorCode || 'all',errorSession:'',day:''});
  if (action === 'clear') {
    state[d.key] = d.key === 'errorCode' ? 'all' : '';
    view = ui.current();
  }
  if (action === 'session') state.errorSession = d.session;
  if (action === 'day') state.day = state.day === d.day ? '' : d.day;
  if (d.ptHeatmapDay) {
    Object.assign(state,{day:d.ptHeatmapDay,preset:'all',session:'',errorSession:'',errorModel:'',errorCode:'all',model:'all',status:'all',onlyAnomalies:false});
    view = state.heatmapMetric === 'errors' ? 'models' : 'requests';
    if (view === 'models') state.includeRetried = false;
  }
  if (d.ptHeatmapDay || ['requests','all','record'].includes(action)) Object.assign(state,{driver:'all',sourceGroup:'all',detailId:'',requestId:''});
  if (['requests','all','record'].includes(action)) {
    view = 'requests';
    state.model = d.model || state.errorModel || 'all';
    state.session = d.session || state.errorSession || '';
    state.onlyAnomalies = false;
    state.status = state.includeRetried === false ? 'error' : 'error_or_retried';
    if (action === 'all') Object.assign(state,{model:'all',errorCode:'all',status:'all',day:'',preset:'all'});
    if (action === 'record') Object.assign(state,{requestId:d.id,detailId:d.id,errorCode:d.code || 'all',status:'error_or_retried'});
  }
  state.page = 1;
  await ui.open(view, { scroll: scrollToErrorCenter });
  return true;
}
