// transfer command — send NIGHT from my wallet to another address
// Usage: midnight transfer <to> <amount> [--shielded]

import * as ledger from '@midnight-ntwrk/ledger-v8';
import { MidnightBech32m, ShieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import { type ParsedArgs, getFlag, hasFlag, isVerbose } from '../lib/argv.ts';
import { enableVerbose } from '../lib/verbose.ts';
import { loadWalletConfig, resolveWalletPath, saveShieldedAddress } from '../lib/wallet-config.ts';
import { resolveNetwork } from '../lib/resolve-network.ts';
import { applyEndpointOverrides } from '../lib/network.ts';
import { getNetworkId } from '../lib/network-id.ts';
import { loadWalletCache, saveWalletCache } from '../lib/wallet-cache.ts';
import { parseAmount, nightToMicro, executeTransfer, ensureDust, suppressRpcNoise } from '../lib/transfer.ts';
import { buildFacade, startAndSyncFacade, stopFacade, suppressSdkTransientErrors, type FacadeBundle } from '../lib/facade.ts';
import { header, keyValue, divider, formatAddress, successMessage } from '../ui/format.ts';
import { bold, dim } from '../ui/colors.ts';
import { start as startSpinner } from '../ui/spinner.ts';
import { writeJsonResult } from '../lib/json-output.ts';

export default async function transferCommand(args: ParsedArgs, signal?: AbortSignal): Promise<void> {
  const recipientInput = args.subcommand;
  const amountStr = args.positionals[0];

  if (!recipientInput) {
    throw new Error(
      'Missing recipient address.\n' +
      'Usage: midnight transfer <to> <amount>\n' +
      'Example: midnight transfer mn_addr_undeployed1... 100\n' +
      'Example: midnight transfer alice 100'
    );
  }

  if (!amountStr) {
    throw new Error(
      'Missing amount.\n' +
      'Usage: midnight transfer <to> <amount>\n' +
      'Example: midnight transfer mn_addr_undeployed1... 100'
    );
  }

  const isShielded = hasFlag(args, 'shielded');
  const recipientAddress = resolveRecipient(recipientInput, args, isShielded);

  if (isShielded) {
    return shieldedTransfer(args, recipientAddress, amountStr, signal);
  }

  return unshieldedTransfer(args, recipientAddress, amountStr, signal);
}

/**
 * Resolve recipient: if it looks like an address (mn_addr_ or mn_shield-addr_ prefix),
 * use it directly. Otherwise treat it as a wallet name and load the address from the wallet file.
 */
function resolveRecipient(input: string, args: ParsedArgs, shielded: boolean): string {
  // Already an address
  if (input.startsWith('mn_addr_') || input.startsWith('mn_shield-addr_')) {
    return input;
  }

  // Treat as wallet name — load the recipient's wallet config
  const recipientPath = resolveWalletPath(input);
  const recipientConfig = loadWalletConfig(recipientPath);

  if (shielded) {
    if (!recipientConfig.shieldedAddress) {
      throw new Error(
        `Wallet "${input}" has no shielded address.\n` +
        `The recipient must run "midnight balance --shielded" first to populate their shielded address.`
      );
    }
    return recipientConfig.shieldedAddress;
  }

  const { name: networkName } = resolveNetwork({ args });
  return recipientConfig.addresses[networkName];
}

// ── Unshielded transfer (existing flow) ──

async function unshieldedTransfer(
  args: ParsedArgs,
  recipientAddress: string,
  amountStr: string,
  signal?: AbortSignal,
): Promise<void> {
  const amountNight = parseAmount(amountStr);

  const walletPath = resolveWalletPath(getFlag(args, 'wallet'));
  const config = loadWalletConfig(walletPath);
  const seedBuffer = Buffer.from(config.seed, 'hex');

  const { name: networkName, config: networkConfig } = resolveNetwork({ args });
  const address = config.addresses[networkName];

  applyEndpointOverrides(networkConfig, {
    proofServer: getFlag(args, 'proof-server'),
    node: getFlag(args, 'node'),
    indexerWS: getFlag(args, 'indexer-ws'),
  });

  process.stderr.write('\n' + header('Transfer') + '\n\n');
  process.stderr.write(keyValue('Network', networkName) + '\n');
  process.stderr.write(keyValue('From', formatAddress(address, true)) + '\n');
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
      walletAddress: address,
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
    spinner.stop('Failed');
    throw err;
  }
}

// ── Shielded transfer ──

