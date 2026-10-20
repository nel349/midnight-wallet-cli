// Unit tests for the shared wallet-seed resolver used by `address`, `balance`,
// and `dust export`. Precedence: --seed → MN_SEED → --wallet <name> → active.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseArgs } from '../lib/argv.ts';
import { parseSeedHex, resolveSeedSource, resolveSeed } from '../lib/seed-resolver.ts';
import { PASSPHRASE_ENV, establishPassphrase } from '../lib/passphrase.ts';
import { type WalletPublic, writeSealedWallet } from '../lib/wallet-config.ts';

const PASSPHRASE = 'correct horse battery staple';
const ORIGINAL_HOME = process.env.HOME;

const SEED_A = '11'.repeat(32);
const SEED_B = '22'.repeat(32);

let TMP: string;
beforeEach(() => { TMP = mkdtempSync(join(tmpdir(), 'mn-seedres-')); delete process.env.MN_SEED; });
afterEach(() => { rmSync(TMP, { recursive: true, force: true }); delete process.env.MN_SEED; });

function walletFile(seedHex: string): string {
  const p = join(TMP, 'w.json');
  writeFileSync(p, JSON.stringify({ seed: seedHex, addresses: {}, createdAt: new Date().toISOString() }));
  return p;
}
const argsFor = (extra: string[]) => parseArgs(['balance', ...extra]);

describe('parseSeedHex', () => {
  it('parses a 64-hex string to the exact 32 bytes', () => {
    const b = parseSeedHex('ab'.repeat(32), '--seed');
    expect(b.length).toBe(32);
    expect(b.toString('hex')).toBe('ab'.repeat(32));
  });

  it('parses a 128-hex string to the exact 64 bytes', () => {
    const b = parseSeedHex('cd'.repeat(64), '--seed');
    expect(b.length).toBe(64);
    expect(b.toString('hex')).toBe('cd'.repeat(64));
  });

  it('strips 0x and surrounding whitespace before the length check', () => {
    expect(parseSeedHex(`0x${'ee'.repeat(64)}\n`, '--seed').toString('hex')).toBe('ee'.repeat(64));
  });

  it.each([
    ['empty', ''],
    ['too short', 'aabb'],
    ['between the two sizes', 'ff'.repeat(48)],
    ['too long', 'ff'.repeat(65)],
    ['right length, non-hex', 'zz'.repeat(32)],
  ])('rejects %s with the sizes it does accept', (_name, input) => {
    expect(() => parseSeedHex(input, '--seed')).toThrow(/64 or 128 hex characters/);
  });

  it('names the offending source in the error', () => {
    expect(() => parseSeedHex('aabb', 'MN_SEED')).toThrow(/^MN_SEED /);
  });
});

describe('resolveSeedSource', () => {
  it('reads --seed, with no backing wallet file/config', async () => {
    const r = await resolveSeedSource(argsFor(['--seed', SEED_A]));
    expect(r.seed.toString('hex')).toBe(SEED_A);
    expect(r.walletPath).toBeNull();
    expect(r.config).toBeNull();
  });

  it('reads MN_SEED when --seed is absent', async () => {
    process.env.MN_SEED = SEED_A;
    const r = await resolveSeedSource(argsFor([]));
    expect(r.seed.toString('hex')).toBe(SEED_A);
    expect(r.walletPath).toBeNull();
  });

  it('lets --seed win over MN_SEED', async () => {
    process.env.MN_SEED = SEED_B;
    const r = await resolveSeedSource(argsFor(['--seed', SEED_A]));
    expect(r.seed.toString('hex')).toBe(SEED_A);
  });

  it('strips 0x and trims a trailing newline (MN_SEED from $(cat seed.hex))', async () => {
    process.env.MN_SEED = `0x${SEED_A}\n`;
    const r = await resolveSeedSource(argsFor([]));
    expect(r.seed.toString('hex')).toBe(SEED_A);
  });

  it('rejects a bad-length --seed', async () => {
    await expect(resolveSeedSource(argsFor(['--seed', 'aabb']))).rejects.toThrow(/64 or 128 hex characters/);
  });

  it('accepts a 128-hex (64-byte BIP-39) --seed', async () => {
    const seed64 = '33'.repeat(64);
    const r = await resolveSeedSource(argsFor(['--seed', seed64]));
    expect(r.seed.length).toBe(64);
    expect(r.seed.toString('hex')).toBe(seed64);
  });

  it('rejects in-between lengths (only 32- and 64-byte seeds occur)', async () => {
    await expect(resolveSeedSource(argsFor(['--seed', '44'.repeat(48)]))).rejects.toThrow(/64 or 128 hex characters/);
  });

  it('names MN_SEED in the error when MN_SEED is the bad source', async () => {
    process.env.MN_SEED = 'zz';
    await expect(resolveSeedSource(argsFor([]))).rejects.toThrow(/MN_SEED/);
  });

  it('reads a wallet file via --wallet, exposing walletPath + config', async () => {
    const p = walletFile(SEED_B);
    const r = await resolveSeedSource(argsFor(['--wallet', p]));
    expect(r.seed.toString('hex')).toBe(SEED_B);
    expect(r.walletPath).toBe(p);
    expect(r.config).not.toHaveProperty('seed');
    expect(r.config?.isSealed).toBe(false);
  });

  it('opens a sealed wallet via --wallet with mn\'s passphrase', async () => {
    process.env.HOME = TMP;
    process.env[PASSPHRASE_ENV] = PASSPHRASE;
    try {
      establishPassphrase(TMP, PASSPHRASE);
      const p = writeSealedWallet(join(TMP, 'sealed.json'), { addresses: {} as WalletPublic['addresses'], createdAt: new Date().toISOString() }, { seed: SEED_B }, PASSPHRASE);
      const r = await resolveSeedSource(argsFor(['--wallet', p]));
      expect(r.seed.toString('hex')).toBe(SEED_B);
      expect(r.config?.isSealed).toBe(true);
    } finally {
      process.env.HOME = ORIGINAL_HOME;
      delete process.env[PASSPHRASE_ENV];
    }
  });

  it('requireExplicit throws a labeled error naming every source when none is given', async () => {
    // No --seed / MN_SEED / --wallet, and requireExplicit disables the active fallback.
    await expect(resolveSeedSource(argsFor([]), { requireExplicit: true, label: 'address' }))
      .rejects.toThrow(/address needs a seed source/);
    const msg = await resolveSeedSource(argsFor([]), { requireExplicit: true, label: 'address' }).then(() => '', (e: Error) => e.message);
    expect(msg).toContain('--seed');
    expect(msg).toContain('MN_SEED');
    expect(msg).toContain('--wallet');
  });

  it('resolveSeed returns just the seed buffer', async () => {
    expect((await resolveSeed(argsFor(['--seed', SEED_A]))).toString('hex')).toBe(SEED_A);
  });
});
