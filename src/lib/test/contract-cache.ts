// The address a suite's contract was deployed at, kept so the next run of the
// suite reuses the contract (test replay). An address means something on one
// chain only: `mn localnet down` followed by `up` is a new chain, and a
// contract cached from the old one is not there. The entry records the chain's
// genesis hash and is not used on another chain.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface ContractCache {
  address: string;
  network: string;
  timestamp: string;
  /** Genesis hash of the chain the contract is on. Absent in entries written before it was recorded, or when the node didn't answer. */
  chainId?: string;
}

function cachePath(dappDir: string, suiteName: string): string {
  return join(dappDir, 'tests', 'results', `.contract-cache-${suiteName}.json`);
}

/**
 * The cached address for this suite, when it is for `network` and for the
 * chain `chainId` names. `chainId` is null when the node couldn't be asked:
 * the entry is then used as it is. An entry with no chain recorded can't be
 * checked, so it is trusted only off the local network, whose chain is the
 * one that gets reset.
 */
export function loadContractCache(dappDir: string, suiteName: string, network: string, chainId: string | null): string | undefined {
  const path = cachePath(dappDir, suiteName);
  if (!existsSync(path)) return undefined;

  try {
    const cache: ContractCache = JSON.parse(readFileSync(path, 'utf-8'));
    if (cache.network !== network) return undefined; // Different network — don't reuse
    if (chainId !== null) {
      if (cache.chainId === undefined) return network === 'undeployed' ? undefined : cache.address;
      if (cache.chainId !== chainId) return undefined; // Another chain: the contract isn't on this one
    }
    return cache.address;
  } catch {
    return undefined;
  }
}

export function saveContractCache(dappDir: string, suiteName: string, network: string, address: string, chainId: string | null): void {
  mkdirSync(join(dappDir, 'tests', 'results'), { recursive: true });
  const cache: ContractCache = { address, network, timestamp: new Date().toISOString() };
  if (chainId !== null) cache.chainId = chainId;
  writeFileSync(cachePath(dappDir, suiteName), JSON.stringify(cache, null, 2) + '\n');
}
