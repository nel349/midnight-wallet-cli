// Measure the WalletDataRepository's caching wins on preprod dust reads.
//
// Three scenarios, all running against a real preprod indexer with a wallet
// that is already registered for dust generation (the cache layer is
// orthogonal to whether the wallet has dust):
//
//   1. Cold      — disk cache cleared, in-memory empty. First-ever read.
//                  Pre-repo this never completed (180s timeout, 0 events
//                  saved). Post-repo+checkpoint, this completes.
//   2. Disk-warm — separate process, disk cache populated from #1.
//                  Tests the disk-resume path (delta sync from last
//                  applied event id).
//   3. Memo-warm — same process, repo singleton in memory.
//                  Tests the in-memory memo path (tip-aware; no network
//                  if chain tip unchanged).
//
// Wall-clock millis printed for each. Runs with no flags against `alice` on
// preprod by default; override with WALLET / NETWORK env.
//
// Usage: npx tsx scripts/measure-preprod-dust.ts

import { Buffer } from 'node:buffer';
import { existsSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

import { WalletDataRepository, defaultRepository } from '../src/lib/wallet-data-repository.ts';
import { getNetworkConfig, type NetworkName } from '../src/lib/network.ts';
import { loadWalletConfig, resolveWalletPath } from '../src/lib/wallet-config.ts';

const WALLET = (process.env.WALLET ?? 'alice') as string;
const NETWORK = (process.env.NETWORK ?? 'preprod') as NetworkName;

function wipeDustCacheFor(network: string): void {
  const dir = join(homedir(), '.midnight', 'cache', network);
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('dust-') && entry.endsWith('.json')) {
      unlinkSync(join(dir, entry));
    }
  }
}

async function main() {
  const network = getNetworkConfig(NETWORK);
  const wallet = loadWalletConfig(resolveWalletPath(WALLET));
  const seed = Buffer.from(wallet.seed, 'hex');

  console.log(`Wallet:  ${WALLET}`);
  console.log(`Network: ${NETWORK}\n`);

  // Scenario 1: cold (no disk, no memo) — fresh repo, wiped disk cache.
  wipeDustCacheFor(NETWORK);
  const coldRepo = new WalletDataRepository();
  const t1 = Date.now();
  const v1 = await coldRepo.dust(seed, network);
  const cold = Date.now() - t1;
  console.log(`1. Cold (no disk, no memo)    ${cold.toString().padStart(7)}ms  fromCache=${v1.fromCache}  events=${v1.eventsApplied}`);

  // Scenario 2: disk-warm (new process). Spawn a sub-process so the in-memory
  // memo doesn't leak. Disk cache from #1 still present.
  const disk = Number(execSync(
    `npx tsx -e "
      import('./src/lib/wallet-data-repository.ts').then(async (repo) => {
        const { Buffer } = await import('node:buffer');
        const { getNetworkConfig } = await import('./src/lib/network.ts');
        const { loadWalletConfig, resolveWalletPath } = await import('./src/lib/wallet-config.ts');
        const cfg = getNetworkConfig('${NETWORK}');
        const wc = loadWalletConfig(resolveWalletPath('${WALLET}'));
        const seed = Buffer.from(wc.seed, 'hex');
        const t = Date.now();
        await repo.defaultRepository().dust(seed, cfg);
        console.log(Date.now() - t);
        process.exit(0);
      });
    "`,
    { encoding: 'utf-8', cwd: import.meta.dirname + '/..' },
  ).trim());
  console.log(`2. Disk-warm (new process)    ${disk.toString().padStart(7)}ms`);

  // Scenario 3: memo-warm (same process). Use defaultRepository singleton —
  // first call primes the memo (we already did one in scenario 1 against
  // `coldRepo`, but that was a different instance). Prime then measure.
  const memoRepo = defaultRepository();
  await memoRepo.dust(seed, network); // prime
  const t3 = Date.now();
  const v3 = await memoRepo.dust(seed, network);
  const memo = Date.now() - t3;
  console.log(`3. Memo-warm (same process)   ${memo.toString().padStart(7)}ms  fromCache=${v3.fromCache}  events=${v3.eventsApplied}`);

  console.log(`\nSpeedup: cold→disk ${(cold / disk).toFixed(1)}× ; cold→memo ${(cold / Math.max(memo, 1)).toFixed(0)}×`);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
