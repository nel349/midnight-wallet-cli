// dust command — register UTXOs for dust generation and check status
// Usage: midnight dust register | midnight dust status

import * as ledger from '@midnight-ntwrk/ledger-v7';

import { type ParsedArgs, getFlag, hasFlag } from '../lib/argv.ts';
import { loadWalletConfig } from '../lib/wallet-config.ts';
import { resolveNetwork } from '../lib/resolve-network.ts';
import { applyEndpointOverrides } from '../lib/network.ts';
import { buildFacade, startAndSyncFacade, stopFacade, suppressSdkTransientErrors, waitForLiteSyncedState, type FacadeBundle } from '../lib/facade.ts';
import { loadWalletCache, saveWalletCache } from '../lib/wallet-cache.ts';
import { ensureDust, suppressRpcNoise } from '../lib/transfer.ts';
import { header, keyValue, divider, formatNight, formatDust, successMessage, toNight, toDust } from '../ui/format.ts';
import { bold, dim } from '../ui/colors.ts';
import { start as startSpinner } from '../ui/spinner.ts';
import { writeJsonResult } from '../lib/json-output.ts';

export default async function dustCommand(args: ParsedArgs, signal?: AbortSignal): Promise<void> {
  const subcommand = args.subcommand;

  if (!subcommand || (subcommand !== 'register' && subcommand !== 'status')) {
    throw new Error(
      'Missing or invalid subcommand.\n' +
      'Usage:\n' +
      '  midnight dust register   Register NIGHT UTXOs for dust generation\n' +
      '  midnight dust status     Check dust registration status'
    );
  }

  // Load wallet config
  const walletPath = getFlag(args, 'wallet');
  const config = loadWalletConfig(walletPath);
  const seedBuffer = Buffer.from(config.seed, 'hex');

  // Resolve network
  const { name: networkName, config: networkConfig } = resolveNetwork({
    args,
    walletNetwork: config.network,
    address: config.address,
  });

  // Apply endpoint overrides: --flag > config > network default
  applyEndpointOverrides(networkConfig, {
    proofServer: getFlag(args, 'proof-server'),
    node: getFlag(args, 'node'),
    indexerWS: getFlag(args, 'indexer-ws'),
  });

  const noCache = hasFlag(args, 'no-cache');

  // Load cached wallet state (unless --no-cache)
  const cache = noCache ? null : loadWalletCache(config.address, networkName);
  const bundle = await buildFacade(seedBuffer, networkConfig, cache);

  const cleanup = async () => {
    try { await stopFacade(bundle); } catch { /* best-effort */ }
  };

  const onAbort = () => { cleanup(); };
  signal?.addEventListener('abort', onAbort, { once: true });

  // Suppress known transient SDK errors (Wallet.Sync: Internal Server Error, etc.)
  const warningRef: { current?: (tag: string, msg: string) => void } = {};
  const unsuppress = suppressSdkTransientErrors((tag, msg) => {
    warningRef.current?.(tag, msg);
  });

  // Suppress polkadot-js RPC-CORE noise (single point for entire command)
  const restoreRpc = suppressRpcNoise();

  const isJson = hasFlag(args, 'json');

  try {
    if (subcommand === 'register') {
      await dustRegister(bundle, networkName, config.address, noCache, isJson, signal, warningRef);
    } else {
      await dustStatus(bundle, networkName, config.address, noCache, isJson, signal, warningRef);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    restoreRpc();
    unsuppress();
    await cleanup();
  }
}

type WarningRef = { current?: (tag: string, msg: string) => void };

async function dustRegister(
  bundle: FacadeBundle,
  networkName: string,
  address: string,
  noCache: boolean,
  jsonMode: boolean,
  signal?: AbortSignal,
  warningRef?: WarningRef,
): Promise<void> {
  process.stderr.write('\n' + header('Dust Register') + '\n\n');
  process.stderr.write(keyValue('Network', networkName) + '\n\n');

  const spinner = startSpinner(bundle.restoredFromCache ? 'Restoring from cache...' : 'Syncing wallet...');
  if (warningRef) {
    warningRef.current = (_tag, msg) => spinner.update(`Syncing wallet... (${msg}, retrying)`);
  }

  try {
    const syncedState = await startAndSyncFacade(bundle, {
      syncMode: 'lite',
      onProgress: (applied, highest) => {
        if (highest > 0) {
          const pct = Math.min(Math.round((applied / highest) * 100), 100);
          spinner.update(pct >= 100 ? 'Syncing wallet...' : `Syncing wallet... ${pct}%`);
        }
      },
    });

    if (signal?.aborted) throw new Error('Operation cancelled');

    spinner.update('Checking dust status...');

    // Use shared ensureDust — handles: early return if dust exists,
    // registration of unregistered UTXOs, waiting for dust coins.
    // Pass syncedState to avoid shareReplay stale-read issue.
    const result = await ensureDust(bundle, (status: string) => {
      spinner.update(status);
    }, syncedState);

    if (signal?.aborted) throw new Error('Operation cancelled');

    // Wait for dust data to be fully populated before reading balance.
    // The lite sync may have resolved via the index fallback before dust
    // events were processed — waitForLiteSyncedState waits for isStrictlyComplete.
    const state = await waitForLiteSyncedState(bundle);
    const dustBal = state.dust.balance(new Date());

    // Save cache after successful sync (unless --no-cache)
    if (!noCache) {
      try { await saveWalletCache(address, networkName, bundle.facade); } catch { /* best-effort */ }
    }

    if (result.alreadyAvailable) {
      spinner.stop('Dust already available');
    } else {
      spinner.stop('Dust registration complete');
    }

    if (jsonMode) {
      const json: Record<string, unknown> = { subcommand: 'register', dustBalance: toDust(dustBal) };
      if (result.txHash) json.txHash = result.txHash;
      writeJsonResult(json);
      return;
    }

    process.stdout.write(dustBal.toString() + '\n');
    if (result.alreadyAvailable) {
      process.stderr.write('\n' + successMessage(
        `Dust tokens already available: ${formatDust(dustBal)}`,
      ) + '\n\n');
    } else {
      process.stderr.write('\n' + successMessage(
        `Dust tokens available: ${formatDust(dustBal)}`,
      ) + '\n\n');
    }
  } catch (err) {
    spinner.stop('Failed');
    throw err;
  }
}

async function dustStatus(
  bundle: FacadeBundle,
  networkName: string,
  address: string,
  noCache: boolean,
  jsonMode: boolean,
  signal?: AbortSignal,
  warningRef?: WarningRef,
): Promise<void> {
  process.stderr.write('\n' + header('Dust Status') + '\n\n');
  process.stderr.write(keyValue('Network', networkName) + '\n\n');

  const spinner = startSpinner(bundle.restoredFromCache ? 'Restoring from cache...' : 'Syncing wallet...');
  if (warningRef) {
    warningRef.current = (_tag, msg) => spinner.update(`Syncing wallet... (${msg}, retrying)`);
  }

  try {
    await startAndSyncFacade(bundle, {
      syncMode: 'lite',
      onProgress: (applied, highest) => {
        if (highest > 0) {
          const pct = Math.min(Math.round((applied / highest) * 100), 100);
          spinner.update(pct >= 100 ? 'Syncing wallet...' : `Syncing wallet... ${pct}%`);
        }
      },
    });

    if (signal?.aborted) throw new Error('Operation cancelled');

    spinner.update('Checking dust status...');

    // Wait for dust data to be fully populated before reading state.
    // The lite sync may have resolved via the index fallback before dust
    // events were processed — waitForLiteSyncedState waits for isStrictlyComplete.
    const state = await waitForLiteSyncedState(bundle);

    // Save cache after successful sync (unless --no-cache)
    if (!noCache) {
      try { await saveWalletCache(address, networkName, bundle.facade); } catch { /* best-effort */ }
    }

    const dustBalance = state.dust.balance(new Date());
    const hasAvailableDust = state.dust.availableCoins.length > 0;
    const allUtxos = state.unshielded.availableCoins;
    const unregisteredUtxos = allUtxos.filter(
      (coin: any) => coin.meta?.registeredForDustGeneration !== true
    );
    const registeredCount = allUtxos.length - unregisteredUtxos.length;
    const unshieldedBalance = state.unshielded.balances[ledger.unshieldedToken().raw] ?? 0n;

    spinner.stop('Done');

    // JSON mode
    if (jsonMode) {
      writeJsonResult({
        subcommand: 'status',
        dustBalance: toDust(dustBalance),
        registered: registeredCount,
        unregistered: unregisteredUtxos.length,
        nightBalance: toNight(unshieldedBalance),
        dustAvailable: hasAvailableDust,
      });
      return;
    }

    // Machine-readable to stdout
    process.stdout.write(`dust=${dustBalance}\n`);
    process.stdout.write(`registered=${registeredCount}\n`);
    process.stdout.write(`unregistered=${unregisteredUtxos.length}\n`);

    // Formatted to stderr
    process.stderr.write(keyValue('NIGHT Balance', bold(formatNight(unshieldedBalance))) + '\n');
    process.stderr.write(keyValue('Dust Balance', bold(formatDust(dustBalance))) + '\n');
    process.stderr.write(keyValue('Dust Available', hasAvailableDust ? 'yes' : 'no') + '\n');
    process.stderr.write(keyValue('Registered', registeredCount.toString() + ' UTXO(s)') + '\n');
    process.stderr.write(keyValue('Unregistered', unregisteredUtxos.length.toString() + ' UTXO(s)') + '\n');
    process.stderr.write('\n' + divider() + '\n\n');
  } catch (err) {
    spinner.stop('Failed');
    throw err;
  }
}
