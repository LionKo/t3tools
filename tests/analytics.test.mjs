import test from 'node:test';
import assert from 'node:assert/strict';
import { detectCacheAnomalies } from '../src/analytics/cache-anomalies.mjs';
import { resolveWeeklyQuotaWindow, resolveDateRange } from '../src/analytics/weekly-window.mjs';
import { build53WeekHeatmap, summarizeAnalytics } from '../src/analytics/heatmap-health.mjs';

test('detectCacheAnomalies excludes cold starts even when another session/time caches the same model, and clears baseline on small/failed compaction', () => {
  const baseTs = 1795000000000;
  const reqs = [
    // Two cold requests in new session s-cold -> MUST NOT flag missed even though s-other caches later!
    { id: 'c1', accountId: 'work', nativeSessionId: 's-cold', modelId: 'gemini-4-neon', timestampMs: baseTs, inputTokens: 20000, cacheReadTokens: 0, outputTokens: 200, status: 'success' },
    { id: 'c2', accountId: 'work', nativeSessionId: 's-cold', modelId: 'gemini-4-neon', timestampMs: baseTs + 20000, inputTokens: 22000, cacheReadTokens: 0, outputTokens: 200, status: 'success' },
    // Unrelated session warming cache later in time
    { id: 'other1', accountId: 'antigravity', nativeSessionId: 's-other', modelId: 'gemini-4-neon', timestampMs: baseTs + 500000, inputTokens: 2000, cacheReadTokens: 20000, outputTokens: 200, status: 'success' },

    // Session s1: warm -> failed compaction -> TWO subsequent cold requests (neither may produce a missed alert!)
    { id: 'w1', accountId: 'work', nativeSessionId: 's1', modelId: 'gemini-4-neon', timestampMs: baseTs + 1000, inputTokens: 2000, cacheReadTokens: 28000, outputTokens: 200, status: 'success' },
    { id: 'w2-compact-fail', accountId: 'work', nativeSessionId: 's1', modelId: 'gemini-4-neon', timestampMs: baseTs + 15000, inputTokens: 1000, cacheReadTokens: 0, outputTokens: 0, status: 'error', compactionBefore: true },
    { id: 'w3-after-compact-1', accountId: 'work', nativeSessionId: 's1', modelId: 'gemini-4-neon', timestampMs: baseTs + 25000, inputTokens: 26000, cacheReadTokens: 0, outputTokens: 200, status: 'success' },
    { id: 'w4-after-compact-2', accountId: 'work', nativeSessionId: 's1', modelId: 'gemini-4-neon', timestampMs: baseTs + 45000, inputTokens: 27000, cacheReadTokens: 0, outputTokens: 200, status: 'success' },

    // Session s3: 30k -> 3k small implicit compaction (below minCurInput) followed by two cold requests -> NO missed alert (fixes P2 #10)
    { id: 'sm1', accountId: 'work', nativeSessionId: 's3', modelId: 'gemini-4-neon', timestampMs: baseTs + 1000, inputTokens: 3000, cacheReadTokens: 27000, outputTokens: 200, status: 'success' },
    { id: 'sm2-compact', accountId: 'work', nativeSessionId: 's3', modelId: 'gemini-4-neon', timestampMs: baseTs + 20000, inputTokens: 3000, cacheReadTokens: 0, outputTokens: 200, status: 'success' },
    { id: 'sm3-cold1', accountId: 'work', nativeSessionId: 's3', modelId: 'gemini-4-neon', timestampMs: baseTs + 40000, inputTokens: 20000, cacheReadTokens: 0, outputTokens: 200, status: 'success' },
    { id: 'sm4-cold2', accountId: 'work', nativeSessionId: 's3', modelId: 'gemini-4-neon', timestampMs: baseTs + 60000, inputTokens: 21000, cacheReadTokens: 0, outputTokens: 200, status: 'success' },

    // Session s2: genuine cleared, missed, and dropped anomalies
    { id: 'g1', accountId: 'work', nativeSessionId: 's2', modelId: 'gemini-4-neon', timestampMs: baseTs + 1000, inputTokens: 3000, cacheReadTokens: 17000, outputTokens: 300, status: 'success' },
    { id: 'g2', accountId: 'work', nativeSessionId: 's2', modelId: 'gemini-4-neon', timestampMs: baseTs + 31000, inputTokens: 22000, cacheReadTokens: 0, outputTokens: 300, status: 'success' },
    { id: 'g3', accountId: 'work', nativeSessionId: 's2', modelId: 'gemini-4-neon', timestampMs: baseTs + 51000, inputTokens: 24000, cacheReadTokens: 0, outputTokens: 300, status: 'success' },
    { id: 'g4', accountId: 'work', nativeSessionId: 's2', modelId: 'gemini-4-neon', timestampMs: baseTs + 71000, inputTokens: 3000, cacheReadTokens: 27000, outputTokens: 300, status: 'success' },
    { id: 'g5', accountId: 'work', nativeSessionId: 's2', modelId: 'gemini-4-neon', timestampMs: baseTs + 91000, inputTokens: 27000, cacheReadTokens: 3000, outputTokens: 300, status: 'success' }
  ];

  const { anomalies, excludedCompactions, summary } = detectCacheAnomalies(reqs);
  assert.equal(anomalies.get('c1'), undefined);
  assert.equal(anomalies.get('c2'), undefined);
  assert.equal(anomalies.get('w3-after-compact-1'), undefined);
  assert.equal(anomalies.get('w4-after-compact-2'), undefined);
  assert.equal(excludedCompactions.has('w2-compact-fail'), true);
  assert.equal(anomalies.get('sm3-cold1'), undefined);
  assert.equal(anomalies.get('sm4-cold2'), undefined);
  assert.equal(excludedCompactions.has('sm2-compact'), true);
  assert.equal(anomalies.get('g2')?.kind, 'cleared');
  assert.equal(anomalies.get('g3')?.kind, 'missed');
  assert.equal(anomalies.get('g5')?.kind, 'dropped');
  assert.equal(summary.total, 3);
});

