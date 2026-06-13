// airdrop command — fund wallet from genesis wallet (seed 0x01)
// Only works on undeployed network (local devnet)
// --shielded: sends shielded NIGHT from genesis shielded balance
//
// `--wallet` accepts three forms:
//   1. a wallet name (resolved from ~/.midnight/wallets/<name>.json)
//   2. a path to a wallet JSON
//   3. a raw bech32m address (mn_addr_… or mn_shield-addr_…) — no wallet
//      file required, useful for funding externally-generated addresses

import * as ledger from '@midnight-ntwrk/ledger-v8';
import { MidnightBech32m, ShieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import { type ParsedArgs, getFlag, hasFlag, isVerbose, rejectNoCacheForWrites } from '../lib/argv.ts';
import { enableVerbose } from '../lib/verbose.ts';
import { loadWalletConfig, resolveWalletPath, saveShieldedAddress } from '../lib/wallet-config.ts';
import { resolveNetwork } from '../lib/resolve-network.ts';
import { applyEndpointOverrides, type NetworkConfig, type NetworkName } from '../lib/network.ts';
import { getNetworkId } from '../lib/network-id.ts';
import { GENESIS_SEED } from '../lib/constants.ts';
import { deriveShieldedAddress } from '../lib/derive-address.ts';
import { parseAmount, nightToMicro, executeTransfer, ensureDust, suppressRpcNoise } from '../lib/transfer.ts';
import { suppressSdkTransientErrors } from '../lib/facade.ts';
import { defaultRepository } from '../lib/wallet-data-repository.ts';
import { header, keyValue, divider, formatAddress, successMessage } from '../ui/format.ts';
import { bold, dim } from '../ui/colors.ts';
import { start as startSpinner, trackElapsed } from '../ui/spinner.ts';
import { writeJsonResult } from '../lib/json-output.ts';

export default async function airdropCommand(args: ParsedArgs, signal?: AbortSignal): Promise<void> {
  rejectNoCacheForWrites(args);
  const amountStr = args.subcommand;
  if (!amountStr) {
    throw new Error(
      'Missing amount.\n' +
      'Usage: midnight airdrop <amount> [--wallet <name|file|address>]\n' +
      'Example: midnight airdrop 1000\n' +
      'Example: midnight airdrop 1000 --wallet alice\n' +
      'Example: midnight airdrop 1000 --wallet mn_addr_undeployed1...'
    );
  }

  const amountNight = parseAmount(amountStr);
  const { name: networkName, config: networkConfig } = resolveNetwork({ args });

  applyEndpointOverrides(networkConfig, {
    proofServer: getFlag(args, 'proof-server'),
    node: getFlag(args, 'node'),
    indexerWS: getFlag(args, 'indexer-ws'),
  }, networkName);

  if (networkName !== 'undeployed') {
    throw new Error(
      `Airdrop is only available on the "undeployed" network (local devnet).\n` +
      `Current network: "${networkName}"\n` +
      `On preprod/preview, use a faucet or transfer from another wallet.`
    );
  }

  const isShielded = hasFlag(args, 'shielded');
  const destination = resolveDestination(args, networkName, networkConfig, isShielded);

  if (isShielded) {
    return shieldedAirdrop(args, destination as ShieldedDestination, amountNight, networkName, networkConfig, signal);
  }

  return unshieldedAirdrop(args, destination as UnshieldedDestination, amountNight, networkName, networkConfig, signal);
}

// ── Destination resolution ──
//
// `--wallet` accepts a name, a file path, or a raw bech32m address.
// Resolution is uniform for the entry point; the helpers receive a
// pre-resolved destination so they don't reach back into wallet files
// when funding an external address.

type UnshieldedDestination = { kind: 'address'; address: string };

type ShieldedDestination =
  | { kind: 'address'; raw: ShieldedAddress; bech32m: string }
  | { kind: 'wallet'; raw: ShieldedAddress; bech32m: string; walletPath: string };

function looksLikeBech32mAddress(value: string): boolean {
  return value.startsWith('mn_addr_') || value.startsWith('mn_shield-addr_');
}

function resolveDestination(
  args: ParsedArgs,
  networkName: NetworkName,
  networkConfig: NetworkConfig,
  isShielded: boolean,
): UnshieldedDestination | ShieldedDestination {
  const walletFlag = getFlag(args, 'wallet');

  if (walletFlag !== undefined && looksLikeBech32mAddress(walletFlag)) {
    return resolveAddressDestination(walletFlag, networkName, networkConfig, isShielded);
  }

  // Fall back to wallet file (name, path, or active wallet)
  const walletPath = resolveWalletPath(walletFlag);
  const config = loadWalletConfig(walletPath);

  if (isShielded) {
    const networkId = getNetworkId(networkConfig.networkId);
    const seedBuffer = Buffer.from(config.seed, 'hex');
    const raw = deriveShieldedAddress(seedBuffer);
    const bech32m = MidnightBech32m.encode(networkId, raw).asString();
    return { kind: 'wallet', raw, bech32m, walletPath };
  }

  return { kind: 'address', address: config.addresses[networkName] };
}

function resolveAddressDestination(
  address: string,
  networkName: NetworkName,
  networkConfig: NetworkConfig,
  isShielded: boolean,
): UnshieldedDestination | ShieldedDestination {
  const looksShielded = address.startsWith('mn_shield-addr_');

  if (isShielded && !looksShielded) {
    throw new Error(
      `--shielded was passed but --wallet is an unshielded address.\n` +
      `Pass a shielded address (mn_shield-addr_...) or drop --shielded.\n` +
      `Got: ${address}`
    );
  }
  if (!isShielded && looksShielded) {
    throw new Error(
      `--wallet is a shielded address but --shielded was not passed.\n` +
      `Add --shielded, or pass an unshielded address (mn_addr_...).\n` +
      `Got: ${address}`
    );
  }

  const expectedPrefix = isShielded
    ? `mn_shield-addr_${networkName}1`
    : `mn_addr_${networkName}1`;

  if (!address.startsWith(expectedPrefix)) {
    throw new Error(
      `Address does not match network "${networkName}".\n` +
      `Expected prefix: ${expectedPrefix}\n` +
      `Got: ${address}`
    );
  }

  if (isShielded) {
    const networkId = getNetworkId(networkConfig.networkId);
    let raw: ShieldedAddress;
    try {
      raw = MidnightBech32m.parse(address).decode(ShieldedAddress, networkId);
    } catch (err: any) {
      throw new Error(`Invalid shielded address: ${err.message}`);
    }
    return { kind: 'address', raw, bech32m: address };
  }

  return { kind: 'address', address };
}

// ── Unshielded airdrop (existing flow) ──

async function unshieldedAirdrop(
  args: ParsedArgs,
  destination: UnshieldedDestination,
  amountNight: number,
  networkName: string,
  networkConfig: NetworkConfig,
  signal?: AbortSignal,
): Promise<void> {
  if (isVerbose(args)) enableVerbose();
  const recipientAddress = destination.address;
  const genesisSeedBuffer = Buffer.from(GENESIS_SEED, 'hex');

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
        spinner.update('Submitting and waiting for finalization (typically 12 to 30s)...');
      },
      onSubmittingTick(elapsedMs: number) {
        const s = Math.floor(elapsedMs / 1000);
        const mm = Math.floor(s / 60).toString().padStart(2, '0');
        const ss = (s % 60).toString().padStart(2, '0');
        spinner.update(`Submitting and waiting for finalization... ${mm}:${ss} elapsed (typically 12 to 30s)`);
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
    spinner.fail('Failed');
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
  destination: ShieldedDestination,
  amountNight: number,
  networkName: string,
  networkConfig: NetworkConfig,
  signal?: AbortSignal,
): Promise<void> {
  const amount = nightToMicro(amountNight);
  if (isVerbose(args)) enableVerbose();

  const genesisSeedBuffer = Buffer.from(GENESIS_SEED, 'hex');
  const nightToken = ledger.unshieldedToken().raw;

  const userShieldedAddress = destination.raw;
  const userShieldedAddrStr = destination.bech32m;
  // Cache the shielded address into the wallet file so subsequent reads
  // can short-circuit. Only meaningful when the destination came from a
  // managed wallet — for a raw address there's nothing to cache.
  if (destination.kind === 'wallet') {
    saveShieldedAddress(destination.walletPath, networkName as NetworkName, userShieldedAddrStr);
  }

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

        // SDK v4 facade.submitTransaction blocks until the chain finalizes
        // the block (typically 12 to 30s on hosted networks, ~6 to 12s on
        // localnet). trackElapsed updates the spinner once a second so
        // users see the wait is alive, not stuck.
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
    spinner.fail('Failed');
    throw err;
  } finally {
    restoreRpc();
    unsuppress();
  }
}
