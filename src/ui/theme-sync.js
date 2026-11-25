/**
 * Synchronizes T3 Code's light/dark mode and CSS theme tokens into our Shadow DOM roots.
 * Properly retains MediaQueryList for cleanup and prioritizes explicit data-theme/class
 * before falling back to computed background luminance (fixes P3 theme toggle & cleanup).
 */
function createThemeSynchronizer(themeConfig = {}) {
  const darkClass = themeConfig.darkClass || 'dark';
  const cssVars = Array.isArray(themeConfig.cssVars) ? themeConfig.cssVars : [];
  const targets = new Set();

  const FALLBACK_DARK = {
    '--pt-bg': '#0b0c0f',
    '--pt-card': '#14161b',
    '--pt-surface': '#1b1e25',
    '--pt-fg': '#f3f4f6',
    '--pt-muted': '#9ca3af',
    '--pt-border': 'rgba(255, 255, 255, 0.10)',
    '--pt-accent': '#6366f1',
    '--pt-accent-fg': '#ffffff',
    '--pt-success': '#22c55e',
    '--pt-warning': '#f59e0b',
    '--pt-danger': '#ef4444',
    '--pt-chart-1': '#6366f1',
    '--pt-chart-2': '#22c55e',
    '--pt-chart-3': '#f59e0b',
    '--pt-chart-4': '#06b6d4',
    '--pt-chart-5': '#ec4899',
    '--pt-chart-6': '#a855f7',
    '--pt-radius': '10px',
    '--pt-shadow': '0 10px 30px rgba(0, 0, 0, 0.45)'
  };

  const FALLBACK_LIGHT = {
    '--pt-bg': '#ffffff',
    '--pt-card': '#f8fafc',
    '--pt-surface': '#f1f5f9',
    '--pt-fg': '#111827',
    '--pt-muted': '#64748b',
    '--pt-border': 'rgba(15, 23, 42, 0.12)',
    '--pt-accent': '#4f46e5',
    '--pt-accent-fg': '#ffffff',
    '--pt-success': '#16a34a',
    '--pt-warning': '#d97706',
    '--pt-danger': '#dc2626',
    '--pt-chart-1': '#4f46e5',
    '--pt-chart-2': '#16a34a',
    '--pt-chart-3': '#d97706',
    '--pt-chart-4': '#0891b2',
    '--pt-chart-5': '#db2777',
    '--pt-chart-6': '#9333ea',
    '--pt-radius': '10px',
    '--pt-shadow': '0 10px 28px rgba(15, 23, 42, 0.14)'
  };

  let mediaQuery = null;

  function detectDark() {
    const html = document.documentElement;
    const explicitAttr = html.getAttribute('data-theme');
    if (explicitAttr === 'dark') return true;
    if (explicitAttr === 'light') return false;
    if (html.classList.contains(darkClass)) return true;
    if (html.classList.contains('light')) return false;
    try {
      const bg = getComputedStyle(document.body).backgroundColor;
      const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (m) {
        const lum = 0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3]);
        return lum < 128;
      }
    } catch {}
    return mediaQuery ? mediaQuery.matches : (window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? true);
  }

  function readTokens() {
    const isDark = detectDark();
    const fallback = isDark ? FALLBACK_DARK : FALLBACK_LIGHT;
    const computed = getComputedStyle(document.documentElement);
    const pick = (name, fb) => {
      const val = computed.getPropertyValue(name)?.trim();
      return val || fb;
    };

    const tokens = {
      ...fallback,
      '--pt-bg': pick('--background', fallback['--pt-bg']),
      '--pt-card': pick('--card', pick('--popover', fallback['--pt-card'])),
      '--pt-surface': pick('--secondary', pick('--muted', fallback['--pt-surface'])),
      '--pt-fg': pick('--foreground', fallback['--pt-fg']),
      '--pt-muted': pick('--muted-foreground', fallback['--pt-muted']),
      '--pt-border': pick('--border', fallback['--pt-border']),
      '--pt-accent': pick('--primary', pick('--accent', fallback['--pt-accent'])),
      '--pt-accent-fg': pick('--primary-foreground', fallback['--pt-accent-fg']),
      '--pt-success': pick('--success', fallback['--pt-success']),
      '--pt-warning': pick('--warning', fallback['--pt-warning']),
      '--pt-danger': pick('--destructive', fallback['--pt-danger']),
      '--pt-chart-1': pick('--chart-1', fallback['--pt-chart-1']),
      '--pt-chart-2': pick('--chart-2', fallback['--pt-chart-2']),
      '--pt-chart-3': pick('--chart-3', fallback['--pt-chart-3']),
      '--pt-chart-4': pick('--chart-4', fallback['--pt-chart-4']),
      '--pt-chart-5': pick('--chart-5', fallback['--pt-chart-5']),
      '--pt-chart-6': pick('--chart-6', fallback['--pt-chart-6']),
      '--pt-radius': pick('--radius', fallback['--pt-radius']),
      '--pt-font-sans': pick('--font-sans', 'system-ui, -apple-system, "Segoe UI", sans-serif'),
      '--pt-font-mono': pick('--font-mono', 'ui-monospace, "Cascadia Code", Consolas, monospace')
    };

    for (const v of cssVars) {
      const val = computed.getPropertyValue(v)?.trim();
      if (val) tokens[v] = val;
    }

    return { isDark, tokens };
  }

  function applyTo(el, state) {
    if (!el || !el.style) return;
    el.setAttribute('data-pt-theme', state.isDark ? 'dark' : 'light');
    for (const [k, v] of Object.entries(state.tokens)) {
      el.style.setProperty(k, v);
    }
  }

  function syncAll() {
    const state = readTokens();
    for (const el of targets) applyTo(el, state);
    return state;
  }

  let observer = null;
  let rafPending = false;
  function scheduleSync() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      syncAll();
    });
  }

  function start() {
    if (observer) return;
    observer = new MutationObserver(scheduleSync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme']
    });
    if (typeof window.matchMedia === 'function') {
      mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      mediaQuery.addEventListener?.('change', scheduleSync);
    }
  }

  function register(el) {
    targets.add(el);
    applyTo(el, readTokens());
  }

  function unregister(el) {
    targets.delete(el);
  }

  function dispose() {
    observer?.disconnect();
    observer = null;
    mediaQuery?.removeEventListener?.('change', scheduleSync);
    mediaQuery = null;
    targets.clear();
  }

  return { start, register, unregister, syncAll, dispose };
}
