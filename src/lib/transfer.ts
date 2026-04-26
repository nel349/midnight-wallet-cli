// Shared transfer execution — used by both airdrop and transfer commands
// Handles: facade lifecycle, sync, balance check, dust, tx build/sign/prove/submit, retries

import * as ledger from '@midnight-ntwrk/ledger-v8';
import { MidnightBech32m, UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import { NetworkId } from '@midnight-ntwrk/wallet-sdk-abstractions';
import { type UtxoWithMeta as DustUtxoWithMeta } from '@midnight-ntwrk/wallet-sdk-dust-wallet/v1';
import * as rx from 'rxjs';

import { type NetworkConfig } from './network.ts';
import { type FacadeBundle, quickSync, suppressSdkTransientErrors } from './facade.ts';
import { defaultRepository } from './wallet-data-repository.ts';
import { verbose } from './verbose.ts';
import {
  NATIVE_TOKEN_TYPE,
  TOKEN_MULTIPLIER,
  TX_TTL_MINUTES,
  PROOF_TIMEOUT_MS,
  DUST_TIMEOUT_MS,
  MAX_RETRY_ATTEMPTS,
  STALE_UTXO_ERROR_CODE,
  DUST_REGISTRATION_TIMEOUT_MS,
  DUST_REGISTRATION_RETRY_DELAY_MS,
  SYNC_ATTEMPT_TIMEOUT_MS,
  DUST_COST_OVERHEAD,
  MIN_DUST_FOR_TRANSFER,
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
  onSyncDetail?: (walletsStillSyncing: string) => void;
  onDust?: (status: string) => void;
  onProving?: () => void;
  onSubmitting?: () => void;
  onSyncWarning?: (tag: string, message: string) => void;
}

export interface TransferResult {
  txHash: string;
  amountMicroNight: bigint;
}

export interface EnsureDustResult {
  alreadyAvailable: boolean;
  txHash?: string;
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

// ── Error detection ──────────────────────────────────────────────────

// SDK error classifiers moved to ./sdk-errors.ts so wallet-data-repository
// can import them without a circular dependency. Re-exported for callers
// that still import from this module.
export { isDustRelatedError, isSdkInsufficientFundsError } from './sdk-errors.ts';
import { isDustRelatedError, isSdkInsufficientFundsError } from './sdk-errors.ts';

/** Format dust specks to human-readable DUST string (e.g. "0.300000"). Lib-layer safe (no UI import). */
function dustToString(specks: bigint): string {
  const abs = specks < 0n ? -specks : specks;
  const whole = abs / 1_000_000_000_000_000n;
  const frac = abs % 1_000_000_000_000_000n;
  const sign = specks < 0n ? '-' : '';
  return `${sign}${whole}.${frac.toString().padStart(15, '0').slice(0, 6)}`;
}

/** Format milliseconds as "Xs" or "Xm Ys" for human-friendly elapsed display. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

// ── RPC noise suppression ────────────────────────────────────────────

/**
 * Suppress polkadot-js RPC-CORE noise (logs "Custom error: 138" to
 * console.warn/error on each failed submit). Returns a restore function.
 *
 * Called once at the outer level (executeTransfer, dustRegister) —
 * inner functions like registerNightUtxos do NOT suppress separately.
 */
export function suppressRpcNoise(): () => void {
  const originalWarn = console.warn;
  const originalError = console.error;
  const hasNoise = (args: any[]) => args.some(a => String(a).includes('RPC-CORE'));
  console.warn = (...args: any[]) => { if (!hasNoise(args)) originalWarn(...args); };
  console.error = (...args: any[]) => { if (!hasNoise(args)) originalError(...args); };
  return () => {
    console.warn = originalWarn;
    console.error = originalError;
  };
}

// ── Dust registration ────────────────────────────────────────────────

/**
 * Build and submit a dust registration transaction using the v1 DustWallet API.
 * Separated so the retry wrapper can call it on each attempt with a fresh timestamp.
 */
async function submitDustRegistration(
  bundle: FacadeBundle,
  dustUtxos: DustUtxoWithMeta[],
  dustReceiverAddress: any,
): Promise<string> {
  const ttl = new Date(Date.now() + TX_TTL_MINUTES * 60 * 1000);

  // Timeout-protected: waitForSyncedState() can hang if the dust wallet's
  // shareReplay buffer cleared or the indexer is slow. Throw a retryable error
  // so registerNightUtxos' retry loop catches it.
  await Promise.race([
    bundle.facade.dust.waitForSyncedState(),
    new Promise<never>((_, reject) => setTimeout(() =>
      reject(new Error('Insufficient funds: dust wallet sync timed out')), SYNC_ATTEMPT_TIMEOUT_MS)),
  ]);

  const unprovenTx = await bundle.facade.dust.createDustGenerationTransaction(
    new Date(),
    ttl,
    dustUtxos,
    bundle.keystore.getPublicKey(),
    dustReceiverAddress,
  );

  const intent = unprovenTx.intents?.get(1);
  if (!intent) {
    throw new Error('Dust generation intent not found on transaction');
  }
  const signature = bundle.keystore.signData(intent.signatureData(1));
  const signedTx = await bundle.facade.dust.addDustGenerationSignature(unprovenTx, signature);

  const finalized = await bundle.facade.finalizeTransaction(signedTx);
  return await bundle.facade.submitTransaction(finalized);
}

/**
 * Register NIGHT UTXOs for dust generation with retry on error 138.
 *
 * On a fresh localnet, the estimated dust capacity (allow_fee_payment) may
 * be less than the registration fee for several minutes after UTXO creation.
 * Each retry rebuilds the transaction with a newer timestamp, giving a
 * larger time delta and thus a larger allow_fee_payment.
 *
 * Caller is responsible for RPC noise suppression.
 */
export async function registerNightUtxos(
  bundle: FacadeBundle,
  dustUtxos: DustUtxoWithMeta[],
  dustReceiverAddress: any,
  onStatus?: (status: string) => void,
): Promise<string> {
  const startTime = Date.now();
  const deadline = startTime + DUST_REGISTRATION_TIMEOUT_MS;
  let lastError: Error | undefined;
  let retrying = false;

  // Once in retry mode, tick the elapsed timer every second so the spinner
  // updates continuously — during the sleep AND during submission attempts.
  const elapsedInterval = setInterval(() => {
    if (retrying && onStatus) {
      const elapsed = formatElapsed(Date.now() - startTime);
      onStatus(`Waiting for dust generation capacity (${elapsed} elapsed, ~5 min on fresh wallets)...`);
    }
  }, 1_000);

  try {
    while (Date.now() < deadline) {
      try {
        return await submitDustRegistration(bundle, dustUtxos, dustReceiverAddress);
      } catch (err: any) {
        lastError = err;
        if (isDustRelatedError(err) && Date.now() + DUST_REGISTRATION_RETRY_DELAY_MS < deadline) {
          retrying = true;
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
    clearInterval(elapsedInterval);
  }
}

// ── Ensure dust (shared by transfer, airdrop, and dust register) ─────

/**
 * Ensure dust tokens are available for paying transaction fees.
 *
 * 1. If dust coins already exist → return immediately (skip registration)
 * 2. If unregistered NIGHT UTXOs exist → register them (retries up to 10 min)
 * 3. Wait for balance to become positive
 *
 * Registration is skipped when dust is already available to avoid burning
 * dust on unnecessary registration transactions. New UTXOs (e.g. change
 * outputs) can be registered later via `midnight dust register`.
 *
 * Used by: executeTransfer (transfer/airdrop commands), dustRegister command.
 * Caller is responsible for RPC noise suppression.
 */
export async function ensureDust(
  bundle: FacadeBundle,
  onStatus?: (status: string) => void,
  /** Pre-fetched synced state from the caller. Avoids re-fetching through
   *  facade.state() / waitForSyncedState() which are unreliable due to
   *  shareReplay({ refCount: true }) clearing its buffer between subscriptions. */
  syncedState?: any,
): Promise<EnsureDustResult> {
  // Prefer caller-provided state; fall back to waitForSyncedState (best-effort).
  const state = syncedState ?? await bundle.facade.waitForSyncedState();

  // If dust coins are already available, proceed immediately.
  // Skip registration even if unregistered UTXOs exist — registration costs
  // dust, and we don't want to burn fees when dust is already sufficient.
  if (state.dust.availableCoins.length > 0 || state.dust.balance(new Date()) > 0n) {
    onStatus?.('Dust available');
    return { alreadyAvailable: true };
  }

  // No dust — check for unregistered NIGHT UTXOs and register them.
  const nightUtxos = state.unshielded.availableCoins.filter(
    (coin: any) => coin.meta?.registeredForDustGeneration !== true
  );

  let txHash: string | undefined;

  if (nightUtxos.length > 0) {
    onStatus?.(`Registering ${nightUtxos.length} UTXO(s) for dust generation...`);

    const dustUtxos: DustUtxoWithMeta[] = nightUtxos.map((coin: any) => ({
      ...coin.utxo,
      ctime: new Date(coin.meta.ctime),
    }));

    txHash = await registerNightUtxos(bundle, dustUtxos, state.dust.address, onStatus);
  } else {
    onStatus?.('UTXOs already registered, waiting for dust generation...');
  }

  // Poll for balance using waitForSyncedState() to avoid shareReplay
  // buffer clearing between subscriptions (same issue as the initial check).
  // Each call is timeout-protected so a hung waitForSyncedState() can't block
  // the deadline check indefinitely.
  onStatus?.('Waiting for dust tokens...');
  const pollStart = Date.now();
  while (Date.now() - pollStart < DUST_TIMEOUT_MS) {
    try {
      const pollState = await Promise.race([
        bundle.facade.waitForSyncedState(),
        new Promise<never>((_, reject) => setTimeout(() =>
          reject(new Error('Poll sync timed out')), SYNC_ATTEMPT_TIMEOUT_MS)),
      ]);
      if (pollState.dust.balance(new Date()) > 0n) {
        onStatus?.('Dust available');
        return { alreadyAvailable: false, txHash };
      }
    } catch {
      // Timeout or sync error — continue polling until deadline
    }
    await new Promise(resolve => setTimeout(resolve, 5_000));
  }
  throw new Error(
    'Timed out waiting for dust tokens. ' +
    'Try running: midnight dust register'
  );
}

// ── Transfer build/submit ────────────────────────────────────────────

/**
 * Build, sign, prove, and submit a transfer transaction.
 *
 * Retries on:
 * - Stale UTXO (error 115): quick-sync and retry immediately (up to 3 attempts)
 * - Dust-related errors: re-ensure dust is available, then retry (up to 10 min)
 */
async function buildAndSubmitTransfer(
  bundle: FacadeBundle,
  recipientAddress: UnshieldedAddress,
  amount: bigint,
  onProving?: () => void,
  onSubmitting?: () => void,
  onDust?: (status: string) => void,
): Promise<string> {
  const startTime = Date.now();
  // Use DUST_TIMEOUT_MS (2 min) not DUST_REGISTRATION_TIMEOUT_MS (10 min) —
  // ensureDust already ran before us, so this is only for edge cases where
  // dust became insufficient between ensureDust and transferTransaction.
  const dustDeadline = startTime + DUST_TIMEOUT_MS;
  let lastError: Error | undefined;
  let staleAttempts = 0;

  while (true) {
    try {
      if (lastError) {
        await quickSync(bundle, 'lite');
      }

      const ttl = new Date(Date.now() + TX_TTL_MINUTES * 60 * 1000);

      verbose('transfer', 'Building transfer transaction...');
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

      verbose('transfer', 'Signing recipe...');
      const signedRecipe = await bundle.facade.signRecipe(unprovenRecipe, (payload) =>
        bundle.keystore.signData(payload)
      );

      verbose('transfer', 'Generating ZK proof...');
      onProving?.();
      const finalizedTx = await Promise.race([
        bundle.facade.finalizeRecipe(signedRecipe),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('ZK proof generation timed out')), PROOF_TIMEOUT_MS);
        }),
      ]);

      verbose('transfer', 'Submitting transaction to node...');
      onSubmitting?.();
      const txHash = await bundle.facade.submitTransaction(finalizedTx);
      verbose('transfer', `Transaction submitted: ${txHash}`);
      return txHash;
    } catch (err: any) {
      lastError = err;

      // Stale UTXO: quick-sync and retry immediately (limited attempts)
      const isStaleUtxo = err?.code === STALE_UTXO_ERROR_CODE ||
        err?.message?.includes('115') ||
        err?.message?.toLowerCase().includes('stale');

      if (isStaleUtxo && ++staleAttempts < MAX_RETRY_ATTEMPTS) {
        continue;
      }

      // SDK "insufficient funds" means the internal coin index is empty
      // even though we pre-flight-checked the balance. Bubble up — the
      // outer retry in executeTransfer will restart the facade.
      if (isSdkInsufficientFundsError(err)) {
        throw err;
      }

      // Dust-related: check sufficiency, re-ensure dust, then retry
      if (isDustRelatedError(err) && Date.now() < dustDeadline) {
        const elapsed = formatElapsed(Date.now() - startTime);
        onDust?.(`Dust insufficient, re-ensuring (${elapsed} elapsed)...`);
        try {
          const freshState = await quickSync(bundle, 'lite');
          // Fail fast if dust is below fee threshold — retrying won't help
          const dustBal = freshState.dust.balance(new Date());
          if (dustBal > 0n && dustBal < MIN_DUST_FOR_TRANSFER) {
            throw new Error(
              `Insufficient dust for transaction fees.\n` +
              `Available: ${dustToString(dustBal)} DUST, need ≥${dustToString(MIN_DUST_FOR_TRANSFER)} DUST.\n` +
              `Dust regenerates over time from registered NIGHT UTXOs.\n` +
              `Check status: midnight dust status`
            );
          }
          await ensureDust(bundle, onDust, freshState);
        } catch (retryErr: any) {
          // Re-throw "Insufficient dust" immediately — not retryable
          if (String(retryErr?.message).startsWith('Insufficient dust')) throw retryErr;
          // quickSync or ensureDust may fail (shareReplay stale-read) — wait and retry anyway
          await new Promise(resolve => setTimeout(resolve, 5_000));
        }
        continue;
      }

      throw err;
    }
  }
}

// ── Main transfer flow ───────────────────────────────────────────────

/**
 * Execute a full transfer flow. The lifecycle and recovery loops live in
 * `repo.withFacade(...)`: pre-prime dust, sync-retry on stale-cache /
 * timeout, cold-start race retry on SDK InsufficientFunds, save+invalidate
 * on success, stopFacade in finally. This function only owns the
 * transfer-specific work: pre-flight checks (balance, dust threshold),
 * `ensureDust` orchestration, and the build/sign/prove/submit retry loop
 * (handled inside `buildAndSubmitTransfer` for stale-UTXO + dust errors).
 */
export async function executeTransfer(params: TransferParams): Promise<TransferResult> {
  const {
    seedBuffer,
    networkConfig,
    recipientAddress,
    amountNight,
    signal,
    onSync,
    onSyncDetail,
    onDust,
    onProving,
    onSubmitting,
    onSyncWarning,
  } = params;

  const amount = nightToMicro(amountNight);
  const decodedAddress = validateRecipientAddress(recipientAddress, networkConfig);

  // Suppress SDK transient errors + polkadot-js RPC noise for the duration
  // of the transfer (covers dust registration AND tx submission).
  const unsuppress = suppressSdkTransientErrors(onSyncWarning);
  const restoreRpc = suppressRpcNoise();

  try {
    return await defaultRepository().withFacade(
      seedBuffer,
      networkConfig,
      async ({ bundle, state }) => {
        if (signal?.aborted) throw new Error('Operation cancelled');

        verbose('transfer', 'Sync complete, checking balance...');
        const unshieldedBalance = state.unshielded.balances[ledger.unshieldedToken().raw] ?? 0n;
        const availableCoinCount = state.unshielded.availableCoins?.length ?? 0;
        verbose('transfer', `Balance: ${Number(unshieldedBalance) / TOKEN_MULTIPLIER} NIGHT, coins: ${availableCoinCount}`);
        if (unshieldedBalance < amount) {
          const haveNight = Number(unshieldedBalance) / TOKEN_MULTIPLIER;
          throw new Error(
            `Insufficient balance: ${haveNight.toFixed(6)} NIGHT available, ` +
            `${amountNight} NIGHT requested`
          );
        }

        // Pre-flight dust-below-threshold check. Facade restart won't change
        // this outcome, so fail fast here.
        const initialDustBalance = state.dust.balance(new Date());
        if (initialDustBalance > 0n && initialDustBalance < MIN_DUST_FOR_TRANSFER) {
          throw new Error(
            `Insufficient dust for transaction fees.\n` +
            `Available: ${dustToString(initialDustBalance)} DUST, need ≥${dustToString(MIN_DUST_FOR_TRANSFER)} DUST.\n` +
            `Dust regenerates over time from registered NIGHT UTXOs.\n` +
            `Check status: midnight dust status`
          );
        }

        if (signal?.aborted) throw new Error('Operation cancelled');

        verbose('transfer', 'Ensuring dust availability...');
        await ensureDust(bundle, onDust, state);
        verbose('transfer', 'Dust available');

        if (signal?.aborted) throw new Error('Operation cancelled');

        verbose('transfer', 'Building and submitting transaction...');
        const txHash = await buildAndSubmitTransfer(
          bundle,
          decodedAddress,
          amount,
          onProving,
          onSubmitting,
          onDust,
        );
        return { txHash, amountMicroNight: amount };
      },
      {
        syncMode: 'lite',
        // Writes build ZK proofs — need strict sync or the commitment tree
        // is stale and chain rejects with MalformedError::InvalidDustSpendProof.
        requireStrictSync: true,
        signal,
        onStatus: onDust,
        onSyncProgress: onSync,
        onSyncDetail,
        onSyncWarning,
      },
    );
  } finally {
    restoreRpc();
    unsuppress();
  }
}
