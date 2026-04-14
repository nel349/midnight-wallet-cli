// Shared transfer execution — used by both airdrop and transfer commands
// Handles: facade lifecycle, sync, balance check, dust, tx build/sign/prove/submit, retries

import * as ledger from '@midnight-ntwrk/ledger-v8';
import { MidnightBech32m, UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import { NetworkId } from '@midnight-ntwrk/wallet-sdk-abstractions';
import { type UtxoWithMeta as DustUtxoWithMeta } from '@midnight-ntwrk/wallet-sdk-dust-wallet/v1';
import * as rx from 'rxjs';

import { type NetworkConfig } from './network.ts';
import { type FacadeBundle, buildFacade, startAndSyncFacade, quickSync, stopFacade, suppressSdkTransientErrors } from './facade.ts';
import { loadWalletCache, saveWalletCache } from './wallet-cache.ts';
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
  SYNC_ATTEMPT_REMOTE_TIMEOUT_MS,
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
  /** Skip cache load and save when true. */
  noCache?: boolean;
  /** Wallet address for cache keying (required for cache). */
  walletAddress?: string;
  /** Network name for cache keying (required for cache). */
  networkName?: string;
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
    const tag = current?._tag;
    if (tag === 'TransactionInvalidError' || tag === 'SubmissionError') return true;
    current = current.cause;
  }
  return false;
}

/**
 * Check if an error is dust-related — the SDK throws various messages when
 * dust capacity is too low to pay fees. All of these are retryable by
 * waiting for dust generation capacity to grow.
 */
