// dust command — register UTXOs for dust generation and check status
// Usage: midnight dust register | midnight dust status

import * as ledger from '@midnight-ntwrk/ledger-v8';

import { type ParsedArgs, getFlag, hasFlag, isVerbose, isMinimalMode, rejectNoCacheForWrites } from '../lib/argv.ts';
import { UsageError } from '../lib/errors.ts';
import { enableVerbose } from '../lib/verbose.ts';
import { loadWalletConfig, resolveWalletPath } from '../lib/wallet-config.ts';
import { resolveNetwork } from '../lib/resolve-network.ts';
import { applyEndpointOverrides, type NetworkConfig } from '../lib/network.ts';
import { suppressSdkTransientErrors, waitForLiteSyncedState } from '../lib/facade.ts';
import { deriveDustSeed } from '../lib/derivation.ts';
import { ensureDust, suppressRpcNoise } from '../lib/transfer.ts';
import { checkBalance } from '../lib/balance-subscription.ts';
import { dustPublicKeyHex } from '../lib/dust-direct-cache.ts';
import { defaultRepository } from '../lib/wallet-data-repository.ts';
import { header, keyValue, divider, formatDust, successMessage, toDust } from '../ui/format.ts';
import { bold, dim } from '../ui/colors.ts';
import { start as startSpinner } from '../ui/spinner.ts';
import { writeJsonResult } from '../lib/json-output.ts';

export default async function dustCommand(args: ParsedArgs, signal?: AbortSignal): Promise<void> {
  const subcommand = args.subcommand;

  if (!subcommand || (subcommand !== 'register' && subcommand !== 'status')) {
    throw new UsageError(
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
  const minimal = isMinimalMode(args);

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
      printUnregisteredStatus(networkName, preCheck, isJson, minimal);
      return;
    }
    // Registered → read balance directly from indexer (bypasses the dust-wallet
    // SDK's `isConnected` hang). No facade needed for a read-only query.
    const useCache = !hasFlag(args, 'no-cache');
    await dustStatusDirect(seedBuffer, networkConfig, preCheck, isJson, minimal, useCache, signal);
    return;
  }

  // register: full facade flow (requires proof server, keystore, sync).
  // The repo's withFacade owns: validate caches, pre-prime dust, build facade,
  // sync (with retry), save, invalidate, stop. We just provide the work.
  rejectNoCacheForWrites(args);

  const warningRef: { current?: (tag: string, msg: string) => void } = {};
  const unsuppress = suppressSdkTransientErrors((tag, msg) => warningRef.current?.(tag, msg));
  const restoreRpc = suppressRpcNoise();

  try {
    await dustRegister(seedBuffer, networkConfig, isJson, signal, warningRef);
  } finally {
    restoreRpc();
    unsuppress();
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
    spinner.fail('Failed');
    throw err;
  }
}

