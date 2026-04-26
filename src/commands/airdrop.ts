// airdrop command — fund wallet from genesis wallet (seed 0x01)
// Only works on undeployed network (local devnet)
// --shielded: sends shielded NIGHT from genesis shielded balance

import * as ledger from '@midnight-ntwrk/ledger-v8';
import { MidnightBech32m } from '@midnight-ntwrk/wallet-sdk-address-format';
import { type ParsedArgs, getFlag, hasFlag, isVerbose, rejectNoCacheForWrites } from '../lib/argv.ts';
import { enableVerbose } from '../lib/verbose.ts';
import { loadWalletConfig, resolveWalletPath, saveShieldedAddress } from '../lib/wallet-config.ts';
import { resolveNetwork } from '../lib/resolve-network.ts';
import { applyEndpointOverrides, type NetworkConfig, type NetworkName } from '../lib/network.ts';
import { getNetworkId } from '../lib/network-id.ts';
import { GENESIS_SEED } from '../lib/constants.ts';
import { deriveUnshieldedAddress, deriveShieldedAddress } from '../lib/derive-address.ts';
import { parseAmount, nightToMicro, executeTransfer, ensureDust, suppressRpcNoise } from '../lib/transfer.ts';
import { suppressSdkTransientErrors } from '../lib/facade.ts';
import { defaultRepository } from '../lib/wallet-data-repository.ts';
import { header, keyValue, divider, formatAddress, successMessage } from '../ui/format.ts';
import { bold, dim } from '../ui/colors.ts';
import { start as startSpinner } from '../ui/spinner.ts';
import { writeJsonResult } from '../lib/json-output.ts';

export default async function airdropCommand(args: ParsedArgs, signal?: AbortSignal): Promise<void> {
  rejectNoCacheForWrites(args);
  const amountStr = args.subcommand;
  if (!amountStr) {
    throw new Error(
      'Missing amount.\n' +
      'Usage: midnight airdrop <amount>\n' +
      'Example: midnight airdrop 1000'
    );
  }

  const amountNight = parseAmount(amountStr);

  const config = loadWalletConfig(resolveWalletPath(getFlag(args, 'wallet')));
  const { name: networkName, config: networkConfig } = resolveNetwork({ args });

  applyEndpointOverrides(networkConfig, {
    proofServer: getFlag(args, 'proof-server'),
    node: getFlag(args, 'node'),
    indexerWS: getFlag(args, 'indexer-ws'),
  });

  if (networkName !== 'undeployed') {
    throw new Error(
      `Airdrop is only available on the "undeployed" network (local devnet).\n` +
      `Current network: "${networkName}"\n` +
      `On preprod/preview, use a faucet or transfer from another wallet.`
    );
  }

  if (hasFlag(args, 'shielded')) {
    return shieldedAirdrop(args, config, amountNight, networkName, networkConfig, signal);
  }

  return unshieldedAirdrop(args, config, amountNight, networkName, networkConfig, signal);
}

// ── Unshielded airdrop (existing flow) ──

async function unshieldedAirdrop(
  args: ParsedArgs,
  config: ReturnType<typeof loadWalletConfig>,
  amountNight: number,
  networkName: string,
  networkConfig: NetworkConfig,
  signal?: AbortSignal,
): Promise<void> {
  if (isVerbose(args)) enableVerbose();
  const recipientAddress = config.addresses[networkName as NetworkName];
  const genesisSeedBuffer = Buffer.from(GENESIS_SEED, 'hex');
  const genesisAddress = deriveUnshieldedAddress(genesisSeedBuffer, networkName as NetworkName);

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
      walletAddress: genesisAddress,
      networkName,
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
      `Airdropped ${amountNight} NIGHT to your wallet`,
      result.txHash,
    ) + '\n');
    process.stderr.write('\n' + divider() + '\n');
    process.stderr.write(dim('  Verify:         midnight balance') + '\n');
    process.stderr.write(dim('  Register dust:  midnight dust register') + '\n');
    process.stderr.write(dim('  Note: Dust generation takes a few minutes on a fresh wallet.') + '\n');
    process.stderr.write(dim('        It will happen automatically on your first transfer.') + '\n\n');
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

// ── Shielded airdrop (genesis shielded → user shielded) ──

