// dust command — register UTXOs for dust generation and check status
// Usage: midnight dust register | midnight dust status

import * as ledger from '@midnight-ntwrk/ledger-v8';

import { type ParsedArgs, getFlag, hasFlag, isVerbose } from '../lib/argv.ts';
import { enableVerbose } from '../lib/verbose.ts';
import { loadWalletConfig, resolveWalletPath } from '../lib/wallet-config.ts';
import { resolveNetwork } from '../lib/resolve-network.ts';
import { applyEndpointOverrides } from '../lib/network.ts';
import { buildFacade, startAndSyncFacade, stopFacade, suppressSdkTransientErrors, waitForLiteSyncedState, type FacadeBundle } from '../lib/facade.ts';
import { deriveDustSeed } from '../lib/derivation.ts';
import { loadWalletCache, saveWalletCache } from '../lib/wallet-cache.ts';
import { ensureDust, suppressRpcNoise } from '../lib/transfer.ts';
import { checkBalance } from '../lib/balance-subscription.ts';
import { readDustBalanceDirect } from '../lib/dust-direct.ts';
import { header, keyValue, divider, formatDust, successMessage, toDust } from '../ui/format.ts';
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
  const walletPath = resolveWalletPath(getFlag(args, 'wallet'));
  const config = loadWalletConfig(walletPath);
  const seedBuffer = Buffer.from(config.seed, 'hex');

  // Resolve network
  const { name: networkName, config: networkConfig } = resolveNetwork({ args });
  const address = config.addresses[networkName];

  // Apply endpoint overrides: --flag > config > network default
  applyEndpointOverrides(networkConfig, {
    proofServer: getFlag(args, 'proof-server'),
    node: getFlag(args, 'node'),
    indexerWS: getFlag(args, 'indexer-ws'),
  });

  if (isVerbose(args)) enableVerbose();
  const isJson = hasFlag(args, 'json');

  // status: pre-check registration via the indexer before paying for a full sync.
  // If the wallet isn't registered, no point doing anything else — return fast.
  if (subcommand === 'status') {
    const preCheck = await dustRegistrationPreCheck(
      address,
      networkName,
      networkConfig.indexerWS,
      signal,
    );
    if (!preCheck.isRegistered) {
      printUnregisteredStatus(networkName, preCheck, isJson);
      return;
    }
    // Registered → read balance directly from indexer (bypasses the dust-wallet
    // SDK's `isConnected` hang). No facade needed for a read-only query.
    await dustStatusDirect(seedBuffer, networkName, networkConfig.indexerWS, preCheck, isJson, signal);
    return;
  }

  // register: full facade flow (requires proof server, keystore, sync).
  const noCache = hasFlag(args, 'no-cache');
  const cache = noCache ? null : loadWalletCache(address, networkName);
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

  try {
    await dustRegister(bundle, networkName, address, noCache, isJson, signal, warningRef);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    restoreRpc();
    unsuppress();
    await cleanup();
  }
}

type WarningRef = { current?: (tag: string, msg: string) => void };

interface PreCheckResult {
  isRegistered: boolean;
  registeredUtxos: number;
  unregisteredUtxos: number;
}

// Queries the indexer directly for UTXO registration metadata — no facade, no dust sync.
// Used to short-circuit `dust status` when the wallet has no registered UTXOs.
async function dustRegistrationPreCheck(
  address: string,
  networkName: string,
  indexerWS: string,
  signal?: AbortSignal,
): Promise<PreCheckResult> {
  process.stderr.write('\n' + header('Dust Status') + '\n\n');
  process.stderr.write(keyValue('Network', networkName) + '\n\n');

  const spinner = startSpinner(`Checking registration on ${networkName}...`);

  try {
    const summary = await checkBalance(address, indexerWS, (current, highest) => {
      if (highest > 0) {
        const pct = Math.min(Math.round((current / highest) * 100), 100);
        spinner.update(pct >= 100 ? 'Checking registration...' : `Checking registration... ${pct}%`);
      }
    });

    if (signal?.aborted) throw new Error('Operation cancelled');

    const { registeredUtxos, unregisteredUtxos } = summary;
    spinner.stop('Registration checked');

    return {
      isRegistered: registeredUtxos > 0,
      registeredUtxos,
      unregisteredUtxos,
    };
  } catch (err) {
    spinner.stop('Failed');
    throw err;
  }
}

