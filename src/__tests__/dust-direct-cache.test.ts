// Unit tests for the dust-direct cache (load/save/invalidate).
// Exercises the file-based persistence layer; no network involved.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as ledger from '@midnight-ntwrk/ledger-v8';

import {
  loadDustCache,
  saveDustCache,
  clearDustDirectCache,
  getDustCachePath,
  dustPublicKeyHex,
} from '../lib/dust-direct-cache.ts';

const CACHE_DIR = path.join(os.tmpdir(), `midnight-dust-cache-test-${process.pid}-${Date.now()}`);
const NETWORK = 'undeployed';
const SEED_HEX = '0000000000000000000000000000000000000000000000000000000000000042';

// Build a real DustLocalState so we exercise the actual serialize/deserialize path.
function freshDustState(): ledger.DustLocalState {
  const params = new ledger.DustParameters(5_000_000_000n, 8_267n, 3n * 60n * 60n);
  return new ledger.DustLocalState(params);
}

function testDustPubkeyHex(): string {
  const seed = Buffer.from(SEED_HEX, 'hex');
  // Mirror what the CLI does — derive dust key from seed via the HD wallet.
  // For a test-only pubkey we just call fromSeed on the raw seed bytes; the
  // cache only cares that it's a stable bigint identifier.
  const sk = ledger.DustSecretKey.fromSeed(seed.subarray(0, 32));
  return dustPublicKeyHex(sk.publicKey);
}

beforeEach(() => {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(CACHE_DIR, { recursive: true, force: true });
});

describe('dustPublicKeyHex', () => {
  it('pads to 64 chars', () => {
    expect(dustPublicKeyHex(1n)).toHaveLength(64);
    expect(dustPublicKeyHex(1n)).toBe('0'.repeat(63) + '1');
  });

  it('is stable for the same key', () => {
    const a = testDustPubkeyHex();
    const b = testDustPubkeyHex();
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });
});

describe('dust-direct cache: round-trip', () => {
  it('saves and loads a serialized state', () => {
    const pubkey = testDustPubkeyHex();
    const state = freshDustState();

    saveDustCache(NETWORK, pubkey, state, 42, CACHE_DIR);
    const loaded = loadDustCache(NETWORK, pubkey, CACHE_DIR);

    expect(loaded).not.toBeNull();
    expect(loaded!.lastAppliedEventId).toBe(42);
    expect(loaded!.state).toBeInstanceOf(ledger.DustLocalState);
    // Structural check: a fresh state has empty utxos.
    expect(loaded!.state.utxos).toEqual([]);
  });

  it('writes file with 0o600 permissions', () => {
    const pubkey = testDustPubkeyHex();
    const state = freshDustState();
    saveDustCache(NETWORK, pubkey, state, 0, CACHE_DIR);

    const filePath = getDustCachePath(NETWORK, pubkey, CACHE_DIR);
    const stat = fs.statSync(filePath);
    // On macOS/Linux the mode low 9 bits reflect user/group/other rwx.
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe('dust-direct cache: invalidation', () => {
  it('returns null when the file is missing', () => {
    expect(loadDustCache(NETWORK, testDustPubkeyHex(), CACHE_DIR)).toBeNull();
  });

  it('returns null on version mismatch', () => {
    const pubkey = testDustPubkeyHex();
    const state = freshDustState();
    saveDustCache(NETWORK, pubkey, state, 1, CACHE_DIR);

    // Corrupt: bump version on disk
    const filePath = getDustCachePath(NETWORK, pubkey, CACHE_DIR);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    data.version = 999;
    fs.writeFileSync(filePath, JSON.stringify(data));

    expect(loadDustCache(NETWORK, pubkey, CACHE_DIR)).toBeNull();
  });

  it('returns null on network mismatch', () => {
    const pubkey = testDustPubkeyHex();
    saveDustCache(NETWORK, pubkey, freshDustState(), 1, CACHE_DIR);
    expect(loadDustCache('preprod', pubkey, CACHE_DIR)).toBeNull();
  });

  it('returns null on pubkey mismatch', () => {
    const pubkey = testDustPubkeyHex();
    saveDustCache(NETWORK, pubkey, freshDustState(), 1, CACHE_DIR);
    expect(loadDustCache(NETWORK, 'f'.repeat(64), CACHE_DIR)).toBeNull();
  });

  it('returns null on corrupted JSON', () => {
    const pubkey = testDustPubkeyHex();
    saveDustCache(NETWORK, pubkey, freshDustState(), 1, CACHE_DIR);
    fs.writeFileSync(getDustCachePath(NETWORK, pubkey, CACHE_DIR), '{not-json');
    expect(loadDustCache(NETWORK, pubkey, CACHE_DIR)).toBeNull();
  });

  it('returns null when dustState is not a hex string', () => {
    const pubkey = testDustPubkeyHex();
    saveDustCache(NETWORK, pubkey, freshDustState(), 1, CACHE_DIR);
    const filePath = getDustCachePath(NETWORK, pubkey, CACHE_DIR);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    data.dustState = 'not-hex-zzz';
    fs.writeFileSync(filePath, JSON.stringify(data));
    expect(loadDustCache(NETWORK, pubkey, CACHE_DIR)).toBeNull();
  });
});

describe('dust-direct cache: clearDustDirectCache', () => {
  it('removes a single (network, pubkey) file', () => {
    const pubkey = testDustPubkeyHex();
    saveDustCache(NETWORK, pubkey, freshDustState(), 1, CACHE_DIR);
    expect(fs.existsSync(getDustCachePath(NETWORK, pubkey, CACHE_DIR))).toBe(true);

    clearDustDirectCache(NETWORK, pubkey, CACHE_DIR);
    expect(fs.existsSync(getDustCachePath(NETWORK, pubkey, CACHE_DIR))).toBe(false);
  });

  it('removes all dust-* files in a network dir, preserving non-dust files', () => {
    const pubkey = testDustPubkeyHex();
    saveDustCache(NETWORK, pubkey, freshDustState(), 1, CACHE_DIR);
    // Simulate an existing facade cache file that should NOT be touched.
    const networkDir = path.join(CACHE_DIR, NETWORK);
    const walletCachePath = path.join(networkDir, 'some-wallet-cache.json');
    fs.writeFileSync(walletCachePath, '{}');

    clearDustDirectCache(NETWORK, undefined, CACHE_DIR);

    expect(fs.existsSync(getDustCachePath(NETWORK, pubkey, CACHE_DIR))).toBe(false);
    expect(fs.existsSync(walletCachePath)).toBe(true);
  });

  it('removes all dust-* files across all networks when called with no args', () => {
    const pubkey = testDustPubkeyHex();
    saveDustCache('undeployed', pubkey, freshDustState(), 1, CACHE_DIR);
    saveDustCache('preprod', pubkey, freshDustState(), 2, CACHE_DIR);

    clearDustDirectCache(undefined, undefined, CACHE_DIR);

    expect(fs.existsSync(getDustCachePath('undeployed', pubkey, CACHE_DIR))).toBe(false);
    expect(fs.existsSync(getDustCachePath('preprod', pubkey, CACHE_DIR))).toBe(false);
  });
});
