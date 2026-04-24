// Node readiness check — Docker healthy ≠ chain ready. Substrate nodes
// finish starting before they've produced block 1, so any command that
// depends on the chain (airdrop needing the genesis UTXO, for instance)
// can race ahead and see an empty chain. This helper polls chain_getHeader
// until a non-zero block number appears.

import { callNodeRpc } from './node-rpc.ts';

export interface WaitForFirstBlockOptions {
  /** Overall deadline for the wait. Default 30s. */
  timeoutMs?: number;
  /** How often to re-poll while waiting. Default 1s. */
  pollIntervalMs?: number;
}

/**
 * Poll `chain_getHeader` until the reported block number is >= 1.
 * Resolves as soon as a block exists; rejects on timeout.
 */
export async function waitForFirstBlock(
  nodeWsUrl: string,
  opts: WaitForFirstBlockOptions = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const header = await callNodeRpc<{ number?: unknown }>(
        { url: nodeWsUrl, timeoutMs: 3_000 },
        'chain_getHeader',
      );
      const hexNumber = typeof header?.number === 'string' ? header.number : '0x0';
      const blockNumber = Number.parseInt(hexNumber, 16);
      if (Number.isFinite(blockNumber) && blockNumber >= 1) return;
    } catch {
      // Node not yet accepting connections — retry.
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs));
  }

  throw new Error(`Node did not produce a block within ${timeoutMs / 1000}s`);
}
