import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { createCodexAdapter, parseCodexRolloutContent, HAS_NATIVE_ZSTD } from '../src/adapters/codex.mjs';
import { createPricingResolver } from '../src/core/pricing.mjs';
import { createTelemetryStore } from '../src/core/telemetry-store.mjs';
import { resolvePaths } from '../src/core/paths.mjs';

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
        rate_limits: { limit_id: 'codex', primary: {used_percent:null} }
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

test('createCodexAdapter scans archived_sessions (.jsonl and .jsonl.zst), survives session archival, deduplicates moved files against usage-scan-cache, and lazily hydrates on cold restart', () => {
  const root = mkdtempSync(join(tmpdir(), 't3tools-codex-arch-'));
  let store;
  try {
    const t3Root = join(root, '.t3');
    const t3UserData = join(t3Root, 'userdata');
    const codexHome = join(root, '.codex');
    const sessionsDayDir = join(codexHome, 'sessions', '2026', '11', '25');
    const archivedDir = join(codexHome, 'archived_sessions');
    const customCodexHome = join(root, 'codex-work');
    const customArchivedDir = join(customCodexHome, 'archived_sessions');
    const pluginDataDir = join(root, '.t3tools');

    mkdirSync(t3UserData, { recursive: true });
    mkdirSync(sessionsDayDir, { recursive: true });
    mkdirSync(archivedDir, { recursive: true });
    mkdirSync(customArchivedDir, { recursive: true });

    const idActive = '11111111-2222-3333-4444-555555555501';
    const idArchived = '11111111-2222-3333-4444-555555555502';
    const idCustom = '11111111-2222-3333-4444-555555555503';

    const makeRollout = (id, model, respId, tsIso, inputTokens, usedPct = null) => [
      JSON.stringify({ timestamp: tsIso, type: 'session_meta', payload: { id } }),
      JSON.stringify({ timestamp: tsIso, type: 'turn_context', payload: { model } }),
      respId
        ? JSON.stringify({
            timestamp: tsIso,
            type: 'token_usage_record',
            payload: {
              thread_id: id,
              response_id: respId,
              usage: { input_tokens: inputTokens, cached_input_tokens: 1000, cache_write_input_tokens: 0, output_tokens: 200 },
              model_context_window: 475000
            }
          })
        : JSON.stringify({
            timestamp: tsIso,
            type: 'event_msg',
            payload: {
              type: 'token_count',
              info: {
                total_token_usage: { total_tokens: inputTokens + 200 },
                last_token_usage: { input_tokens: inputTokens, cached_input_tokens: 1000, cache_write_input_tokens: 0, output_tokens: 200 },
                model_context_window: 475000
              },
              ...(usedPct != null ? { rate_limits: { limit_id: 'codex', primary: { used_percent: usedPct, window_minutes: 10080, resets_at: 1796000000 } } } : {})
            }
          })
    ].join('\n');

    const activeFile = join(sessionsDayDir, `rollout-2026-11-25T10-00-00-${idActive}.jsonl`);
    writeFileSync(activeFile, makeRollout(idActive, 'gpt-6.2-astra', 'resp_active_1', '2026-11-25T02:00:00.000Z', 5000));

    // Legacy archived rollout (no response_id) + matching old path in usage-scan-cache-v17.json to verify no double-counting
    const archivedBase = `rollout-2026-11-25T12-00-00-${idArchived}.jsonl`;
    const archivedContent = makeRollout(idArchived, 'gpt-6.2-astra', '', '2026-11-25T04:00:00.000Z', 8000, 31);
    const archivedFile = join(archivedDir, HAS_NATIVE_ZSTD ? `${archivedBase}.zst` : archivedBase);
    writeFileSync(archivedFile, HAS_NATIVE_ZSTD ? zlib.zstdCompressSync(Buffer.from(archivedContent, 'utf8')) : archivedContent);

    // Custom instance homePath archived rollout
    const customFile = join(customArchivedDir, `rollout-2026-11-25T13-00-00-${idCustom}.jsonl`);
    writeFileSync(customFile, makeRollout(idCustom, 'gpt-6.2-sol', 'resp_custom_1', '2026-11-25T05:00:00.000Z', 6000));

    // Old pre-archive sessions path in T3 usage-scan-cache must NOT duplicate archived rollout
    writeFileSync(join(t3UserData, 'usage-scan-cache-v17.json'), JSON.stringify({
      models: ['gpt-6.2-astra'],
      sessions: [idArchived],
      files: {
        [join(sessionsDayDir, archivedBase)]: {
          p: 'codex',
          r: [[Date.parse('2026-11-25T04:00:00.000Z'), 0, 0, 7000, 1000, 0, 200, 0, '', null]]
        }
      }
    }));

    const paths = resolvePaths({ home: root, appData: root, t3Root, codexHome, pluginDataDir });
    store = createTelemetryStore(paths.telemetryDbPath);
    const pricing = createPricingResolver('');
    const t3State = {
      readThreadIndex: () => ({ nativeToThread: new Map() }),
      readProviderInstances: () => new Map([
        ['codex', { instanceId: 'codex', driver: 'codex', enabled: true, homePath: codexHome }],
        ['codex-work', { instanceId: 'codex-work', driver: 'codex', enabled: true, homePath: customCodexHome }]
      ])
    };

    const adapter = createCodexAdapter({ paths, store, pricing, t3State });
    adapter.syncAll();

    const rows1 = store.listAllRequests();
    assert.equal(rows1.length, 3, 'should ingest active + archived + custom homePath without duplicating usage-scan-cache');
    assert.equal(rows1.find(r => r.nativeSessionId === idCustom)?.accountId, 'codex-work');
    assert.equal(adapter.getRateLimitWindows('codex')[0]?.usedPercent, 31);

    // Simulate Codex archiving the active session (moving it from sessions/ to archived_sessions/)
    const movedFile = join(archivedDir, `rollout-2026-11-25T10-00-00-${idActive}.jsonl`);
    renameSync(activeFile, movedFile);
    adapter.syncAll();
    const rows2 = store.listAllRequests();
    assert.equal(rows2.length, 3, 'archiving a rollout must preserve its requests');

    // Simulate cold daemon restart with an already-populated SQLite store (fresh adapter instance)
    const coldAdapter = createCodexAdapter({ paths, store, pricing, t3State });
    coldAdapter.syncAll();
    assert.equal(store.listAllRequests().length, 3);
    assert.equal(coldAdapter.readLiveContext(idArchived)?.usedTokens, 8000);
    assert.equal(coldAdapter.getRateLimitWindows('codex')[0]?.usedPercent, 31);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
