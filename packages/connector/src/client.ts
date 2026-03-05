// WalletClient factory — connects to `midnight serve` over WebSocket JSON-RPC
// Returns an object implementing all 18 ConnectedAPI methods

import { createTransport, type RpcTransport } from './transport.ts';
import { reviveBalanceRecord, reviveDustBalance } from './bigint.ts';
import type {
  ConnectedAPI,
  Configuration,
  ConnectionStatus,
  DesiredOutput,
  DesiredInput,
  HistoryEntry,
  KeyMaterialProvider,
  ProvingProvider,
  Signature,
  SignDataOptions,
} from './types.ts';

// ── Options ──

export interface WalletClientOptions {
  /** WebSocket URL, e.g. ws://localhost:9932 */
  url: string;
  /** Network to connect to: 'Undeployed', 'PreProd', 'Preview' */
  networkId: string;
  /** Per-call timeout in ms (default: 300_000 = 5 minutes) */
  timeout?: number;
}

// ── WalletClient interface ──

export interface WalletClient extends ConnectedAPI {
  /** Close the WebSocket connection */
  disconnect(): void;
  /** Register a callback for when the connection drops */
  onDisconnect(handler: () => void): void;
}

// ── Factory ──

export async function createWalletClient(options: WalletClientOptions): Promise<WalletClient> {
  const { url, networkId, timeout } = options;

  const disconnectHandlers: Array<() => void> = [];

  const transport: RpcTransport = await createTransport({
    url,
    timeout,
    onDisconnect: () => {
      for (const handler of disconnectHandlers) {
        handler();
      }
    },
  });

  // Perform handshake — validates network match
  await transport.call('connect', { networkId });

  // ── Build the client object ──

  const client: WalletClient = {
    // ── Balance methods (bigint conversion) ──

    async getUnshieldedBalances() {
      const result = await transport.call('getUnshieldedBalances') as Record<string, string>;
      return reviveBalanceRecord(result);
    },

    async getShieldedBalances() {
      const result = await transport.call('getShieldedBalances') as Record<string, string>;
      return reviveBalanceRecord(result);
    },

    async getDustBalance() {
      const result = await transport.call('getDustBalance') as { cap: string; balance: string };
      return reviveDustBalance(result);
    },

    // ── Address methods (pass-through) ──

    async getUnshieldedAddress() {
      return await transport.call('getUnshieldedAddress') as { unshieldedAddress: string };
    },

    async getShieldedAddresses() {
      return await transport.call('getShieldedAddresses') as {
        shieldedAddress: string;
        shieldedCoinPublicKey: string;
        shieldedEncryptionPublicKey: string;
      };
    },

    async getDustAddress() {
      return await transport.call('getDustAddress') as { dustAddress: string };
    },

    // ── History ──

    async getTxHistory(pageNumber: number, pageSize: number) {
      return await transport.call('getTxHistory', { pageNumber, pageSize }) as HistoryEntry[];
    },

    // ── Transaction methods ──

    async balanceUnsealedTransaction(tx: string, options?: { payFees?: boolean }) {
      return await transport.call('balanceUnsealedTransaction', { tx, options }) as { tx: string };
    },

    async balanceSealedTransaction(tx: string, options?: { payFees?: boolean }) {
      return await transport.call('balanceSealedTransaction', { tx, options }) as { tx: string };
    },

    async makeTransfer(desiredOutputs: DesiredOutput[], options?: { payFees?: boolean }) {
      return await transport.call('makeTransfer', {
        desiredOutputs,
        options,
      }) as { tx: string };
    },

    async makeIntent(
      desiredInputs: DesiredInput[],
      desiredOutputs: DesiredOutput[],
      options: { intentId: number | 'random'; payFees: boolean },
    ) {
      return await transport.call('makeIntent', {
        desiredInputs,
        desiredOutputs,
        options,
      }) as { tx: string };
    },

    // ── Signing & submission ──

    async signData(data: string, options: SignDataOptions) {
      return await transport.call('signData', { data, options }) as Signature;
    },

    async submitTransaction(tx: string) {
      await transport.call('submitTransaction', { tx });
    },

    // ── Proving provider ──

    async getProvingProvider(_keyMaterialProvider: KeyMaterialProvider) {
      // The CLI server returns { provingProvider: 'ready', proverServerUri }
      // Real proving over JSON-RPC requires bidirectional RPC (future).
      // For now, return a stub that delegates to the proof server.
      const result = await transport.call('getProvingProvider') as {
        provingProvider: string;
        proverServerUri: string;
      };

      return {
        proverServerUri: result.proverServerUri,
        async check() {
          throw new Error('Proving over WebSocket is not yet supported — use proverServerUri directly');
        },
        async prove() {
          throw new Error('Proving over WebSocket is not yet supported — use proverServerUri directly');
        },
      } as unknown as ProvingProvider;
    },

    // ── Configuration ──

    async getConfiguration() {
      return await transport.call('getConfiguration') as Configuration;
    },

    async getConnectionStatus() {
      return await transport.call('getConnectionStatus') as ConnectionStatus;
    },

    // ── Hints ──

    async hintUsage(methodNames) {
      await transport.call('hintUsage', { methodNames });
    },

    // ── Client-only methods ──

    disconnect() {
      transport.close();
    },

    onDisconnect(handler: () => void) {
      disconnectHandlers.push(handler);
    },
  };

  return client;
}
