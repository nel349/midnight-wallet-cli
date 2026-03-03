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
  BALANCE_OVERSPEND_ERROR_CODE,
  DUST_REGISTRATION_TIMEOUT_MS,
  DUST_REGISTRATION_RETRY_DELAY_MS,
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
 * Returns the decoded UnshieldedAddress for use with the facade.
 */
export function validateRecipientAddress(address: string, networkConfig: NetworkConfig): UnshieldedAddress {
  const networkId = NETWORK_ID_MAP[networkConfig.networkId];
  if (networkId === undefined) {
    throw new Error(`Unknown networkId: ${networkConfig.networkId}`);
  }

  try {
    return MidnightBech32m.parse(address).decode(UnshieldedAddress, networkId);
  } catch (err: any) {
    throw new Error(
      `Invalid recipient address: ${err.message}\n` +
      `Expected a bech32m address for network "${networkConfig.networkId}"`
    );
  }
}

/**
 * Check if an error is a transaction submission rejection from the node.
 *
 * During dust registration, this is almost always error 138
 * (BalanceCheckOverspend) — the estimated dust capacity hasn't grown
 * large enough to cover the tx fee yet.
 *
 * The SDK throws a generic "Transaction submission error" without the
 * actual error code (138). The code is only printed to console by
 * polkadot-js. So we match on the submission error message pattern
 * plus any "138" in the cause chain as a fallback.
 */
function isTransactionRejectedError(err: any): boolean {
  let current = err;
  while (current) {
    const msg = String(current?.message ?? '').toLowerCase();
    if (msg.includes('submission error')) return true;
    if (msg.includes('transaction') && msg.includes('invalid')) return true;
    if (msg.includes('138')) return true;
    // Effect-TS tagged errors
    const tag = current?._tag;
    if (tag === 'TransactionInvalidError' || tag === 'SubmissionError') return true;
    current = current.cause;
  }
  return false;
}

/**
 * Register NIGHT UTXOs for dust generation with retry on error 138.
 *
 * On a fresh localnet, the estimated dust capacity (allow_fee_payment) may
 * be less than the registration fee for several minutes after UTXO creation.
 * Each retry rebuilds the transaction with a newer block timestamp, giving
 * a larger time delta and thus a larger allow_fee_payment.
 *
 * Exported so dust.ts command can reuse the same retry logic.
 */
export async function registerNightUtxos(
  bundle: FacadeBundle,
  nightUtxos: any[],
  onStatus?: (status: string) => void,
): Promise<string> {
  const startTime = Date.now();
  const deadline = startTime + DUST_REGISTRATION_TIMEOUT_MS;
  let lastError: Error | undefined;

  // Suppress polkadot-js RPC-CORE noise during retries (it logs
  // "Custom error: 138" to console.warn/error on each failed submit).
  // polkadot-js may pass timestamp and message as separate args,
  // so we check ALL args for "RPC-CORE".
  const originalWarn = console.warn;
  const originalError = console.error;
  const hasRpcNoise = (args: any[]) => args.some(a => String(a).includes('RPC-CORE'));
  const suppressRpcNoise = () => {
    console.warn = (...args: any[]) => {
      if (hasRpcNoise(args)) return;
      originalWarn(...args);
    };
    console.error = (...args: any[]) => {
      if (hasRpcNoise(args)) return;
      originalError(...args);
    };
  };
  const restoreConsole = () => {
    console.warn = originalWarn;
    console.error = originalError;
  };

  // Suppress RPC noise from all attempts (polkadot-js logs "Custom error: 138"
  // to console on each failed submit — we handle this with retry + spinner)
  suppressRpcNoise();

  try {
    while (Date.now() < deadline) {
      try {
        const recipe = await bundle.facade.registerNightUtxosForDustGeneration(
          nightUtxos,
          bundle.keystore.getPublicKey(),
          (payload) => bundle.keystore.signData(payload),
        );

        const finalized = await bundle.facade.finalizeRecipe(recipe);
        const txHash = await bundle.facade.submitTransaction(finalized);
        return txHash;
      } catch (err: any) {
        lastError = err;
        if (isTransactionRejectedError(err) && Date.now() + DUST_REGISTRATION_RETRY_DELAY_MS < deadline) {
          const elapsed = formatElapsed(Date.now() - startTime);
          onStatus?.(`Waiting for dust generation capacity (${elapsed} elapsed, ~5 min on fresh wallets)...`);
          await new Promise(resolve => setTimeout(resolve, DUST_REGISTRATION_RETRY_DELAY_MS));
          continue;
        }
        throw err;
      }
    }

    throw lastError ?? new Error('Dust registration timed out');
  } finally {
    restoreConsole();
  }
}