test('resolveWeeklyQuotaWindow uses trailing 7d for expired resets (1d or 16d old) and isolates unmatched accounts', () => {
  const now = Date.parse('2026-11-24T15:00:00.000Z');
  const staleReset1d = now - 1 * 86400000; // 1 day ago
  const activeReset = now + 2 * 86400000;  // started 5 days ago
  const win = resolveWeeklyQuotaWindow({
    now,
    quotaWindows: [
      { accountId: 'work', poolKey: 'gemini', label: 'Gemini · Weekly', kind: 'weekly', usedPercent: 10, remainingPercent: 90, resetsAtMs: activeReset, windowDurationMins: 10080 },
      { accountId: 'codex', poolKey: 'codex', label: 'Codex · Weekly', kind: 'weekly', usedPercent: 50, remainingPercent: 50, resetsAtMs: staleReset1d, windowDurationMins: 10080 }
    ]
  });

  // 12-day-old Codex request excluded; 3-day-old Codex request INCLUDED even though expired reset was 1 day ago (matches 7d fallback)
  assert.equal(win.match({ accountId: 'codex', providerDriver: 'codex', modelId: 'gpt-6.2-astra', billingTsMs: now - 12 * 86400000 }), false);
  assert.equal(win.match({ accountId: 'codex', providerDriver: 'codex', modelId: 'gpt-6.2-astra', billingTsMs: now - 3 * 86400000 }), true);
  assert.equal(win.match({ accountId: 'other-acct', providerDriver: 'antigravity', modelId: 'gemini-4-neon', billingTsMs: now - 6 * 86400000 }), true);
  // Named Codex pool (`codex:pro`) starting 1 day ago excludes 4-day-old request on that account (fixes P1 #9)
  const namedWin = resolveWeeklyQuotaWindow({
    now,
    quotaWindows: [
      { accountId: 'work-codex', poolKey: 'codex:pro', label: 'Codex (pro) · Weekly', kind: 'weekly', usedPercent: 5, remainingPercent: 95, resetsAtMs: now + 6 * 86400000, windowDurationMins: 10080 }
    ]
  });
  assert.equal(namedWin.match({ accountId: 'work-codex', providerDriver: 'codex', modelId: 'gpt-6.2-astra', billingTsMs: now - 4 * 86400000 }), false);
  assert.equal(namedWin.match({ accountId: 'work-codex', providerDriver: 'codex', modelId: 'gpt-6.2-astra', billingTsMs: now - 2 * 3600000 }), true);
});

test('summarizeAnalytics peakTps is order-independent when mixing generation and e2e rows', () => {
  const now = Date.parse('2026-11-24T15:00:00.000Z');
  const genRow = { id: 'g', modelId: 'm1', timestampMs: now - 2000, billingTsMs: now - 2000, inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100, streamingMs: 1000, durationMs: 2000, tps: 100, tpsKind: 'generation', status: 'success', outcomeKnown: true };
  const e2eRow = { id: 'e', modelId: 'm1', timestampMs: now - 1000, billingTsMs: now - 1000, inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2000, streamingMs: null, durationMs: 1000, tps: 2000, tpsKind: 'e2e-estimate', status: 'success', outcomeKnown: true };
  const s1 = summarizeAnalytics([genRow, e2eRow], { match: () => true });
  const s2 = summarizeAnalytics([e2eRow, genRow], { match: () => true });
  assert.equal(s1.models[0].peakTps, 100);
  assert.equal(s2.models[0].peakTps, 100);
});

