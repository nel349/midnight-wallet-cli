// Wallet state cache — persist serialized wallet state to disk for fast restore.
// On subsequent runs, the SDK restores from checkpoint and only syncs delta.

import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, readdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { MIDNIGHT_DIR, CACHE_VERSION, CACHE_DIR_NAME, DIR_MODE, FILE_MODE } from './constants.ts';

export interface WalletCacheData {
  shielded: string;
  unshielded: string;
  dust: string;
}

interface CacheFile {
  version: number;
  network: string;
  address: string;
  /**
   * Genesis block hash of the chain this cache was built against.
   * Used to detect remote-testnet resets: a mismatch means the cache
   * refers to a now-defunct chain and must be wiped. Optional for
   * back-compat with pre-S1 cache files.
   */
  chainId?: string;
  timestamp: string;
  wallets: WalletCacheData;
}

/**
 * Derive the cache file path for a given address and network.
 * Path: ~/.midnight/cache/<network>/<address-prefix>.json
 */
export function getCachePath(address: string, network: string, cacheDir?: string): string {
  const base = cacheDir ?? join(homedir(), MIDNIGHT_DIR, CACHE_DIR_NAME);
  // Use first 20 chars of address as prefix (enough to avoid collisions, short enough for filesystem)
  const prefix = address.slice(0, 20);
  return join(base, network, `${prefix}.json`);
}

/**
 * Load cached wallet state from disk.
 * Returns null if cache is missing, corrupt, version-mismatched, or network-mismatched.
 */
export function loadWalletCache(
  address: string,
  network: string,
  cacheDir?: string,
): WalletCacheData | null {
  const path = getCachePath(address, network, cacheDir);

  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed: CacheFile = JSON.parse(raw);

    // Version check
    if (parsed.version !== CACHE_VERSION) return null;

    // Network check
    if (parsed.network !== network) return null;

    // Address check
    if (parsed.address !== address) return null;

    // Validate wallets structure
    if (
      !parsed.wallets ||
      typeof parsed.wallets.shielded !== 'string' ||
      typeof parsed.wallets.unshielded !== 'string' ||
      typeof parsed.wallets.dust !== 'string'
    ) {
      return null;
    }

    return parsed.wallets;
  } catch {
    // Corrupted or unreadable — fall back to fresh build
    return null;
  }
}

/**
 * Serialize and save wallet state to disk.
 * Uses atomic write (write to temp file + rename) to prevent corruption.
 */
export async function saveWalletCache(
  address: string,
  network: string,
  facade: { shielded: { serializeState(): Promise<string> }; unshielded: { serializeState(): Promise<string> }; dust: { serializeState(): Promise<string> } },
  cacheDir?: string,
  chainId?: string,
): Promise<void> {
  const [shielded, unshielded, dust] = await Promise.all([
    facade.shielded.serializeState(),
    facade.unshielded.serializeState(),
    facade.dust.serializeState(),
  ]);

  const data: CacheFile = {
    version: CACHE_VERSION,
    network,
    address,
    timestamp: new Date().toISOString(),
    wallets: { shielded, unshielded, dust },
    ...(chainId ? { chainId } : {}),
  };

  const path = getCachePath(address, network, cacheDir);
  const dir = dirname(path);

  // Ensure directory exists
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  }

  // Atomic write: temp file + rename
  const tmpPath = path + `.tmp.${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(data), { mode: FILE_MODE });
    renameSync(tmpPath, path);
  } catch (err) {
    // Clean up temp file on failure
    try { unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw err;
  }
}

/**
 * Wipe every wallet cache file for a network whose stored chainId doesn't
 * match the chain's current genesis hash. Called at command startup so we
 * catch remote-testnet resets (chain advanced past our cache, so the
 * `applied > highest` detector never fires). Best-effort: if the node is
 * unreachable, we skip validation rather than blocking the command.
 *
 * Returns the list of wiped cache file paths so callers can surface a
 * one-line "cache invalidated" message to the user.
 */
export async function validateWalletCacheChainId(
  network: string,
  nodeWsUrl: string,
  cacheDir?: string,
): Promise<string[]> {
  const { getChainGenesisHash } = await import('./chain-id.ts');
  const currentChainId = await getChainGenesisHash(nodeWsUrl);
  if (!currentChainId) return []; // node unreachable — skip validation

  const base = cacheDir ?? join(homedir(), MIDNIGHT_DIR, CACHE_DIR_NAME);
  const dir = join(base, network);
  if (!existsSync(dir)) return [];

  const wiped: string[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }

  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    const path = join(dir, file);
    try {
      const parsed: CacheFile = JSON.parse(readFileSync(path, 'utf-8'));
      // Legacy caches (pre-S1) have no chainId — leave alone for back-compat;
      // the next save writes the field.
      if (!parsed.chainId) continue;
      if (parsed.chainId !== currentChainId) {
        unlinkSync(path);
        wiped.push(path);
      }
    } catch { /* corrupt file — skip, loadWalletCache will reject it too */ }
  }
  return wiped;
}

/**
 * Delete cache files. If address is provided, delete only that address's cache.
 * If only network is provided, delete all caches for that network.
 * If neither is provided, delete all caches.
 */
export function clearWalletCache(address?: string, network?: string, cacheDir?: string): void {
  const base = cacheDir ?? join(homedir(), MIDNIGHT_DIR, CACHE_DIR_NAME);

  if (address && network) {
    // Delete specific cache file
    const path = getCachePath(address, network, cacheDir);
    try { unlinkSync(path); } catch { /* not found is ok */ }
    return;
  }

  if (network) {
    // Delete all caches for a network
    const dir = join(base, network);
    if (!existsSync(dir)) return;
    try {
      for (const file of readdirSync(dir)) {
        if (file.endsWith('.json')) {
          unlinkSync(join(dir, file));
        }
      }
    } catch { /* best-effort */ }
    return;
  }

  // Delete everything
  if (!existsSync(base)) return;
  try {
    for (const net of readdirSync(base)) {
      const dir = join(base, net);
      try {
        for (const file of readdirSync(dir)) {
          if (file.endsWith('.json')) {
            unlinkSync(join(dir, file));
          }
        }
      } catch { /* best-effort */ }
    }
  } catch { /* best-effort */ }
}