/** Format milliseconds as "Xs" or "Xm Ys" for human-friendly elapsed display. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

/**
 * Wait for dust to become available.
 * If no dust and unregistered UTXOs exist, registers them first.
 *
 * Uses the facade's registerNightUtxosForDustGeneration — it passes
 * undefined for currentTime (using block timestamp), which ensures
 * allow_fee_payment aligns with the node's availability check.
 * Retries on error 138 (BalanceCheckOverspend) — on fresh localnets,
 * the estimated dust capacity takes several minutes to exceed the fee.
 */
async function ensureDust(
  bundle: FacadeBundle,
  onDust?: (status: string) => void,
): Promise<void> {
  const state = await rx.firstValueFrom(
    bundle.facade.state().pipe(rx.filter((s) => s.isSynced))
  );

  // Check for unregistered NIGHT UTXOs — always register new ones,
  // even if some dust already exists, to maximize dust generation rate.
  const nightUtxos = state.unshielded.availableCoins.filter(
    (coin: any) => coin.meta?.registeredForDustGeneration !== true
  );

  if (nightUtxos.length > 0) {
    onDust?.(`Registering ${nightUtxos.length} UTXO(s) for dust generation...`);
    await registerNightUtxos(bundle, nightUtxos, onDust);
  } else if (state.dust.availableCoins.length > 0) {
    onDust?.('Dust available');
    return;
  } else {
    onDust?.('UTXOs already registered, waiting for dust generation...');
  }

  // Wait for dust to generate
  onDust?.('Waiting for dust tokens...');
  await rx.firstValueFrom(
    bundle.facade.state().pipe(
      rx.throttleTime(5_000),
      rx.filter((s) => s.isSynced),
      rx.filter((s) => s.dust.balance(new Date()) > 0n),
      rx.timeout(DUST_TIMEOUT_MS),
    )
  );
  onDust?.('Dust available');
}

/**
 * Build, sign, prove, and submit a transfer transaction.
 * Retries on stale UTXO errors (error code 115) and insufficient dust.
 */
async function buildAndSubmitTransfer(
  bundle: FacadeBundle,
  recipientAddress: UnshieldedAddress,
  amount: bigint,
  onProving?: () => void,
  onSubmitting?: () => void,
  onDust?: (status: string) => void,
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

      // Stale UTXO: quick-sync and retry immediately
      const isStaleUtxo = err?.code === STALE_UTXO_ERROR_CODE ||
        err?.message?.includes('115') ||
        err?.message?.toLowerCase().includes('stale');

      if (isStaleUtxo && attempt < MAX_RETRY_ATTEMPTS) {
        continue;
      }

      // Insufficient dust: wait for more dust to accumulate, then retry
      const isDustInsufficient = err?.message?.toLowerCase().includes('not enough dust') ||
        err?.message?.toLowerCase().includes('dust generated');

      if (isDustInsufficient && attempt < MAX_RETRY_ATTEMPTS) {
        onDust?.('Waiting for more dust to accumulate...');
        await new Promise(resolve => setTimeout(resolve, DUST_REGISTRATION_RETRY_DELAY_MS));
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

  // Validate and decode recipient address
  const decodedAddress = validateRecipientAddress(recipientAddress, networkConfig);

  // Suppress known transient SDK errors (Wallet.Sync: Internal Server Error, etc.)
  const unsuppress = suppressSdkTransientErrors(onSyncWarning);

  // Build facade
  const bundle = await buildFacade(seedBuffer, networkConfig);
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
      decodedAddress,
      amount,
      onProving,
      onSubmitting,
      onDust,
    );

    return { txHash, amountMicroNight: amount };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    unsuppress();
    await cleanup();
  }
}
