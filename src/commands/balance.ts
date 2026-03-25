// balance command — check unshielded + shielded balance via full wallet sync
// For positional address: unshielded only (GraphQL, no facade needed)

import * as ledger from '@midnight-ntwrk/ledger-v8';
import { MidnightBech32m } from '@midnight-ntwrk/wallet-sdk-address-format';
import { type ParsedArgs, getFlag, hasFlag } from '../lib/argv.ts';
import { loadWalletConfig, resolveWalletPath, saveShieldedAddress } from '../lib/wallet-config.ts';
import { resolveNetwork } from '../lib/resolve-network.ts';
import { applyEndpointOverrides } from '../lib/network.ts';
import { getNetworkId } from '../lib/network-id.ts';
import { checkBalance, isNativeToken } from '../lib/balance-subscription.ts';
import { buildFacade, startAndSyncFacade, stopFacade, suppressSdkTransientErrors, type FacadeBundle } from '../lib/facade.ts';
import { loadWalletCache, saveWalletCache } from '../lib/wallet-cache.ts';
import { suppressRpcNoise } from '../lib/transfer.ts';
import { header, keyValue, divider, formatNight, formatAddress, toNight } from '../ui/format.ts';
import { bold, dim } from '../ui/colors.ts';
import { start as startSpinner } from '../ui/spinner.ts';
import { writeJsonResult } from '../lib/json-output.ts';

export default async function balanceCommand(args: ParsedArgs): Promise<void> {
  // Positional address → unshielded only (lightweight, no facade)
  if (args.subcommand) {
    return addressBalance(args);
  }

  // Wallet-based → full sync, show both unshielded + shielded
  return walletBalance(args);
}

// ── Positional address: unshielded only via GraphQL ──

async function addressBalance(args: ParsedArgs): Promise<void> {
  const address = args.subcommand!;
  const { name: networkName, config: networkConfig } = resolveNetwork({ args });

  applyEndpointOverrides(networkConfig, {
    proofServer: getFlag(args, 'proof-server'),
    node: getFlag(args, 'node'),
    indexerWS: getFlag(args, 'indexer-ws'),
  });

  const spinner = startSpinner(`Checking balance on ${networkName}...`);

  try {
    const result = await checkBalance(address, networkConfig.indexerWS, (current, highest) => {
      if (highest > 0) {
        const pct = Math.round((current / highest) * 100);
        spinner.update(`Syncing transactions... ${pct}%`);
      }
    });

    spinner.stop(`Synced ${result.txCount} transactions`);

    if (hasFlag(args, 'json')) {
      const balances: Record<string, string> = {};
      for (const [tokenType, amount] of result.balances) {
        const key = isNativeToken(tokenType) ? 'NIGHT' : tokenType;
        balances[key] = isNativeToken(tokenType) ? toNight(amount) : amount.toString();
      }
      writeJsonResult({ address, network: networkName, balances, utxoCount: result.utxoCount, txCount: result.txCount });
      return;
    }

    if (result.balances.size === 0) {
      process.stdout.write('0\n');
    } else {
      for (const [tokenType, amount] of result.balances) {
        process.stdout.write(`${isNativeToken(tokenType) ? 'NIGHT' : tokenType}=${amount}\n`);
      }
    }

    process.stderr.write('\n' + header('Balance') + '\n\n');
    process.stderr.write(keyValue('Address', formatAddress(address)) + '\n');
    process.stderr.write(keyValue('Network', networkName) + '\n');
    process.stderr.write(keyValue('UTXOs', result.utxoCount.toString()) + '\n');
    process.stderr.write(keyValue('Transactions', result.txCount.toString()) + '\n');
    process.stderr.write('\n');

    if (result.balances.size === 0) {
      process.stderr.write(`  ${dim('No balance found')}\n`);
    } else {
      for (const [tokenType, amount] of result.balances) {
        if (isNativeToken(tokenType)) {
          process.stderr.write(keyValue('NIGHT', bold(formatNight(amount))) + '\n');
        } else {
          const shortType = tokenType.slice(0, 8) + '…' + tokenType.slice(-8);
          process.stderr.write(keyValue(`Token ${shortType}`, bold(amount.toString())) + '\n');
        }
      }
    }

    process.stderr.write('\n' + divider() + '\n\n');
  } catch (err) {
    spinner.stop('Failed');
    throw err;
  }
}

// ── Wallet-based: full facade sync, both unshielded + shielded ──

