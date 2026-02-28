// Shared transfer execution — used by both airdrop and transfer commands
// Handles: facade lifecycle, sync, balance check, dust, tx build/sign/prove/submit, retries

import * as ledger from '@midnight-ntwrk/ledger-v7';
import { MidnightBech32m, UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import { NetworkId } from '@midnight-ntwrk/wallet-sdk-abstractions';
import * as rx from 'rxjs';

import { type NetworkConfig } from './network.ts';
import { type FacadeBundle, buildFacade, startAndSyncFacade, quickSync, stopFacade, suppressSdkTransientErrors } from './facade.ts';
import {
  NATIVE_TOKEN_TYPE,
  TOKEN_MULTIPLIER,
  TX_TTL_MINUTES,
  PROOF_TIMEOUT_MS,
  DUST_TIMEOUT_MS,
  MAX_RETRY_ATTEMPTS,
  STALE_UTXO_ERROR_CODE,
} from './constants.ts';

const NETWORK_ID_MAP: Record<string, NetworkId.NetworkId> = {
  PreProd: NetworkId.NetworkId.PreProd,
  Preview: NetworkId.NetworkId.Preview,
  Undeployed: NetworkId.NetworkId.Undeployed,
};

export interface TransferParams {
  seedBuffer: Buffer;
  networkConfig: NetworkConfig;
  recipientAddress: string;
  amountNight: number;
  signal?: AbortSignal;
  onSync?: (applied: number, highest: number) => void;
  onDust?: (status: string) => void;
  onProving?: () => void;
  onSubmitting?: () => void;
  onSyncWarning?: (tag: string, message: string) => void;
}

export interface TransferResult {
  txHash: string;
  amountMicroNight: bigint;
}

/**
 * Convert NIGHT amount to micro-NIGHT (bigint).
 * Validates the amount is positive and not too many decimal places.
 */
export function nightToMicro(amountNight: number): bigint {
  if (amountNight <= 0) {
    throw new Error('Amount must be greater than 0');
  }
  if (!Number.isFinite(amountNight)) {
    throw new Error('Amount must be a finite number');
  }
  // Use string math to avoid floating point rounding issues
  const str = amountNight.toFixed(6);
  const [whole, frac] = str.split('.');
  const microStr = whole! + (frac ?? '').padEnd(6, '0');
  const micro = BigInt(microStr);
  if (micro <= 0n) {
    throw new Error('Amount too small — minimum is 0.000001 NIGHT');
  }
  return micro;
}

/**
 * Parse and validate amount string from CLI input.
 * Returns the amount as a number (in NIGHT).
 */
export function parseAmount(amountStr: string): number {
  const amount = Number(amountStr);
  if (Number.isNaN(amount) || !Number.isFinite(amount)) {
    throw new Error(`Invalid amount: "${amountStr}" — must be a positive number`);
  }
  if (amount <= 0) {
    throw new Error(`Invalid amount: "${amountStr}" — must be greater than 0`);
  }
  return amount;
}

/**
 * Validate recipient address format (bech32m, matching network).
 */
export function validateRecipientAddress(address: string, networkConfig: NetworkConfig): void {
  const networkId = NETWORK_ID_MAP[networkConfig.networkId];
  if (networkId === undefined) {
    throw new Error(`Unknown networkId: ${networkConfig.networkId}`);
  }

  try {
    MidnightBech32m.parse(address).decode(UnshieldedAddress, networkId);
  } catch (err: any) {
    throw new Error(
      `Invalid recipient address: ${err.message}\n` +
      `Expected a bech32m address for network "${networkConfig.networkId}"`
    );
  }
}

/**
 * Wait for dust to become available.
 * If no dust and unregistered UTXOs exist, registers them first.
 */
async function ensureDust(
  bundle: FacadeBundle,
  onDust?: (status: string) => void,
): Promise<void> {
  const state = await rx.firstValueFrom(
    bundle.facade.state().pipe(rx.filter((s) => s.isSynced))
  );

  // Check if dust is already available
  if (state.dust.availableCoins.length > 0) {
    onDust?.('Dust available');
    return;
  }

  // Check for unregistered NIGHT UTXOs
  const nightUtxos = state.unshielded.availableCoins.filter(
    (coin: any) => coin.meta?.registeredForDustGeneration !== true
  );

  if (nightUtxos.length > 0) {
    onDust?.(`Registering ${nightUtxos.length} UTXO(s) for dust generation...`);

    const recipe = await bundle.facade.registerNightUtxosForDustGeneration(
      nightUtxos,
      bundle.keystore.getPublicKey(),
      (payload) => bundle.keystore.signData(payload)
    );
    const finalized = await bundle.facade.finalizeRecipe(recipe);
    await bundle.facade.submitTransaction(finalized);
  } else {
    onDust?.('UTXOs already registered, waiting for dust generation...');
  }

  // Wait for dust to generate
  onDust?.('Waiting for dust tokens...');
  await rx.firstValueFrom(
    bundle.facade.state().pipe(
      rx.throttleTime(5_000),
      rx.filter((s) => s.isSynced),
      rx.filter((s) => s.dust.walletBalance(new Date()) > 0n),
      rx.timeout(DUST_TIMEOUT_MS),
    )
  );
  onDust?.('Dust available');
}

/**
 * Build, sign, prove, and submit a transfer transaction.
 * Retries on stale UTXO errors (error code 115).
 */
async function buildAndSubmitTransfer(
  bundle: FacadeBundle,
  recipientAddress: string,
  amount: bigint,
  onProving?: () => void,
  onSubmitting?: () => void,
): Promise<string> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) {
        await quickSync(bundle);
      }

      const ttl = new Date(Date.now() + TX_TTL_MINUTES * 60 * 1000);

      const unprovenRecipe = await bundle.facade.transferTransaction(
        [
          {
            type: 'unshielded',
            outputs: [
              {
                amount,
                receiverAddress: recipientAddress,
                type: ledger.unshieldedToken().raw,
              },
            ],
          },
        ],
        { shieldedSecretKeys: bundle.zswapSecretKeys, dustSecretKey: bundle.dustSecretKey },
        { ttl, payFees: true },
      );

      const signedRecipe = await bundle.facade.signRecipe(unprovenRecipe, (payload) =>
        bundle.keystore.signData(payload)
      );

      onProving?.();
      const finalizedTx = await Promise.race([
        bundle.facade.finalizeRecipe(signedRecipe),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('ZK proof generation timed out')), PROOF_TIMEOUT_MS);
        }),
      ]);

      onSubmitting?.();
      const txHash = await bundle.facade.submitTransaction(finalizedTx);
      return txHash;
    } catch (err: any) {
      lastError = err;
      // Stale UTXO: quick-sync and retry
      const isStaleUtxo = err?.code === STALE_UTXO_ERROR_CODE ||
        err?.message?.includes('115') ||
        err?.message?.toLowerCase().includes('stale');

      if (isStaleUtxo && attempt < MAX_RETRY_ATTEMPTS) {
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error('Transfer failed after retries');
}

/**
 * Execute a full transfer flow:
 * 1. Build facade from seed + network config
 * 2. Start & sync facade
 * 3. Check balance
 * 4. Ensure dust is available
 * 5. Build/sign/prove/submit transaction
 * 6. Clean shutdown
 */
export async function executeTransfer(params: TransferParams): Promise<TransferResult> {
  const {
    seedBuffer,
    networkConfig,
    recipientAddress,
    amountNight,
    signal,
    onSync,
    onDust,
    onProving,
    onSubmitting,
    onSyncWarning,
  } = params;

  const amount = nightToMicro(amountNight);

  // Validate recipient address
  validateRecipientAddress(recipientAddress, networkConfig);

  // Suppress known transient SDK errors (Wallet.Sync: Internal Server Error, etc.)
  const unsuppress = suppressSdkTransientErrors(onSyncWarning);

  // Build facade
  const bundle = buildFacade(seedBuffer, networkConfig);
  let shutdownComplete = false;

  // Signal handling — clean shutdown on abort
  const cleanup = async () => {
    if (!shutdownComplete) {
      shutdownComplete = true;
      try {
        await stopFacade(bundle);
      } catch {
        // Best-effort shutdown
      }
    }
  };

  const onAbort = () => { cleanup(); };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    // Start & sync
    const syncedState = await startAndSyncFacade(bundle, onSync);

    if (signal?.aborted) throw new Error('Operation cancelled');

    // Check balance
    const unshieldedBalance = syncedState.unshielded.balances[ledger.unshieldedToken().raw] ?? 0n;
    if (unshieldedBalance < amount) {
      const haveNight = Number(unshieldedBalance) / TOKEN_MULTIPLIER;
      throw new Error(
        `Insufficient balance: ${haveNight.toFixed(6)} NIGHT available, ` +
        `${amountNight} NIGHT requested`
      );
    }

    if (signal?.aborted) throw new Error('Operation cancelled');

    // Ensure dust
    await ensureDust(bundle, onDust);

    if (signal?.aborted) throw new Error('Operation cancelled');

    // Build, sign, prove, submit
    const txHash = await buildAndSubmitTransfer(
      bundle,
      recipientAddress,
      amount,
      onProving,
      onSubmitting,
    );

    return { txHash, amountMicroNight: amount };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    unsuppress();
    await cleanup();
  }
}
