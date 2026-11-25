import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDecodeSpeed,
  computeWeightedTtftMs,
  computeCallTps,
  computeOutputThroughput,
  computeTurnCacheHit,
  isUsageStale,
  summarizeThreadUsageMetrics
} from '../src/analytics/usage-metrics.mjs';

test('computeDecodeSpeed and computeWeightedTtftMs compute token-weighted averages over up to 10 recent successful requests', () => {
  // Newest-first requests: (100 out, 2000ms decode, 1000ms ttft) + (900 out, 3000ms decode, 1000ms ttft)
  // Total decode: 1000 tokens / 5s = 200 tok/s; weighted TTFT = 1000ms
  const recent = [
    { status: 'success', outputTokens: 100, streamingMs: 2000, ttftMs: 1000, durationMs: 3000 },
    { status: 'success', outputTokens: 900, streamingMs: 3000, ttftMs: 1000, durationMs: 4000 },
    { status: 'error', outputTokens: 500, streamingMs: 500, ttftMs: 500, durationMs: 1000 }
  ];
  assert.equal(computeDecodeSpeed(recent).value, 200);
  assert.equal(computeDecodeSpeed(recent).samples, 2);
  assert.equal(computeWeightedTtftMs(recent).value, 1000);
  assert.equal(computeWeightedTtftMs(recent).samples, 2);
  // Call TPS: 1000 tokens / 7s = 142.9 tok/s
  assert.equal(computeCallTps(recent).value, 142.9);
});

test('timing filters exclude sub-50ms windows, >5000 tok/s anomalies, and never invent decode speed without TTFT/streamingMs', () => {
  const anomalousDecode = [
    { status: 'success', outputTokens: 100, streamingMs: null, ttftMs: null, durationMs: 3000 }, // no decode timing
    { status: 'success', outputTokens: 500, streamingMs: 20, ttftMs: 800, durationMs: 820 }, // < 50ms decode window
    { status: 'success', outputTokens: 6000, streamingMs: 1000, ttftMs: 500, durationMs: 1500 }, // > 5000 tok/s decode
    { status: 'error', outputTokens: 200, streamingMs: 1000, ttftMs: 500, durationMs: 1500 }
  ];
  assert.equal(computeDecodeSpeed(anomalousDecode).value, null);
  // Missing TTFT on first row leaves only valid rows with ttftMs (500*800 + 6000*500) / 6500 = 523ms
  assert.equal(computeWeightedTtftMs(anomalousDecode).value, 523);

  const throughputRows = [
    { status: 'success', outputTokens: 100, durationMs: 3000 }, // valid: 100 / 3s = 33.3 tok/s
    { status: 'success', outputTokens: 200, durationMs: 200 }, // excluded: < 500ms
    { status: 'success', outputTokens: 300, durationMs: 150000 }, // excluded: > 120s
    { status: 'success', outputTokens: 10000, durationMs: 1000 }, // excluded: > 5000 tok/s
    { status: 'error', outputTokens: 500, durationMs: 2000 } // excluded: error
  ];
  assert.equal(computeOutputThroughput(throughputRows).value, 33.3);
  assert.equal(computeOutputThroughput(throughputRows).samples, 1);
});

test('computeTurnCacheHit aggregates only the latest turn weighted by total input tokens', () => {
  const chronological = [
    { turnId: 't1', inputTokens: 9000, cacheReadTokens: 1000, cacheWriteTokens: 0 }, // 10% old turn
    { turnId: 't2', inputTokens: 2000, cacheReadTokens: 8000, cacheWriteTokens: 0 }, // 80%
    { turnId: 't2', inputTokens: 1000, cacheReadTokens: 9000, cacheWriteTokens: 0 }  // 90% -> combined 17000/20000 = 85%
  ];
  assert.equal(computeTurnCacheHit(chronological), 85);
  assert.equal(computeTurnCacheHit(chronological.slice().reverse(), { newestFirst: true }), 85);
});

test('isUsageStale dims speed after 120s idle but never during live streaming', () => {
  const now = 1_000_000;
  assert.equal(isUsageStale(now - 30_000, now, false), false);
  assert.equal(isUsageStale(now - 125_000, now, false), true);
  assert.equal(isUsageStale(now - 125_000, now, true), false);

  const summary = summarizeThreadUsageMetrics(
    [{ status: 'success', outputTokens: 250, streamingMs: 2500, ttftMs: 1200, durationMs: 3700, timestampMs: now - 150_000 }],
    { now }
  );
  assert.equal(summary.decodeSpeed, 100);
  assert.equal(summary.ttftMs, 1200);
  assert.equal(summary.stale, true);
});
