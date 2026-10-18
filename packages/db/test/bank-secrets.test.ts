import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MIN_BLOB_LEN, SecretError, decryptSecret, encryptSecret, loadKeyring, needsRotation, parseKeyring,
} from '../src/bank/secrets.js';

const k = () => randomBytes(32).toString('base64');
const URL_SECRET = 'https://user:s3cret@bridge.example.test/simplefin';

describe('encryptSecret / decryptSecret', () => {
  const ring = parseKeyring(`1:${k()}`);

  it('round-trips, including unicode and empty strings', () => {
    for (const p of [URL_SECRET, '', 'päss—wörd 🔐']) {
      const e = encryptSecret(p, ring, 'ctx');
      expect(decryptSecret(e.data, e.keyId, ring, 'ctx')).toBe(p);
    }
  });

  it('never contains the plaintext and uses a fresh random IV each time', () => {
    const a = encryptSecret(URL_SECRET, ring);
    const b = encryptSecret(URL_SECRET, ring);
    expect(a.data.includes(Buffer.from('s3cret'))).toBe(false);
    expect(a.data.equals(b.data)).toBe(false);
    expect(a.data.subarray(1, 13).equals(b.data.subarray(1, 13))).toBe(false); // IVs differ
    expect(a.data.length).toBe(MIN_BLOB_LEN + Buffer.byteLength(URL_SECRET));
  });

  it('detects tampering in every region of the blob', () => {
    const e = encryptSecret(URL_SECRET, ring, 'ctx');
    for (const i of [0, 1, 12, 13, 28, 29, e.data.length - 1]) {
      const bad = Buffer.from(e.data);
      bad[i] = bad[i]! ^ 0x01;
      expect(() => decryptSecret(bad, e.keyId, ring, 'ctx'), `byte ${i}`).toThrow(SecretError);
    }
    expect(() => decryptSecret(e.data.subarray(0, e.data.length - 1), e.keyId, ring, 'ctx')).toThrow(SecretError);
    expect(() => decryptSecret(Buffer.alloc(3), e.keyId, ring, 'ctx')).toThrow(SecretError);
  });

  it('rejects a wrong AAD (ciphertext moved to another row) and a wrong key', () => {
    const e = encryptSecret(URL_SECRET, ring, 'biz:A:conn:1');
    expect(() => decryptSecret(e.data, e.keyId, ring, 'biz:A:conn:2')).toThrow(SecretError);
    expect(() => decryptSecret(e.data, e.keyId, ring)).toThrow(SecretError);
    const other = parseKeyring(`1:${k()}`);
    expect(() => decryptSecret(e.data, '1', other, 'biz:A:conn:1')).toThrow(SecretError);
  });

  it('error messages never include plaintext or key material', () => {
    const key = k();
    const r = parseKeyring(key);
    const e = encryptSecret(URL_SECRET, r, 'a');
    try { decryptSecret(e.data, e.keyId, r, 'b'); } catch (err) {
      expect(String((err as Error).message)).not.toContain('s3cret');
      expect(String((err as Error).message)).not.toContain(key);
    }
  });
});

describe('key versioning and rotation', () => {
  it('encrypts with the first key, decrypts old rows with their stored key id', () => {
    const oldKey = k(); const newKey = k();
    const before = parseKeyring(`1:${oldKey}`);
    const old = encryptSecret(URL_SECRET, before, 'ctx');
    const after = parseKeyring(`2:${newKey},1:${oldKey}`);
    expect(after.currentId).toBe('2');
    expect(encryptSecret('x', after).keyId).toBe('2');
    expect(decryptSecret(old.data, old.keyId, after, 'ctx')).toBe(URL_SECRET);
    expect(needsRotation(old.keyId, after)).toBe(true);
    expect(needsRotation('2', after)).toBe(false);
    // Dropping the old key makes old rows undecryptable, loudly.
    expect(() => decryptSecret(old.data, old.keyId, parseKeyring(`2:${newKey}`), 'ctx')).toThrow(/no key with id/);
  });
});

describe('keyring parsing', () => {
  it('accepts bare base64 (id 1) and 64-char hex', () => {
    expect(parseKeyring(k()).currentId).toBe('1');
    expect(parseKeyring(randomBytes(32).toString('hex')).keys.size).toBe(1);
  });

  it.each([
    ['undefined', undefined],
    ['empty', '  '],
    ['short key', randomBytes(16).toString('base64')],
    ['garbage', 'not-a-key'],
    ['bad id', `bad id!:${k()}`],
    ['duplicate id', `1:${k()},1:${k()}`],
    ['trailing comma', `1:${k()},`],
  ])('rejects %s', (_n, spec) => {
    expect(() => parseKeyring(spec)).toThrow(SecretError);
  });

  it('loadKeyring reads RIFFLE_SECRET_KEY and fails closed when unset', () => {
    expect(() => loadKeyring({})).toThrow(/not set/);
    expect(loadKeyring({ RIFFLE_SECRET_KEY: k() }).keys.size).toBe(1);
  });
});
