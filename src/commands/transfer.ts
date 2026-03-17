// transfer command — send NIGHT from my wallet to another address
// Usage: midnight transfer <to> <amount>

import { type ParsedArgs, getFlag, hasFlag, isVerbose } from '../lib/argv.ts';
import { enableVerbose } from '../lib/verbose.ts';
import { loadWalletConfig, resolveWalletPath } from '../lib/wallet-config.ts';
import { resolveNetwork } from '../lib/resolve-network.ts';
import { applyEndpointOverrides } from '../lib/network.ts';
import { loadWalletCache, saveWalletCache } from '../lib/wallet-cache.ts';
import { parseAmount, executeTransfer } from '../lib/transfer.ts';
import { header, keyValue, divider, formatAddress, successMessage } from '../ui/format.ts';
import { bold, dim } from '../ui/colors.ts';
import { start as startSpinner } from '../ui/spinner.ts';
import { writeJsonResult } from '../lib/json-output.ts';

export default async function transferCommand(args: ParsedArgs, signal?: AbortSignal): Promise<void> {
  // Recipient is subcommand, amount is first positional
  const recipientAddress = args.subcommand;
  const amountStr = args.positionals[0];

  if (!recipientAddress) {
    throw new Error(
      'Missing recipient address.\n' +
      'Usage: midnight transfer <to> <amount>\n' +
      'Example: midnight transfer mn_addr_undeployed1... 100'
    );
  }

  if (!amountStr) {
    throw new Error(
      'Missing amount.\n' +
      'Usage: midnight transfer <to> <amount>\n' +
      'Example: midnight transfer mn_addr_undeployed1... 100'
    );
  }

  const amountNight = parseAmount(amountStr);

  // Load wallet config to get sender seed
  const walletPath = resolveWalletPath(getFlag(args, 'wallet'));
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

  // Show header on stderr
  process.stderr.write('\n' + header('Transfer') + '\n\n');
  process.stderr.write(keyValue('Network', networkName) + '\n');
  process.stderr.write(keyValue('From', formatAddress(config.address, true)) + '\n');
  process.stderr.write(keyValue('To', formatAddress(recipientAddress, true)) + '\n');
  process.stderr.write(keyValue('Amount', bold(amountNight + ' NIGHT')) + '\n');
  process.stderr.write('\n');

  const noCache = hasFlag(args, 'no-cache');
  if (isVerbose(args)) enableVerbose();
  const spinner = startSpinner('Starting wallet...');

  try {
    const result = await executeTransfer({
      seedBuffer,
      networkConfig,
      recipientAddress,
      amountNight,
      signal,
      noCache,
      walletAddress: config.address,
      networkName,
      onSync(applied, highest) {
        if (highest > 0) {
          const pct = Math.min(Math.round((applied / highest) * 100), 100);
          spinner.update(pct >= 100 ? 'Syncing wallet...' : `Syncing wallet... ${pct}%`);
        }
      },
      onSyncDetail(detail) {
        spinner.update(`Syncing wallet... (waiting on: ${detail})`);
      },
      onDust(status) {
        spinner.update(`Dust: ${status}`);
      },
      onProving() {
        spinner.update('Generating ZK proof (this may take a few minutes)...');
      },
      onSubmitting() {
        spinner.update('Submitting transaction...');
      },
      onSyncWarning(_tag, msg) {
        spinner.update(`Syncing wallet... (${msg}, retrying)`);
      },
    });

    spinner.stop('Transaction submitted');

    // JSON mode
    if (hasFlag(args, 'json')) {
      writeJsonResult({
        txHash: result.txHash,
        amount: amountNight,
        recipient: recipientAddress,
        network: networkName,
      });
      return;
    }

    // Tx hash to stdout (pipeable)
    process.stdout.write(result.txHash + '\n');

    // Summary to stderr
    process.stderr.write('\n' + successMessage(
      `Transferred ${amountNight} NIGHT`,
      result.txHash,
    ) + '\n');
    process.stderr.write('\n' + divider() + '\n');
    process.stderr.write(dim('  Verify: midnight balance') + '\n\n');
  } catch (err) {
    spinner.stop('Failed');
    throw err;
  }
}
