// The keystore's sealed secrets: what is sealed opens only with the same
// passphrase and for the same purpose, and nothing else opens it: not another
// passphrase, not a changed byte, not a block sealed for another purpose. A
// sealed block never holds the secret in the clear, and asks no more of the
// machine than mn's own parameters do.

import { describe, expect, it } from 'vitest';
import { MalformedSecretError, WrongPassphraseError, openSecret, sealSecret } from '../lib/keystore.ts';

const SEED = Buffer.from('aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233', 'hex');
const PASSPHRASE = 'correct horse battery staple';

describe('a sealed secret', () => {
  it('opens with the passphrase and purpose it was sealed with', () => {
    const sealed = sealSecret(SEED, PASSPHRASE, 'wallet');
    expect(openSecret(sealed, PASSPHRASE, 'wallet')).toEqual(SEED);
  });

  it('does not hold the secret in the clear', () => {
    const text = JSON.stringify(sealSecret(SEED, PASSPHRASE, 'wallet'));
    expect(text).not.toContain(SEED.toString('hex'));
    expect(text).not.toContain(SEED.toString('base64'));
  });

  it('is sealed afresh each time: no two seals of the same secret are alike', () => {
    const first = sealSecret(SEED, PASSPHRASE, 'wallet');
    const second = sealSecret(SEED, PASSPHRASE, 'wallet');
    expect(second.salt).not.toBe(first.salt);
    expect(second.iv).not.toBe(first.iv);
    expect(second.ciphertext).not.toBe(first.ciphertext);
  });

  it('is refused with another passphrase', () => {
    const sealed = sealSecret(SEED, PASSPHRASE, 'wallet');
    expect(() => openSecret(sealed, 'Correct horse battery staple', 'wallet')).toThrow(WrongPassphraseError);
  });

  it('is refused for another purpose: a wallet seed never opens as an owner key', () => {
    const sealed = sealSecret(SEED, PASSPHRASE, 'wallet');
    expect(() => openSecret(sealed, PASSPHRASE, 'owner-key')).toThrow(WrongPassphraseError);
  });

  it('is refused when any part of it is changed', () => {
    const sealed = sealSecret(SEED, PASSPHRASE, 'wallet');
    const flip = (hex: string): string => (hex[0] === '0' ? '1' : '0') + hex.slice(1);
    for (const field of ['ciphertext', 'iv', 'tag', 'salt'] as const) {
      expect(() => openSecret({ ...sealed, [field]: flip(sealed[field]) }, PASSPHRASE, 'wallet'), field).toThrow(WrongPassphraseError);
    }
  });

  it('is refused as malformed when it is not a sealed secret mn can open', () => {
    const sealed = sealSecret(SEED, PASSPHRASE, 'wallet');
    expect(() => openSecret({ ...sealed, v: 2 }, PASSPHRASE, 'wallet')).toThrow(MalformedSecretError);
    expect(() => openSecret({ ...sealed, kdf: 'pbkdf2' }, PASSPHRASE, 'wallet')).toThrow(MalformedSecretError);
    expect(() => openSecret({ ...sealed, iv: 'zz' }, PASSPHRASE, 'wallet')).toThrow(MalformedSecretError);
    expect(() => openSecret('not a secret', PASSPHRASE, 'wallet')).toThrow(MalformedSecretError);
  });

  it('is refused as malformed when its key derivation would cost more than mn ever asks', () => {
    // A file that names a huge scrypt cost would tie up the machine before
    // any passphrase is checked.
    const sealed = sealSecret(SEED, PASSPHRASE, 'wallet');
    expect(() => openSecret({ ...sealed, n: 2 ** 24 }, PASSPHRASE, 'wallet')).toThrow(MalformedSecretError);
  });

  it('is refused as malformed when its key derivation is weaker than mn ever writes', () => {
    const sealed = sealSecret(SEED, PASSPHRASE, 'wallet');
    expect(() => openSecret({ ...sealed, n: 2 ** 10 }, PASSPHRASE, 'wallet')).toThrow(MalformedSecretError);
  });

  it('refuses an empty passphrase', () => {
    expect(() => sealSecret(SEED, '', 'wallet')).toThrow(WrongPassphraseError);
  });
});
