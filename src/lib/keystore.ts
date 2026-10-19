// mn's keystore: every secret mn keeps (a wallet's seed and mnemonic, an
// account's owner key) sealed under the user's one passphrase. Each secret is
// sealed on its own, with its own salt and IV, so files stay independent:
//   key = scrypt(passphrase, salt), 32 bytes
//   AES-256-GCM(key, iv) over the secret, with the purpose bound in as
//   associated data, so a block sealed for one purpose never opens as another.
// A wrong passphrase and a changed byte fail the same way: GCM's tag does not
// verify, and nothing is opened.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/** What a sealed secret is for: a wallet's seed and mnemonic, an account's owner key, or the keystore's check of the one passphrase. */
export type SecretPurpose = 'wallet' | 'owner-key' | 'keystore-check';

/** A secret as mn writes it: the cipher text and everything needed to open it but the passphrase. */
export interface SealedSecret {
  v: 1;
  kdf: 'scrypt';
  n: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

const VERSION = 1;
const KDF = 'scrypt';
// scrypt's cost as mn writes it: 2^17 x 8 x 128 bytes = 128 MiB, about half a
// second, the cost OWASP sets as its floor for scrypt.
const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
// What mn accepts from a file: never weaker than 2^14 (scrypt's interactive
// floor), never costlier than 2^20 (1 GiB), so a planted file cannot tie up
// the machine before any passphrase is checked.
const MIN_N = 2 ** 14;
const MAX_N = 2 ** 20;
const MAX_R = 16;
const MAX_P = 4;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const CIPHER = 'aes-256-gcm';
const HEX = /^(?:[0-9a-f]{2})+$/;

/** The passphrase is wrong, or the sealed secret was changed: the two are indistinguishable by design. */
export class WrongPassphraseError extends Error {
  readonly code = 'WRONG_PASSPHRASE';

  constructor(message = 'Wrong passphrase, or the sealed secret has been changed.') {
    super(message);
    this.name = 'WrongPassphraseError';
    Object.setPrototypeOf(this, WrongPassphraseError.prototype);
  }
}

/** Not a sealed secret this mn can open. */
export class MalformedSecretError extends Error {
  constructor(reason: string) {
    super(`Not a sealed secret mn can open: ${reason}.`);
    this.name = 'MalformedSecretError';
    Object.setPrototypeOf(this, MalformedSecretError.prototype);
  }
}

const associatedData = (purpose: SecretPurpose): Buffer => Buffer.from(`mn-keystore:v${VERSION}:${purpose}`, 'utf8');

// scrypt needs 128 x N x r bytes; Node refuses above 32 MiB unless told.
const deriveKey = (passphrase: string, salt: Buffer, n: number, r: number, p: number): Buffer =>
  scryptSync(passphrase.normalize('NFKC'), salt, KEY_BYTES, { N: n, r, p, maxmem: 256 * n * r });

const assertPassphrase = (passphrase: string): void => {
  if (passphrase.length === 0) throw new WrongPassphraseError('The passphrase is empty.');
};

/** Seals `secret` under `passphrase`, for `purpose`. */
export function sealSecret(secret: Uint8Array, passphrase: string, purpose: SecretPurpose): SealedSecret {
  assertPassphrase(passphrase);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = deriveKey(passphrase, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  try {
    const cipher = createCipheriv(CIPHER, key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(associatedData(purpose));
    const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
    return {
      v: VERSION,
      kdf: KDF,
      n: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      salt: salt.toString('hex'),
      iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
      ciphertext: ciphertext.toString('hex'),
    };
  } finally {
    key.fill(0);
  }
}

const hexField = (value: unknown, name: string, bytes?: number): Buffer => {
  if (typeof value !== 'string' || !HEX.test(value)) throw new MalformedSecretError(`its ${name} is not hex`);
  const decoded = Buffer.from(value, 'hex');
  if (bytes !== undefined && decoded.length !== bytes) throw new MalformedSecretError(`its ${name} is not ${bytes} bytes`);
  return decoded;
};

const costField = (value: unknown, name: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new MalformedSecretError(`its scrypt ${name} is outside ${min} to ${max}`);
  }
  return value;
};

/** True for a sealed secret's shape, without checking its fields. */
export function isSealedSecret(value: unknown): value is SealedSecret {
  return typeof value === 'object' && value !== null && 'ciphertext' in value && 'kdf' in value;
}

/** Opens a sealed secret; refuses a wrong passphrase, another purpose, or a changed byte. */
export function openSecret(sealed: unknown, passphrase: string, purpose: SecretPurpose): Buffer {
  if (!isSealedSecret(sealed)) throw new MalformedSecretError('it has no cipher text');
  const fields = sealed as unknown as Record<string, unknown>;
  if (fields.v !== VERSION) throw new MalformedSecretError(`version ${String(fields.v)} is not ${VERSION}`);
  if (fields.kdf !== KDF) throw new MalformedSecretError(`its key derivation ${String(fields.kdf)} is not ${KDF}`);
  const n = costField(fields.n, 'N', MIN_N, MAX_N);
  if ((n & (n - 1)) !== 0) throw new MalformedSecretError('its scrypt N is not a power of two');
  const r = costField(fields.r, 'r', 1, MAX_R);
  const p = costField(fields.p, 'p', 1, MAX_P);
  const salt = hexField(fields.salt, 'salt', SALT_BYTES);
  const iv = hexField(fields.iv, 'IV', IV_BYTES);
  const tag = hexField(fields.tag, 'tag', TAG_BYTES);
  const ciphertext = hexField(fields.ciphertext, 'cipher text');
  assertPassphrase(passphrase);
  const key = deriveKey(passphrase, salt, n, r, p);
  try {
    const decipher = createDecipheriv(CIPHER, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(associatedData(purpose));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new WrongPassphraseError();
    }
  } finally {
    key.fill(0);
  }
}
