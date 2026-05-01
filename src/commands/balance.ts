// balance command — check unshielded + shielded balance via full wallet sync
// For positional address: unshielded only (GraphQL, no facade needed)

import * as ledger from '@midnight-ntwrk/ledger-v8';
import { MidnightBech32m } from '@midnight-ntwrk/wallet-sdk-address-format';
import { type ParsedArgs, getFlag, hasFlag, isMinimalMode, isVerbose } from '../lib/argv.ts';
import { enableVerbose, verbose } from '../lib/verbose.ts';
import { type NetworkName, isValidNetworkName } from '../lib/network.ts';
import { loadWalletConfig, resolveWalletPath, saveShieldedAddress } from '../lib/wallet-config.ts';
import { resolveNetwork } from '../lib/resolve-network.ts';
import { applyEndpointOverrides } from '../lib/network.ts';
import { getNetworkId } from '../lib/network-id.ts';
import { isNativeToken } from '../lib/balance-subscription.ts';
import { defaultRepository } from '../lib/wallet-data-repository.ts';
import { suppressSdkTransientErrors } from '../lib/facade.ts';
import { createEtaEstimator, formatSyncStatus } from '../lib/sync-eta.ts';
import { suppressRpcNoise } from '../lib/transfer.ts';
import { header, keyValue, divider, formatNight, formatAddress, toNight } from '../ui/format.ts';
import { bold, dim } from '../ui/colors.ts';
import { start as startSpinner, type Spinner } from '../ui/spinner.ts';
import { writeJsonResult } from '../lib/json-output.ts';

export default async function balanceCommand(args: ParsedArgs): Promise<void> {
  // Positional address → unshielded only (lightweight, no facade)
  if (args.subcommand) {
    return addressBalance(args);
  }

  // Wallet-based → full sync, show both unshielded + shielded
  return walletBalance(args);
}

/**
 * Pull the network name out of a Bech32m address HRP. Addresses look like
 * `mn_addr_<network>1...` so we slice between the second underscore and the
 * `1` separator. Returns null when the format doesn't match a known network.
 */
function inferNetworkFromAddress(address: string): NetworkName | null {
  const match = address.match(/^mn_addr_([a-z]+)1/);
  if (!match) return null;
  const candidate = match[1];
  return isValidNetworkName(candidate) ? candidate : null;
}

// ── Positional address: unshielded only via GraphQL ──

