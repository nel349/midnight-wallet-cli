// Indexer readiness — a Docker-healthy indexer can still be a few seconds
// behind the node, with no visible record of block 0's state yet. A
// follow-up airdrop runs before the genesis UTXO is indexed and bails with
// INSUFFICIENT_BALANCE. This helper polls until the indexer reports a
// non-zero balance for a known-funded address (typically the genesis key
// on localnet), confirming state has been ingested end-to-end.

import { checkBalance } from './balance-subscription.ts';

export interface WaitForIndexerOptions {
  /** Overall deadline for the wait. Default 30s. */
  timeoutMs?: number;
  /** How often to re-poll while waiting. Default 1s. */
  pollIntervalMs?: number;
}

/**
 * Poll the indexer for the given address until utxoCount > 0. Resolves
 * silently as soon as funds are visible; rejects on timeout. Suitable for
 * "wait until localnet is usable" checks against the genesis address.
 */
export async function waitForAddressFunded(
  indexerWS: string,
  address: string,
  opts: WaitForIndexerOptions = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const result = await checkBalance(address, indexerWS);
      if (result.utxoCount > 0) return;
    } catch {
      // Indexer not yet accepting subscriptions — retry.
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs));
  }

  throw new Error(`Indexer did not report funds for ${address.slice(0, 20)}… within ${timeoutMs / 1000}s`);
}
