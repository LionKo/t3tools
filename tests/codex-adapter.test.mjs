import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { parseCodexRolloutContent, HAS_NATIVE_ZSTD } from '../src/adapters/codex.mjs';
import { createPricingResolver } from '../src/core/pricing.mjs';

test('parseCodexRolloutContent parses token_usage_record ledger, prefers native id over shared session_id, and avoids cache_write double billing', () => {
  const pricing = createPricingResolver('');
  const lines = [
    // Forked thread: distinct `id` vs shared parent `session_id`
    JSON.stringify({ timestamp: '2026-11-24T10:00:00.000Z', type: 'session_meta', payload: { id: 'fork-child-id', session_id: 'shared-parent-id' } }),
    JSON.stringify({ timestamp: '2026-11-24T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-6.2-astra', reasoning_effort: 'xhigh' } }),
    // Ledger record with input_tokens=10000 including cached=5000 and cache_write=2000 -> uncached must be 3000 (not 5000!)
    JSON.stringify({
      timestamp: '2026-11-24T10:00:05.000Z',
      type: 'token_usage_record',
      payload: {
        thread_id: 'fork-child-id',
        response_id: 'resp_001',
        usage: { input_tokens: 10000, cached_input_tokens: 5000, cache_write_input_tokens: 2000, output_tokens: 400, reasoning_output_tokens: 150 },
        model_context_window: 475000
      }
    }),
    // Duplicate response_id must be ignored
    JSON.stringify({
      timestamp: '2026-11-24T10:00:05.500Z',
      type: 'token_usage_record',
      payload: {
        thread_id: 'fork-child-id',
        response_id: 'resp_001',
        usage: { input_tokens: 10000, cached_input_tokens: 5000, cache_write_input_tokens: 2000, output_tokens: 400, reasoning_output_tokens: 150 }
      }
    }),
    // Paired legacy token_count event in same rollout should NOT double-count when ledger records exist,
    // AND valid rate_limits followed by empty rate_limits must preserve the valid window
    JSON.stringify({
      timestamp: '2026-11-24T10:00:06.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { total_tokens: 10400 },
          last_token_usage: { input_tokens: 10000, cached_input_tokens: 5000, cache_write_input_tokens: 2000, output_tokens: 400 },
          model_context_window: 475000
        },
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 24.5, window_minutes: 10080, resets_at: 1796000000 }
        }
      }
    }),
    JSON.stringify({
      timestamp: '2026-11-24T10:00:07.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: null,
        rate_limits: { limit_id: 'codex', primary: null }
      }
    })
  ].join('\n');

  const parsed = parseCodexRolloutContent(lines, { pricing });
  assert.equal(parsed.nativeThreadId, 'fork-child-id');
  assert.equal(parsed.requests.length, 1);

  const [r1] = parsed.requests;
  assert.equal(r1.nativeSessionId, 'fork-child-id');
  assert.equal(r1.inputTokens, 3000);
  assert.equal(r1.cacheReadTokens, 5000);
  assert.equal(r1.cacheWriteTokens, 2000);
  assert.equal(r1.inputTokens + r1.cacheReadTokens + r1.cacheWriteTokens, 10000);
  assert.equal(r1.billingTsMs, r1.timestampMs);
  assert.equal(r1.tpsKind, 'e2e-estimate');

  // Empty rate_limits payload did NOT wipe the valid primary window
  assert.equal(parsed.rateLimitWindows.length, 1);
  assert.equal(parsed.rateLimitWindows[0].usedPercent, 24.5);
});

test('parseCodexRolloutContent handles legacy-only token_count + compaction + zstd roundtrip', { skip: !HAS_NATIVE_ZSTD }, () => {
  const pricing = createPricingResolver('');
  const lines = [
    JSON.stringify({ timestamp: '2026-11-24T10:00:00.000Z', type: 'session_meta', payload: { id: 'sess-legacy-1' } }),
    JSON.stringify({ timestamp: '2026-11-24T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }),
    JSON.stringify({
      timestamp: '2026-11-24T10:00:05.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { total_tokens: 20500 },
          last_token_usage: { input_tokens: 20000, cached_input_tokens: 15000, cache_write_input_tokens: 0, output_tokens: 500 },
          model_context_window: 475000
        }
      }
    }),
    JSON.stringify({ timestamp: '2026-11-24T10:00:20.000Z', type: 'compacted', payload: {} }),
    JSON.stringify({
      timestamp: '2026-11-24T10:00:25.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { total_tokens: 29000 },
          last_token_usage: { input_tokens: 8000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 500 },
          model_context_window: 475000
        }
      }
    })
  ].join('\n');

  const roundtripped = zlib.zstdDecompressSync(zlib.zstdCompressSync(Buffer.from(lines, 'utf8'))).toString('utf8');
  const parsed = parseCodexRolloutContent(roundtripped, { pricing });
  assert.equal(parsed.requests.length, 2);
  assert.equal(parsed.requests[1].compactionBefore, true);
});