async function walletBalance(args: ParsedArgs): Promise<void> {
  const { name: networkName, config: networkConfig } = resolveNetwork({ args });
  const walletPath = resolveWalletPath(getFlag(args, 'wallet'));
  const config = loadWalletConfig(walletPath);
  const seedBuffer = Buffer.from(config.seed, 'hex');
  const address = config.addresses[networkName];

  applyEndpointOverrides(networkConfig, {
    proofServer: getFlag(args, 'proof-server'),
    node: getFlag(args, 'node'),
    indexerWS: getFlag(args, 'indexer-ws'),
  });

  const unsuppress = suppressSdkTransientErrors();
  const restoreRpc = suppressRpcNoise();
  const noCache = hasFlag(args, 'no-cache');
  const cache = noCache ? null : loadWalletCache(address, networkName);
  const spinner = startSpinner(`Syncing wallet on ${networkName}...`);

  let bundle: FacadeBundle | undefined;

  try {
    bundle = await buildFacade(seedBuffer, networkConfig, cache);
    if (bundle.restoredFromCache) spinner.update('Restoring from cache...');

    const state = await startAndSyncFacade(bundle, {
      syncMode: 'full',
      onProgress: (applied, highest) => {
        if (highest > 0) {
          const pct = Math.min(Math.round((applied / highest) * 100), 100);
          spinner.update(pct >= 100 ? 'Syncing wallet...' : `Syncing wallet... ${pct}%`);
        }
      },
      onSyncDetail: (detail) => spinner.update(`Syncing wallet... (waiting on: ${detail})`),
    });

    spinner.stop('Synced');

    // Save cache + shielded address
    if (!noCache) {
      try { await saveWalletCache(address, networkName, bundle.facade); } catch { /* best-effort */ }
    }
    const networkId = getNetworkId(networkConfig.networkId);
    const shieldedAddrStr = MidnightBech32m.encode(networkId, state.shielded.address).asString();
    saveShieldedAddress(walletPath, shieldedAddrStr);

    // Extract balances
    const nightToken = ledger.unshieldedToken().raw;
    const unshieldedBalance = state.unshielded.balances[nightToken] ?? 0n;
    const shieldedBalance = state.shielded.balances[nightToken] ?? 0n;
    const unshieldedUtxos = state.unshielded.availableCoins?.length ?? 0;
    const shieldedCoins = state.shielded.availableCoins.length;
    const pendingCoins = state.shielded.pendingCoins.length;

    // JSON mode
    if (hasFlag(args, 'json')) {
      writeJsonResult({
        address,
        shieldedAddress: shieldedAddrStr,
        network: networkName,
        unshielded: { NIGHT: toNight(unshieldedBalance), utxoCount: unshieldedUtxos },
        shielded: { NIGHT: toNight(shieldedBalance), availableCoins: shieldedCoins, pendingCoins },
      });
      return;
    }

    // Bare data to stdout (pipeable)
    process.stdout.write(`NIGHT=${unshieldedBalance}\n`);
    process.stdout.write(`SHIELDED_NIGHT=${shieldedBalance}\n`);

    // Formatted to stderr
    process.stderr.write('\n' + header('Balance') + '\n\n');
    process.stderr.write(keyValue('Address', formatAddress(address)) + '\n');
    process.stderr.write(keyValue('Shielded', formatAddress(shieldedAddrStr)) + '\n');
    process.stderr.write(keyValue('Network', networkName) + '\n');

    process.stderr.write('\n  ' + bold('Unshielded') + '\n');
    if (unshieldedBalance > 0n) {
      process.stderr.write(keyValue('  NIGHT', bold(formatNight(unshieldedBalance))) + '\n');
      process.stderr.write(keyValue('  UTXOs', unshieldedUtxos.toString()) + '\n');
    } else {
      process.stderr.write(`    ${dim('No unshielded balance')}\n`);
    }

    process.stderr.write('\n  ' + bold('Shielded') + '\n');
    if (shieldedBalance > 0n) {
      process.stderr.write(keyValue('  NIGHT', bold(formatNight(shieldedBalance))) + '\n');
      process.stderr.write(keyValue('  Coins', `${shieldedCoins} available, ${pendingCoins} pending`) + '\n');
    } else {
      process.stderr.write(`    ${dim('No shielded balance')}\n`);
    }

    process.stderr.write('\n' + divider() + '\n\n');
  } catch (err) {
    spinner.stop('Failed');
    throw err;
  } finally {
    if (bundle) await stopFacade(bundle);
    restoreRpc();
    unsuppress();
  }
}
