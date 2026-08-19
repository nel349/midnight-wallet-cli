// Export a facade-restorable dust snapshot for a seed.
//
// Combines the fast indexer-direct dust sync (primeDustCache) with a base
// facade dust snapshot (built from keys, never connected) to produce a JSON
// blob that ANY wallet on the same seed can hand to `DustWallet.restore(...)`
// (e.g. via a wallet-SDK facade's `dustSerializedState`) to skip the slow cold
// dust scan. This is the seam a dApp operator uses to warm up in seconds
// instead of re-scanning the whole dust event history on every restart.
//
// Pure logic: returns values, never writes to stdout/stderr or exits.

import { primeDustCache, loadDustCache, dustPublicKeyHexFromSeed } from './dust-direct-cache.ts';
import { buildFacade, stopFacade, overlayDustDirectSnapshot } from './facade.ts';
import { type NetworkConfig } from './network.ts';

export interface DustExportResult {
  network: string;
  /** Dust public key (hex) this snapshot belongs to — derived from the seed. */
  dustPublicKey: string;
  /** Last dust event id the snapshot covers; -1 if the wallet has no dust events yet. */
  offset: number;
  /** Dust balance encoded in the snapshot, at export time. */
  balance: bigint;
  /** Dust events applied during this export's sync (delta since any prior cache). */
  eventCount: number;
  /** True if an existing dust-direct cache was extended; false if synced from scratch. */
  fromCache: boolean;
  /** The facade-restorable dust snapshot — pass as `dustSerializedState`. */
  snapshot: string;
}

export interface DustExportOptions {
  onProgress?: (eventsApplied: number, maxIdSeen: number) => void;
  signal?: AbortSignal;
}

/**
 * Produce a restorable dust snapshot for `seedBuffer` on `network`.
 *
 * 1. Fast dust-direct sync (warm-resumes from the on-disk checkpoint).
 * 2. Build a fresh facade (from keys only — no `start()`, so no network I/O)
 *    to get a correctly-shaped base dust snapshot (publicKey/protocolVersion/
 *    networkId + schema).
 * 3. Overlay the synced `DustLocalState` onto that base — the same operation
 *    `maybeBridgeDustCache` does for the CLI's own write commands.
 */
export async function exportDustSnapshot(
  seedBuffer: Buffer,
  network: string,
  networkConfig: NetworkConfig,
  options: DustExportOptions = {},
): Promise<DustExportResult> {
  const pubkeyHex = dustPublicKeyHexFromSeed(seedBuffer);

  const prime = await primeDustCache(seedBuffer, network, networkConfig.indexerWS, options);

  // A fresh facade built from keys; never started, so this touches no network.
  const bundle = await buildFacade(seedBuffer, networkConfig, null);
  let baseDust: string;
  try {
    baseDust = await (bundle.facade as unknown as {
      dust: { serializeState(): Promise<string> };
    }).dust.serializeState();
  } finally {
    await stopFacade(bundle);
  }

  const direct = loadDustCache(network, pubkeyHex);
  // Apply the synced state whenever at least one event was applied. For a wallet with no
  // dust events yet (lastAppliedEventId -1) the fresh base snapshot is already the correct
  // empty state and carries a valid offset 0, so leave it untouched.
  const snapshot = direct && direct.lastAppliedEventId >= 0
    ? overlayDustDirectSnapshot(baseDust, direct)
    : baseDust;
  const balance = direct ? direct.state.walletBalance(new Date()) : 0n;

  return {
    network,
    dustPublicKey: pubkeyHex,
    offset: prime.lastAppliedEventId,
    balance,
    eventCount: prime.eventCount,
    fromCache: prime.fromCache,
    snapshot,
  };
}
