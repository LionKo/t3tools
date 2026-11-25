import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startDaemon } from '../src/host/daemon.mjs';
import { buildClientBundle } from '../src/ui/bundle.mjs';

test('assembled client bundle has valid JS syntax and handles desktop Requests tab click without backdrop hijack', () => {
  const code = buildClientBundle({ version: '0.1.0', transport: 'cdp' });
  assert.ok(code.length > 5000);
  assert.doesNotThrow(() => new Function(code));
  // Ensure backdrop uses data-pt-backdrop (NOT data-pt-action) so inner tab/page clicks are never hijacked (P1 #1)
  assert.ok(code.includes('data-pt-backdrop="1"'));
  assert.equal(code.includes('data-pt-action="backdrop-close"'), false);
  // Usage bar aligns inline on composer footer row (with below-card fallback) and does NOT reference Magpie
  assert.ok(code.includes('data-chat-composer-footer'));
  assert.ok(code.includes("mode: 'footer-inline'"));
  assert.ok(code.includes("insertAdjacentElement('afterend', composerMount.host)"));
  assert.equal(code.includes('127.0.0.1:3425'), false);

  // Composer usage bar renders the exact 4 CodexUsageBar-style items: speed, ttft, cache, context
  const sharedViewsSrc = readFileSync(new URL('../src/ui/shared-views.js', import.meta.url), 'utf8');
  const renderComposerBar = new Function(`${sharedViewsSrc}\nreturn renderComposerBarHtml;`)();
  const barHtml = renderComposerBar({
    thread: { unresolved: false },
    context: {
      decodeSpeed: 128.4,
      ttftMs: 1460,
      cacheHitPercent: 86.4,
      usedPercent: 31.7,
      usedTokens: 162489,
      maxTokens: 512000,
      stale: false
    }
  }, { hideWhenUnresolved: true, inline: true });
  assert.ok(barHtml.includes('pt-usage-bar pt-usage-inline'));
  assert.equal((barHtml.match(/class="pt-usage-item"/g) || []).length, 4);
  assert.equal((barHtml.match(/class="pt-usage-tip"/g) || []).length, 4);
  assert.equal(barHtml.includes(' title="'), false);
  assert.ok(barHtml.includes('data-usage="speed"'));
  assert.ok(barHtml.includes('data-usage="ttft"'));
  assert.ok(barHtml.includes('data-usage="cache"'));
  assert.ok(barHtml.includes('data-usage="context"'));
  assert.ok(barHtml.includes('128<span class="pt-usage-unit">tok/s</span>'));
  assert.ok(barHtml.includes('首字</span>'));
  assert.ok(barHtml.includes('>1.5s<'));
  assert.ok(barHtml.includes('缓存</span>'));
  assert.ok(barHtml.includes('>86.4%<'));
  assert.ok(barHtml.includes('>32%<'));
  assert.ok(barHtml.includes('data-stale="false"'));

  // Empty/no-data thread renders "--" placeholders without inventing metrics; unresolved hides on desktop
  const emptyBarHtml = renderComposerBar({ thread: { unresolved: false }, context: null }, { hideWhenUnresolved: true });
  assert.equal((emptyBarHtml.match(/class="pt-usage-item"/g) || []).length, 4);
  assert.ok(emptyBarHtml.includes('--<span class="pt-usage-unit">tok/s</span>'));
  assert.ok(emptyBarHtml.includes('首字</span>'));
  assert.ok(emptyBarHtml.includes('缓存</span>'));
  const hiddenBarHtml = renderComposerBar({ thread: { unresolved: true }, context: null }, { hideWhenUnresolved: true });
  assert.ok(hiddenBarHtml.includes('data-hidden="true"'));

  // Overview card MUST show only the active thread's account quotas, not other accounts
  const renderOverview = new Function(`${sharedViewsSrc}\nreturn renderOverviewCardHtml;`)();
  const html = renderOverview({
    thread: { unresolved: false, accountId: 'work', selectedModel: 'gemini-4-neon', phase: 'idle', phaseLabel: '空闲', steps: [] },
    context: { accountId: 'work', modelId: 'gemini-4-neon' },
    quotas: {
      groups: [
        { accountId: 'antigravity', displayName: 'Antigravity', driver: 'antigravity', windows: [{ label: 'Gemini · Weekly', poolKey: 'gemini', kind: 'weekly', remainingPercent: 49 }] },
        { accountId: 'codex', displayName: 'Codex', driver: 'codex', windows: [{ label: 'Weekly', poolKey: 'codex', kind: 'weekly', remainingPercent: 81 }] },
        { accountId: 'work', displayName: 'work (Antigravity)', driver: 'antigravity', windows: [{ label: 'Gemini · Weekly', poolKey: 'gemini', kind: 'weekly', remainingPercent: 93.3 }] }
      ]
    }
  }, false, false);
  assert.ok(html.includes('work (Antigravity)'));
  assert.ok(html.includes('93.3%'));
  assert.equal(html.includes('>Antigravity<'), false);
  assert.equal(html.includes('>Codex<'), false);
  // Floating card includes shortcut button to All Quotas panel and never renders warning icons or error banners
  assert.ok(html.includes('data-pt-action="open-quotas"'));
  assert.ok(code.includes('<span class="pt-sidebar-logo-text">T3</span>'));
  assert.ok(code.includes('<span class="pt-sidebar-status-dot"></span>'));
  assert.equal(code.includes('⚡ T3Tools'), false);
  assert.equal(code.includes('用量 & 缓存看板'), false);
  assert.equal(code.includes('⚠'), false);

  const noisyLive = {
    settings: { alertConfig: { enabled: true, injectedBanner: true } },
    globalAlerts: { otherUnreadCount: 4, unreadIncidents: 7 },
    threadErrors: [{ timestampMs: Date.now(), modelId: 'gemini-4-neon', errorCode: 'eof', errorText: 'upstream EOF error' }],
    thread: {
      unresolved: false,
      accountId: 'work',
      selectedModel: 'gemini-4-neon',
      phase: 'error',
      phaseLabel: '已结束',
      run: { status: 'failed' },
      steps: []
    },
    context: { accountId: 'work', modelId: 'gemini-4-neon', decodeSpeed: 90, ttftMs: 500, cacheHitPercent: 75, usedPercent: 20 },
    quotas: {
      groups: [{ accountId: 'work', displayName: 'work', driver: 'antigravity', windows: [], unavailable: { message: 'HTTP 503 upstream failure' } }]
    }
  };
  const noisyComposerHtml = renderComposerBar(noisyLive, { hideWhenUnresolved: true, inline: true });
  const noisyOverviewHtml = renderOverview(noisyLive, false, false);
  for (const forbidden of ['⚠', 'thread-errors', '点击排查', '会话失败', '运行失败', 'upstream EOF error', 'HTTP 503']) {
    assert.equal(noisyComposerHtml.includes(forbidden), false, `composer bar should not contain ${forbidden}`);
    assert.equal(noisyOverviewHtml.includes(forbidden), false, `overview card should not contain ${forbidden}`);
  }
  assert.ok(noisyOverviewHtml.includes('暂无额度'));

  // Dashboard renders All-Accounts Quotas panel (cards view, matrix table view, provider filter & email masking)
  const renderDashboard = new Function(`${sharedViewsSrc}\nreturn renderDashboardHtml;`)();
  const sampleDash = {
    range: { preset: 'weeklyQuota', status: 'active', start: Date.now() - 3600000, end: Date.now(), resetsAtMs: Date.now() + 86400000 },
    summary: { kpis: { totalRequests: 5 }, models: [] },
    heatmap: { days: [] },
    anomalySummary: { total: 0, excludedCompactions: 0 },
    facets: { accounts: ['work', 'antigravity', 'codex'], models: [] },
    accountUsage: {
      codex: { requests: 5, totalTokens: 42000, costUsd: 0.35, errors: 0 }
    },
    quotas: {
      updatedAtMs: Date.now(),
      summary: {
        totalAccounts: 3,
        readyAccounts: 3,
        healthyAccounts: 2,
        warningAccounts: 1,
        criticalAccounts: 0,
        unknownAccounts: 0,
        drivers: [
          { driver: 'antigravity', label: 'Antigravity', count: 2 },
          { driver: 'codex', label: 'Codex', count: 1 }
        ],
        lowestWindow: { accountId: 'antigravity', displayName: 'Antigravity', driver: 'antigravity', poolLabel: 'Claude & GPT (shared)', windowTag: '周额度 (7d)', remainingPercent: 32.5 },
        soonestResetWindow: { accountId: 'codex', displayName: 'Codex', driver: 'codex', poolLabel: 'Codex', resetsAtMs: Date.now() + 7200000 }
      },
      groups: [
        {
          accountId: 'antigravity',
          shortName: 'antigravity',
          displayName: 'Antigravity',
          driverLabel: 'Antigravity',
          driver: 'antigravity',
          auth: { status: 'authenticated', type: 'oauth-personal', label: 'Google account', email: '' },
          modelsCount: 9,
          minRemainingPercent: 32.5,
          health: 'warning',
          nextResetMs: Date.now() + 18000000,
          windows: [
            { poolKey: '3p', poolLabel: 'Claude & GPT (shared)', windowTag: '周额度 (7d)', kind: 'weekly', usedPercent: 67.5, remainingPercent: 32.5, resetsAtMs: Date.now() + 18000000 }
          ]
        },
        {
          accountId: 'work',
          shortName: 'work',
          displayName: 'work (Antigravity)',
          driverLabel: 'Antigravity',
          driver: 'antigravity',
          accentColor: '#2563eb',
          auth: { status: 'authenticated', type: 'oauth-personal', label: 'Google account', email: '' },
          modelsCount: 11,
          minRemainingPercent: 93.3,
          health: 'healthy',
          nextResetMs: Date.now() + 28000000,
          windows: [
            { poolKey: 'gemini', poolLabel: 'Gemini', windowTag: '周额度 (7d)', kind: 'weekly', usedPercent: 6.7, remainingPercent: 93.3, resetsAtMs: Date.now() + 28000000 }
          ]
        },
        {
          accountId: 'codex',
          shortName: 'codex',
          displayName: 'Codex',
          driverLabel: 'Codex',
          driver: 'codex',
          auth: { status: 'authenticated', type: 'chatgpt', label: 'ChatGPT Pro', email: 'alice123@example.com' },
          modelsCount: 10,
          resetCredits: { availableCount: 2, nextExpiresAtMs: Date.now() + 864000000 },
          minRemainingPercent: 81,
          health: 'healthy',
          nextResetMs: Date.now() + 7200000,
          windows: [
            { poolKey: 'codex', poolLabel: 'Codex', windowTag: '周额度 (7d)', kind: 'weekly', usedPercent: 19, remainingPercent: 81, resetsAtMs: Date.now() + 7200000 }
          ]
        }
      ]
    }
  };

  // Overview tab uses the unified sidebar App Shell layout + quick all-accounts strip + Quotas nav badge
  const overviewDashHtml = renderDashboard(sampleDash, { tab: 'overview' });
  assert.ok(overviewDashHtml.includes('class="app-shell"'));
  assert.ok(overviewDashHtml.includes('class="app-side"'));
  assert.ok(overviewDashHtml.includes('class="app-top"'));
  assert.ok(overviewDashHtml.includes('<span>账号额度</span>'));
  assert.ok(overviewDashHtml.includes('data-tone="warning">3</span>'));
  assert.ok(overviewDashHtml.includes('pt-quota-strip'));
  assert.ok(overviewDashHtml.includes('work'));
  assert.ok(overviewDashHtml.includes('codex'));
  assert.equal(overviewDashHtml.includes('实时监控'), false);

  // Settings tab in embedded overlay exposes T3 widget & alert controls
  const embeddedSettingsHtml = renderDashboard(sampleDash, { tab: 'settings' }, {
    statusData: { pid: 1234, httpUrl: 'http://127.0.0.1:17373', cdp: { connected: true, devToolsPort: 9222 }, settings: { showComposerBar: true, showOverviewCard: true } }
  });
  assert.ok(embeddedSettingsHtml.includes('data-pt-setting="showComposerBar"'));
  assert.ok(embeddedSettingsHtml.includes('data-pt-setting="showOverviewCard"'));
  assert.ok(embeddedSettingsHtml.includes('已吸附 T3 Code (:9222)'));

  // Quotas tab (cards view + email masked)
  const quotasCardsHtml = renderDashboard(sampleDash, { tab: 'quotas', quotaDriver: 'all', quotaSort: 'remaining', quotaView: 'cards', hideEmail: true });
  assert.ok(quotasCardsHtml.includes('al***23@example.com'));
  assert.equal(quotasCardsHtml.includes('alice123@example.com'), false);
  assert.ok(quotasCardsHtml.includes('重置券 ×2'));
  assert.ok(quotasCardsHtml.includes('本周期 5 次'));
  assert.ok(quotasCardsHtml.includes('Claude &amp; GPT (shared)'));
  // Tightest account card (antigravity 32.5%) surfaces before work (93.3%)
  assert.ok(
    quotasCardsHtml.indexOf('data-pt-inspect-account="antigravity"') <
    quotasCardsHtml.indexOf('data-pt-inspect-account="work"')
  );

  // Quotas tab (driver filter + matrix table view)
  const quotasTableHtml = renderDashboard(sampleDash, { tab: 'quotas', quotaDriver: 'codex', quotaView: 'table', hideEmail: false });
  assert.ok(quotasTableHtml.includes('alice123@example.com'));
  assert.ok(quotasTableHtml.includes('模型额度池'));
  assert.equal(quotasTableHtml.includes('data-pt-inspect-account="work"'), false);

  // Requests tab renders first-token latency (TTFT) column with measured values and "-" fallback
  const requestsDashHtml = renderDashboard({
    ...sampleDash,
    requests: {
      total: 3,
      page: 1,
      totalPages: 1,
      items: [
        {
          id: 'req-1',
          timestampMs: Date.now() - 5000,
          accountId: 'work',
          modelId: 'gemini-4-neon',
          t3ThreadTitle: '首字测试会话',
          nativeSessionId: 'sess-1',
          inputTokens: 1200,
          cacheReadTokens: 8000,
          outputTokens: 320,
          cacheHitPercent: 87.0,
          ttftMs: 1460,
          streamingMs: 2500,
          durationMs: 3960,
          tps: 128,
          tpsKind: 'generation',
          status: 'success',
          outcomeKnown: true,
          retries: 0
        },
        {
          id: 'req-2',
          timestampMs: Date.now() - 3000,
          accountId: 'work',
          modelId: 'gemini-4-neon',
          t3ThreadTitle: '极速首字',
          nativeSessionId: 'sess-2',
          inputTokens: 500,
          cacheReadTokens: 0,
          outputTokens: 120,
          cacheHitPercent: 0,
          ttftMs: 420,
          streamingMs: 800,
          durationMs: 1220,
          tps: 150,
          tpsKind: 'generation',
          status: 'success',
          outcomeKnown: true,
          retries: 0
        },
        {
          id: 'req-3',
          timestampMs: Date.now() - 1000,
          accountId: 'codex',
          modelId: 'gpt-6.2-astra',
          t3ThreadTitle: '无首字计时',
          nativeSessionId: 'sess-3',
          inputTokens: 900,
          cacheReadTokens: 3000,
          outputTokens: 200,
          cacheHitPercent: 76.9,
          ttftMs: null,
          streamingMs: null,
          durationMs: 2400,
          tps: 83.3,
          tpsKind: 'e2e-estimate',
          status: 'success',
          outcomeKnown: true,
          retries: 0
        }
      ]
    }
  }, { tab: 'requests' });
  assert.ok(requestsDashHtml.includes('<th class="n ttft lc-opt2">首字响应</th>'));
  assert.ok(requestsDashHtml.includes('title="首字响应 1.5s · 流式生成 2.5s">1.5s<'));
  assert.ok(requestsDashHtml.includes('title="首字响应 420ms · 流式生成 800ms">420ms<'));
  assert.ok(requestsDashHtml.includes('title="当前数据源无首字计时">-<'));

  const emptyRequestsHtml = renderDashboard({
    ...sampleDash,
    requests: { total: 0, page: 1, totalPages: 1, items: [] }
  }, { tab: 'requests' });
  assert.ok(emptyRequestsHtml.includes('colspan="15"'));
});

