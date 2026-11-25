import { existsSync, readFileSync, statSync } from 'node:fs';

/**
 * Fallback per-token USD rates for frontier / experimental models that may not
 * yet appear in LiteLLM's usage-model-rates.json.
 * Values are USD per 1 token (i.e. $/1M tokens * 1e-6).
 */
const FALLBACK_RATES = [
  { match: /claude[-_]?opus/i, input: 15e-6, output: 75e-6, cacheRead: 1.5e-6, cacheWrite: 18.75e-6 },
  { match: /claude[-_]?sonnet/i, input: 3e-6, output: 15e-6, cacheRead: 0.3e-6, cacheWrite: 3.75e-6 },
  { match: /claude[-_]?haiku/i, input: 0.8e-6, output: 4e-6, cacheRead: 0.08e-6, cacheWrite: 1e-6 },
  { match: /gemini[-_]?4[-_]?(neon|carbon|pro)|orchestrator/i, input: 2.5e-6, output: 15e-6, cacheRead: 0.25e-6, cacheWrite: 0 },
  { match: /gemini[-_]?4[-_]?(argon|hydrogen)/i, input: 1.25e-6, output: 10e-6, cacheRead: 0.125e-6, cacheWrite: 0 },
  { match: /gemini[-_]?[\d.]+[-_]?flash/i, input: 0.3e-6, output: 2.5e-6, cacheRead: 0.03e-6, cacheWrite: 0 },
  { match: /gemini[-_]?[\d.]+[-_]?pro/i, input: 1.25e-6, output: 10e-6, cacheRead: 0.125e-6, cacheWrite: 0 },
  { match: /gpt[-_]?6\.?\d*[-_]?astra/i, input: 5e-6, output: 20e-6, cacheRead: 0.5e-6, cacheWrite: 0 },
  { match: /gpt[-_]?6\.?\d*[-_]?sol|codex/i, input: 2.5e-6, output: 10e-6, cacheRead: 0.25e-6, cacheWrite: 0 },
  { match: /gpt[-_]?5|o3|o4/i, input: 2.5e-6, output: 10e-6, cacheRead: 0.25e-6, cacheWrite: 0 },
  { match: /gpt[-_]?4\.1|gpt[-_]?4o/i, input: 2.5e-6, output: 10e-6, cacheRead: 1.25e-6, cacheWrite: 0 }
];

/**
 * Normalize raw model strings from Antigravity, Codex, Claude, etc. into a
 * consistent canonical model ID + optional reasoning effort/depth.
 */
export function normalizeModelIdentity(rawLabel = '') {
  const raw = String(rawLabel || '').trim();
  if (!raw) return { id: 'unknown', displayName: 'Unknown', effort: '' };

  const strippedPrefix = raw.replace(/^group\//i, '').trim();
  const effortMatch = strippedPrefix.match(
    /\((low|medium|high|xhigh|extra\s+high|max|ultra|minimal|thinking)\)|[-_\s](low|medium|high|xhigh|extra\s+high|max|ultra|minimal)$/i
  );
  const effort = (effortMatch?.[1] || effortMatch?.[2] || '')
    .toLowerCase()
    .replace(/^extra\s+high$/, 'xhigh');

  const orch = strippedPrefix.match(/^orchestrator(?:\s*\(([^)]+)\)|\s+(.+))?$/i);
  if (orch) {
    const tail = (orch[1] || orch[2] || '')
      .replace(/\([^)]*\)/g, '')
      .replace(/\s+(low|medium|high|xhigh|extra\s+high|max|ultra|minimal|thinking)$/i, '')
      .trim()
      .toLowerCase();
    if (/claude/i.test(tail)) {
      const norm = tail.replace(/\s+/g, '-').replace(/(claude-(?:opus|sonnet|haiku)-\d+)\.(\d+)/, '$1-$2');
      return { id: `orchestrator-${norm}`, displayName: `Orchestrator (${tail})`, effort };
    }
    const g4 = tail.match(/(?:gemini[\s-]*4[\s-]*)?(neon|carbon|argon|hydrogen)$/);
    const variant = g4 ? g4[1] : tail.replace(/\s+/g, '-');
    const id = !variant || variant === 'carbon' ? 'gemini-pro-orchestrator' : `gemini-pro-orchestrator-${variant}`;
    return { id, displayName: `Orchestrator (${variant || 'carbon'})`, effort };
  }

  let id = strippedPrefix
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-(low|medium|high|xhigh|extra-high|max|ultra|minimal|thinking)$/, '');

  id = id.replace(/(claude-(?:opus|sonnet|haiku|fable)-\d+)\.(\d+)/, '$1-$2');
  const displayName = strippedPrefix.replace(/\s*\([^)]*\)\s*/g, ' ').trim() || id;
  return { id, displayName, effort };
}