async function shieldedAirdrop(
  args: ParsedArgs,
  config: ReturnType<typeof loadWalletConfig>,
  amountNight: number,
  networkName: string,
  networkConfig: NetworkConfig,
  signal?: AbortSignal,
): Promise<void> {
  const amount = nightToMicro(amountNight);
  if (isVerbose(args)) enableVerbose();

  const userSeedBuffer = Buffer.from(config.seed, 'hex');
  const genesisSeedBuffer = Buffer.from(GENESIS_SEED, 'hex');
  const networkId = getNetworkId(networkConfig.networkId);
  const nightToken = ledger.unshieldedToken().raw;

  // Recipient shielded address — pure key derivation, no facade needed.
  const userShieldedAddress = deriveShieldedAddress(userSeedBuffer);
  const userShieldedAddrStr = MidnightBech32m.encode(networkId, userShieldedAddress).asString();
  // Cache it in the wallet file so subsequent reads can short-circuit.
  saveShieldedAddress(resolveWalletPath(getFlag(args, 'wallet')), networkName as NetworkName, userShieldedAddrStr);

  process.stderr.write('\n' + header('Shielded Airdrop') + '\n\n');
  process.stderr.write(keyValue('Network', networkName) + '\n');
  process.stderr.write(keyValue('From', dim('genesis shielded (seed 0x01)')) + '\n');
  process.stderr.write(keyValue('To', formatAddress(userShieldedAddrStr, true)) + '\n');
  process.stderr.write(keyValue('Amount', bold(amountNight + ' NIGHT (shielded)')) + '\n');
  process.stderr.write('\n');

  const unsuppress = suppressSdkTransientErrors();
  const restoreRpc = suppressRpcNoise();
  const spinner = startSpinner('Syncing genesis wallet...');

  try {
    const txHash = await defaultRepository().withFacade(
      genesisSeedBuffer,
      networkConfig,
      async ({ bundle, state }) => {
        const genesisShieldedBalance = state.shielded.balances[nightToken] ?? 0n;
        if (genesisShieldedBalance < amount) {
          const available = Number(genesisShieldedBalance) / 1_000_000;
          throw new Error(
            `Genesis wallet has insufficient shielded balance: ${available.toFixed(6)} NIGHT available, ${amountNight} NIGHT requested`
          );
        }

        spinner.update('Checking dust...');
        await ensureDust(bundle, (status: string) => spinner.update(status));

        if (signal?.aborted) throw new Error('Operation cancelled');

        spinner.update('Building shielded transaction...');
        const recipe = await bundle.facade.transferTransaction(
          [{
            type: 'shielded' as const,
            outputs: [{ type: nightToken, amount, receiverAddress: userShieldedAddress }],
          }],
          { shieldedSecretKeys: bundle.zswapSecretKeys, dustSecretKey: bundle.dustSecretKey },
          { ttl: new Date(Date.now() + 60 * 60 * 1000) },
        );

        spinner.update('Signing...');
        const signed = await bundle.facade.signRecipe(
          recipe,
          (payload: Uint8Array) => bundle.keystore.signData(payload),
        );

        spinner.update('Generating ZK proof (this may take a few minutes)...');
        const finalized = await bundle.facade.finalizeRecipe(signed);

        spinner.update('Submitting transaction...');
        const txId = await bundle.facade.submitTransaction(finalized);
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
            spinner.update(pct >= 100 ? 'Syncing genesis wallet...' : `Syncing genesis wallet... ${pct}%`);
          }
        },
        onSyncDetail: (detail) => spinner.update(`Syncing genesis wallet... (waiting on: ${detail})`),
      },
    );

    spinner.stop('Transaction submitted');

    if (hasFlag(args, 'json')) {
      writeJsonResult({ txHash, amount: amountNight, shieldedAddress: userShieldedAddrStr, network: networkName, type: 'shielded' });
      return;
    }
    process.stdout.write(txHash + '\n');
    process.stderr.write('\n' + successMessage(`Airdropped ${amountNight} shielded NIGHT to your wallet`, txHash) + '\n');
    process.stderr.write('\n' + divider() + '\n');
    process.stderr.write(dim('  Verify: midnight balance --shielded') + '\n\n');
  } catch (err) {
    spinner.stop('Failed');
    throw err;
  } finally {
    restoreRpc();
    unsuppress();
  }
}
