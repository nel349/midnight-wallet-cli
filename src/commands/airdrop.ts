// airdrop command — fund wallet from genesis wallet (seed 0x01)
// Only works on undeployed network (local devnet)

import { type ParsedArgs, getFlag, hasFlag } from '../lib/argv.ts';
import { loadWalletConfig } from '../lib/wallet-config.ts';
import { resolveNetwork } from '../lib/resolve-network.ts';
import { GENESIS_SEED } from '../lib/constants.ts';
import { parseAmount, executeTransfer } from '../lib/transfer.ts';
import { header, keyValue, divider, formatNight, formatAddress, successMessage } from '../ui/format.ts';
import { bold, dim } from '../ui/colors.ts';
import { start as startSpinner } from '../ui/spinner.ts';
import { writeJsonResult } from '../lib/json-output.ts';

export default async function airdropCommand(args: ParsedArgs, signal?: AbortSignal): Promise<void> {
  // Amount is the subcommand (first positional after 'airdrop')
  const amountStr = args.subcommand;
  if (!amountStr) {
    throw new Error(
      'Missing amount.\n' +
      'Usage: midnight airdrop <amount>\n' +
      'Example: midnight airdrop 1000'
    );
  }

  const amountNight = parseAmount(amountStr);

  // Load wallet config to get recipient address and network
  const walletPath = getFlag(args, 'wallet');
  const config = loadWalletConfig(walletPath);

  // Resolve network — must be undeployed
  const { name: networkName, config: networkConfig } = resolveNetwork({
    args,
    walletNetwork: config.network,
    address: config.address,
  });

  if (networkName !== 'undeployed') {
    throw new Error(
      `Airdrop is only available on the "undeployed" network (local devnet).\n` +
      `Current network: "${networkName}"\n` +
      `On preprod/preview, use a faucet or transfer from another wallet.`
    );
  }

  const recipientAddress = config.address;
  const genesisSeedBuffer = Buffer.from(GENESIS_SEED, 'hex');

  // Show header on stderr
  process.stderr.write('\n' + header('Airdrop') + '\n\n');
  process.stderr.write(keyValue('Network', networkName) + '\n');
  process.stderr.write(keyValue('From', dim('genesis (seed 0x01)')) + '\n');
  process.stderr.write(keyValue('To', formatAddress(recipientAddress, true)) + '\n');
  process.stderr.write(keyValue('Amount', bold(amountNight + ' NIGHT')) + '\n');
  process.stderr.write('\n');

  const spinner = startSpinner('Starting genesis wallet...');

  try {
    const result = await executeTransfer({
      seedBuffer: genesisSeedBuffer,
      networkConfig,
      recipientAddress,
      amountNight,
      signal,
      onSync(applied, highest) {
        if (highest > 0) {
          const pct = Math.round((applied / highest) * 100);
          spinner.update(`Syncing genesis wallet... ${pct}%`);
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
      onSyncWarning(_tag, msg) {
        spinner.update(`Syncing genesis wallet... (${msg}, retrying)`);
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
      `Airdropped ${amountNight} NIGHT to your wallet`,
      result.txHash,
    ) + '\n');
    process.stderr.write('\n' + divider() + '\n');
    process.stderr.write(dim('  Verify: midnight balance') + '\n\n');
  } catch (err) {
    spinner.stop('Failed');
    if (err instanceof Error && err.message.toLowerCase().includes('dust')) {
      throw new Error(
        `${err.message}\n\n` +
        `On a fresh localnet, the minimum airdrop is ~1 NIGHT.\n` +
        `Try: midnight airdrop 1`
      );
    }
    throw err;
  }
}
