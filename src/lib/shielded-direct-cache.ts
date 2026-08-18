// Cache for the indexer-direct shielded (zswap) reader.
//
// Persists a serialized `ZswapLocalState` + the last event id we applied to
// disk, keyed by (network, shielded coin public key). On next run we restore the
// state and resume the subscription from `lastAppliedEventId + 1` — delta-sync
// instead of re-reading the full zswap event history (which is ~50-70s cold on
// hosted networks; incremental is ~instant).
//
// Security: the cached state contains owned coins but NOT the secret keys. Same
// sensitivity as the wallet file (mode 0o600).

import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, readdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

import * as ledger from '@midnight-ntwrk/ledger-v8';

import { MIDNIGHT_DIR, CACHE_DIR_NAME, DIR_MODE, FILE_MODE } from './constants.ts';
import { deriveShieldedSeed } from './derivation.ts';
import { readShieldedBalanceDirect, type ShieldedDirectOptions } from './shielded-direct.ts';

const SHIELDED_CACHE_VERSION = 1;

interface ShieldedCacheFile {
  version: number;
  network: string;
  coinPublicKeyHex: string;
  lastAppliedEventId: number;
  /** Genesis block hash — invalidates the cache on chain reset. Optional for back-compat. */
  chainId?: string;
  timestamp: string;
  zswapState: string; // hex-encoded ZswapLocalState.serialize()
}

export interface ShieldedCacheEntry {
  state: ledger.ZswapLocalState;
  lastAppliedEventId: number;
}

/**
 * Derive the shielded coin public key (as hex) from a wallet seed. Used to key
 * shielded-direct cache entries by wallet.
 */
export function shieldedCoinPublicKeyHexFromSeed(seedBuffer: Buffer): string {
  const keys = ledger.ZswapSecretKeys.fromSeed(deriveShieldedSeed(seedBuffer));
  return keys.coinPublicKey;
}

function shieldedCacheDir(network: string, cacheDir?: string): string {
  const base = cacheDir ?? join(homedir(), MIDNIGHT_DIR, CACHE_DIR_NAME);
  return join(base, network);
}

export function getShieldedCachePath(
  network: string,
  pubkeyHex: string,
  cacheDir?: string,
): string {
  const prefix = pubkeyHex.slice(0, 20);
  return join(shieldedCacheDir(network, cacheDir), `shielded-${prefix}.json`);
}

/**
 * Load a cached ZswapLocalState for the given (network, coin pubkey).
 * Returns null if missing, corrupt, version-mismatched, network/pubkey-mismatched,
 * or — when `expectedChainId` is given and the cache recorded one — if the chain
 * genesis hash no longer matches (chain reset). A stale-chain cache is discarded
 * so a localnet reset can't surface a wrong balance from an old chain's coins.
 */
export function loadShieldedCache(
  network: string,
  pubkeyHex: string,
  cacheDir?: string,
  expectedChainId?: string,
): ShieldedCacheEntry | null {
  const path = getShieldedCachePath(network, pubkeyHex, cacheDir);
  if (!existsSync(path)) return null;

  try {
    const parsed: ShieldedCacheFile = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed.version !== SHIELDED_CACHE_VERSION) return null;
    if (parsed.network !== network) return null;
    if (parsed.coinPublicKeyHex !== pubkeyHex) return null;
    if (typeof parsed.lastAppliedEventId !== 'number') return null;
    if (typeof parsed.zswapState !== 'string') return null;
    if (expectedChainId && parsed.chainId && parsed.chainId !== expectedChainId) return null;

    const state = ledger.ZswapLocalState.deserialize(new Uint8Array(Buffer.from(parsed.zswapState, 'hex')));
    return { state, lastAppliedEventId: parsed.lastAppliedEventId };
  } catch {
    return null;
  }
}

/**
 * Serialize a ZswapLocalState + lastAppliedEventId to disk atomically.
 */
