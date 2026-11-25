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
  // Floating card includes shortcut button to All Quotas panel
  assert.ok(html.includes('data-pt-action="open-quotas"'));

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

  // Overview tab contains the quick all-accounts strip + Quotas tab button
  const overviewDashHtml = renderDashboard(sampleDash, { tab: 'overview' });
  assert.ok(overviewDashHtml.includes('账号额度 (3)'));
  assert.ok(overviewDashHtml.includes('全账号额度速览'));
  assert.ok(overviewDashHtml.includes('work'));
  assert.ok(overviewDashHtml.includes('codex'));

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

    // /api/bundle.js must NOT embed the daemon's mutation token (fixes P2 #5)
    const bundleText = await (await fetch(`${daemon.url}/api/bundle.js`)).text();
    assert.equal(bundleText.includes(daemon.authToken), false);

    const badSchema = await fetch(`${daemon.url}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-T3Tools-Token': daemon.authToken },
      body: JSON.stringify({ port: 80 })
    });
    assert.equal(badSchema.status, 400);

    // Valid token + JSON + schema succeeds
    const okPost = await fetch(`${daemon.url}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-T3Tools-Token': daemon.authToken },
      body: JSON.stringify({ overviewCollapsed: true })
    });
    assert.equal(okPost.status, 200);
    assert.equal((await okPost.json()).data.overviewCollapsed, true);

    // 5. Fallback HTML uses safe JSON boot config & thread picker
    const html = await (await fetch(`${daemon.url}/`)).text();
    assert.ok(html.includes('id="pt-boot-config"'));
    assert.ok(html.includes('id="live-thread-picker"'));

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
  } finally {
    await daemon?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
