import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decodeAntigravityGeneration, readAntigravityConversationDb } from '../src/adapters/antigravity.mjs';
import { ProtobufDecodeError } from '../src/core/protobuf.mjs';
import { antigravityInstanceHash } from '../src/core/paths.mjs';

function encodeVarint(val) {
  let n = BigInt(val);
  const out = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    out.push(b);
  } while (n > 0n);
  return Buffer.from(out);
}
function pbVarint(fn, val) {
  return Buffer.concat([encodeVarint((fn << 3) | 0), encodeVarint(val)]);
}
function pbBytes(fn, buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
  return Buffer.concat([encodeVarint((fn << 3) | 2), encodeVarint(b.length), b]);
}
function pbDuration(ms) {
  const sec = Math.floor(ms / 1000);
  const nanos = (ms % 1000) * 1e6;
  return Buffer.concat([pbVarint(1, sec), pbVarint(2, nanos)]);
}

test('antigravityInstanceHash matches T3 Code sha256 directory scheme', () => {
  assert.equal(
    antigravityInstanceHash('work'),
    createHash('sha256').update('work').digest('hex')
  );
  assert.equal(
    antigravityInstanceHash('antigravity'),
    'ac0a3dfd6dddb20962cecff6ee5fe65e19d3923be20e52c5ab52ff877f7e4c32'
  );
});

test('decodeAntigravityGeneration decodes usage, context, timings, and requestId', () => {
  const usage = Buffer.concat([
    pbVarint(2, 2500),
    pbVarint(3, 800),
    pbVarint(5, 17500),
    pbVarint(9, 300),
    pbVarint(10, 500)
  ]);
  const catGroup = Buffer.concat([pbBytes(1, 'System Prompt'), pbVarint(4, 5000)]);
  const breakdown = pbBytes(1, catGroup);
  const context = Buffer.concat([pbVarint(1, 19800), pbBytes(3, breakdown), pbVarint(4, 512000)]);
  const start = pbBytes(10, context);
  const reqIdEntry = Buffer.concat([pbBytes(1, 'request_id'), pbBytes(2, 'req_abc123')]);
  const chat = Buffer.concat([
    pbBytes(4, usage),
    pbBytes(9, start),
    pbBytes(11, pbDuration(1200)),
    pbBytes(12, pbDuration(3800)),
    pbVarint(14, 1),
    pbBytes(20, reqIdEntry),
    pbBytes(21, 'Gemini 4 Neon (High)')
  ]);
  const gen = Buffer.concat([
    pbBytes(1, chat),
    pbVarint(2, 5),
    pbBytes(4, 'exec_1')
  ]);

  const decoded = decodeAntigravityGeneration(gen);
  assert.equal(decoded.modelRaw, 'Gemini 4 Neon (High)');
  assert.equal(decoded.requestId, 'req_abc123');
  assert.equal(decoded.inputTokens, 2500);
  assert.equal(decoded.cacheReadTokens, 17500);
  assert.equal(decoded.providerInputTokens, 20000);
  assert.equal(decoded.outputTokens, 800);
  assert.equal(decoded.thinkingTokens, 300);
  assert.equal(decoded.ttftMs, 1200);
  assert.equal(decoded.streamingMs, 3800);
  assert.equal(decoded.retries, 1);
  assert.equal(decoded.context.maxTokens, 512000);
  assert.equal(decoded.context.categories[0].label, 'System Prompt');
  assert.deepEqual(decoded.stepIndices, [5]);
});

test('decodeAntigravityGeneration rejects truncated / malformed protobuf and uint64 10th-byte overflow', () => {
  // Unterminated varint (high bit set at end of buffer)
  assert.throws(() => decodeAntigravityGeneration(Buffer.from([0x08, 0x80])), ProtobufDecodeError);
  // Truncated length-delimited field claiming 50 bytes when only 2 exist
  assert.throws(() => decodeAntigravityGeneration(Buffer.from([0x0a, 50, 0x01, 0x02])), ProtobufDecodeError);
  // 10-byte varint with 10th byte = 0x02 (exceeds uint64 max)
  assert.throws(
    () => decodeAntigravityGeneration(Buffer.from([0x08, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x02])),
    ProtobufDecodeError
  );
});

test('readAntigravityConversationDb detects compaction checkpoints and counts malformed generations', () => {
  const dir = mkdtempSync(join(tmpdir(), 't3tools-agy-'));
  try {
    const dbPath = join(dir, 'conv1.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB);
    `);
    const ts = pbDuration(1795000000000);
    const stepMeta = pbBytes(1, ts);
    db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)').run(1, 1, stepMeta);
    db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)').run(2, 23, stepMeta);
    // Insert one corrupted blob
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(0, Buffer.from([0x0a, 80, 0x01]));
    db.close();

    const parsed = readAntigravityConversationDb(dbPath);
    assert.ok(parsed);
    assert.deepEqual(parsed.compactionStepIndices, [2]);
    assert.equal(parsed.stepTimes.get(1).createdMs, 1795000000000);
    assert.equal(parsed.malformedGenerations, 1);
    assert.equal(parsed.generations.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
