import { describe, it, expect } from 'vitest';
import { resolvePrivateStateSecretKey } from '../lib/contract/private-state-secret.ts';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('resolvePrivateStateSecretKey', () => {
  const injected = 'aa'.repeat(32); // 64 hex chars → 32 bytes of 0xaa
  const cpk = 'bb'.repeat(40); // 80 hex chars (coin pubkey is longer than 32 bytes)

  it('uses the injected 64-hex secret exactly, as 32 bytes', () => {
    const key = resolvePrivateStateSecretKey(injected, undefined);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
    expect(hex(key)).toBe(injected);
  });

  it('injected secret wins over the wallet coin public key', () => {
    const key = resolvePrivateStateSecretKey(injected, cpk);
    expect(hex(key)).toBe(injected);
  });

  it('derives the first 32 bytes of the coin public key when no secret is injected', () => {
    const key = resolvePrivateStateSecretKey(undefined, cpk);
    expect(hex(key)).toBe('bb'.repeat(32)); // first 32 bytes only
  });

  it('ignores a wrong-length injected secret and falls back to the coin public key', () => {
    const key = resolvePrivateStateSecretKey('abcd', cpk); // 4 hex chars, not 64
    expect(hex(key)).toBe('bb'.repeat(32));
  });

  it('falls back to a random 32-byte key when neither is available', () => {
    const a = resolvePrivateStateSecretKey(undefined, undefined);
    const b = resolvePrivateStateSecretKey(undefined, '');
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
    // Two random draws must not collide (guards against a zero/constant fallback).
    expect(hex(a)).not.toBe(hex(b));
    expect(hex(a)).not.toBe('00'.repeat(32));
  });

  it('is deterministic for the same coin public key (post/takeDown reuse the key)', () => {
    const a = resolvePrivateStateSecretKey(undefined, cpk);
    const b = resolvePrivateStateSecretKey(undefined, cpk);
    expect(hex(a)).toBe(hex(b));
  });
});
