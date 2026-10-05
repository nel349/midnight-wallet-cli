// transfer command — send NIGHT from my wallet to another address
// Usage: midnight transfer <to> <amount> [--shielded]

import * as ledger from '@midnightntwrk/ledger-v9';
import { MidnightBech32m } from '@midnightntwrk/wallet-sdk/address-format';
import { type ParsedArgs, getFlag, hasFlag, isVerbose, rejectNoCacheForWrites } from '../lib/argv.ts';
import { enableVerbose } from '../lib/verbose.ts';
import { saveShieldedAddress } from '../lib/wallet-config.ts';
import { resolveNetwork } from '../lib/resolve-network.ts';
import { applyEndpointOverrides } from '../lib/network.ts';
import { getNetworkId } from '../lib/network-id.ts';
import { resolveTransferRequest, decodeShieldedRecipient, type TransferRequest } from '../lib/transfer-request.ts';
import { nightToMicro, executeTransfer, ensureDust, suppressRpcNoise } from '../lib/transfer.ts';
import { suppressSdkTransientErrors } from '../lib/facade.ts';
import { defaultRepository } from '../lib/wallet-data-repository.ts';
import { header, keyValue, divider, formatAddress, successMessage } from '../ui/format.ts';
import { bold, dim } from '../ui/colors.ts';
import { start as startSpinner, trackElapsed } from '../ui/spinner.ts';
import { writeJsonResult } from '../lib/json-output.ts';

export default async function transferCommand(args: ParsedArgs, signal?: AbortSignal): Promise<void> {
  rejectNoCacheForWrites(args);
  const request = resolveTransferRequest(args);
  return request.shielded ? shieldedTransfer(args, request, signal) : unshieldedTransfer(args, request, signal);
}

// ── Unshielded transfer (existing flow) ──

async function unshieldedTransfer(
  args: ParsedArgs,
  { walletConfig: config, recipientAddress, amountNight }: TransferRequest,
  signal?: AbortSignal,
): Promise<void> {
  const seedBuffer = Buffer.from(config.seed, 'hex');

  const { name: networkName, config: networkConfig } = resolveNetwork({ args });
  const address = config.addresses[networkName];

  applyEndpointOverrides(networkConfig, {
    proofServer: getFlag(args, 'proof-server'),
    node: getFlag(args, 'node'),
    indexerWS: getFlag(args, 'indexer-ws'),
  }, networkName);

  process.stderr.write('\n' + header('Transfer') + '\n\n');
  process.stderr.write(keyValue('Network', networkName) + '\n');
  process.stderr.write(keyValue('From', formatAddress(address, true)) + '\n');
  process.stderr.write(keyValue('To', formatAddress(recipientAddress, true)) + '\n');
  process.stderr.write(keyValue('Amount', bold(amountNight + ' NIGHT')) + '\n');
  process.stderr.write('\n');

  if (isVerbose(args)) enableVerbose();
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
        spinner.update('Submitting and waiting for finalization (typically 12 to 30s)...');
      },
      onSubmittingTick(elapsedMs: number) {
        const s = Math.floor(elapsedMs / 1000);
        const mm = Math.floor(s / 60).toString().padStart(2, '0');
        const ss = (s % 60).toString().padStart(2, '0');
        spinner.update(`Submitting and waiting for finalization... ${mm}:${ss} elapsed (typically 12 to 30s)`);
      },
      onSyncWarning(_tag, msg) {
        spinner.update(`Syncing wallet... (${msg}, retrying)`);
      },
    });

    spinner.stop('Transaction submitted');

    if (hasFlag(args, 'json')) {
      writeJsonResult({
        txHash: result.txHash,
        amount: amountNight,
        recipient: recipientAddress,
        network: networkName,
      });
      return;
    }

    process.stdout.write(result.txHash + '\n');

    process.stderr.write('\n' + successMessage(
      `Transferred ${amountNight} NIGHT`,
      result.txHash,
    ) + '\n');
    process.stderr.write('\n' + divider() + '\n');
    process.stderr.write(dim('  Verify: midnight balance') + '\n\n');
  } catch (err) {
    spinner.fail('Failed');
    throw err;
  }
}

