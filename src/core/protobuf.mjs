/**
 * Lightweight zero-dependency wire-format Protobuf decoder with strict truncation
 * and bounds validation so malformed blobs are rejected instead of becoming zeros.
 */

export class ProtobufDecodeError extends Error {
  constructor(message, offset = 0) {
    super(`${message} (offset ${offset})`);
    this.name = 'ProtobufDecodeError';
    this.offset = offset;
  }
}

export function readVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const rawByte = buf[pos++];
    const byte = BigInt(rawByte);
    // On the 10th byte (shift === 63), only bit 0 is valid for uint64 and continuation bit must be 0
    if (shift === 63n && (rawByte > 1)) {
      throw new ProtobufDecodeError('Varint uint64 overflow', offset);
    }
    result |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) {
      return [Number(result), pos];
    }
    shift += 7n;
    if (shift > 63n) {
      throw new ProtobufDecodeError('Varint overflow (> 10 bytes)', offset);
    }
  }
  throw new ProtobufDecodeError('Unterminated varint', offset);
}

export function decodeFields(raw) {
  const map = new Map();
  if (!raw || raw.length === 0) return map;
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  let pos = 0;

  while (pos < buf.length) {
    const fieldStart = pos;
    const [tag, nextPos] = readVarint(buf, pos);
    pos = nextPos;
    const fieldNumber = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNumber === 0) {
      throw new ProtobufDecodeError('Invalid field number 0', fieldStart);
    }

    let value;
    if (wireType === 0) {
      [value, pos] = readVarint(buf, pos);
    } else if (wireType === 1) {
      if (pos + 8 > buf.length) {
        throw new ProtobufDecodeError('Truncated 64-bit fixed field', fieldStart);
      }
      value = buf.subarray(pos, pos + 8);
      pos += 8;
    } else if (wireType === 2) {
      const [len, start] = readVarint(buf, pos);
      if (len < 0 || start + len > buf.length) {
        throw new ProtobufDecodeError(`Truncated length-delimited field (need ${len} bytes)`, fieldStart);
      }
      value = buf.subarray(start, start + len);
      pos = start + len;
    } else if (wireType === 5) {
      if (pos + 4 > buf.length) {
        throw new ProtobufDecodeError('Truncated 32-bit fixed field', fieldStart);
      }
      value = buf.subarray(pos, pos + 4);
      pos += 4;
    } else {
      throw new ProtobufDecodeError(`Unsupported wire type ${wireType}`, fieldStart);
    }

    let list = map.get(fieldNumber);
    if (!list) {
      list = [];
      map.set(fieldNumber, list);
    }
    list.push(value);
  }
  return map;
}

export function firstField(fieldMap, fieldNumber, fallback = undefined) {
  const list = fieldMap?.get?.(fieldNumber);
  return list && list.length > 0 ? list[0] : fallback;
}

export function nestedFields(fieldMap, fieldNumber) {
  const value = firstField(fieldMap, fieldNumber);
  return Buffer.isBuffer(value) ? decodeFields(value) : new Map();
}

export function stringField(fieldMap, fieldNumber, fallback = '') {
  const value = firstField(fieldMap, fieldNumber);
  return Buffer.isBuffer(value) ? value.toString('utf8') : fallback;
}

/**
 * Decode google.protobuf.Timestamp or google.protobuf.Duration -> milliseconds.
 */
export function durationOrTimestampMs(raw) {
  if (!Buffer.isBuffer(raw) || raw.length === 0) return null;
  const f = decodeFields(raw);
  const seconds = firstField(f, 1, 0);
  const nanos = firstField(f, 2, 0);
  if (!Number.isFinite(seconds) && !Number.isFinite(nanos)) return null;
  const ms = Math.trunc(seconds) * 1000 + Math.floor((Number(nanos) || 0) / 1e6);
  return Number.isFinite(ms) ? ms : null;
}

export function decodePackedVarints(values = []) {
  const out = [];
  for (const item of values) {
    if (typeof item === 'number') {
      out.push(item);
      continue;
    }
    if (!Buffer.isBuffer(item)) continue;
    let pos = 0;
    while (pos < item.length) {
      const [val, next] = readVarint(item, pos);
      out.push(val);
      pos = next;
    }
  }
  return out;
}
