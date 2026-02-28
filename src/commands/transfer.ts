// transfer command — send NIGHT from my wallet to another address
// Usage: midnight transfer <to> <amount>

import { type ParsedArgs, getFlag } from '../lib/argv.ts';
import { loadWalletConfig } from '../lib/wallet-config.ts';
import { resolveNetwork } from '../lib/resolve-network.ts';
import { parseAmount, executeTransfer } from '../lib/transfer.ts';
import { header, keyValue, divider, formatAddress, successMessage } from '../ui/format.ts';
import { bold, dim } from '../ui/colors.ts';
import { start as startSpinner } from '../ui/spinner.ts';

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
  const walletPath = getFlag(args, 'wallet');
  const config = loadWalletConfig(walletPath);
  const seedBuffer = Buffer.from(config.seed, 'hex');

  // Resolve network
  const { name: networkName, config: networkConfig } = resolveNetwork({
    args,
    walletNetwork: config.network,
    address: config.address,
  });

  // Show header on stderr
  process.stderr.write('\n' + header('Transfer') + '\n\n');
  process.stderr.write(keyValue('Network', networkName) + '\n');
  process.stderr.write(keyValue('From', formatAddress(config.address, true)) + '\n');
  process.stderr.write(keyValue('To', formatAddress(recipientAddress, true)) + '\n');
  process.stderr.write(keyValue('Amount', bold(amountNight + ' NIGHT')) + '\n');
  process.stderr.write('\n');

  const spinner = startSpinner('Starting wallet...');

  try {
    const result = await executeTransfer({
      seedBuffer,
      networkConfig,
      recipientAddress,
      amountNight,
      signal,
      onSync(applied, highest) {
        if (highest > 0) {
          const pct = Math.round((applied / highest) * 100);
          spinner.update(`Syncing wallet... ${pct}%`);
        }
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
    });

    spinner.stop('Transaction submitted');

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
