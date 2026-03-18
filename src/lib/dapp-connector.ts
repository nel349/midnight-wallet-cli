// DApp Connector — implements all 18 ConnectedAPI methods as RPC handlers
// Factory function returns a handler map for ws-rpc.ts to dispatch

import * as rx from 'rxjs';
import * as ledger from '@midnight-ntwrk/ledger-v7';
import { MidnightBech32m, UnshieldedAddress, ShieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import { NetworkId } from '@midnight-ntwrk/wallet-sdk-abstractions';
import type { FacadeState } from '@midnight-ntwrk/wallet-sdk-facade';

import type { FacadeBundle } from './facade.ts';
import type { NetworkConfig } from './network.ts';
import type { ApprovalOptions } from './approval.ts';
import { promptApproval } from './approval.ts';
import { createApiError, type RpcHandler, type RpcHandlerContext } from './ws-rpc.ts';
import { createPhaseTracker, type PhaseTracker } from './phase-tracker.ts';
import { serializeTx, deserializeUnsealed, deserializeSealed, fromHex } from './tx-serde.ts';
import { inspectTxHex } from './tx-inspect.ts';
import { TX_TTL_MINUTES, PROOF_TIMEOUT_MS, DUST_RETRY_ATTEMPTS, DUST_RETRY_DELAY_MS, ABANDONED_TX_TIMEOUT_MS } from './constants.ts';
import { dim } from '../ui/colors.ts';
// Apply SDK workaround: patches CoreWallet.revertTransaction to not destroy dust UTXOs.
// Must be imported before any facade.revert() call.
import './dust-revert-patch.ts';

// ── Helpers ──

// ── Network ID mapping ──

const NETWORK_ID_MAP: Record<string, NetworkId.NetworkId> = {
  PreProd: NetworkId.NetworkId.PreProd,
  Preview: NetworkId.NetworkId.Preview,
  Undeployed: NetworkId.NetworkId.Undeployed,
};

// ── Types ──

export interface DAppConnectorCallbacks {
  onPhaseStart?: (connectionId: string, method: string, phase: string) => void;
  onPhaseComplete?: (connectionId: string, method: string, phase: string, durationMs: number) => void;
}

export interface DAppConnectorOptions {
  bundle: FacadeBundle;
  networkConfig: NetworkConfig;
  approvalOptions: ApprovalOptions;
  callbacks?: DAppConnectorCallbacks;
}

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

export function createDAppConnector(options: DAppConnectorOptions): DAppConnector {
  const { bundle, networkConfig, approvalOptions, callbacks } = options;
  const { facade, keystore, zswapSecretKeys, dustSecretKey } = bundle;

  const networkId = NETWORK_ID_MAP[networkConfig.networkId];
  if (networkId === undefined) {
    throw new Error(`Unknown networkId: ${networkConfig.networkId}`);
  }

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

  const secrets = { shieldedSecretKeys: zswapSecretKeys, dustSecretKey };

  // Track pending transactions per connection that haven't been submitted yet.
  // Keyed by serialized tx hex so untracking works after deserialization.
  // On rejection/disconnect/abandon, we call facade.revert(recipe) to release
  // dust coins from pendingDustTokens. The dust-revert-patch ensures this does
  // NOT destroy the UTXO (the SDK's default processTtls behavior).
  const pendingTxsByConnection = new Map<string, Map<string, { recipe: any; timer: ReturnType<typeof setTimeout> }>>();

  function trackPendingTx(connectionId: string, txHex: string, recipe: any): void {
    let txMap = pendingTxsByConnection.get(connectionId);
    if (!txMap) {
      txMap = new Map();
      pendingTxsByConnection.set(connectionId, txMap);
    }
    // Start abandon timer — auto-revert if DApp never submits.
    const timer = setTimeout(async () => {
      txMap!.delete(txHex);
      if (txMap!.size === 0) pendingTxsByConnection.delete(connectionId);
      try { await facade.revert(recipe); } catch { /* best-effort */ }
      process.stderr.write(dim(`  abandoned tx reverted (${connectionId})`) + '\n');
    }, ABANDONED_TX_TIMEOUT_MS);
    txMap.set(txHex, { recipe, timer });
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
      try { await facade.revert(entry.recipe); } catch { /* best-effort */ }
    }
    process.stderr.write(dim(`  reverted ${txMap.size} pending tx(s) on disconnect`) + '\n');
  }

  function createTtl(): Date {
    return new Date(Date.now() + TX_TTL_MINUTES * 60 * 1000);
  }

  /** Sign, prove (with timeout), and serialize a transaction recipe.
   *  Returns both the serialized hex and the finalized tx object (for tracking/revert). */
  async function processRecipe(recipe: any, tracker?: PhaseTracker): Promise<{ hex: string; finalized: any }> {
    tracker?.start('signing');
    const signed = await facade.signRecipe(recipe, (payload) =>
      keystore.signData(payload),
    );
    tracker?.start('proving');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finalized = await Promise.race([
      facade.finalizeRecipe(signed),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('ZK proof generation timed out')), PROOF_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    tracker?.complete();
    return { hex: serializeTx(finalized), finalized };
  }

  /** Prompt terminal approval for a write method. Throws Rejected on denial. */
  async function requireApproval(
    method: string,
    details: Array<{ label: string; value: string }> = [],
    context?: RpcHandlerContext,
  ): Promise<void> {
    context?.notify('approval:pending', { method });
    const result = await promptApproval(
      { method, network: networkConfig.networkId, details, dappName: context?.connectionId },
      approvalOptions,
    );
    const outcome = result === 'reject' ? 'rejected' : 'approved';
    context?.notify('approval:resolved', { method, result: outcome });
    if (result === 'reject') {
      throw createApiError('Rejected', 'User rejected the request');
    }
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
    if (!latestState) return false;
    try {
      const dust = latestState.dust as any;
      return dust?.availableCoins?.length > 0 || dust?.balance(new Date()) > 0n;
    } catch { return false; }
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
        const isDustError = /no dust tokens/i.test(msg) || /dust.*unavailable/i.test(msg);
        if (!isDustError || attempt === DUST_RETRY_ATTEMPTS) throw err;
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
      const balance = (state.dust as any).balance(new Date());
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
      const addr = (state.shielded as any).address;
      return {
        shieldedAddress: encodeAddress(addr),
        shieldedCoinPublicKey: addr.coinPublicKeyString(),
        shieldedEncryptionPublicKey: addr.encryptionPublicKeyString(),
      };
    },

    getDustAddress: async () => {
      const state = getState();
      return { dustAddress: encodeAddress((state.dust as any).address) };
    },

    getTxHistory: async (params) => {
      const state = getState();
      const pageNumber = Number(params.pageNumber ?? 0);
      const pageSize = Number(params.pageSize ?? 20);

      try {
        const history = (state.unshielded as any).transactionHistory;
        const entries: Array<{ txHash: string; txStatus: { status: string } }> = [];
        let index = 0;
        const start = pageNumber * pageSize;

        for await (const entry of history.getAll()) {
          if (index >= start + pageSize) break;
          if (index >= start) {
            entries.push({
              txHash: entry.hash,
              txStatus: entry.status === 'SUCCESS'
                ? { status: 'finalized' }
                : { status: 'pending' },
            });
          }
          index++;
        }
        return entries;
      } catch {
        // SDK may throw "Not yet implemented" — return empty array gracefully
        return [];
      }
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
      return { status: 'connected', networkId: networkConfig.networkId };
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
      const recipe = await withDustRetry(() => facade.transferTransaction(combinedTransfers, secrets, {
        ttl: createTtl(),
        payFees,
      }));
      const { hex, finalized } = await processRecipe(recipe, tracker);
      trackPendingTx(context.connectionId, hex, recipe);
      context.metadata.phases = tracker.getTimings();
      return { tx: hex };
    },

    submitTransaction: async (params, context) => {
      const txHex = String(params.tx ?? '');
      if (!txHex) {
        throw createApiError('InvalidRequest', 'tx is required');
      }

      const tracker = makeTracker('submitTransaction', context);

      // Submit is the irreversible action — always prompt
      tracker.start('approve');
      try {
        await requireApproval('submitTransaction', inspectTxHex(txHex, 'sealed'), context);
      } catch (err) {
        // Rejection — revert to release dust coins from pending.
        // The dust-revert-patch ensures this does NOT destroy the UTXO.
        const txMap = pendingTxsByConnection.get(context.connectionId);
        const entry = txMap?.get(txHex);
        if (entry) {
          try { await facade.revert(entry.recipe); } catch { /* best-effort */ }
        }
        untrackPendingTx(context.connectionId, txHex);
        throw err;
      }

      // Deserialize for submission (the chain doesn't need object identity)
      const sealedTx = deserializeSealed(txHex);
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
          try { await facade.revert(entry.recipe); } catch { /* best-effort */ }
        }
        untrackPendingTx(context.connectionId, txHex);
        // Re-throw with full detail so the RPC layer can forward it
        const detail = extractErrorDetail(submitErr);
        const enriched = new Error(`Transaction submission failed: ${detail}`);
        enriched.cause = submitErr;
        throw enriched;
      }
    },

    balanceUnsealedTransaction: async (params, context) => {
      const txHex = String(params.tx ?? '');
      if (!txHex) {
        throw createApiError('InvalidRequest', 'tx is required');
      }

      const tracker = makeTracker('balanceUnsealedTransaction', context);

      tracker.start('approve');
      await requireApproval('balanceUnsealedTransaction', inspectTxHex(txHex, 'unsealed'), context);

      tracker.start('building');
      const unsealedTx = deserializeUnsealed(txHex);
      const recipe = await withDustRetry(() => facade.balanceUnboundTransaction(unsealedTx, secrets, {
        ttl: createTtl(),
      }));
      const { hex, finalized } = await processRecipe(recipe, tracker);
      trackPendingTx(context.connectionId, hex, recipe);
      context.metadata.phases = tracker.getTimings();
      return { tx: hex };
    },

    balanceSealedTransaction: async (params, context) => {
      const txHex = String(params.tx ?? '');
      if (!txHex) {
        throw createApiError('InvalidRequest', 'tx is required');
      }

      const tracker = makeTracker('balanceSealedTransaction', context);

      tracker.start('approve');
      await requireApproval('balanceSealedTransaction', inspectTxHex(txHex, 'sealed'), context);

      tracker.start('building');
      const sealedTx = deserializeSealed(txHex);
      const recipe = await withDustRetry(() => facade.balanceFinalizedTransaction(sealedTx, secrets, {
        ttl: createTtl(),
      }));
      const { hex, finalized } = await processRecipe(recipe, tracker);
      trackPendingTx(context.connectionId, hex, recipe);
      context.metadata.phases = tracker.getTimings();
      return { tx: hex };
    },

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

      const recipe = await withDustRetry(() => facade.initSwap(swapInputs, combinedOutputs, secrets, {
        ttl: createTtl(),
        payFees: intentOptions.payFees ?? true,
      }));
      const { hex, finalized } = await processRecipe(recipe, tracker);
      trackPendingTx(context.connectionId, hex, recipe);
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

      // keystore.signData returns ledger.Signature (hex string)
      // keystore.getPublicKey returns SignatureVerifyingKey (hex string)
      const signature = keystore.signData(payload);
      const verifyingKey = keystore.getPublicKey();

      return {
        data,
        signature: String(signature),
        verifyingKey: String(verifyingKey),
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