async function shieldedTransfer(
  args: ParsedArgs,
  recipientAddress: string,
  amountStr: string,
  signal?: AbortSignal,
): Promise<void> {
  const amountNight = parseAmount(amountStr);
  const amount = nightToMicro(amountNight);

  const walletPath = resolveWalletPath(getFlag(args, 'wallet'));
  const config = loadWalletConfig(walletPath);
  const seedBuffer = Buffer.from(config.seed, 'hex');

  const { name: networkName, config: networkConfig } = resolveNetwork({ args });
  const unshieldedAddress = config.addresses[networkName];
  const networkId = getNetworkId(networkConfig.networkId);
  const nightToken = ledger.unshieldedToken().raw;

  applyEndpointOverrides(networkConfig, {
    proofServer: getFlag(args, 'proof-server'),
    node: getFlag(args, 'node'),
    indexerWS: getFlag(args, 'indexer-ws'),
  });

  // Validate recipient as ShieldedAddress
  let decodedRecipient: ShieldedAddress;
  try {
    decodedRecipient = MidnightBech32m.parse(recipientAddress).decode(ShieldedAddress, networkId);
  } catch (err: any) {
    throw new Error(
      `Invalid shielded address: ${err.message}\n` +
      `Expected a shielded address (mn_shield-addr_...) for network "${networkConfig.networkId}"`
    );
  }

  process.stderr.write('\n' + header('Shielded Transfer') + '\n\n');
  process.stderr.write(keyValue('Network', networkName) + '\n');
  process.stderr.write(keyValue('To', formatAddress(recipientAddress, true)) + '\n');
  process.stderr.write(keyValue('Amount', bold(amountNight + ' NIGHT (shielded)')) + '\n');
  process.stderr.write('\n');

  const noCache = hasFlag(args, 'no-cache');
  if (isVerbose(args)) enableVerbose();

  const unsuppress = suppressSdkTransientErrors();
  const restoreRpc = suppressRpcNoise();
  const cache = noCache ? null : loadWalletCache(unshieldedAddress, networkName);
  const spinner = startSpinner('Syncing wallet...');

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

    // Cache shielded address in wallet file
    const senderShieldedAddr = MidnightBech32m.encode(networkId, state.shielded.address).asString();
    saveShieldedAddress(walletPath, senderShieldedAddr);

    // Check shielded balance
    const shieldedBalance = state.shielded.balances[nightToken] ?? 0n;
    if (shieldedBalance < amount) {
      const available = Number(shieldedBalance) / 1_000_000;
      throw new Error(
        `Insufficient shielded balance: ${available.toFixed(6)} NIGHT available, ${amountNight} NIGHT requested.\n` +
        `Fund shielded balance: midnight airdrop ${amountNight} --shielded`
      );
    }

    // Ensure dust
    spinner.update('Checking dust...');
    await ensureDust(bundle, (status: string) => spinner.update(status));

    if (signal?.aborted) throw new Error('Operation cancelled');

    // Build shielded transfer
    spinner.update('Building shielded transaction...');
    const recipe = await bundle.facade.transferTransaction(
      [{
        type: 'shielded' as const,
        outputs: [{
          type: nightToken,
          amount,
          receiverAddress: decodedRecipient,
        }],
      }],
      {
        shieldedSecretKeys: bundle.zswapSecretKeys,
        dustSecretKey: bundle.dustSecretKey,
      },
      { ttl: new Date(Date.now() + 60 * 60 * 1000) },
    );

    // Sign, prove, submit
    spinner.update('Signing...');
    const signed = await bundle.facade.signRecipe(
      recipe,
      (payload: Uint8Array) => bundle!.keystore.signData(payload),
    );

    spinner.update('Generating ZK proof (this may take a few minutes)...');
    const finalized = await bundle.facade.finalizeRecipe(signed);

    spinner.update('Submitting transaction...');
    const txId = await bundle.facade.submitTransaction(finalized);
    const txHash = String(txId);

    spinner.stop('Transaction submitted');

    // Save cache
    if (!noCache) {
      try { await saveWalletCache(unshieldedAddress, networkName, bundle.facade); } catch { /* best-effort */ }
    }

    if (hasFlag(args, 'json')) {
      writeJsonResult({
        txHash,
        amount: amountNight,
        recipient: recipientAddress,
        network: networkName,
        type: 'shielded',
      });
      return;
    }

    process.stdout.write(txHash + '\n');

    process.stderr.write('\n' + successMessage(
      `Transferred ${amountNight} shielded NIGHT`,
      txHash,
    ) + '\n');
    process.stderr.write('\n' + divider() + '\n');
    process.stderr.write(dim('  Verify: midnight balance --shielded') + '\n\n');
  } catch (err) {
    spinner.stop('Failed');
    throw err;
  } finally {
    if (bundle) await stopFacade(bundle);
    restoreRpc();
    unsuppress();
  }
}
