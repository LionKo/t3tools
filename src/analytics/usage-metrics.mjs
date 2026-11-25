/**
 * Usage status bar metrics computation (powered strictly by local T3Tools data).
 * Mirrors the 4-metric semantics of CodexUsageBar / Codex++:
 * 1. Speed (tok/s): token-weighted decode speed over up to 10 recent successful requests
 *    (outputTokens / post-TTFT decode time), falling back to weighted e2e/turn throughput.
 * 2. TTFT (s): output-token-weighted first-token latency over up to 10 recent successful requests.
 * 3. Cache hit (%): input-token-weighted cache read ratio over the latest turn.
 * 4. Context usage (%): current context tokens / model context window.
 */

export const USAGE_DECODE_SAMPLE_LIMIT = 10;
export const USAGE_FIRST_TOKEN_SAMPLE_LIMIT = 10;
export const USAGE_MIN_TIMING_WINDOW_MS = 50;
export const USAGE_MAX_PLAUSIBLE_TPS = 5000;
export const USAGE_MIN_THROUGHPUT_INTERVAL_MS = 500;
export const USAGE_MAX_THROUGHPUT_INTERVAL_MS = 120000;
export const USAGE_STALE_MS = 120000;

export function isPlausibleTimingSample(outputTokens, elapsedMs) {
  const out = Number(outputTokens) || 0;
  const ms = Number(elapsedMs);
  if (!(out > 0) || !Number.isFinite(ms) || ms < USAGE_MIN_TIMING_WINDOW_MS) return false;
  return out / (ms / 1000) <= USAGE_MAX_PLAUSIBLE_TPS;
}

function isSuccessfulRequest(req) {
  if (!req || typeof req !== 'object') return false;
  if (req.status != null) return req.status === 'success';
  return !req.error;
}

function resolveDecodeWindowMs(req) {
  const streamingMs = req?.streamingMs == null ? Number.NaN : Number(req.streamingMs);
  if (Number.isFinite(streamingMs) && streamingMs > 0) return streamingMs;
  const durationMs = req?.durationMs == null ? Number.NaN : Number(req.durationMs);
  const ttftMs = req?.ttftMs == null ? Number.NaN : Number(req.ttftMs);
  if (Number.isFinite(durationMs) && Number.isFinite(ttftMs) && ttftMs >= 0) {
    return durationMs - ttftMs;
  }
  return Number.NaN;
}

/**
 * Pure decode speed (decode_tps): output_tokens / post-TTFT streaming time,
 * token-weighted across up to 10 most recent valid successful requests.
 * Expects `recentRequests` ordered newest-first.
 */
export function computeDecodeSpeed(recentRequests = []) {
  if (!Array.isArray(recentRequests) || !recentRequests.length) return { value: null, samples: 0 };
  let tokens = 0;
  let seconds = 0;
  let samples = 0;
  for (const req of recentRequests) {
    if (samples >= USAGE_DECODE_SAMPLE_LIMIT) break;
    if (!isSuccessfulRequest(req)) continue;
    const out = Number(req.outputTokens) || 0;
    const decodeMs = resolveDecodeWindowMs(req);
    if (!isPlausibleTimingSample(out, decodeMs)) continue;
    tokens += out;
    seconds += decodeMs / 1000;
    samples += 1;
  }
  return {
    value: seconds > 0 ? Number((tokens / seconds).toFixed(1)) : null,
    samples
  };
}

/**
 * First-token latency (TTFT in ms): output-token-weighted average across up to 10
 * most recent successful requests with measured `ttftMs >= 0`.
 * Expects `recentRequests` ordered newest-first.
 */
export function computeWeightedTtftMs(recentRequests = []) {
  if (!Array.isArray(recentRequests) || !recentRequests.length) return { value: null, samples: 0 };
  let weightedMs = 0;
  let tokens = 0;
  let samples = 0;
  for (const req of recentRequests) {
    if (samples >= USAGE_FIRST_TOKEN_SAMPLE_LIMIT) break;
    if (!isSuccessfulRequest(req)) continue;
    const out = Number(req.outputTokens) || 0;
    const ttftMs = req?.ttftMs == null ? Number.NaN : Number(req.ttftMs);
    if (!(out > 0) || !Number.isFinite(ttftMs) || ttftMs < 0) continue;
    weightedMs += ttftMs * out;
    tokens += out;
    samples += 1;
  }
  return {
    value: tokens > 0 ? Math.round(weightedMs / tokens) : null,
    samples
  };
}

/**
 * Model-call throughput (call_tps): output_tokens / full model call duration (incl. TTFT, excl. tools).
 * Only computed from rows that carry measured call timing (ttftMs or streamingMs).
 * Expects `recentRequests` ordered newest-first.
 */