test('end-to-end daemon: pending nativeThreadRef resolution, unresolved desktop state, HTTP auth/origin guards, and Fallback HTML', async () => {
  const root = mkdtempSync(join(tmpdir(), 't3tools-e2e-'));
  let daemon;
  try {
    const t3Root = join(root, '.t3');
    const t3UserData = join(t3Root, 'userdata');
    const t3Caches = join(t3Root, 'caches');
    const codexDir = join(root, '.codex', 'sessions', '2026', '11', '24');
    const pluginDataDir = join(root, '.t3tools');

    mkdirSync(t3UserData, { recursive: true });
    mkdirSync(t3Caches, { recursive: true });
    mkdirSync(codexDir, { recursive: true });

    writeFileSync(join(t3UserData, 'settings.json'), JSON.stringify({
      providerInstances: {
        work: { driver: 'antigravity', displayName: 'Antigravity', enabled: true },
        codex: { driver: 'codex', enabled: true }
      }
    }));

    const futureReset = new Date(Date.now() + 5 * 86400000).toISOString();
    writeFileSync(join(t3Caches, 'work.json'), JSON.stringify({
      instanceId: 'work',
      driver: 'antigravity',
      displayName: 'Antigravity',
      enabled: true,
      status: 'ready',
      usageLimits: {
        checkedAt: new Date().toISOString(),
        windows: [
          null,
          { id: 'gemini-unknown', label: 'Gemini', usedPercent: null, resetsAt: '1796000000' },
          { id: 'gemini-5h', label: 'Gemini · 5-hour', kind: 'session', usedPercent: 10, resetsAt: new Date(Date.now() + 3600000).toISOString(), windowDurationMins: 300 },
          { id: 'gemini-weekly', label: 'Gemini · Weekly', kind: 'weekly', usedPercent: 25, resetsAt: futureReset, windowDurationMins: 10080 }
        ]
      }
    }));

    // T3 statev2.sqlite with a PENDING provider_thread_id key whose payload_json carries resolved nativeThreadRef.nativeId (fixes P1 #3)
    const stateDb = new DatabaseSync(join(t3UserData, 'statev2.sqlite'));
    stateDb.exec(`
      CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT, default_provider TEXT, provider_instance_id TEXT, updated_at TEXT, archived_at TEXT, deleted_at TEXT);
      CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, provider TEXT, driver TEXT, provider_instance_id TEXT, provider_session_id TEXT, status TEXT, updated_at TEXT, payload_json TEXT);
      CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY, thread_id TEXT, ordinal INTEGER, provider TEXT, provider_instance_id TEXT, provider_thread_id TEXT, status TEXT, requested_at TEXT, completed_at TEXT, payload_json TEXT);
      CREATE TABLE orchestration_v2_projection_turn_items (turn_item_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT, ordinal INTEGER, type TEXT, status TEXT, updated_at TEXT, payload_json TEXT);
    `);
    const nowIso = new Date().toISOString();
    const pendingKey = 'provider-thread:provider:codex:native-thread:pending%3Arun%3Athread%3Ath-1%3Aordinal%3A1';
    const resolvedNativeId = '11111111-2222-3333-4444-555555555555';

    stateDb.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,?)').run('th-1', '测试会话', 'codex', 'codex', nowIso, null, null);
    stateDb.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?,?,?,?,?,?,?)').run(
      pendingKey, 'th-1', 'codex', 'codex', 'codex', 'ps-1', 'active', nowIso,
      JSON.stringify({ nativeThreadRef: { driver: 'codex', nativeId: resolvedNativeId, strength: 'strong' } })
    );
    stateDb.prepare('INSERT INTO orchestration_v2_projection_runs VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      'run-1', 'th-1', 1, 'codex', 'codex', pendingKey, 'running', new Date(Date.now() - 8000).toISOString(), null,
      JSON.stringify({ modelSelection: { instanceId: 'codex', model: 'gpt-6.2-astra' } })
    );
    // Queued follow-up run with higher ordinal MUST NOT override active run-1 (fixes P2 #13)
    stateDb.prepare('INSERT INTO orchestration_v2_projection_runs VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      'run-2', 'th-1', 2, 'codex', 'codex', pendingKey, 'queued', nowIso, null,
      JSON.stringify({ modelSelection: { instanceId: 'codex', model: 'gpt-6.2-astra' } })
    );
    stateDb.prepare('INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?,?,?,?,?,?)').run(
      'item-1', 'th-1', 'run-1', 1, 'reasoning', 'completed', nowIso,
      JSON.stringify({ title: '分析需求', startedAt: new Date(Date.now() - 6000).toISOString(), completedAt: new Date(Date.now() - 2000).toISOString() })
    );
    stateDb.close();

    // Codex rollout using token_usage_record
    const ts1 = new Date(Date.now() - 50000).toISOString();
    const ts2 = new Date(Date.now() - 20000).toISOString();
    writeFileSync(join(codexDir, `rollout-${resolvedNativeId}.jsonl`), [
      'null',
      JSON.stringify({ timestamp: ts1, type: 'session_meta', payload: { id: resolvedNativeId } }),
      JSON.stringify({ timestamp: ts1, type: 'turn_context', payload: { model: 'gpt-6.2-astra' } }),
      JSON.stringify({
        timestamp: ts1, type: 'token_usage_record',
        payload: { thread_id: resolvedNativeId, response_id: 'resp_1', usage: { input_tokens: 15000, cached_input_tokens: 12000, cache_write_input_tokens: 0, output_tokens: 500 }, model_context_window: 475000 }
      }),
      JSON.stringify({
        timestamp: ts2, type: 'token_usage_record',
        payload: { thread_id: resolvedNativeId, response_id: 'resp_2', usage: { input_tokens: 16000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 500 }, model_context_window: 475000 }
      })
    ].join('\n'));

    daemon = await startDaemon({
      pathOverrides: { t3Root, codexSessionsDir: join(root, '.codex', 'sessions'), pluginDataDir, home: root, appData: root },
      portOverride: 0,
      enableCdp: false
    });

    // 1. Live snapshot resolves pending key -> nativeId -> context, prefers active run-1, counts queuedRuns=1
    const liveRes = await (await fetch(`${daemon.url}/api/live?threadId=th-1&allowFallback=0`)).json();
    assert.equal(liveRes.ok, true);
    assert.equal(liveRes.data.thread.run.runId, 'run-1');
    assert.equal(liveRes.data.thread.queuedRuns, 1);
    assert.equal(liveRes.data.context.maxTokens, 475000);

    // 2. Unresolved desktop thread with allowFallback=0 does NOT leak th-1
    const unresolvedRes = await (await fetch(`${daemon.url}/api/live?threadId=nonexistent&allowFallback=0`)).json();
    assert.equal(unresolvedRes.data.thread.unresolved, true);
    assert.equal(unresolvedRes.data.context, null);

    // 3. Dashboard links pending session title, flags cleared cache anomaly, and includes enriched quotas + accountUsage
    const dashRes = await (await fetch(`${daemon.url}/api/dashboard?preset=weeklyQuota`)).json();
    assert.equal(dashRes.data.summary.kpis.totalRequests, 2);
    assert.equal(dashRes.data.requests.items[0].t3ThreadTitle, '测试会话');
    assert.equal(dashRes.data.requests.items[0].cacheAnomaly.kind, 'cleared');
    assert.equal(dashRes.data.quotas.summary.totalAccounts, 2);
    assert.equal(dashRes.data.quotas.summary.readyAccounts, 1);
    assert.equal(dashRes.data.quotas.groups.find(g => g.accountId === 'work').pools.length, 1);
    assert.equal(dashRes.data.accountUsage.codex.requests, 2);
    const unknown = dashRes.data.quotas.flatWindows.find(w => w.windowId === 'gemini-unknown');
    assert.equal(unknown.remainingPercent, null);
    assert.equal(unknown.resetsAtMs, 1796000000000);

    // 4. Negative authorization tests (fixes P1 #5)
    const badOrigin = await fetch(`${daemon.url}/api/status`, { headers: { Origin: 'http://evil.localhost:9999' } });
    assert.equal(badOrigin.status, 403);

    const noTokenPost = await fetch(`${daemon.url}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overviewCollapsed: true })
    });
    assert.equal(noTokenPost.status, 401);

    const badContentType = await fetch(`${daemon.url}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-T3Tools-Token': daemon.authToken },
      body: '{"overviewCollapsed":true}'
    });
    assert.equal(badContentType.status, 415);

    const badSyncMediaType = await fetch(`${daemon.url}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; application/json', 'X-T3Tools-Token': daemon.authToken },
      body: '{}'
    });
    assert.equal(badSyncMediaType.status, 415);

    for (const [body, expected] of [['{', 400], ['null', 400], ['[]', 400], ['a'.repeat(65537), 413]]) {
      const result = await fetch(daemon.url + '/api/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-T3Tools-Token': daemon.authToken }, body
      });
      assert.equal(result.status, expected);
      assert.equal((await result.json()).ok, false);
    }
    // /api/bundle.js must NOT embed the daemon's mutation token (fixes P2 #5)
    const bundleText = await (await fetch(`${daemon.url}/api/bundle.js`)).text();
    assert.equal(bundleText.includes(daemon.authToken), false);

    const badSchema = await fetch(`${daemon.url}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-T3Tools-Token': daemon.authToken },
      body: JSON.stringify({ port: 80 })
    });
    assert.equal(badSchema.status, 400);

    const badTheme = await fetch(`${daemon.url}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-T3Tools-Token': daemon.authToken },
      body: JSON.stringify({ theme: 'blue' })
    });
    assert.equal(badTheme.status, 400);

    // Valid token + JSON + schema succeeds (including theme persistence)
    const okPost = await fetch(`${daemon.url}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-T3Tools-Token': daemon.authToken },
      body: JSON.stringify({ overviewCollapsed: true, theme: 'light' })
    });
    assert.equal(okPost.status, 200);
    const updatedCfg = (await okPost.json()).data;
    assert.equal(updatedCfg.overviewCollapsed, true);
    assert.equal(updatedCfg.theme, 'light');

    // 5. Fallback HTML reflects persisted light theme on first paint (no dark flash) and has valid inline JS syntax
    const fallback = await fetch(daemon.url + '/');
    assert.equal(fallback.headers.get('X-Frame-Options'), 'DENY');
    const html = await fallback.text();
    assert.ok(html.includes('<html lang="zh-CN" class="light" data-theme="light">'));
    assert.ok(html.includes('html[data-theme="light"]'));
    assert.ok(html.includes('"theme":"light"'));
    assert.ok(html.includes('id="pt-boot-config"'));
    assert.equal(html.includes('id="live-thread-picker"'), false);
    assert.equal(html.includes('id="view-live"'), false);
    assert.equal(html.includes('实时监控'), false);
    for (const viewId of ['view-overview', 'view-quotas', 'view-models', 'view-requests', 'view-settings']) {
      assert.ok(html.includes(`id="${viewId}"`), `missing ${viewId}`);
    }
    const scriptMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(scriptMatches.length >= 1);
    assert.doesNotThrow(() => new Function(scriptMatches[0][1]));

    // Switching back to dark theme updates initial HTML theme as well
    const backToDark = await fetch(`${daemon.url}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-T3Tools-Token': daemon.authToken },
      body: JSON.stringify({ theme: 'dark' })
    });
    assert.equal(backToDark.status, 200);
    const darkHtml = await (await fetch(`${daemon.url}/`)).text();
    assert.ok(darkHtml.includes('<html lang="zh-CN" class="dark" data-theme="dark">'));

    // 6. Fork deletion MUST NOT erase parent request from telemetry store (fixes P1 #6)
    const forkFile = join(codexDir, 'rollout-99999999-2222-3333-4444-555555555555.jsonl');
    writeFileSync(forkFile, [
      JSON.stringify({ timestamp: ts1, type: 'session_meta', payload: { id: '99999999-2222-3333-4444-555555555555', session_id: resolvedNativeId } }),
      JSON.stringify({
        timestamp: ts1, type: 'token_usage_record',
        payload: { thread_id: resolvedNativeId, response_id: 'resp_1', usage: { input_tokens: 15000, cached_input_tokens: 12000, cache_write_input_tokens: 0, output_tokens: 500 } }
      })
    ].join('\n'));
    daemon.ctx.engine.syncAll({ force: true });
    rmSync(forkFile, { force: true });
    daemon.ctx.engine.syncAll({ force: true });
    const afterForkDelete = await (await fetch(`${daemon.url}/api/dashboard?preset=weeklyQuota`)).json();
    assert.equal(afterForkDelete.data.summary.kpis.totalRequests, 2);

    const postErrorAction = async (route, body = {}) => (await fetch(daemon.url + route, {
      method: 'POST', headers: {'Content-Type':'application/json','X-T3Tools-Token':daemon.authToken},
      body:JSON.stringify(body)
    })).json();
    assert.equal((await postErrorAction('/api/t3/focus-thread',{threadId:'th-1'})).data.focused,false);
    const projection = new DatabaseSync(join(t3UserData,'statev2.sqlite'));
    try {
      projection.prepare("UPDATE orchestration_v2_projection_runs SET status='failed', completed_at=? WHERE run_id='run-1'").run(new Date().toISOString());
    } finally { projection.close(); }
    // Wait for the idle daemon timer. No dashboard requests drive ingestion here.
    const deadline = Date.now() + 12000;
    while (daemon.getStatus().alerts.latestAlert?.errorCode !== 'failed' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve,100));
    }
    const alerts = (await (await fetch(daemon.url + '/api/status')).json()).data.alerts;
    assert.equal(alerts.latestAlert.errorCode,'failed');
    assert.equal(alerts.latestAlert.t3ThreadTitle,'测试会话');
    assert.equal(alerts.latestAlert.desktopNotify,true);
    const synthetic = (await postErrorAction('/api/alerts/test')).data;
    assert.equal(synthetic.seq,alerts.latestSeq+1);
    assert.equal(synthetic.errorCode,'test');
    const receipt = (await postErrorAction('/api/errors/ack')).data;
    assert.equal(receipt.unreadCount,0);
    assert.equal(Number(daemon.ctx.store.getMeta('error_ack_ts_ms')),receipt.ackTsMs);
  } finally {
    await daemon?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('injected client isolates composer TPS per conversation across SPA switches, in-flight races, drafts, and RPC disconnects', async () => {
  const code = buildClientBundle({ version: '0.1.0', bootId: 'test-boot', transport: 'cdp' });

  class FakeEl {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase();
      this.id = '';
      this.className = '';
      this.classList = { contains: () => false, add: () => {}, remove: () => {}, toggle: () => {} };
      this.style = { cssText: '', display: '', setProperty: () => {} };
      this.attrs = new Map();
      this.children = [];
      this.parentElement = null;
      this.shadowRoot = null;
      this._innerHTML = '';
      this.listeners = new Map();
      this.isConnected = false;
    }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(v) { this._innerHTML = String(v); }
    setAttribute(k, v) { this.attrs.set(k, String(v)); }
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
    attachShadow() {
      const sr = new FakeEl('shadow-root');
      sr.isConnected = true;
      this.shadowRoot = sr;
      return sr;
    }
    append(...nodes) { for (const n of nodes) this.appendChild(n); }
    appendChild(node) {
      if (node.parentElement) node.parentElement.removeChild(node);
      node.parentElement = this;
      node.isConnected = this.isConnected;
      this.children.push(node);
      return node;
    }
    insertBefore(node, ref) {
      if (node.parentElement) node.parentElement.removeChild(node);
      node.parentElement = this;
      node.isConnected = this.isConnected;
      const idx = ref ? this.children.indexOf(ref) : -1;
      if (idx >= 0) this.children.splice(idx, 0, node);
      else this.children.push(node);
      return node;
    }
    removeChild(node) {
      const idx = this.children.indexOf(node);
      if (idx >= 0) this.children.splice(idx, 1);
      node.parentElement = null;
      node.isConnected = false;
    }
    remove() { if (this.parentElement) this.parentElement.removeChild(this); }
    get nextElementSibling() {
      if (!this.parentElement) return null;
      const idx = this.parentElement.children.indexOf(this);
      return idx >= 0 ? (this.parentElement.children[idx + 1] || null) : null;
    }
    get previousElementSibling() {
      if (!this.parentElement) return null;
      const idx = this.parentElement.children.indexOf(this);
      return idx > 0 ? (this.parentElement.children[idx - 1] || null) : null;
    }
    contains(node) {
      let cur = node;
      while (cur) { if (cur === this) return true; cur = cur.parentElement; }
      return false;
    }
    closest(sel) {
      let cur = this;
      while (cur) {
        if (sel === '[data-t3tools]' && cur.getAttribute('data-t3tools')) return cur;
        if (sel === '[data-thread-item]' && cur.getAttribute('data-thread-item')) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    querySelector() { return null; }
    getBoundingClientRect() { return { width: 400, height: 40, x: 0, y: 0 }; }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  }

  const body = new FakeEl('body');
  body.isConnected = true;
  const footer = new FakeEl('div');
  footer.setAttribute('data-chat-composer-footer', 'true');
  body.appendChild(footer);
  const sidebar = new FakeEl('aside');
  body.appendChild(sidebar);
  const sidebarHtml = () => sidebar.children.find(c => c.id === 't3tools-sidebar-btn')?.shadowRoot?.children?.[1]?.innerHTML || '';
  const sidebarActive = new FakeEl('li');
  sidebarActive.setAttribute('data-thread-item', '2d40c3ef-6556-4e58-b87d-dbf308ba9990:thread-sidebar-only');
  sidebarActive.setAttribute('aria-current', 'page');

  const locationObj = {
    href: 't3code://app/#/2d40c3ef-6556-4e58-b87d-dbf308ba9990/thread-a',
    pathname: '/',
    hash: '#/2d40c3ef-6556-4e58-b87d-dbf308ba9990/thread-a',
    search: ''
  };
  const setHash = hash => {
    locationObj.hash = hash;
    locationObj.href = `t3code://app/${hash}`;
  };

  const observers = [];
  class FakeMutationObserver {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() {}
    disconnect() {}
  }

  const windowListeners = new Map();
  const pendingBridge = [];
  const docObj = {
    body,
    documentElement: new FakeEl('html'),
    createElement: tag => new FakeEl(tag),
    querySelector: sel => {
      if (sel === 'aside') return sidebar;
      if (sel.includes('data-thread-item') || sel.includes('aria-current')) return sidebarActive;
      return null;
    },
    querySelectorAll: sel => (sel === '[data-chat-composer-footer]' ? [footer] : sel === 'aside' ? [sidebar] : [])
  };

  const timers = new Set();
  const intervals = new Set();
  const trackedSetTimeout = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); id.unref?.(); timers.add(id); return id; };
  const trackedClearTimeout = id => { timers.delete(id); clearTimeout(id); };
  const trackedSetInterval = (fn, ms) => { const id = setInterval(fn, ms); id.unref?.(); intervals.add(id); return id; };
  const trackedClearInterval = id => { intervals.delete(id); clearInterval(id); };

  const sandbox = {
    window: {
      addEventListener(type, fn) {
        if (!windowListeners.has(type)) windowListeners.set(type, new Set());
        windowListeners.get(type).add(fn);
      },
      removeEventListener(type, fn) { windowListeners.get(type)?.delete(fn); },
      getComputedStyle: () => ({ display: 'block', flexDirection: 'column', backgroundColor: 'rgb(11, 12, 15)', getPropertyValue: () => '' })
    },
    document: docObj,
    location: locationObj,
    MutationObserver: FakeMutationObserver,
    getComputedStyle: () => ({ display: 'block', flexDirection: 'column', backgroundColor: 'rgb(11, 12, 15)', getPropertyValue: () => '' }),
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout: trackedSetTimeout,
    clearTimeout: trackedClearTimeout,
    setInterval: trackedSetInterval,
    clearInterval: trackedClearInterval,
    requestAnimationFrame: fn => trackedSetTimeout(fn, 0),
    URL,
    URLSearchParams,
    console,
    __t3ToolsBridge(raw) {
      const req = JSON.parse(raw);
      pendingBridge.push(req);
    }
  };
  sandbox.globalThis = sandbox;

  const runner = new Function(
    'globalThis', 'window', 'document', 'location', 'MutationObserver', 'getComputedStyle', 'localStorage',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'URL', 'URLSearchParams', 'console',
    code
  );
  runner(
    sandbox, sandbox.window, sandbox.document, sandbox.location, sandbox.MutationObserver,
    sandbox.getComputedStyle, sandbox.localStorage, trackedSetTimeout, trackedClearTimeout,
    trackedSetInterval, trackedClearInterval, sandbox.requestAnimationFrame, URL, URLSearchParams, console
  );

  const makeLive = (threadId, decodeSpeed) => ({
    settings: { enabled: true, showComposerBar: true, showOverviewCard: true, pollIntervalMs: 60000 },
    thread: { unresolved: false, threadId, title: threadId, accountId: 'work', selectedModel: 'gemini-4-neon', phase: 'completed', phaseLabel: '已完成', steps: [] },
    context: { decodeSpeed, ttftMs: 1200, cacheHitPercent: 88, usedPercent: 30, usedTokens: 30000, maxTokens: 100000 },
    quotas: { groups: [] }
  });

  const composerHost = () => footer.children.find(c => c.id === 't3tools-composer');
  const composerHtml = () => composerHost()?.shadowRoot?.children?.[1]?.innerHTML || '';
  const flush = () => new Promise(r => setTimeout(r, 15));

  try {
    // 1. Initial boot requests thread-a
    assert.equal(pendingBridge.length, 1);
    assert.equal(pendingBridge[0].params.threadId, 'thread-a');
    sandbox.__t3ToolsReceive(pendingBridge.shift().id, { ok: true, data: makeLive('thread-a', 111) });
    await flush();
    assert.equal(composerHost().style.display, 'inline-flex');
    assert.ok(composerHtml().includes('111<span class="pt-usage-unit">tok/s</span>'));

    // 2. Simulate an in-flight poll for thread-a, then SPA switch to thread-b WITHOUT hashchange (DOM mutation only)
    for (const fn of windowListeners.get('popstate') || []) fn();
    assert.equal(pendingBridge.length, 1);
    assert.match(sidebarHtml(), /data-state="attached"/);
    const slowReqA = pendingBridge.shift();
    assert.equal(slowReqA.params.threadId, 'thread-a');

    setHash('#/2d40c3ef-6556-4e58-b87d-dbf308ba9990/thread-b');
    for (const obs of observers) obs.cb();
    // Stale thread-a TPS MUST be hidden immediately on switch and thread-b MUST be fetched even while slowReqA is in flight
    assert.equal(composerHost().style.display, 'none');
    assert.equal(composerHtml().includes('111<span'), false);
    assert.equal(pendingBridge.length, 1);
    assert.match(sidebarHtml(), /data-state="attached"/);
    const reqB = pendingBridge.shift();
    assert.equal(reqB.params.threadId, 'thread-b');

    // Thread-b responds with 222 tok/s; then delayed slowReqA arrives later and MUST be ignored
    sandbox.__t3ToolsReceive(reqB.id, { ok: true, data: { ...makeLive('thread-b', 222),
      settings: { ...makeLive('thread-b', 222).settings, sidebarUsageRange: '7d' },
      sidebarUsage: { preset: 'today', totalTokens: 987, costUsd: 99.81 } } });
    await flush();
    assert.equal(composerHost().style.display, 'inline-flex');
    assert.ok(composerHtml().includes('222<span class="pt-usage-unit">tok/s</span>'));

    assert.doesNotMatch(sidebarHtml(), /99\.81|data-pt-sidebar-range="today"/);
    assert.match(sidebarHtml(), /近7天|近 7 天|7天/);
    sandbox.__t3ToolsReceive(slowReqA.id, { ok: true, data: makeLive('thread-a', 111) });
    await flush();
    assert.ok(composerHtml().includes('222<span class="pt-usage-unit">tok/s</span>'));

    // 3. Switching to #/draft/<id> immediately clears threadId to '' and hides composer bar
    setHash('#/draft/157fa5c3-0d4a-4f4e-a435-23d7ab4dd51e');
    for (const obs of observers) obs.cb();
    assert.equal(sandbox.__t3Tools.diagnoseAnchors().threadId, '');
    assert.equal(composerHost().style.display, 'none');
    const draftReq = pendingBridge.shift();
    assert.equal(draftReq.params.threadId, '');
    sandbox.__t3ToolsReceive(draftReq.id, { ok: true, data: { settings: { enabled: true }, thread: { unresolved: true, steps: [] }, context: null, quotas: { groups: [] } } });
    await flush();
    assert.equal(composerHost().style.display, 'none');

    // 4. Root route falls back to sidebar data-thread-item and strips "<envUuid>:" prefix
    setHash('#/');
    assert.equal(sandbox.__t3Tools.diagnoseAnchors().threadId, 'thread-sidebar-only');

    // 5. Switch to thread-c and simulate RPC disconnect error -> composer stays hidden (no stale TPS leaked)
    setHash('#/2d40c3ef-6556-4e58-b87d-dbf308ba9990/thread-c');
    for (const obs of observers) obs.cb();
    const reqC = pendingBridge.shift();
    assert.equal(reqC.params.threadId, 'thread-c');
    sandbox.__t3ToolsReceive(reqC.id, { ok: false, error: 'RPC getLive 超时' });
    await flush();
    assert.equal(composerHost().style.display, 'none');
    assert.equal(composerHtml().includes('222<span'), false);
  } finally {
    sandbox.__t3Tools?.dispose?.();
    for (const id of timers) clearTimeout(id);
    for (const id of intervals) clearInterval(id);
  }
});