// ── Shielded transfer ──

async function shieldedTransfer(
  args: ParsedArgs,
  { walletPath, walletConfig: config, recipientAddress, amountNight }: TransferRequest,
  signal?: AbortSignal,
): Promise<void> {
  const amount = nightToMicro(amountNight);
  const seedBuffer = Buffer.from(config.seed, 'hex');

  const { name: networkName, config: networkConfig } = resolveNetwork({ args });
  const networkId = getNetworkId(networkConfig.networkId);
  const nightToken = ledger.unshieldedToken().raw;

  applyEndpointOverrides(networkConfig, {
    proofServer: getFlag(args, 'proof-server'),
    node: getFlag(args, 'node'),
    indexerWS: getFlag(args, 'indexer-ws'),
  }, networkName);

  const decodedRecipient = decodeShieldedRecipient(recipientAddress, networkName);

  process.stderr.write('\n' + header('Shielded Transfer') + '\n\n');
  process.stderr.write(keyValue('Network', networkName) + '\n');
  process.stderr.write(keyValue('To', formatAddress(recipientAddress, true)) + '\n');
  process.stderr.write(keyValue('Amount', bold(amountNight + ' NIGHT (shielded)')) + '\n');
  process.stderr.write('\n');

  if (isVerbose(args)) enableVerbose();

  const unsuppress = suppressSdkTransientErrors();
  const restoreRpc = suppressRpcNoise();
  const spinner = startSpinner('Syncing wallet...');

  try {
    const txHash = await defaultRepository().withFacade(
      seedBuffer,
      networkConfig,
      async ({ bundle, state }) => {
        // Cache shielded address in wallet file
        const senderShieldedAddr = MidnightBech32m.encode(networkId, state.shielded.address).asString();
        saveShieldedAddress(walletPath, networkName, senderShieldedAddr);

        const shieldedBalance = state.shielded.balances[nightToken] ?? 0n;
        if (shieldedBalance < amount) {
          const available = Number(shieldedBalance) / 1_000_000;
          throw new Error(
            `Insufficient shielded balance: ${available.toFixed(6)} NIGHT available, ${amountNight} NIGHT requested.\n` +
            `Fund shielded balance: midnight airdrop ${amountNight} --shielded`
          );
        }

        spinner.update('Checking dust...');
        await ensureDust(bundle, (status: string) => spinner.update(status));

        if (signal?.aborted) throw new Error('Operation cancelled');

        spinner.update('Building shielded transaction...');
        const recipe = await bundle.facade.transferTransaction(
          [{
            type: 'shielded' as const,
            outputs: [{ type: nightToken, amount, receiverAddress: decodedRecipient }],
          }],
          { ttl: new Date(Date.now() + 60 * 60 * 1000) },
        );

        spinner.update('Signing...');
        const signed = await bundle.facade.signRecipe(
          recipe,
          bundle.keystore.signDataAsync,
        );

        spinner.update('Generating ZK proof (this may take a few minutes)...');
        const finalized = await bundle.facade.finalizeRecipe(signed);

        const txId = await trackElapsed(
          spinner,
          'Submitting and waiting for finalization (typically 12 to 30s)...',
          bundle.facade.submitTransaction(finalized),
        );
        return String(txId);
      },
      {
        syncMode: 'full',
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

    spinner.stop('Transaction submitted');

    if (hasFlag(args, 'json')) {
      writeJsonResult({ txHash, amount: amountNight, recipient: recipientAddress, network: networkName, type: 'shielded' });
      return;
    }
    process.stdout.write(txHash + '\n');
    process.stderr.write('\n' + successMessage(`Transferred ${amountNight} shielded NIGHT`, txHash) + '\n');
    process.stderr.write('\n' + divider() + '\n');
    process.stderr.write(dim('  Verify: midnight balance --shielded') + '\n\n');
  } catch (err) {
    spinner.fail('Failed');
    throw err;
  } finally {
    restoreRpc();
    unsuppress();
  }
}