export function computeCallTps(recentRequests = []) {
  if (!Array.isArray(recentRequests) || !recentRequests.length) return { value: null, samples: 0 };
  let tokens = 0;
  let seconds = 0;
  let samples = 0;
  for (const req of recentRequests) {
    if (samples >= USAGE_DECODE_SAMPLE_LIMIT) break;
    if (!isSuccessfulRequest(req)) continue;
    const hasMeasuredCallTiming =
      (req.streamingMs != null && Number.isFinite(Number(req.streamingMs))) ||
      (req.ttftMs != null && Number.isFinite(Number(req.ttftMs)));
    if (!hasMeasuredCallTiming) continue;
    const out = Number(req.outputTokens) || 0;
    const durationMs = req.durationMs != null
      ? Number(req.durationMs)
      : ((Number(req.ttftMs) || 0) + (Number(req.streamingMs) || 0));
    if (!isPlausibleTimingSample(out, durationMs)) continue;
    tokens += out;
    seconds += durationMs / 1000;
    samples += 1;
  }
  return {
    value: seconds > 0 ? Number((tokens / seconds).toFixed(1)) : null,
    samples
  };
}

/**
 * Approximate turn / e2e output throughput (tok/s) for providers without TTFT/streamingMs
 * (e.g. Codex rollout logs). Excludes sub-500ms bursts, >120s idle pauses, and >5000 tok/s spikes.
 * Expects `recentRequests` ordered newest-first.
 */
export function computeOutputThroughput(recentRequests = []) {
  if (!Array.isArray(recentRequests) || !recentRequests.length) return { value: null, samples: 0 };
  let tokens = 0;
  let seconds = 0;
  let samples = 0;
  for (const req of recentRequests) {
    if (samples >= USAGE_DECODE_SAMPLE_LIMIT) break;
    if (!isSuccessfulRequest(req)) continue;
    const out = Number(req.outputTokens) || 0;
    const durationMs = req?.durationMs == null ? Number.NaN : Number(req.durationMs);
    if (!(out > 0) || !Number.isFinite(durationMs)) continue;
    if (durationMs < USAGE_MIN_THROUGHPUT_INTERVAL_MS || durationMs > USAGE_MAX_THROUGHPUT_INTERVAL_MS) continue;
    if (out / (durationMs / 1000) > USAGE_MAX_PLAUSIBLE_TPS) continue;
    tokens += out;
    seconds += durationMs / 1000;
    samples += 1;
  }
  return {
    value: seconds > 0 ? Number((tokens / seconds).toFixed(1)) : null,
    samples
  };
}

/**
 * Input-token-weighted cache hit ratio (%) over the latest turn.
 * Expects `chronologicalRequests` ordered oldest-first (or provide `newestFirst: true`).
 * Groups consecutive trailing requests sharing the same non-empty `turnKey` (`turnId` or `executionId`).
 */
export function computeTurnCacheHit(requests = [], { newestFirst = false } = {}) {
  if (!Array.isArray(requests) || !requests.length) return null;
  const ordered = newestFirst ? requests.slice().reverse() : requests;

  // Find latest request that actually has input tokens
  let end = ordered.length - 1;
  while (end >= 0) {
    const r = ordered[end];
    const totalIn = (Number(r?.inputTokens) || 0) + (Number(r?.cacheReadTokens) || 0) + (Number(r?.cacheWriteTokens) || 0);
    if (totalIn > 0) break;
    end -= 1;
  }
  if (end < 0) return null;

  const latestKey = String(ordered[end]?.turnId || ordered[end]?.executionId || '').trim();
  let start = end;
  if (latestKey) {
    while (start > 0) {
      const prevKey = String(ordered[start - 1]?.turnId || ordered[start - 1]?.executionId || '').trim();
      if (prevKey !== latestKey) break;
      start -= 1;
    }
  }

  let totalInput = 0;
  let totalCached = 0;
  for (let i = start; i <= end; i += 1) {
    const r = ordered[i];
    const uncached = Math.max(0, Number(r?.inputTokens) || 0);
    const cached = Math.max(0, Number(r?.cacheReadTokens) || 0);
    const write = Math.max(0, Number(r?.cacheWriteTokens) || 0);
    const rowIn = uncached + cached + write;
    if (rowIn > 0) {
      totalInput += rowIn;
      totalCached += Math.min(cached, rowIn);
    }
  }
  if (!(totalInput > 0)) return null;
  return Number(Math.min(100, Math.max(0, (totalCached / totalInput) * 100)).toFixed(1));
}

export function isUsageStale(lastRequestAtMs, now = Date.now(), liveStreaming = false) {
  if (liveStreaming) return false;
  if (!Number.isFinite(Number(lastRequestAtMs)) || Number(lastRequestAtMs) <= 0) return false;
  return Math.max(0, now - Number(lastRequestAtMs)) > USAGE_STALE_MS;
}

export function summarizeThreadUsageMetrics(recentRequestsNewestFirst = [], { now = Date.now(), lastRequestAtMs = null, liveStreaming = false } = {}) {
  const decode = computeDecodeSpeed(recentRequestsNewestFirst);
  const ttft = computeWeightedTtftMs(recentRequestsNewestFirst);
  const call = computeCallTps(recentRequestsNewestFirst);
  const throughput = computeOutputThroughput(recentRequestsNewestFirst);
  const latestTs = lastRequestAtMs ?? recentRequestsNewestFirst[0]?.timestampMs ?? null;

  return {
    decodeSpeed: decode.value,
    decodeSamples: decode.samples,
    ttftMs: ttft.value,
    ttftSamples: ttft.samples,
    callTps: call.value,
    outputThroughput: throughput.value,
    throughputSamples: throughput.samples,
    stale: isUsageStale(latestTs, now, liveStreaming)
  };
}