test('parseCodexRolloutContent keeps legacy-only row in mixed rollout, honors parent thread_id on forks, and correlates Reconnecting 1/5 retry', () => {
  const pricing = createPricingResolver('');
  const lines = [
    JSON.stringify({ timestamp: '2026-11-24T10:00:00.000Z', type: 'session_meta', payload: { id: 'child-thread', session_id: 'parent-thread' } }),
    JSON.stringify({ timestamp: '2026-11-24T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-6.2-astra' } }),
    // Legacy-only request (no matching ledger entry)
    JSON.stringify({
      timestamp: '2026-11-24T10:00:05.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { total_tokens: 5200 },
          last_token_usage: { input_tokens: 5000, cached_input_tokens: 1000, cache_write_input_tokens: 0, output_tokens: 200 },
          model_context_window: 475000
        }
      }
    }),
    // Reconnecting retry event followed by inherited parent ledger record
    JSON.stringify({ timestamp: '2026-11-24T10:00:10.000Z', type: 'event_msg', payload: { type: 'error', message: 'Reconnecting... 1/5' } }),
    JSON.stringify({
      timestamp: '2026-11-24T10:00:15.000Z',
      type: 'token_usage_record',
      payload: {
        thread_id: 'parent-thread',
        response_id: 'resp_parent_1',
        usage: { input_tokens: 9000, cached_input_tokens: 4000, cache_write_input_tokens: 0, output_tokens: 300 }
      }
    }),
    // Paired legacy token_count for the same response must NOT double-count or steal retry/timing
    JSON.stringify({
      timestamp: '2026-11-24T10:00:15.200Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { total_tokens: 14500 },
          last_token_usage: { input_tokens: 9000, cached_input_tokens: 4000, cache_write_input_tokens: 0, output_tokens: 300 }
        }
      }
    })
  ].join('\n');

  const parsed = parseCodexRolloutContent(lines, { pricing });
  assert.equal(parsed.requests.length, 2);
  assert.equal(parsed.requests[0].inputTokens, 4000);
  // Inherited ledger row keeps parent-thread ID and gets the correlated retry=1
  assert.equal(parsed.requests[1].id, 'codex:parent-thread:resp_parent_1');
  assert.equal(parsed.requests[1].retries, 1);
});

test('parseCodexRolloutContent does not merge distinct turns/models/cache_writes and propagates raised context window', () => {
  const pricing = createPricingResolver('');
  const lines = [
    JSON.stringify({ timestamp: '2026-11-24T10:00:00.000Z', type: 'session_meta', payload: { id: 'sess-pair-check' } }),
    JSON.stringify({ timestamp: '2026-11-24T10:00:01.000Z', type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-6.2-sol' } }),
    JSON.stringify({
      timestamp: '2026-11-24T10:00:02.000Z',
      type: 'token_usage_record',
      payload: { thread_id: 'sess-pair-check', turn_id: 't1', response_id: 'r_sol', usage: { input_tokens: 5000, cached_input_tokens: 1000, cache_write_input_tokens: 0, output_tokens: 200 }, model_context_window: 20000 }
    }),
    // Paired notification raises context window from 20000 -> 80000
    JSON.stringify({
      timestamp: '2026-11-24T10:00:02.100Z',
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 5200 }, last_token_usage: { input_tokens: 5000, cached_input_tokens: 1000, cache_write_input_tokens: 0, output_tokens: 200 }, model_context_window: 80000 } }
    }),
    // Different turn + different model within 10s with same 3 token counts MUST NOT be dropped as duplicate!
    JSON.stringify({ timestamp: '2026-11-24T10:00:04.000Z', type: 'turn_context', payload: { turn_id: 't2', model: 'gpt-6.2-astra' } }),
    JSON.stringify({
      timestamp: '2026-11-24T10:00:05.000Z',
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 10400 }, last_token_usage: { input_tokens: 5000, cached_input_tokens: 1000, cache_write_input_tokens: 500, output_tokens: 200 }, model_context_window: 80000 } }
    })
  ].join('\n');

  const parsed = parseCodexRolloutContent(lines, { pricing });
  assert.equal(parsed.requests.length, 2);
  assert.equal(parsed.requests[0].contextMaxTokens, 80000);
  assert.equal(parsed.latestContext.maxTokens, 80000);
  assert.equal(parsed.requests[1].modelId, 'gpt-6.2-astra');
});