export function saveShieldedCache(
  network: string,
  pubkeyHex: string,
  state: ledger.ZswapLocalState,
  lastAppliedEventId: number,
  cacheDir?: string,
  chainId?: string,
): void {
  const data: ShieldedCacheFile = {
    version: SHIELDED_CACHE_VERSION,
    network,
    coinPublicKeyHex: pubkeyHex,
    lastAppliedEventId,
    timestamp: new Date().toISOString(),
    zswapState: Buffer.from(state.serialize()).toString('hex'),
    ...(chainId ? { chainId } : {}),
  };

  const path = getShieldedCachePath(network, pubkeyHex, cacheDir);
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
 * Remove shielded-direct cache files. Scope:
 *  - (network, pubkeyHex) → single file
 *  - (network)            → all shielded-* files in that network dir
 *  - (neither)            → all shielded-* files across all networks
 */
export function clearShieldedDirectCache(
  network?: string,
  pubkeyHex?: string,
  cacheDir?: string,
): void {
  const base = cacheDir ?? join(homedir(), MIDNIGHT_DIR, CACHE_DIR_NAME);

  if (network && pubkeyHex) {
    const path = getShieldedCachePath(network, pubkeyHex, cacheDir);
    try { unlinkSync(path); } catch { /* not found is ok */ }
    return;
  }

  const wipeNetworkDir = (dir: string) => {
    if (!existsSync(dir)) return;
    try {
      for (const file of readdirSync(dir)) {
        if (file.startsWith('shielded-') && file.endsWith('.json')) {
          try { unlinkSync(join(dir, file)); } catch { /* best-effort */ }
        }
      }
    } catch { /* best-effort */ }
  };

  if (network) {
    wipeNetworkDir(shieldedCacheDir(network, cacheDir));
    return;
  }

  if (!existsSync(base)) return;
  try {
    for (const net of readdirSync(base)) {
      wipeNetworkDir(join(base, net));
    }
  } catch { /* best-effort */ }
}

export interface ShieldedBalanceResult {
  /** Native (NIGHT) shielded balance in atomic units. */
  balance: bigint;
  /** Number of spendable NIGHT coins. */
  availableCoins: number;
  /** Events applied in this run (delta since last cache save). */
  eventCount: number;
  /** Latest event id in the saved cache (carried from prior cache if no new events). */
  lastAppliedEventId: number;
  /** True if an existing cache was loaded and extended; false if synced from scratch. */
  fromCache: boolean;
  /** True if the sync stopped before catching up (timeout/abort) — resume next call. */
  partial: boolean;
}

export interface ShieldedCachedOptions extends Pick<ShieldedDirectOptions, 'onProgress' | 'signal' | 'timeoutMs'> {
  /** Ignore any cached state and re-sync from the beginning (honours --no-cache). */
  forceFresh?: boolean;
  /** Current chain genesis hash — stored on save and checked on load (chain-reset guard). */
  chainId?: string;
}

/**
 * Read the shielded NIGHT balance for a wallet seed, using (and refreshing) the
 * indexer-direct cache. Loads any cached ZswapLocalState, resumes the
 * `zswapLedgerEvents` subscription from the last applied event, and persists the
 * extended state. First sync walks the full history (~50-70s on hosted nets);
 * subsequent calls are delta-syncs.
 */
export async function readShieldedBalanceCached(
  seedBuffer: Buffer,
  network: string,
  indexerWS: string,
  options: ShieldedCachedOptions = {},
): Promise<ShieldedBalanceResult> {
  const secretKeys = ledger.ZswapSecretKeys.fromSeed(deriveShieldedSeed(seedBuffer));
  const pubkeyHex = secretKeys.coinPublicKey;

  const cached = options.forceFresh ? null : loadShieldedCache(network, pubkeyHex, undefined, options.chainId);
  const startFromId = cached ? cached.lastAppliedEventId + 1 : 0;

  const result = await readShieldedBalanceDirect(secretKeys, indexerWS, {
    initialState: cached?.state,
    startFromId,
    onProgress: options.onProgress,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    // Persist after each chunk so a Ctrl+C / kill during a cold ~70s sync
    // doesn't lose progress — the next call resumes from the last checkpoint.
    onCheckpoint: (state, lastAppliedEventId) => {
      try { saveShieldedCache(network, pubkeyHex, state, lastAppliedEventId, undefined, options.chainId); } catch { /* best-effort */ }
    },
  });

  // Only write if we advanced or this is a first sync. If we had a cache and zero
  // new events arrived, leave the on-disk file untouched.
  if (result.lastAppliedEventId >= 0) {
    saveShieldedCache(network, pubkeyHex, result.state, result.lastAppliedEventId, undefined, options.chainId);
  } else if (!cached) {
    saveShieldedCache(network, pubkeyHex, result.state, -1, undefined, options.chainId);
  }

  return {
    balance: result.balance,
    availableCoins: result.availableCoins,
    eventCount: result.eventCount,
    lastAppliedEventId: result.lastAppliedEventId >= 0
      ? result.lastAppliedEventId
      : (cached?.lastAppliedEventId ?? -1),
    fromCache: cached !== null,
    partial: result.partial,
  };
}
