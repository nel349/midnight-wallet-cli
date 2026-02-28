// dust command — register UTXOs for dust generation and check status
// Usage: midnight dust register | midnight dust status

import * as ledger from '@midnight-ntwrk/ledger-v7';
import * as rx from 'rxjs';

import { type ParsedArgs, getFlag } from '../lib/argv.ts';
import { loadWalletConfig } from '../lib/wallet-config.ts';
import { resolveNetwork } from '../lib/resolve-network.ts';
import { buildFacade, startAndSyncFacade, stopFacade, type FacadeBundle } from '../lib/facade.ts';
import { DUST_TIMEOUT_MS, TOKEN_MULTIPLIER } from '../lib/constants.ts';
import { header, keyValue, divider, formatNight, formatDust, successMessage } from '../ui/format.ts';
import { bold, dim } from '../ui/colors.ts';
import { start as startSpinner } from '../ui/spinner.ts';

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

  const bundle = buildFacade(seedBuffer, networkConfig);

  const cleanup = async () => {
    try { await stopFacade(bundle); } catch { /* best-effort */ }
  };

  const onAbort = () => { cleanup(); };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    if (subcommand === 'register') {
      await dustRegister(bundle, networkName, signal);
    } else {
      await dustStatus(bundle, networkName, signal);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await cleanup();
  }
}

async function dustRegister(
  bundle: FacadeBundle,
  networkName: string,
  signal?: AbortSignal,
): Promise<void> {
  process.stderr.write('\n' + header('Dust Register') + '\n\n');
  process.stderr.write(keyValue('Network', networkName) + '\n\n');

  const spinner = startSpinner('Syncing wallet...');

  try {
    await startAndSyncFacade(bundle, (applied, highest) => {
      if (highest > 0) {
        const pct = Math.round((applied / highest) * 100);
        spinner.update(`Syncing wallet... ${pct}%`);
      }
    });

    if (signal?.aborted) throw new Error('Operation cancelled');

    spinner.update('Checking dust status...');

    const state = await rx.firstValueFrom(
      bundle.facade.state().pipe(rx.filter((s) => s.isSynced))
    );

    // Already have dust?
    if (state.dust.availableCoins.length > 0) {
      const dustBal = state.dust.walletBalance(new Date());
      spinner.stop('Dust already available');
      process.stdout.write(dustBal.toString() + '\n');
      process.stderr.write('\n' + successMessage(
        `Dust tokens already available: ${formatDust(dustBal)}`,
      ) + '\n\n');
      return;
    }

    // Find unregistered UTXOs
    const nightUtxos = state.unshielded.availableCoins.filter(
      (coin: any) => coin.meta?.registeredForDustGeneration !== true
    );

    if (nightUtxos.length === 0) {
      spinner.update('All UTXOs already registered, waiting for dust generation...');
    } else {
      spinner.update(`Registering ${nightUtxos.length} UTXO(s) for dust generation...`);

      const recipe = await bundle.facade.registerNightUtxosForDustGeneration(
        nightUtxos,
        bundle.keystore.getPublicKey(),
        (payload) => bundle.keystore.signData(payload)
      );
      const finalized = await bundle.facade.finalizeRecipe(recipe);
      const txHash = await bundle.facade.submitTransaction(finalized);
      spinner.update(`Registration submitted (${txHash.slice(0, 12)}...), waiting for dust...`);
    }

    if (signal?.aborted) throw new Error('Operation cancelled');

    // Wait for dust to generate
    const dustState = await rx.firstValueFrom(
      bundle.facade.state().pipe(
        rx.throttleTime(5_000),
        rx.filter((s) => s.isSynced),
        rx.filter((s) => s.dust.walletBalance(new Date()) > 0n),
        rx.timeout(DUST_TIMEOUT_MS),
      )
    );

    const dustBal = dustState.dust.walletBalance(new Date());
    spinner.stop('Dust registration complete');

    process.stdout.write(dustBal.toString() + '\n');
    process.stderr.write('\n' + successMessage(
      `Dust tokens available: ${formatDust(dustBal)}`,
    ) + '\n\n');
  } catch (err) {
    spinner.stop('Failed');
    throw err;
  }
}

async function dustStatus(
  bundle: FacadeBundle,
  networkName: string,
  signal?: AbortSignal,
): Promise<void> {
  process.stderr.write('\n' + header('Dust Status') + '\n\n');
  process.stderr.write(keyValue('Network', networkName) + '\n\n');

  const spinner = startSpinner('Syncing wallet...');

  try {
    await startAndSyncFacade(bundle, (applied, highest) => {
      if (highest > 0) {
        const pct = Math.round((applied / highest) * 100);
        spinner.update(`Syncing wallet... ${pct}%`);
      }
    });

    if (signal?.aborted) throw new Error('Operation cancelled');

    spinner.update('Checking dust status...');

    const state = await rx.firstValueFrom(
      bundle.facade.state().pipe(rx.filter((s) => s.isSynced))
    );

    const dustBalance = state.dust.walletBalance(new Date());
    const hasAvailableDust = state.dust.availableCoins.length > 0;
    const allUtxos = state.unshielded.availableCoins;
    const unregisteredUtxos = allUtxos.filter(
      (coin: any) => coin.meta?.registeredForDustGeneration !== true
    );
    const registeredCount = allUtxos.length - unregisteredUtxos.length;
    const unshieldedBalance = state.unshielded.balances[ledger.unshieldedToken().raw] ?? 0n;

    spinner.stop('Done');

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
