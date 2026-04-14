// Cache for the indexer-direct dust reader.
//
// Persists a serialized `DustLocalState` + the last event id we applied to
// disk, keyed by (network, dust public key). On next run we restore the state
// and resume the subscription from `lastAppliedEventId + 1` — delta-sync
// instead of re-reading the full event history.
//
// Security: the cached state contains owned UTXOs but NOT the dust secret
// key. Same sensitivity as the wallet file (mode 0o600).

import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, readdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

import * as ledger from '@midnight-ntwrk/ledger-v8';

import { MIDNIGHT_DIR, CACHE_DIR_NAME, DIR_MODE, FILE_MODE } from './constants.ts';
import { deriveDustSeed } from './derivation.ts';

const DUST_CACHE_VERSION = 1;

interface DustCacheFile {
  version: number;
  network: string;
  dustPublicKeyHex: string;
  lastAppliedEventId: number;
  timestamp: string;
  dustState: string; // hex-encoded DustLocalState.serialize()
}

export interface DustCacheEntry {
  state: ledger.DustLocalState;
  lastAppliedEventId: number;
}

/** Normalize a DustPublicKey (bigint) to a fixed-width 64-char hex string. */
export function dustPublicKeyHex(publicKey: ledger.DustPublicKey): string {
  return publicKey.toString(16).padStart(64, '0');
}

/**
 * Derive the dust public key (as hex) from a wallet seed. Convenience for
 * callers that want to look up dust-direct cache entries by wallet rather
 * than by raw public key.
 */
export function dustPublicKeyHexFromSeed(seedBuffer: Buffer): string {
  const dustSeed = deriveDustSeed(seedBuffer);
  const sk = ledger.DustSecretKey.fromSeed(dustSeed);
  return dustPublicKeyHex(sk.publicKey);
}

function dustCacheDir(network: string, cacheDir?: string): string {
  const base = cacheDir ?? join(homedir(), MIDNIGHT_DIR, CACHE_DIR_NAME);
  return join(base, network);
}

export function getDustCachePath(
  network: string,
  pubkeyHex: string,
  cacheDir?: string,
): string {
  const prefix = pubkeyHex.slice(0, 20);
  return join(dustCacheDir(network, cacheDir), `dust-${prefix}.json`);
}

/**
 * Load a cached DustLocalState for the given (network, dust pubkey).
 * Returns null if missing, corrupt, version-mismatched, or network/pubkey-mismatched.
 */
export function loadDustCache(
  network: string,
  pubkeyHex: string,
  cacheDir?: string,
): DustCacheEntry | null {
  const path = getDustCachePath(network, pubkeyHex, cacheDir);
  if (!existsSync(path)) return null;

  try {
    const parsed: DustCacheFile = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed.version !== DUST_CACHE_VERSION) return null;
    if (parsed.network !== network) return null;
    if (parsed.dustPublicKeyHex !== pubkeyHex) return null;
    if (typeof parsed.lastAppliedEventId !== 'number') return null;
    if (typeof parsed.dustState !== 'string') return null;

    const bytes = Buffer.from(parsed.dustState, 'hex');
    const state = ledger.DustLocalState.deserialize(bytes);
    return { state, lastAppliedEventId: parsed.lastAppliedEventId };
  } catch {
    return null;
  }
}

/**
 * Serialize a DustLocalState + lastAppliedEventId to disk atomically.
 */
export function saveDustCache(
  network: string,
  pubkeyHex: string,
  state: ledger.DustLocalState,
  lastAppliedEventId: number,
  cacheDir?: string,
): void {
  const data: DustCacheFile = {
    version: DUST_CACHE_VERSION,
    network,
    dustPublicKeyHex: pubkeyHex,
    lastAppliedEventId,
    timestamp: new Date().toISOString(),
    dustState: Buffer.from(state.serialize()).toString('hex'),
  };

  const path = getDustCachePath(network, pubkeyHex, cacheDir);
  const dir = dirname(path);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  }

  const tmpPath = path + `.tmp.${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(data), { mode: FILE_MODE });
    renameSync(tmpPath, path);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw err;
  }
}

/**
 * Remove dust-direct cache files. Scope:
 *  - (network, pubkeyHex) → single file
 *  - (network)            → all dust-* files in that network dir
 *  - (neither)            → all dust-* files across all networks
 */
export function clearDustDirectCache(
  network?: string,
  pubkeyHex?: string,
  cacheDir?: string,
): void {
  const base = cacheDir ?? join(homedir(), MIDNIGHT_DIR, CACHE_DIR_NAME);

  if (network && pubkeyHex) {
    const path = getDustCachePath(network, pubkeyHex, cacheDir);
    try { unlinkSync(path); } catch { /* not found is ok */ }
    return;
  }

  const wipeNetworkDir = (dir: string) => {
    if (!existsSync(dir)) return;
    try {
      for (const file of readdirSync(dir)) {
        if (file.startsWith('dust-') && file.endsWith('.json')) {
          try { unlinkSync(join(dir, file)); } catch { /* best-effort */ }
        }
      }
    } catch { /* best-effort */ }
  };

  if (network) {
    wipeNetworkDir(dustCacheDir(network, cacheDir));
    return;
  }

  if (!existsSync(base)) return;
  try {
    for (const net of readdirSync(base)) {
      wipeNetworkDir(join(base, net));
    }
  } catch { /* best-effort */ }
}