export function createPricingResolver(modelRatesPath) {
  let cachedStamp = '';
  let rateIndex = new Map();

  function reloadIfNeeded() {
    if (!modelRatesPath || !existsSync(modelRatesPath)) return;
    let stamp = '';
    try {
      const s = statSync(modelRatesPath);
      stamp = `${s.mtimeMs}:${s.size}`;
    } catch {
      return;
    }
    if (stamp === cachedStamp) return;
    const next = new Map();
    try {
      const parsed = JSON.parse(readFileSync(modelRatesPath, 'utf8'));
      const doc = parsed?.document && typeof parsed.document === 'object' ? parsed.document : parsed;
      if (doc && typeof doc === 'object') {
        for (const [key, entry] of Object.entries(doc)) {
          if (!entry || typeof entry !== 'object') continue;
          const input = Number(entry.input_cost_per_token ?? NaN);
          const output = Number(entry.output_cost_per_token ?? NaN);
          if (!Number.isFinite(input) && !Number.isFinite(output)) continue;
          const normalizedKey = key.toLowerCase();
          const bareKey = normalizedKey.includes('/') ? normalizedKey.split('/').pop() : normalizedKey;
          const rate = {
            input: Number.isFinite(input) ? input : 0,
            output: Number.isFinite(output) ? output : 0,
            cacheRead: Number.isFinite(Number(entry.cache_read_input_token_cost ?? NaN))
              ? Number(entry.cache_read_input_token_cost)
              : (Number.isFinite(input) ? input * 0.1 : 0),
            cacheWrite: Number.isFinite(Number(entry.cache_creation_input_token_cost ?? NaN))
              ? Number(entry.cache_creation_input_token_cost)
              : (Number.isFinite(input) ? input * 1.25 : 0),
            maxInputTokens: Number.isFinite(Number(entry.max_input_tokens ?? NaN)) ? Number(entry.max_input_tokens) : null,
            source: 't3-rates'
          };
          next.set(normalizedKey, rate);
          if (!next.has(bareKey)) next.set(bareKey, rate);
        }
      }
      rateIndex = next;
      cachedStamp = stamp;
    } catch {
      // keep previous rateIndex
    }
  }

  function lookupRate(modelLabel) {
    reloadIfNeeded();
    const { id } = normalizeModelIdentity(modelLabel);
    const candidates = [
      String(modelLabel || '').toLowerCase().trim(),
      id,
      id.replace(/-/g, '.'),
      id.replace(/\./g, '-')
    ];
    for (const c of candidates) {
      if (c && rateIndex.has(c)) return rateIndex.get(c);
    }
    for (const fb of FALLBACK_RATES) {
      if (fb.match.test(id) || fb.match.test(String(modelLabel || ''))) {
        return { ...fb, maxInputTokens: null, source: 'fallback' };
      }
    }
    return null;
  }

  function estimateRequestCost(req) {
    if (Number.isFinite(req?.costUsd) && req.costUsd >= 0) {
      return { costUsd: req.costUsd, savedUsd: 0, rateSource: 'reported' };
    }
    const rate = lookupRate(req?.modelId || req?.model || '');
    if (!rate) return { costUsd: null, savedUsd: null, rateSource: 'none' };

    const input = Math.max(0, Number(req.inputTokens) || 0);
    const cacheRead = Math.max(0, Number(req.cacheReadTokens) || 0);
    const cacheWrite = Math.max(0, Number(req.cacheWriteTokens) || 0);
    const output = Math.max(0, Number(req.outputTokens) || 0);

    const costUsd = input * rate.input + cacheRead * rate.cacheRead + cacheWrite * rate.cacheWrite + output * rate.output;
    const savedUsd = cacheRead * Math.max(0, rate.input - rate.cacheRead);
    return {
      costUsd: Number(costUsd.toFixed(6)),
      savedUsd: Number(savedUsd.toFixed(6)),
      rateSource: rate.source
    };
  }

  return {
    lookupRate,
    estimateRequestCost
  };
}
