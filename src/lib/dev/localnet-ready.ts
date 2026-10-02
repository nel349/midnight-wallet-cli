// Ensures a ledger-9 network is reachable for `mn dev`. This build can't
// start a localnet (no published ledger-9 indexer image), so it requires a
// running stack at the endpoints `undeployed` resolves to (saved config, or
// the single local stack docker shows).

import { resolveNetwork } from '../resolve-network.ts';
import { assertLedger9StackReachable } from '../ledger-guard.ts';

export type LocalnetState = 'already-running';

export interface EnsureLocalnetResult {
  state: LocalnetState;
}

/** Require a running ledger-9 stack; throws with setup instructions if none answers. */
export async function ensureLocalnetRunning(onProgress?: (msg: string) => void): Promise<EnsureLocalnetResult> {
  const { name, config } = resolveNetwork({
    args: { command: 'dev', subcommand: undefined, positionals: [], flags: { network: 'undeployed' } },
  });
  onProgress?.(`Checking the ledger-9 stack at ${config.node}`);
  await assertLedger9StackReachable(name, config);
  return { state: 'already-running' };
}