test('summarizeAnalytics separates unknown usage-only outcomes and generation vs e2e TPS', () => {
  const now = Date.parse('2026-11-24T15:00:00.000Z');
  const reqs = [
    { id: 'a', modelId: 'gemini-4-neon', timestampMs: now - 3600000, billingTsMs: now - 3600000, inputTokens: 2000, cacheReadTokens: 8000, cacheWriteTokens: 0, outputTokens: 1000, thinkingTokens: 400, streamingMs: 5000, durationMs: 7000, ttftMs: 2000, tps: 200, tpsKind: 'generation', costUsd: 0.05, savedUsd: 0.02, status: 'success', outcomeKnown: true, retries: 0 },
    { id: 'b', modelId: 'claude-usage-only', timestampMs: now - 1800000, billingTsMs: now - 1800000, inputTokens: 5000, cacheReadTokens: 5000, cacheWriteTokens: 0, outputTokens: 500, thinkingTokens: 0, durationMs: null, ttftMs: null, tps: null, tpsKind: 'none', costUsd: 0.15, savedUsd: 0.02, status: 'recorded', outcomeKnown: false, retries: 0 }
  ];

  const hm = build53WeekHeatmap(reqs, now);
  assert.ok(hm.totalDays >= 365 && hm.totalDays <= 372);
  assert.equal(hm.activeDays, 1);

  const summary = summarizeAnalytics(reqs, { match: () => true });
  const neon = summary.models.find(m => m.modelId === 'gemini-4-neon');
  const claude = summary.models.find(m => m.modelId === 'claude-usage-only');
  assert.equal(neon.avgTps, 200); // uses pure streamingMs (1000 / 5s), not ttft+streaming
  assert.equal(neon.avgTpsKind, 'generation');
  assert.equal(neon.healthStatus, 'healthy');
  assert.equal(claude.healthStatus, 'unknown');
  assert.equal(claude.knownOutcomeCount, 0);
  assert.equal(claude.successRate, null);
});

test('resolveDateRange supports Magpie-style rolling hours and date/time ranges', () => {
  const now = +new Date(2026, 10, 25, 15, 30, 0, 0);

  const rolling = resolveDateRange('last:6h', { now });
  assert.equal(rolling.status, 'rolling');
  assert.equal(rolling.end, now);
  assert.equal(rolling.start, now - 6 * 3600 * 1000);
  assert.equal(rolling.match({ billingTsMs: now - 3 * 3600 * 1000 }), true);
  assert.equal(rolling.match({ billingTsMs: now - 7 * 3600 * 1000 }), false);

  const daySpan = resolveDateRange('2026-11-20..2026-11-22', { now });
  assert.equal(daySpan.status, 'custom');
  assert.equal(daySpan.start, +new Date(2026, 10, 20, 0, 0, 0, 0));
  assert.equal(daySpan.end, +new Date(2026, 10, 23, 0, 0, 0, 0));
  assert.equal(daySpan.match({ billingTsMs: +new Date(2026, 10, 22, 23, 59, 59, 0) }), true);
  assert.equal(daySpan.match({ billingTsMs: +new Date(2026, 10, 23, 0, 0, 0, 0) }), false);

  const intraday = resolveDateRange('2026-11-24T09:30..2026-11-24T18:00', { now });
  assert.equal(intraday.status, 'custom');
  assert.equal(intraday.start, +new Date(2026, 10, 24, 9, 30, 0, 0));
  assert.equal(intraday.end, +new Date(2026, 10, 24, 18, 0, 0, 0));
  assert.equal(intraday.match({ billingTsMs: +new Date(2026, 10, 24, 12, 0, 0, 0) }), true);
  assert.equal(intraday.match({ billingTsMs: +new Date(2026, 10, 24, 18, 0, 0, 0) }), false);

  const fullDayExplicit = resolveDateRange('2026-11-24T00:00..2026-11-24T24:00', { now });
  assert.equal(fullDayExplicit.start, +new Date(2026, 10, 24, 0, 0, 0, 0));
  assert.equal(fullDayExplicit.end, +new Date(2026, 10, 25, 0, 0, 0, 0));

  const badRange = resolveDateRange('2026-02-31..2026-03-01', { now });
  assert.equal(badRange.start, now - 24 * 3600 * 1000);
});
