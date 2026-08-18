// Shielded-sync policy. Shielded (zswap) sync is the slow part of a facade sync,
// and on preview/preprod it is pointless: there is no shielded faucet, so a
// wallet can never hold shielded funds there. Skipping it makes those networks
// fast (unshielded is GraphQL, dust is already optimized) without hiding
// anything real. `undeployed` (localnet genesis) and any future funded network
// keep shielded on. Overridable with `--force-shielded` for the rare case a
// wallet did receive shielded funds out of band.

import type { NetworkName } from './network.ts';

/** Networks with no shielded faucet — shielded sync is skipped by default. */
const NO_SHIELDED_FAUCET: readonly NetworkName[] = ['preview', 'preprod'];

/** True when shielded funds are actually reachable on this network. */
export function networkHasShielded(network: NetworkName): boolean {
  return !NO_SHIELDED_FAUCET.includes(network);
}

/**
 * Whether to sync/allow shielded for this run. Off by default on faucet-less
 * networks; `force` (the `--force-shielded` flag) re-enables it.
 */
export function shieldedSyncEnabled(network: NetworkName, force = false): boolean {
  return networkHasShielded(network) || force;
}

/** One-line reason shown when a shielded op is skipped/blocked. */
export function shieldedDisabledReason(network: NetworkName): string {
  return `Shielded is unavailable on ${network} (no faucet). Use --force-shielded to sync anyway, or --network undeployed.`;
}
