import { randomBytes } from 'node:crypto';

let lastMs = 0;
let seq = 0;

/**
 * UUIDv7 (RFC 9562): 48-bit unix-ms timestamp + random bits. Time-ordered for
 * index locality. A 12-bit counter keeps IDs generated in the same
 * millisecond monotonic within this process.
 */
export function uuidv7(now: number = Date.now()): string {
  if (now <= lastMs) {
    now = lastMs;
    seq = (seq + 1) & 0xfff;
    if (seq === 0) now = ++lastMs; // counter overflow: borrow the next ms
  } else {
    seq = randomBytes(2).readUInt16BE() & 0x1ff; // leave headroom for increments
  }
  lastMs = now;

  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = 0x70 | (seq >> 8);
  b[7] = seq & 0xff;
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 10
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
