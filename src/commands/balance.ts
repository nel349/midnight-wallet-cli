// balance command — check unshielded balance via GraphQL subscription
// Reads address from positional arg or wallet file

import { type ParsedArgs, getFlag, hasFlag } from '../lib/argv.ts';
import { loadWalletConfig } from '../lib/wallet-config.ts';
import { resolveNetwork } from '../lib/resolve-network.ts';
import { checkBalance, isNativeToken } from '../lib/balance-subscription.ts';
import { header, keyValue, divider, formatNight, formatAddress, toNight } from '../ui/format.ts';
import { bold, dim } from '../ui/colors.ts';
import { start as startSpinner } from '../ui/spinner.ts';
import { writeJsonResult } from '../lib/json-output.ts';

export default async function balanceCommand(args: ParsedArgs): Promise<void> {
  let address: string | undefined;
  let walletNetwork: string | undefined;

  // Address from positional arg (subcommand position) or wallet file
  if (args.subcommand) {
    address = args.subcommand;
  } else {
    // Load from wallet file
    const walletPath = getFlag(args, 'wallet');
    const config = loadWalletConfig(walletPath);
    address = config.address;
    walletNetwork = config.network;
  }

  if (!address) {
    throw new Error('No address provided and no wallet file found.');
  }

  // Resolve network using address for auto-detection
  const { name: networkName, config: networkConfig } = resolveNetwork({
    args,
    walletNetwork,
    address,
  });

  // Allow --indexer-ws override
  const indexerWsOverride = getFlag(args, 'indexer-ws');
  const indexerWS = indexerWsOverride ?? networkConfig.indexerWS;

  // Spinner on stderr
  const spinner = startSpinner(`Checking balance on ${networkName}...`);

  try {
    const result = await checkBalance(address, indexerWS, (current, highest) => {
      if (highest > 0) {
        const pct = Math.round((current / highest) * 100);
        spinner.update(`Syncing transactions... ${pct}%`);
      }
    });

    spinner.stop(`Synced ${result.txCount} transactions`);

    // JSON mode — balances in NIGHT (not micro-NIGHT)
    if (hasFlag(args, 'json')) {
      const balances: Record<string, string> = {};
      for (const [tokenType, amount] of result.balances) {
        const key = isNativeToken(tokenType) ? 'NIGHT' : tokenType;
        balances[key] = isNativeToken(tokenType) ? toNight(amount) : amount.toString();
      }
      writeJsonResult({
        address,
        network: networkName,
        balances,
        utxoCount: result.utxoCount,
        txCount: result.txCount,
      });
      return;
    }

    // Bare data to stdout (pipeable)
    if (result.balances.size === 0) {
      process.stdout.write('0\n');
    } else {
      for (const [tokenType, amount] of result.balances) {
        if (isNativeToken(tokenType)) {
          process.stdout.write(`NIGHT=${amount}\n`);
        } else {
          process.stdout.write(`${tokenType}=${amount}\n`);
        }
      }
    }

    // Formatted details to stderr
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
