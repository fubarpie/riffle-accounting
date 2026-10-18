/**
 * Application-level encryption for secrets at rest (bank access URLs).
 *
 * AES-256-GCM, a fresh random 96-bit IV per message, and caller-supplied
 * associated data (AAD) so a ciphertext copied to another row or business
 * fails authentication. Keys are versioned so they can be rotated without
 * downtime: new writes use the first key listed, old rows still decrypt with
 * the key id stored next to them.
 *
 * RIFFLE_SECRET_KEY format: one or more comma-separated entries, first is the
 * current key. An entry is `<id>:<key>` or a bare `<key>` (id "1"). `<key>` is
 * 32 bytes as base64 or 64 hex characters. Example for rotation:
 *   RIFFLE_SECRET_KEY="2:<new key>,1:<old key>"
 * Generate one with: `openssl rand -base64 32`.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const FORMAT_V1 = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const KEY_ID = /^[A-Za-z0-9_-]{1,16}$/;
/** Smallest possible blob: format + IV + tag (empty plaintext). */
export const MIN_BLOB_LEN = 1 + IV_LEN + TAG_LEN;

/** Never carries key material or plaintext in its message. */
export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretError';
  }
}

export interface Keyring {
  /** Id used for new encryptions. */
  readonly currentId: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

export interface EncryptedSecret {
  keyId: string;
  /** format byte | IV | auth tag | ciphertext */
  data: Buffer;
}

function decodeKey(raw: string): Buffer {
  const s = raw.trim();
  let key: Buffer | undefined;
  if (/^[0-9a-fA-F]{64}$/.test(s)) key = Buffer.from(s, 'hex');
  else if (/^[A-Za-z0-9+/]{43}=$/.test(s)) key = Buffer.from(s, 'base64');
  if (!key || key.length !== KEY_LEN) {
    throw new SecretError('RIFFLE_SECRET_KEY: each key must be 32 bytes (base64 or 64 hex characters)');
  }
  return key;
}

/** Parse the RIFFLE_SECRET_KEY value. Throws SecretError on anything malformed. */
export function parseKeyring(spec: string | undefined): Keyring {
  if (!spec || spec.trim() === '') throw new SecretError('RIFFLE_SECRET_KEY is not set');
  const keys = new Map<string, Buffer>();
  let currentId: string | undefined;
  for (const part of spec.split(',')) {
    const entry = part.trim();
    if (entry === '') throw new SecretError('RIFFLE_SECRET_KEY: empty entry');
    const colon = entry.indexOf(':');
    const id = colon === -1 ? '1' : entry.slice(0, colon);
    const keyText = colon === -1 ? entry : entry.slice(colon + 1);
    if (!KEY_ID.test(id)) throw new SecretError('RIFFLE_SECRET_KEY: invalid key id');
    if (keys.has(id)) throw new SecretError('RIFFLE_SECRET_KEY: duplicate key id');
    keys.set(id, decodeKey(keyText));
    currentId ??= id;
  }
  return { currentId: currentId!, keys };
}

/** Load the keyring from the environment (default: process.env). */
export function loadKeyring(env: Record<string, string | undefined> = process.env): Keyring {
  return parseKeyring(env.RIFFLE_SECRET_KEY);
}

function aadBuffer(aad: string | undefined): Buffer {
  return Buffer.from(aad ?? '', 'utf8');
}

/** Encrypt with the current key. `aad` must be presented again to decrypt. */
export function encryptSecret(plaintext: string, keyring: Keyring, aad?: string): EncryptedSecret {
  const key = keyring.keys.get(keyring.currentId);
  if (!key) throw new SecretError('current key missing from keyring');
  const iv = randomBytes(IV_LEN); // random IV: GCM must never reuse (key, IV)
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  cipher.setAAD(aadBuffer(aad));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { keyId: keyring.currentId, data: Buffer.concat([Buffer.from([FORMAT_V1]), iv, tag, ct]) };
}

/**
 * Decrypt a blob produced by `encryptSecret`. Any tampering (ciphertext, tag,
 * IV, AAD, wrong key) yields the same opaque SecretError.
 */
export function decryptSecret(blob: Buffer, keyId: string, keyring: Keyring, aad?: string): string {
  const key = keyring.keys.get(keyId);
  if (!key) throw new SecretError(`no key with id "${keyId}" in RIFFLE_SECRET_KEY`);
  if (blob.length < MIN_BLOB_LEN || blob[0] !== FORMAT_V1) throw new SecretError('unrecognised secret format');
  const iv = blob.subarray(1, 1 + IV_LEN);
  const tag = blob.subarray(1 + IV_LEN, MIN_BLOB_LEN);
  const ct = blob.subarray(MIN_BLOB_LEN);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
    decipher.setAAD(aadBuffer(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretError('secret failed authentication (tampered, wrong key or wrong context)');
  }
}

/** True when the blob's key id is not the current one (candidate for re-encryption). */
export function needsRotation(keyId: string, keyring: Keyring): boolean {
  return keyId !== keyring.currentId;
}