// Prints the "not registered" status and exits. Called only when registeredUtxos === 0.
function printUnregisteredStatus(
  networkName: string,
  preCheck: PreCheckResult,
  jsonMode: boolean,
  minimal: boolean,
): void {
  const { registeredUtxos, unregisteredUtxos } = preCheck;
  const totalUtxos = registeredUtxos + unregisteredUtxos;

  if (jsonMode) {
    if (minimal) {
      writeJsonResult({
        network: networkName,
        registered: false,
        registeredUtxos,
        unregisteredUtxos,
      });
      return;
    }
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
  seedBuffer: Buffer,
  networkConfig: NetworkConfig,
  jsonMode: boolean,
  signal?: AbortSignal,
  warningRef?: WarningRef,
): Promise<void> {
  const networkName = networkConfig.networkId.toLowerCase();
  process.stderr.write('\n' + header('Dust Register') + '\n\n');
  process.stderr.write(keyValue('Network', networkName) + '\n\n');

  const spinner = startSpinner('Syncing wallet...');
  if (warningRef) {
    warningRef.current = (_tag, msg) => spinner.update(`Syncing wallet... (${msg}, retrying)`);
  }

  try {
    const { result, dustBal } = await defaultRepository().withFacade(
      seedBuffer,
      networkConfig,
      async ({ bundle, state }) => {
        if (signal?.aborted) throw new Error('Operation cancelled');
        spinner.update('Checking dust status...');

        // ensureDust handles: early return if dust exists, registration
        // of unregistered UTXOs, waiting for dust coins.
        const result = await ensureDust(bundle, (status: string) => spinner.update(status), state);

        if (signal?.aborted) throw new Error('Operation cancelled');

        // Wait for dust data to be fully populated before reading balance.
        const finalState = await waitForLiteSyncedState(bundle);
        return { result, dustBal: finalState.dust.balance(new Date()) };
      },
      {
        syncMode: 'lite',
        requireStrictSync: true,
        signal,
        onStatus: (s) => spinner.update(s),
        onSyncProgress: (applied, highest) => {
          if (highest > 0) {
            const pct = Math.min(Math.round((applied / highest) * 100), 100);
            spinner.update(pct >= 100 ? 'Syncing wallet...' : `Syncing wallet... ${pct}%`);
          }
        },
        onSyncDetail: (detail) => spinner.update(`Syncing wallet... (waiting on: ${detail})`),
      },
    );

    spinner.stop(result.alreadyAvailable ? 'Dust already available' : 'Dust registration complete');

    if (jsonMode) {
      const json: Record<string, unknown> = { subcommand: 'register', dustBalance: toDust(dustBal) };
      if (result.txHash) json.txHash = result.txHash;
      writeJsonResult(json);
      return;
    }

    process.stdout.write(dustBal.toString() + '\n');
    process.stderr.write('\n' + successMessage(
      result.alreadyAvailable
        ? `Dust tokens already available: ${formatDust(dustBal)}`
        : `Dust tokens available: ${formatDust(dustBal)}`,
    ) + '\n\n');
  } catch (err) {
    spinner.fail('Failed');
    throw err;
  }
}

// Registered-status path: indexer-direct dust read via the wallet data
// repository. Repo handles cache load/save, in-memory memo, tip-aware
// invalidation, and force-fresh — see lib/wallet-data-repository.ts.
async function dustStatusDirect(
  seedBuffer: Buffer,
  networkConfig: NetworkConfig,
  preCheck: PreCheckResult,
  jsonMode: boolean,
  minimal: boolean,
  useCache: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const networkName = networkConfig.networkId.toLowerCase();
  const spinner = startSpinner(`Reading dust events from ${networkName}...`);

  try {
    const view = await defaultRepository().dust(seedBuffer, networkConfig, {
      forceFresh: !useCache,
      signal,
      onStatus: (msg) => spinner.update(msg),
    });

    spinner.stop(view.fromCache && view.eventsApplied === 0 ? 'Cache up to date' : 'Dust events applied');

    const { registeredUtxos, unregisteredUtxos } = preCheck;

    if (jsonMode) {
      // Slim drops eventsApplied/ownedUtxos/cached/subcommand — internal
      // sync details an agent doesn't need to act on.
      if (minimal) {
        writeJsonResult({
          network: networkName,
          registered: true,
          registeredUtxos,
          unregisteredUtxos,
          dustBalance: toDust(view.balance),
          dustAvailable: view.availableCoins > 0,
        });
        return;
      }
      writeJsonResult({
        subcommand: 'status',
        registered: true,
        registeredUtxos,
        unregisteredUtxos,
        dustBalance: toDust(view.balance),
        dustAvailable: view.availableCoins > 0,
        eventsApplied: view.eventsApplied,
        ownedUtxos: view.ownedUtxoCount,
        cached: view.fromCache,
        network: networkName,
      });
      return;
    }

    // Machine-readable to stdout
    process.stdout.write('registered=yes\n');
    process.stdout.write(`dust=${view.balance}\n`);
    process.stdout.write(`registered_utxos=${registeredUtxos}\n`);
    process.stdout.write(`unregistered_utxos=${unregisteredUtxos}\n`);

    // Formatted to stderr
    process.stderr.write(keyValue('Registered', bold('yes')) + '\n');
    process.stderr.write(keyValue('UTXOs', `${registeredUtxos} registered, ${unregisteredUtxos} unregistered`) + '\n');
    process.stderr.write(keyValue('Dust Balance', bold(formatDust(view.balance))) + '\n');
    process.stderr.write(keyValue('Dust Available', view.availableCoins > 0 ? 'yes' : 'no') + '\n');
    process.stderr.write(keyValue('Events applied', view.eventsApplied.toString() + (view.fromCache ? ' (delta)' : '')) + '\n');
    if (unregisteredUtxos > 0) {
      process.stderr.write('\n' + dim(`${unregisteredUtxos} UTXO(s) not yet registered. Run: midnight dust register`) + '\n');
    }
    process.stderr.write('\n' + divider() + '\n\n');
  } catch (err) {
    spinner.fail('Failed');
    throw err;
  }
}
