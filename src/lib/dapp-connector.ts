// DApp Connector — implements all 18 ConnectedAPI methods as RPC handlers
// Factory function returns a handler map for ws-rpc.ts to dispatch

import * as rx from 'rxjs';
import { MidnightBech32m, UnshieldedAddress, ShieldedAddress } from '@midnightntwrk/wallet-sdk/address-format';
import type { TransactionStage, WalletTransaction } from '@midnightntwrk/wallet-sdk';
import type { FacadeState, WalletEntry } from '@midnightntwrk/wallet-sdk/facade';
import type { FinalizedTx } from '@midnightntwrk/wallet-sdk';

import { type FacadeBundle, hasDustAvailable } from './facade.ts';
import type { NetworkConfig } from './network.ts';
import type { ApprovalOptions } from './approval.ts';
import { promptApproval } from './approval.ts';
import { createApiError, type RpcHandler, type RpcHandlerContext } from './ws-rpc.ts';
import { createPhaseTracker, type PhaseTracker } from './phase-tracker.ts';
import { toHex, fromHex } from './tx-serde.ts';
import { getNetworkId } from './network-id.ts';
import { isDustShortage } from './sdk-errors.ts';
import { DEFAULT_FEE_LIMITS, feeLimitRefusal, pendingLimitRefusal, type FeeLimits } from './fee-limits.ts';
import { inspectTxHex } from './tx-inspect.ts';
import { feeOnlyRefusals, readDAppTransaction, type DAppTxStage, type FeeCheckTransaction } from './fee-only-check.ts';
import { assertSignable, signRecipe } from './sign-recipe.ts';
import { TX_TTL_MINUTES, PROOF_TIMEOUT_MS, DUST_RETRY_ATTEMPTS, DUST_RETRY_DELAY_MS, ABANDONED_TX_TIMEOUT_MS } from './constants.ts';
import { dim } from '../ui/colors.ts';
import { toDust } from '../ui/format.ts';

// ── Types ──

export interface DAppConnectorCallbacks {
  onPhaseStart?: (connectionId: string, method: string, phase: string) => void;
  onPhaseComplete?: (connectionId: string, method: string, phase: string, durationMs: number) => void;
}

export interface DAppConnectorOptions {
  bundle: FacadeBundle;
  networkConfig: NetworkConfig;
  approvalOptions: ApprovalOptions;
  /** Under --approve-fees: the most a transaction may cost, and how many may wait unsubmitted. */
  feeLimits?: FeeLimits;
  callbacks?: DAppConnectorCallbacks;
}

/** Which token kinds the facade balances a dApp's transaction in. */
export type TokenKindsToBalance = 'all' | Array<'dust' | 'shielded' | 'unshielded'>;

export interface DAppConnector {
  handlers: Record<string, RpcHandler>;
  /** Revert all pending (unsubmitted) transactions for a connection, releasing locked coins. */
  revertPendingTxs(connectionId: string): Promise<void>;
  /** True if any connection has a balanced-but-not-submitted transaction. */
  hasPendingTxs(): boolean;
  dispose(): void;
}

// ── Factory ──

/** Extract a human-readable detail string from an SDK/chain error.
 *  Walks nested cause chains including Effect Data.TaggedError objects. */
function extractErrorDetail(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const anyErr = current as any;
    // Effect Data.TaggedError or standard Error
    if (current instanceof Error || (typeof current === 'object' && anyErr._tag)) {
      const tag = anyErr._tag;
      const msg = anyErr.message ?? '';
      if (tag && msg) {
        parts.push(`[${tag}] ${msg}`);
      } else if (msg) {
        parts.push(msg);
      } else if (tag) {
        parts.push(`[${tag}]`);
      }
      // Effect errors may have structured data
      if (anyErr.data && typeof anyErr.data === 'object') {
        try { parts.push(`data=${JSON.stringify(anyErr.data)}`); } catch { /* skip */ }
      }
      // Walk the cause chain (works for both Error.cause and Effect's cause field)
      current = anyErr.cause;
    } else if (typeof current === 'string') {
      parts.push(current);
      break;
    } else {
      try {
        const str = JSON.stringify(current);
        if (str && str !== '{}') parts.push(str);
        else parts.push(String(current));
      } catch { parts.push(String(current)); }
      break;
    }
  }
  // Deduplicate identical consecutive messages (SDK wraps same message at multiple levels)
  const deduped: string[] = [];
  for (const p of parts) {
    if (deduped.length === 0 || deduped[deduped.length - 1] !== p) {
      deduped.push(p);
    }
  }
  return deduped.join(' → ') || 'Unknown error';
}