async function addressBalance(args: ParsedArgs): Promise<void> {
  if (isVerbose(args)) enableVerbose();
  const address = args.subcommand!;
  verbose('balance', `address=${address}`);

  // Bech32m addresses encode the network in their HRP
  // (mn_addr_undeployed1..., mn_addr_preprod1..., mn_addr_preview1...).
  // When the caller didn't pass --network, infer from the address rather
  // than defaulting to whatever the config says — otherwise users hit a
  // confusing "expected HRP X, but was Y" error from the indexer.
  // When --network is explicit and disagrees with the HRP, fail loudly so
  // the mismatch surfaces at the CLI layer instead of as a GraphQL error.
  const inferredNetwork = inferNetworkFromAddress(address);
  const explicitNetwork = getFlag(args, 'network');
  if (explicitNetwork && inferredNetwork && explicitNetwork !== inferredNetwork) {
    throw new Error(
      `Address belongs to ${inferredNetwork} but --network is ${explicitNetwork}.\n` +
      `Drop --network (we'll infer from the address) or pass an address for ${explicitNetwork}.`
    );
  }
  if (!explicitNetwork && inferredNetwork) {
    args = { ...args, flags: { ...args.flags, network: inferredNetwork } };
  }

  const { name: networkName, config: networkConfig } = resolveNetwork({ args });

  applyEndpointOverrides(networkConfig, {
    proofServer: getFlag(args, 'proof-server'),
    node: getFlag(args, 'node'),
    indexerWS: getFlag(args, 'indexer-ws'),
  });

  const spinner = startSpinner(`Checking balance on ${networkName}...`);

  try {
    const result = await defaultRepository().unshielded(address, networkConfig, {
      forceFresh: hasFlag(args, 'no-cache'),
      onProgress: (current, highest) => {
        if (highest > 0) {
          const pct = Math.round((current / highest) * 100);
          spinner.update(`Syncing transactions... ${pct}%`);
        }
      },
    });

    spinner.stop(`Synced ${result.txCount} transactions`);

    if (hasFlag(args, 'json')) {
      const balances: Record<string, string> = {};
      for (const [tokenType, amount] of result.balances) {
        const key = isNativeToken(tokenType) ? 'NIGHT' : tokenType;
        balances[key] = isNativeToken(tokenType) ? toNight(amount) : amount.toString();
      }
      // Top-level NIGHT alias mirrors the nested balances.NIGHT for
      // consumers that read the flat shape (midnight-expert's session
      // health hook does jq '.balance // .NIGHT // "unknown"'). The
      // nested form remains the canonical source of truth.
      const nightAlias = balances.NIGHT !== undefined ? { NIGHT: balances.NIGHT } : {};
      // Slim drops the (long) address echo and txCount — agents already
      // know what they asked for, and txCount is an internal sync detail.
      if (isMinimalMode(args)) {
        writeJsonResult({ network: networkName, balances, ...nightAlias, utxoCount: result.utxoCount });
        return;
      }
      writeJsonResult({ address, network: networkName, balances, ...nightAlias, utxoCount: result.utxoCount, txCount: result.txCount });
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
    spinner.fail('Failed');
    throw err;
  }
}

// ── Wallet-based: full facade sync, both unshielded + shielded ──

async function walletBalance(args: ParsedArgs): Promise<void> {
  if (isVerbose(args)) enableVerbose();
  const { name: networkName, config: networkConfig } = resolveNetwork({ args });
  verbose('balance', `network=${networkName} indexerWS=${networkConfig.indexerWS}`);
  const walletPath = resolveWalletPath(getFlag(args, 'wallet'));
  verbose('balance', `wallet path=${walletPath}`);
  const config = loadWalletConfig(walletPath);
  const seedBuffer = Buffer.from(config.seed, 'hex');
  const address = config.addresses[networkName];
  const shieldedAddrStr = config.shieldedAddresses?.[networkName] ?? '';

  applyEndpointOverrides(networkConfig, {
    proofServer: getFlag(args, 'proof-server'),
    node: getFlag(args, 'node'),
    indexerWS: getFlag(args, 'indexer-ws'),
  });

  const unsuppress = suppressSdkTransientErrors();
  const restoreRpc = suppressRpcNoise();
  const noCache = hasFlag(args, 'no-cache');
  const isJson = hasFlag(args, 'json');
  const nightToken = ledger.unshieldedToken().raw;

  let activeSpinner: Spinner | null = null;

  try {

    // Header + address chrome (we already have everything except live balances).
    if (!isJson) {
      process.stderr.write('\n' + header('Balance') + '\n\n');
      process.stderr.write(keyValue('Address', formatAddress(address)) + '\n');
      if (shieldedAddrStr) {
        process.stderr.write(keyValue('Shielded', formatAddress(shieldedAddrStr)) + '\n');
      }
      process.stderr.write(keyValue('Network', networkName) + '\n');
      process.stderr.write('\n  ' + bold('Unshielded') + '\n');
    }

    // ── Phase 1: fast unshielded via GraphQL (no facade, no proof server) ──
    if (!isJson) activeSpinner = startSpinner('Checking unshielded...');
    verbose('balance', `phase=unshielded forceFresh=${noCache}`);
    const unshieldedResult = await defaultRepository().unshielded(address, networkConfig, {
      forceFresh: noCache,
      // Quiet by design — this finishes in <1s on most networks.
    });
    const unshieldedBalance = unshieldedResult.balances.get(nightToken) ?? 0n;
    const unshieldedUtxos = unshieldedResult.utxoCount;
    verbose('balance', `unshielded fromCache=${unshieldedResult.fromCache} utxos=${unshieldedUtxos} txs=${unshieldedResult.txCount}`);

    if (activeSpinner) {
      activeSpinner.stop('Unshielded ready');
      activeSpinner = null;
      if (unshieldedBalance > 0n) {
        process.stderr.write(keyValue('  NIGHT', bold(formatNight(unshieldedBalance))) + '\n');
        process.stderr.write(keyValue('  UTXOs', unshieldedUtxos.toString()) + '\n');
      } else {
        process.stderr.write(`    ${dim('No unshielded balance')}\n`);
      }
    }

    // Pipeable stdout for unshielded — emit immediately so consumers don't
    // have to wait for the shielded sync to read the unshielded value.
    if (!isJson) {
      process.stdout.write(`NIGHT=${unshieldedBalance}\n`);
      process.stderr.write('\n  ' + bold('Shielded') + '\n');
    }

    // ── Phase 2: shielded via facade sync (slower — needs ZK keys + WASM state) ──
    if (!isJson) activeSpinner = startSpinner('Syncing shielded...');

    const eta = createEtaEstimator();
    const networkId = getNetworkId(networkConfig.networkId);
    const { liveShieldedAddrStr, shieldedBalance, shieldedCoins, pendingCoins } =
      await defaultRepository().withFacade(
        seedBuffer,
        networkConfig,
        async ({ state }) => {
          const liveShieldedAddrStr = MidnightBech32m.encode(networkId, state.shielded.address).asString();
          saveShieldedAddress(walletPath, networkName, liveShieldedAddrStr);
          return {
            liveShieldedAddrStr,
            shieldedBalance: state.shielded.balances[nightToken] ?? 0n,
            shieldedCoins: state.shielded.availableCoins.length,
            pendingCoins: state.shielded.pendingCoins.length,
          };
        },
        {
          // Balance reads NIGHT from unshielded + shielded; dust isn't needed and
          // skipping it avoids the dust isConnected SDK hang on hosted networks.
          syncMode: 'no-dust',
          // requireStrictSync: false because this is a read; opt out of write-mode
          // so the repo skips the dust pre-prime and the cold-start race retry.
          requireStrictSync: false,
          readOnly: true,
          forceFresh: noCache,
          onSyncProgress: (applied, highest) => {
            if (!activeSpinner) return;
            const snap = eta.sample({ applied, highest, t: Date.now() });
            activeSpinner.update(formatSyncStatus(snap, 'Syncing shielded'));
          },
          onSyncDetail: (detail) => activeSpinner?.update(`Syncing shielded (waiting on: ${detail})`),
        },
      );

    if (activeSpinner) {
      activeSpinner.stop('Shielded ready');
      activeSpinner = null;
      if (shieldedBalance > 0n) {
        process.stderr.write(keyValue('  NIGHT', bold(formatNight(shieldedBalance))) + '\n');
        process.stderr.write(keyValue('  Coins', `${shieldedCoins} available, ${pendingCoins} pending`) + '\n');
      } else {
        process.stderr.write(`    ${dim('No shielded balance')}\n`);
      }
    }

    if (isJson) {
      // Slim drops the unshielded + shielded address strings (~220 chars
      // combined). Agents already know which wallet they queried.
      if (isMinimalMode(args)) {
        writeJsonResult({
          network: networkName,
          unshielded: { NIGHT: toNight(unshieldedBalance), utxoCount: unshieldedUtxos },
          shielded: { NIGHT: toNight(shieldedBalance), availableCoins: shieldedCoins, pendingCoins },
        });
        return;
      }
      writeJsonResult({
        address,
        shieldedAddress: liveShieldedAddrStr,
        network: networkName,
        unshielded: { NIGHT: toNight(unshieldedBalance), utxoCount: unshieldedUtxos },
        shielded: { NIGHT: toNight(shieldedBalance), availableCoins: shieldedCoins, pendingCoins },
      });
      return;
    }

    process.stdout.write(`SHIELDED_NIGHT=${shieldedBalance}\n`);
    process.stderr.write('\n' + divider() + '\n\n');
  } catch (err) {
    activeSpinner?.fail('Failed');
    throw err;
  } finally {
    restoreRpc();
    unsuppress();
  }
}
