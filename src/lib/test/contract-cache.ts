// The address a suite's contract was deployed at, kept so the next run of the
// suite reuses the contract (test replay). The file says which network the
// address is on; whether the contract is still there is the caller's to check
// (a local network that was torn down and started again has the same name and
// the same genesis hash, and none of the old contracts).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface ContractCache {
  address: string;
  network: string;
  timestamp: string;
}

function cachePath(dappDir: string, suiteName: string): string {
  return join(dappDir, 'tests', 'results', `.contract-cache-${suiteName}.json`);
}

/** The address cached for this suite on `network`, if any. */
export function loadContractCache(dappDir: string, suiteName: string, network: string): string | undefined {
  const path = cachePath(dappDir, suiteName);
  if (!existsSync(path)) return undefined;

  try {
    const cache: ContractCache = JSON.parse(readFileSync(path, 'utf-8'));
    if (cache.network !== network) return undefined; // Different network — don't reuse
    return cache.address;
  } catch {
    return undefined;
  }
}

export function saveContractCache(dappDir: string, suiteName: string, network: string, address: string): void {
  mkdirSync(join(dappDir, 'tests', 'results'), { recursive: true });
  const cache: ContractCache = { address, network, timestamp: new Date().toISOString() };
  writeFileSync(cachePath(dappDir, suiteName), JSON.stringify(cache, null, 2) + '\n');
}