/** The error message when the operator declines an approval prompt. */
export const OPERATOR_REJECTED_MESSAGE = 'User rejected the request';

/** The connector API's history entry for one wallet history entry. */
export type HistoryEntry = {
  txHash: string;
  txStatus:
    | { status: 'finalized'; executionStatus: Record<number, 'Success' | 'Failure'> }
    | { status: 'pending' }
    | { status: 'discarded' };
};

/**
 * Map a wallet history entry onto the connector API's shape. The wallet
 * records one outcome per transaction, not one per segment, so a finalized
 * entry reports no per-segment execution status rather than inventing one.
 */
export function toHistoryEntry(entry: WalletEntry): HistoryEntry {
  switch (entry.lifecycle.status) {
    case 'finalized':
      return { txHash: entry.hash, txStatus: { status: 'finalized', executionStatus: {} } };
    case 'rejected':
      return { txHash: entry.hash, txStatus: { status: 'discarded' } };
    case 'pending':
      return { txHash: entry.hash, txStatus: { status: 'pending' } };
  }
}

/**
 * The connector API's name for a signature scheme. mn's unshielded key is a
 * BIP-340 Schnorr key; it never signs ECDSA, so any other tag is a bug.
 */
export function signatureScheme(tag: string): 'schnorr_bip340' {
  if (tag !== 'schnorr') {
    throw new Error(`Unexpected signature scheme "${tag}": mn signs with BIP-340 Schnorr only`);
  }
  return 'schnorr_bip340';
}