// Prints the "not registered" status and exits. Called only when registeredUtxos === 0.
function printUnregisteredStatus(
  networkName: string,
  preCheck: PreCheckResult,
  jsonMode: boolean,
): void {
  const { registeredUtxos, unregisteredUtxos } = preCheck;
  const totalUtxos = registeredUtxos + unregisteredUtxos;

  if (jsonMode) {
    writeJsonResult({
      subcommand: 'status',
      registered: false,
      registeredUtxos,
      unregisteredUtxos,
      network: networkName,
    });
    return;
  }

  // Machine-readable to stdout
  process.stdout.write('registered=no\n');
  process.stdout.write(`registered_utxos=${registeredUtxos}\n`);
  process.stdout.write(`unregistered_utxos=${unregisteredUtxos}\n`);

  // Formatted to stderr
  process.stderr.write(keyValue('Registered', bold('no')) + '\n');
  process.stderr.write(keyValue('UTXOs', `${registeredUtxos} registered, ${unregisteredUtxos} unregistered`) + '\n');

  if (totalUtxos === 0) {
    process.stderr.write('\n' + dim('No NIGHT UTXOs at this address. Fund the wallet first.') + '\n');
  } else {
    process.stderr.write('\n' + dim('Not generating dust. Run: midnight dust register') + '\n');
  }

  process.stderr.write('\n' + divider() + '\n\n');
}

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
      onSyncDetail: (detail) => {
        spinner.update(`Syncing wallet... (waiting on: ${detail})`);
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

// Registered-status path: read dust balance directly from the indexer by
// subscribing to `dustLedgerEvents`, deserializing each raw event, and replaying
// into a fresh DustLocalState. Bypasses the dust-wallet SDK facade entirely —
// no proof server, no keystore, no `isConnected` hang.
async function dustStatusDirect(
  seedBuffer: Buffer,
  networkName: string,
  indexerWS: string,
  preCheck: PreCheckResult,
  jsonMode: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const dustSeed = deriveDustSeed(seedBuffer);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(dustSeed);

  const spinner = startSpinner(`Reading dust events from ${networkName}...`);

  try {
    const result = await readDustBalanceDirect(dustSecretKey, indexerWS, {
      onProgress: (applied, maxId) => {
        if (maxId > 0) {
          spinner.update(`Reading dust events... ${applied}/${maxId + 1}`);
        } else {
          spinner.update(`Reading dust events... ${applied}`);
        }
      },
      signal,
    });

    spinner.stop('Dust events applied');

    const { registeredUtxos, unregisteredUtxos } = preCheck;

    if (jsonMode) {
      writeJsonResult({
        subcommand: 'status',
        registered: true,
        registeredUtxos,
        unregisteredUtxos,
        dustBalance: toDust(result.balance),
        dustAvailable: result.availableCoins > 0,
        eventsApplied: result.eventCount,
        ownedUtxos: result.ownedUtxoCount,
        network: networkName,
      });
      return;
    }

    // Machine-readable to stdout
    process.stdout.write('registered=yes\n');
    process.stdout.write(`dust=${result.balance}\n`);
    process.stdout.write(`registered_utxos=${registeredUtxos}\n`);
    process.stdout.write(`unregistered_utxos=${unregisteredUtxos}\n`);

    // Formatted to stderr
    process.stderr.write(keyValue('Registered', bold('yes')) + '\n');
    process.stderr.write(keyValue('UTXOs', `${registeredUtxos} registered, ${unregisteredUtxos} unregistered`) + '\n');
    process.stderr.write(keyValue('Dust Balance', bold(formatDust(result.balance))) + '\n');
    process.stderr.write(keyValue('Dust Available', result.availableCoins > 0 ? 'yes' : 'no') + '\n');
    process.stderr.write(keyValue('Events applied', result.eventCount.toString()) + '\n');
    if (unregisteredUtxos > 0) {
      process.stderr.write('\n' + dim(`${unregisteredUtxos} UTXO(s) not yet registered. Run: midnight dust register`) + '\n');
    }
    process.stderr.write('\n' + divider() + '\n\n');
  } catch (err) {
    spinner.stop('Failed');
    throw err;
  }
}