export function isDustRelatedError(err: any): boolean {
  const msg = err?.message?.toLowerCase() ?? '';
  return msg.includes('not enough dust') ||
    msg.includes('dust generated') ||
    msg.includes('insufficient funds') ||
    msg.includes('no dust tokens') ||
    isTransactionRejectedError(err);
}

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
 * Execute a full transfer flow:
 * 1. Build facade from seed + network config
 * 2. Start & sync facade
 * 3. Check balance
 * 4. Ensure dust is available
 * 5. Build/sign/prove/submit transaction (re-ensures dust on retry)
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
    onSyncDetail,
    onDust,
    onProving,
    onSubmitting,
    onSyncWarning,
    noCache,
    walletAddress,
    networkName,
  } = params;

  const amount = nightToMicro(amountNight);

  // Validate and decode recipient address
  const decodedAddress = validateRecipientAddress(recipientAddress, networkConfig);

  // Suppress known transient SDK errors (Wallet.Sync: Internal Server Error, etc.)
  const unsuppress = suppressSdkTransientErrors(onSyncWarning);

  // Suppress polkadot-js RPC-CORE noise — single suppression point for the
  // entire transfer flow (covers dust registration and transfer submission).
  const restoreRpc = suppressRpcNoise();

  // Load cached wallet state (unless --no-cache or missing cache params)
  const useCache = !noCache && walletAddress && networkName;
  const cache = useCache ? loadWalletCache(walletAddress, networkName) : null;

  // Build facade — may be rebuilt on sync retry
  verbose('transfer', 'Building facade...');
  let bundle = await buildFacade(seedBuffer, networkConfig, cache);
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
    // Start & sync with retry — dust wallet can take many events to catch up
    // on remote networks (preview/preprod). On timeout, save partial progress
    // to cache so the next attempt resumes where it left off.
    const isRemote = networkConfig.networkId !== 'Undeployed';
    const syncTimeoutMs = isRemote ? SYNC_ATTEMPT_REMOTE_TIMEOUT_MS : SYNC_ATTEMPT_TIMEOUT_MS;
    const MAX_SYNC_ATTEMPTS = 3;
    let syncedState!: any;

    verbose('transfer', `Sync timeout: ${syncTimeoutMs / 1000}s (${isRemote ? 'remote' : 'local'} network)`);

    for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt++) {
      try {
        syncedState = await startAndSyncFacade(bundle, {
          onProgress: onSync,
          onSyncDetail,
          timeoutMs: syncTimeoutMs,
          syncMode: 'lite',
          // Writes build ZK proofs — need strict sync or the commitment tree
          // is stale and chain rejects with MalformedError::InvalidDustSpendProof.
          requireStrictSync: true,
        });
        break;
      } catch (err: any) {
        if (signal?.aborted) throw new Error('Operation cancelled');
        if (attempt < MAX_SYNC_ATTEMPTS && String(err?.message).includes('timed out')) {
          // Save partial sync progress to cache before retrying
          if (useCache) {
            try {
              verbose('transfer', 'Saving partial sync progress to cache...');
              await saveWalletCache(walletAddress, networkName, bundle.facade);
            } catch { /* best-effort */ }
          }
          onDust?.(`Sync timed out, retrying (attempt ${attempt + 1}/${MAX_SYNC_ATTEMPTS})...`);
          await stopFacade(bundle).catch(() => {});
          const retryCache = useCache ? loadWalletCache(walletAddress, networkName) : null;
          bundle = await buildFacade(seedBuffer, networkConfig, retryCache);
          continue;
        }
        throw err;
      }
    }

    if (signal?.aborted) throw new Error('Operation cancelled');

    // Check balance
    verbose('transfer', 'Sync complete, checking balance...');
    const unshieldedBalance = syncedState.unshielded.balances[ledger.unshieldedToken().raw] ?? 0n;
    verbose('transfer', `Balance: ${Number(unshieldedBalance) / TOKEN_MULTIPLIER} NIGHT`);
    if (unshieldedBalance < amount) {
      const haveNight = Number(unshieldedBalance) / TOKEN_MULTIPLIER;
      throw new Error(
        `Insufficient balance: ${haveNight.toFixed(6)} NIGHT available, ` +
        `${amountNight} NIGHT requested`
      );
    }

    if (signal?.aborted) throw new Error('Operation cancelled');

    // Ensure dust — pass syncedState to avoid shareReplay stale-read
    verbose('transfer', 'Ensuring dust availability...');
    await ensureDust(bundle, onDust, syncedState);
    verbose('transfer', 'Dust available');

    // Pre-flight: fail fast if dust exists but is below the minimum for a transfer.
    // The actual fee = feesWithMargin(tx, params, 5) + DUST_COST_OVERHEAD (~0.5 DUST total).
    // Without this check, the transfer would fail inside the SDK and enter a 2-minute
    // retry loop that can never succeed (ensureDust keeps returning alreadyAvailable
    // because dust > 0, but the SDK can't build transactions with insufficient dust).
    const dustBalance = syncedState.dust.balance(new Date());
    if (dustBalance > 0n && dustBalance < MIN_DUST_FOR_TRANSFER) {
      throw new Error(
        `Insufficient dust for transaction fees.\n` +
        `Available: ${dustToString(dustBalance)} DUST, need ≥${dustToString(MIN_DUST_FOR_TRANSFER)} DUST.\n` +
        `Dust regenerates over time from registered NIGHT UTXOs.\n` +
        `Check status: midnight dust status`
      );
    }

    if (signal?.aborted) throw new Error('Operation cancelled');

    // Build, sign, prove, submit (re-ensures dust on retry)
    verbose('transfer', 'Building and submitting transaction...');
    const txHash = await buildAndSubmitTransfer(
      bundle,
      decodedAddress,
      amount,
      onProving,
      onSubmitting,
      onDust,
    );

    // Save cache after successful transfer (post-tx state has updated UTXOs)
    if (useCache) {
      try { await saveWalletCache(walletAddress, networkName, bundle.facade); } catch { /* best-effort */ }
    }

    return { txHash, amountMicroNight: amount };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    restoreRpc();
    unsuppress();
    await cleanup();
  }
}
