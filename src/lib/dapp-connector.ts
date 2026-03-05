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
import { serializeTx, deserializeUnsealed, deserializeSealed, fromHex } from './tx-serde.ts';
import { TX_TTL_MINUTES, PROOF_TIMEOUT_MS } from './constants.ts';
import { dim } from '../ui/colors.ts';

// ── Network ID mapping ──

const NETWORK_ID_MAP: Record<string, NetworkId.NetworkId> = {
  PreProd: NetworkId.NetworkId.PreProd,
  Preview: NetworkId.NetworkId.Preview,
  Undeployed: NetworkId.NetworkId.Undeployed,
};

// ── Types ──

export interface DAppConnectorOptions {
  bundle: FacadeBundle;
  networkConfig: NetworkConfig;
  approvalOptions: ApprovalOptions;
}

export interface DAppConnector {
  handlers: Record<string, RpcHandler>;
  dispose(): void;
}

// ── Factory ──

export function createDAppConnector(options: DAppConnectorOptions): DAppConnector {
  const { bundle, networkConfig, approvalOptions } = options;
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

  function createTtl(): Date {
    return new Date(Date.now() + TX_TTL_MINUTES * 60 * 1000);
  }

  /** Sign, prove (with timeout), and serialize a transaction recipe. */
  async function processRecipe(recipe: any): Promise<string> {
    const signed = await facade.signRecipe(recipe, (payload) =>
      keystore.signData(payload),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finalized = await Promise.race([
      facade.finalizeRecipe(signed),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('ZK proof generation timed out')), PROOF_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    return serializeTx(finalized);
  }

  /** Prompt terminal approval for a write method. Throws Rejected on denial. */
  async function requireApproval(
    method: string,
    details: Array<{ label: string; value: string }> = [],
    notify?: RpcHandlerContext['notify'],
  ): Promise<void> {
    notify?.('approval:pending', { method });
    const result = await promptApproval(
      { method, network: networkConfig.networkId, details },
      approvalOptions,
    );
    const outcome = result === 'reject' ? 'rejected' : 'approved';
    notify?.('approval:resolved', { method, result: outcome });
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

      const details = outputs.map((o, i) => ({
        label: `Output ${i + 1}`,
        value: `${o.value} → ${String(o.recipient).slice(0, 20)}... (${o.kind})`,
      }));
      await requireApproval('makeTransfer', details, context.notify);

      const combinedTransfers = parseDesiredOutputs(outputs);
      const payFees = (params.options as any)?.payFees ?? true;
      const recipe = await facade.transferTransaction(combinedTransfers, secrets, {
        ttl: createTtl(),
        payFees,
      });
      const txHex = await processRecipe(recipe);
      return { tx: txHex };
    },

    submitTransaction: async (params, context) => {
      const txHex = String(params.tx ?? '');
      if (!txHex) {
        throw createApiError('InvalidRequest', 'tx is required');
      }

      await requireApproval('submitTransaction', [], context.notify);

      const sealedTx = deserializeSealed(txHex);
      await facade.submitTransaction(sealedTx);
      // DApp Connector spec: Promise<void> — discard txHash
    },

    balanceUnsealedTransaction: async (params, context) => {
      const txHex = String(params.tx ?? '');
      if (!txHex) {
        throw createApiError('InvalidRequest', 'tx is required');
      }

      await requireApproval('balanceUnsealedTransaction', [], context.notify);

      const unsealedTx = deserializeUnsealed(txHex);
      const recipe = await facade.balanceUnboundTransaction(unsealedTx, secrets, {
        ttl: createTtl(),
      });
      const resultHex = await processRecipe(recipe);
      return { tx: resultHex };
    },

    balanceSealedTransaction: async (params, context) => {
      const txHex = String(params.tx ?? '');
      if (!txHex) {
        throw createApiError('InvalidRequest', 'tx is required');
      }

      await requireApproval('balanceSealedTransaction', [], context.notify);

      const sealedTx = deserializeSealed(txHex);
      const recipe = await facade.balanceFinalizedTransaction(sealedTx, secrets, {
        ttl: createTtl(),
      });
      const resultHex = await processRecipe(recipe);
      return { tx: resultHex };
    },

    makeIntent: async (params, context) => {
      const desiredInputs = params.desiredInputs as any[];
      const desiredOutputs = params.desiredOutputs as any[];
      const intentOptions = params.options as any;

      if (!intentOptions) {
        throw createApiError('InvalidRequest', 'options is required for makeIntent');
      }

      await requireApproval('makeIntent', [], context.notify);

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

      const recipe = await facade.initSwap(swapInputs, combinedOutputs, secrets, {
        ttl: createTtl(),
        payFees: intentOptions.payFees ?? true,
      });
      const txHex = await processRecipe(recipe);
      return { tx: txHex };
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
      ], context.notify);

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
  }

  return { handlers, dispose };
}