export function createDAppConnector(options: DAppConnectorOptions): DAppConnector {
  const { bundle, networkConfig, approvalOptions, callbacks } = options;
  const feeLimits = options.feeLimits ?? DEFAULT_FEE_LIMITS;
  const { facade, keystore } = bundle;
  const networkId = getNetworkId(networkConfig.networkId);

  // ── State subscription — cache latest synced state ──

  let latestState: FacadeState | undefined;
  const subscription = facade.state().pipe(
    rx.filter((s) => s.isSynced),
  ).subscribe((state) => {
    latestState = state;
  });

  function getState(): FacadeState {
    if (!latestState) {
      throw createApiError('Disconnected', 'Wallet not synced yet');
    }
    return latestState;
  }

  // ── Shared helpers ──

  // Track pending transactions per connection that haven't been submitted yet.
  // Keyed by serialized tx hex so untracking works after deserialization.
  // On rejection/disconnect/abandon we revert the FINALIZED transaction: that
  // releases the coins it spent in all three wallets and clears the pending
  // entry `finalizeRecipe` registered for it. Reverting the recipe would leave
  // that entry pending until its TTL. `feeOnly` marks a transaction this
  // connection had balanced Dust-only under --approve-fees: only its submit
  // counts as fee-only.
  const pendingTxsByConnection = new Map<string, Map<string, { finalized: FinalizedTx; timer: ReturnType<typeof setTimeout>; feeOnly: boolean }>>();

  function trackPendingTx(connectionId: string, txHex: string, finalized: FinalizedTx, feeOnly = false): void {
    let txMap = pendingTxsByConnection.get(connectionId);
    if (!txMap) {
      txMap = new Map();
      pendingTxsByConnection.set(connectionId, txMap);
    }
    // Start abandon timer — auto-revert if DApp never submits.
    const timer = setTimeout(async () => {
      txMap!.delete(txHex);
      if (txMap!.size === 0) pendingTxsByConnection.delete(connectionId);
      try { await facade.revert(finalized); } catch { /* best-effort */ }
      process.stderr.write(dim(`  abandoned tx reverted (${connectionId})`) + '\n');
    }, ABANDONED_TX_TIMEOUT_MS);
    txMap.set(txHex, { finalized, timer, feeOnly });
  }

  function untrackPendingTx(connectionId: string, txHex: string): void {
    const txMap = pendingTxsByConnection.get(connectionId);
    if (!txMap) return;
    const entry = txMap.get(txHex);
    if (entry) {
      clearTimeout(entry.timer);
      txMap.delete(txHex);
    }
    if (txMap.size === 0) pendingTxsByConnection.delete(connectionId);
  }

  /** Revert and clean up all pending transactions for a connection (disconnect). */
  async function revertPendingTxs(connectionId: string): Promise<void> {
    const txMap = pendingTxsByConnection.get(connectionId);
    if (!txMap || txMap.size === 0) return;
    pendingTxsByConnection.delete(connectionId);
    for (const [, entry] of txMap) {
      clearTimeout(entry.timer);
      try { await facade.revert(entry.finalized); } catch { /* best-effort */ }
    }
    process.stderr.write(dim(`  reverted ${txMap.size} pending tx(s) on disconnect`) + '\n');
  }

  function createTtl(): Date {
    return new Date(Date.now() + TX_TTL_MINUTES * 60 * 1000);
  }

  /** Sign, prove (with timeout), and serialize a transaction recipe.
   *  Returns both the serialized hex and the finalized tx object (for tracking/revert). */
  async function processRecipe(recipe: any, tracker?: PhaseTracker): Promise<{ hex: string; finalized: FinalizedTx }> {
    tracker?.start('signing');
    let signed: any;
    try {
      signed = await signRecipe(facade, recipe, keystore.signDataAsync);
    } catch (err) {
      // Release what balancing booked; nothing will be tracked for this recipe.
      try { await facade.revert(recipe); } catch { /* best-effort */ }
      throw err;
    }
    tracker?.start('proving');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finalized: FinalizedTx;
    const finalizing = facade.finalizeRecipe(signed);
    try {
      finalized = await Promise.race([
        finalizing,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('ZK proof generation timed out')), PROOF_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      // No finalized transaction to track: release what balancing booked now,
      // rather than leaving the coins held until the TTL.
      try { await facade.revert(recipe); } catch { /* best-effort */ }
      // A timed-out proof keeps running, and the SDK registers its finalized tx
      // as pending when it lands; nobody will submit it, so revert that too.
      finalizing.then((late) => facade.revert(late)).catch(() => { /* best-effort */ });
      throw err;
    } finally {
      clearTimeout(timer);
    }
    tracker?.complete();
    return { hex: toHex(finalized.serialize()), finalized };
  }

  /**
   * Read a dApp's hex transaction at the given stage, as this wallet's current
   * ledger version. Bytes from another ledger version, or another stage, are
   * the caller's mistake, so they come back as InvalidRequest.
   */
  function adopt<TStage extends TransactionStage>(txHex: string, stage: TStage): WalletTransaction<TStage> {
    try {
      return facade.adoptTransaction(fromHex(txHex), stage);
    } catch (err) {
      throw createApiError(
        'InvalidRequest',
        `The transaction could not be read at stage ${stage} as this wallet's ledger version: ${extractErrorDetail(err)}`,
      );
    }
  }

  /** Prompt terminal approval for a write method. Throws Rejected on denial. */
  async function requireApproval(
    method: string,
    details: Array<{ label: string; value: string }> = [],
    context?: RpcHandlerContext,
    feeOnly = false,
  ): Promise<void> {
    context?.notify('approval:pending', { method });
    const result = await promptApproval(
      { method, network: networkConfig.networkId, details, dappName: context?.connectionId, feeOnly },
      approvalOptions,
    );
    const outcome = result === 'reject' ? 'rejected' : 'approved';
    context?.notify('approval:resolved', { method, result: outcome });
    if (result === 'reject') {
      throw createApiError('Rejected', OPERATOR_REJECTED_MESSAGE);
    }
  }

  /**
   * Fee-wallet mode (--approve-fees): refuse a dApp transaction unless paying
   * its Dust fee is all this wallet would do to it. Signing an unbound recipe
   * signs the dApp's own transaction, so Dust-only balancing alone does not
   * keep the wallet to the fee (see fee-only-check.ts).
   */
  function assertFeeOnly(txHex: string, stage: DAppTxStage, payFees: unknown): void {
    if (payFees === false) {
      throw createApiError('InvalidRequest',
        'This wallet is a fee wallet (--approve-fees): it only pays the Dust fee, so payFees: false leaves it nothing to do');
    }
    let tx: FeeCheckTransaction;
    try {
      tx = readDAppTransaction(fromHex(txHex), stage);
    } catch (err) {
      throw createApiError('InvalidRequest',
        `The transaction could not be read as a proven ledger-9 ${stage} transaction: ${extractErrorDetail(err)}`);
    }
    const reasons = feeOnlyRefusals(tx, keystore.getPublicKey());
    if (reasons.length > 0) {
      throw createApiError('Rejected',
        `This wallet is a fee wallet (--approve-fees) and pays only the Dust fee; it refuses this transaction because ${reasons.join('; ')}`);
    }
  }

  /** Refuse an unsealed dApp transaction the wallet can't sign without breaking it. */
  function assertDAppTxSignable(txHex: string): void {
    try {
      assertSignable(readDAppTransaction(fromHex(txHex), 'unsealed'));
    } catch (err) {
      throw createApiError('InvalidRequest', extractErrorDetail(err));
    }
  }

  /**
   * Fee-wallet limits, checked before anything is booked: no more than
   * `maxPending` balanced transactions may wait unsubmitted, and the total fee
   * (the dApp's tx plus the wallet's balancing tx) may not exceed `maxFee`.
   */
  async function assertWithinFeeLimits(dappTx: WalletTransaction<'Unbound'> | WalletTransaction<'Finalized'>, ttl: Date): Promise<void> {
    let pending = 0;
    for (const [, txMap] of pendingTxsByConnection) pending += txMap.size;
    const pendingReason = pendingLimitRefusal(pending, feeLimits);
    let reason = pendingReason;
    if (!pendingReason) {
      const fee = await facade.estimateTransactionFee(dappTx, { ttl });
      process.stderr.write(dim(`  fee-only: estimated fee ${toDust(fee)} DUST (limit ${toDust(feeLimits.maxFeeSpecks)})`) + '\n');
      reason = feeLimitRefusal(fee, feeLimits);
    }
    if (reason) {
      throw createApiError('Rejected', `This wallet is a fee wallet (--approve-fees) and refuses this transaction: ${reason}`);
    }
  }

  /**
   * Balance a dApp's transaction. Under --approve-fees: Dust only, and only once
   * `assertFeeOnly` passes, never falling back to a wider balance. Otherwise
   * every token kind, or all but Dust when the dApp says `payFees: false`.
   */
  async function balanceDAppTransaction(
    method: 'balanceUnsealedTransaction' | 'balanceSealedTransaction',
    stage: DAppTxStage,
    params: Record<string, unknown>,
    context: RpcHandlerContext,
  ): Promise<{ tx: string }> {
    const txHex = String(params.tx ?? '');
    if (!txHex) {
      throw createApiError('InvalidRequest', 'tx is required');
    }
    const payFees = (params.options as { payFees?: unknown } | undefined)?.payFees;
    const feeOnly = approvalOptions.approveFees === true;
    if (feeOnly) assertFeeOnly(txHex, stage, payFees);
    const tokenKindsToBalance: TokenKindsToBalance = feeOnly
      ? ['dust']
      : payFees === false ? ['shielded', 'unshielded'] : 'all';

    const ttl = createTtl();
    const dappTx = stage === 'unsealed' ? adopt(txHex, 'Unbound') : adopt(txHex, 'Finalized');
    // Signing an unsealed transaction signs the dApp's part too; refuse one that can't be signed before booking anything.
    if (stage === 'unsealed') assertDAppTxSignable(txHex);
    if (feeOnly) await assertWithinFeeLimits(dappTx, ttl);

    const tracker = makeTracker(method, context);

    tracker.start('approve');
    await requireApproval(method, inspectTxHex(txHex, stage), context, feeOnly);

    tracker.start('building');
    const balanceOptions = { ttl, tokenKindsToBalance };
    let recipe: any;
    if (stage === 'unsealed') {
      const unsealedTx = dappTx as WalletTransaction<'Unbound'>;
      recipe = await withDustRetry(() => facade.balanceUnboundTransaction(unsealedTx, balanceOptions));
    } else {
      const sealedTx = dappTx as WalletTransaction<'Finalized'>;
      recipe = await withDustRetry(() => facade.balanceFinalizedTransaction(sealedTx, balanceOptions));
    }
    const { hex, finalized } = await processRecipe(recipe, tracker);
    trackPendingTx(context.connectionId, hex, finalized, feeOnly);
    context.metadata.phases = tracker.getTimings();
    return { tx: hex };
  }

  /** Encode an SDK address object to bech32m string. */
  function encodeAddress(address: any): string {
    return MidnightBech32m.encode(networkId, address).asString();
  }

  /**
   * Convert DApp Connector DesiredOutput[] to SDK CombinedTokenTransfer[].
   *
   * Field mapping:
   *   DesiredOutput.kind  ('shielded'|'unshielded') → CombinedTokenTransfer.type
   *   DesiredOutput.type  (hex TokenType)           → TokenTransfer.type (RawTokenType)
   *   DesiredOutput.value (bigint or string)         → TokenTransfer.amount (bigint)
   *   DesiredOutput.recipient (bech32m string)       → TokenTransfer.receiverAddress (Address object)
   */
  function parseDesiredOutputs(outputs: any[]): any[] {
    const grouped: Record<string, any[]> = {};

    for (const output of outputs) {
      const kind = output.kind as string;
      if (kind !== 'shielded' && kind !== 'unshielded') {
        throw createApiError('InvalidRequest', `Invalid output kind: "${kind}" — must be "shielded" or "unshielded"`);
      }
      if (!grouped[kind]) grouped[kind] = [];

      const amount = BigInt(output.value);

      let receiverAddress: any;
      if (kind === 'unshielded') {
        receiverAddress = MidnightBech32m.parse(output.recipient).decode(UnshieldedAddress, networkId);
      } else {
        receiverAddress = MidnightBech32m.parse(output.recipient).decode(ShieldedAddress, networkId);
      }

      grouped[kind].push({
        type: output.type,
        receiverAddress,
        amount,
      });
    }

    return Object.entries(grouped).map(([kind, transfers]) => ({
      type: kind,
      outputs: transfers,
    }));
  }

  /** Create a phase tracker wired to callbacks and context notifications. */
  function makeTracker(method: string, context?: RpcHandlerContext): PhaseTracker {
    return createPhaseTracker({
      onStart: (phase) => {
        const connId = context?.connectionId ?? 'unknown';
        callbacks?.onPhaseStart?.(connId, method, phase);
        context?.notify('progress', { method, phase, status: 'started' });
      },
      onComplete: (phase, durationMs) => {
        const connId = context?.connectionId ?? 'unknown';
        callbacks?.onPhaseComplete?.(connId, method, phase, durationMs);
        context?.notify('progress', { method, phase, status: 'completed', durationMs });
      },
    });
  }

  /** Check if dust coins are currently available via the cached state. */
  function isDustAvailable(): boolean {
    return latestState !== undefined && hasDustAvailable(latestState);
  }

  /** Wait for dust to become available by observing state updates. */
  async function waitForDust(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      // If already available, resolve immediately
      if (isDustAvailable()) { resolve(true); return; }
      const sub = facade.state().pipe(
        rx.filter(() => isDustAvailable()),
        rx.take(1),
        rx.timeout(timeoutMs),
      ).subscribe({
        next: () => { sub.unsubscribe(); resolve(true); },
        error: () => { sub.unsubscribe(); resolve(false); },
      });
    });
  }

  /** Retry a facade call that fails with "No dust tokens", waiting for dust between attempts. */
  async function withDustRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= DUST_RETRY_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        const msg = String(err?.message ?? err ?? '');
        if (!isDustShortage(err) || attempt === DUST_RETRY_ATTEMPTS) throw err;
        process.stderr.write(dim(`  dust unavailable, waiting for recovery (${attempt}/${DUST_RETRY_ATTEMPTS})... [${msg.slice(0, 60)}]`) + '\n');
        // Wait for dust to actually appear in state, not just a blind delay
        const recovered = await waitForDust(DUST_RETRY_DELAY_MS);
        if (!recovered && attempt < DUST_RETRY_ATTEMPTS) {
          // Dust didn't appear within delay — give it a bit more time
          await new Promise((r) => setTimeout(r, DUST_RETRY_DELAY_MS));
        }
      }
    }
    throw new Error('unreachable');
  }

  // ── Handler map — all 18 ConnectedAPI methods ──

  const handlers: Record<string, RpcHandler> = {

    // ── Handshake (1) ──

    connect: async (params) => {
      const requestedNetwork = String(params.networkId ?? '');
      if (requestedNetwork.toLowerCase() !== networkConfig.networkId.toLowerCase()) {
        throw createApiError('InvalidRequest',
          `Network mismatch: wallet is on ${networkConfig.networkId}, requested ${requestedNetwork}`);
      }
      return { networkId: networkConfig.networkId };
    },

    // ── Read-Only Methods (9) — auto-approved ──

    getUnshieldedBalances: async () => {
      return getState().unshielded.balances;
    },

    getShieldedBalances: async () => {
      return getState().shielded.balances;
    },

    getDustBalance: async () => {
      const state = getState();
      const balance = state.dust.balance(new Date());
      // API expects { cap, balance }. Exact cap requires estimating from
      // registered NIGHT UTXO dust generation potential. For v1, use balance
      // as approximation — both represent current dust availability.
      return { cap: balance, balance };
    },

    getUnshieldedAddress: async () => {
      const state = getState();
      return { unshieldedAddress: encodeAddress(state.unshielded.address) };
    },

    getShieldedAddresses: async () => {
      const state = getState();
      const addr = state.shielded.address;
      return {
        shieldedAddress: encodeAddress(addr),
        shieldedCoinPublicKey: addr.coinPublicKeyString(),
        shieldedEncryptionPublicKey: addr.encryptionPublicKeyString(),
      };
    },

    getDustAddress: async () => {
      const state = getState();
      return { dustAddress: encodeAddress(state.dust.address) };
    },

    getTxHistory: async (params) => {
      getState();
      const pageNumber = Number(params.pageNumber ?? 0);
      const pageSize = Number(params.pageSize ?? 20);
      const start = pageNumber * pageSize;
      const entries = await facade.getAllFromTxHistory();
      return entries.slice(start, start + pageSize).map(toHistoryEntry);
    },

    getConfiguration: async () => {
      return {
        indexerUri: networkConfig.indexer,
        indexerWsUri: networkConfig.indexerWS,
        proverServerUri: networkConfig.proofServer,
        substrateNodeUri: networkConfig.node,
        networkId: networkConfig.networkId,
      };
    },

    getConnectionStatus: async () => {
      // Return the lowercase abstractions form (e.g. 'undeployed'), matching
      // what addresses are encoded with. dApps that round-trip this back into
      // setNetworkId() and then decode an address would otherwise hit a
      // case-sensitivity mismatch — bech32m HRPs are lowercase, so encoder
      // and getConnectionStatus must agree on the lowercase form.
      return { status: 'connected', networkId };
    },

    // ── Write Methods (7) — require terminal approval ──

    makeTransfer: async (params, context) => {
      const outputs = params.desiredOutputs as any[];
      if (!Array.isArray(outputs) || outputs.length === 0) {
        throw createApiError('InvalidRequest', 'desiredOutputs must be a non-empty array');
      }

      const tracker = makeTracker('makeTransfer', context);

      const details = outputs.map((o, i) => ({
        label: `Output ${i + 1}`,
        value: `${o.value} → ${String(o.recipient).slice(0, 20)}... (${o.kind})`,
      }));
      tracker.start('approve');
      await requireApproval('makeTransfer', details, context);

      tracker.start('building');
      const combinedTransfers = parseDesiredOutputs(outputs);
      const payFees = (params.options as any)?.payFees ?? true;
      const recipe = await withDustRetry(() => facade.transferTransaction(combinedTransfers, {
        ttl: createTtl(),
        payFees,
      }));
      const { hex, finalized } = await processRecipe(recipe, tracker);
      trackPendingTx(context.connectionId, hex, finalized);
      context.metadata.phases = tracker.getTimings();
      return { tx: hex };
    },

    submitTransaction: async (params, context) => {
      const txHex = String(params.tx ?? '');
      if (!txHex) {
        throw createApiError('InvalidRequest', 'tx is required');
      }

      const tracker = makeTracker('submitTransaction', context);

      // Submit is the irreversible action: prompt, unless under --approve-fees
      // it is a transaction this connection had balanced fee-only.
      const feeOnly = approvalOptions.approveFees === true
        && pendingTxsByConnection.get(context.connectionId)?.get(txHex)?.feeOnly === true;
      tracker.start('approve');
      try {
        await requireApproval('submitTransaction', inspectTxHex(txHex, 'sealed'), context, feeOnly);
      } catch (err) {
        // Rejection — revert to release dust coins from pending.
        const txMap = pendingTxsByConnection.get(context.connectionId);
        const entry = txMap?.get(txHex);
        if (entry) {
          try { await facade.revert(entry.finalized); } catch { /* best-effort */ }
        }
        untrackPendingTx(context.connectionId, txHex);
        throw err;
      }

      // Adopt for submission (the chain doesn't need object identity)
      const sealedTx = adopt(txHex, 'Finalized');
      tracker.start('submitting');
      try {
        const txHash = await facade.submitTransaction(sealedTx);
        tracker.complete();
        // Tx submitted successfully — untrack (coins are now spent, not pending)
        untrackPendingTx(context.connectionId, txHex);
        context.metadata.phases = tracker.getTimings();
        // Return txHash for server logging (onResponse can read it from result)
        return { txHash };
      } catch (submitErr: unknown) {
        tracker.complete();
        // Revert pending tx to release locked dust coins
        const txMap = pendingTxsByConnection.get(context.connectionId);
        const entry = txMap?.get(txHex);
        if (entry) {
          try { await facade.revert(entry.finalized); } catch { /* best-effort */ }
        }
        untrackPendingTx(context.connectionId, txHex);
        // Re-throw with full detail so the RPC layer can forward it
        const detail = extractErrorDetail(submitErr);
        const enriched = new Error(`Transaction submission failed: ${detail}`);
        enriched.cause = submitErr;
        throw enriched;
      }
    },

    balanceUnsealedTransaction: (params, context) =>
      balanceDAppTransaction('balanceUnsealedTransaction', 'unsealed', params, context),

    balanceSealedTransaction: (params, context) =>
      balanceDAppTransaction('balanceSealedTransaction', 'sealed', params, context),

    makeIntent: async (params, context) => {
      const desiredInputs = params.desiredInputs as any[];
      const desiredOutputs = params.desiredOutputs as any[];
      const intentOptions = params.options as any;

      if (!intentOptions) {
        throw createApiError('InvalidRequest', 'options is required for makeIntent');
      }

      const tracker = makeTracker('makeIntent', context);

      tracker.start('approve');
      await requireApproval('makeIntent', [], context);

      tracker.start('building');
      // Convert DesiredInput[] → CombinedSwapInputs { shielded?: Record, unshielded?: Record }
      const swapInputs: Record<string, Record<string, bigint>> = {};
      if (Array.isArray(desiredInputs)) {
        for (const input of desiredInputs) {
          const kind = input.kind as string;
          if (!swapInputs[kind]) swapInputs[kind] = {};
          swapInputs[kind][input.type] = BigInt(input.value);
        }
      }

      const combinedOutputs = parseDesiredOutputs(desiredOutputs ?? []);

      const recipe = await withDustRetry(() => facade.initSwap(swapInputs, combinedOutputs, {
        ttl: createTtl(),
        payFees: intentOptions.payFees ?? true,
      }));
      const { hex, finalized } = await processRecipe(recipe, tracker);
      trackPendingTx(context.connectionId, hex, finalized);
      context.metadata.phases = tracker.getTimings();
      return { tx: hex };
    },

    signData: async (params, context) => {
      const data = String(params.data ?? '');
      const signOptions = params.options as any;

      if (!data || !signOptions?.encoding) {
        throw createApiError('InvalidRequest', 'data and options.encoding are required');
      }
      if (signOptions.keyType && signOptions.keyType !== 'unshielded') {
        throw createApiError('InvalidRequest', `Unsupported keyType: "${signOptions.keyType}" — only "unshielded" is supported`);
      }

      await requireApproval('signData', [
        { label: 'Encoding', value: signOptions.encoding },
        { label: 'Data', value: data.length > 64 ? data.slice(0, 64) + '...' : data },
      ], context);

      // Decode data based on encoding
      let payload: Uint8Array;
      switch (signOptions.encoding) {
        case 'hex':
          payload = fromHex(data);
          break;
        case 'base64':
          payload = new Uint8Array(Buffer.from(data, 'base64'));
          break;
        case 'text':
          payload = new Uint8Array(Buffer.from(data, 'utf-8'));
          break;
        default:
          throw createApiError('InvalidRequest', `Unknown encoding: ${signOptions.encoding}`);
      }

      // Both come back as { tag, value }: the hex is in `value`, and the
      // tag names the scheme the connector API reports.
      const signature = await keystore.signDataAsync(payload);
      const verifyingKey = keystore.getPublicKey();

      return {
        data,
        signature: signature.value,
        verifyingKey: verifyingKey.value,
        scheme: signatureScheme(signature.tag),
      };
    },

    // ── Proving Provider (1) ──

    getProvingProvider: async () => {
      // For v1, we use the proof server from network config.
      // The DApp's keyMaterialProvider is not used over JSON-RPC — the proof
      // server handles proving directly. WASM proving with DApp-provided key
      // material would require bidirectional RPC (future enhancement).
      return { provingProvider: 'ready', proverServerUri: networkConfig.proofServer };
    },

    // ── Permission (1) ──

    hintUsage: async (params) => {
      const methods = (params.methodNames as string[]) ?? [];
      process.stderr.write(dim(`  DApp hints usage: ${methods.join(', ')}`) + '\n');
    },
  };

  function dispose(): void {
    subscription.unsubscribe();
    // Clear all abandon timers
    for (const [, txMap] of pendingTxsByConnection) {
      for (const [, entry] of txMap) {
        clearTimeout(entry.timer);
      }
    }
    pendingTxsByConnection.clear();
  }

  function hasPendingTxs(): boolean {
    for (const [, txMap] of pendingTxsByConnection) {
      if (txMap.size > 0) return true;
    }
    return false;
  }

  return { handlers, revertPendingTxs, hasPendingTxs, dispose };
}
