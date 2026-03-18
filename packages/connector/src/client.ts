// WalletClient factory — connects to a Midnight wallet
//
// Two modes, chosen automatically:
//   1. WebSocket (url provided)  → connects to `midnight serve` via JSON-RPC
//   2. Browser extension (no url) → discovers Lace via window.midnight

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
  WalletProvingProvider,
  Signature,
  SignDataOptions,
} from './types.ts';

// ── Options ──

export interface WalletClientOptions {
  /** WebSocket URL (e.g. ws://localhost:9932). If omitted, uses the Lace browser extension. */
  url?: string;
  /** Network to connect to: 'Undeployed', 'PreProd', 'Preview' */
  networkId: string;
  /** Per-call timeout in ms (default: 300_000 = 5 minutes) */
  timeout?: number;
  /** Called when the server begins waiting for terminal approval on a write method */
  onApprovalPending?: (method: string) => void;
  /** Called when the server finishes terminal approval (approved or rejected) */
  onApprovalResolved?: (method: string, result: 'approved' | 'rejected') => void;
}

// ── WalletClient interface ──

export interface WalletClient extends ConnectedAPI {
  /** Close the connection (WebSocket) or no-op (extension) */
  disconnect(): void;
  /** Register a callback for when the connection drops */
  onDisconnect(handler: () => void): void;
}

// ── Factory ──

export async function createWalletClient(options: WalletClientOptions): Promise<WalletClient> {
  if (options.url) {
    return createWebSocketClient(options as WalletClientOptions & { url: string });
  }
  return createExtensionClient(options);
}

// ── WebSocket mode (midnight serve) ──

async function createWebSocketClient(options: WalletClientOptions & { url: string }): Promise<WalletClient> {
  const { url, networkId, timeout, onApprovalPending, onApprovalResolved } = options;

  const disconnectHandlers: Array<() => void> = [];

  const transport: RpcTransport = await createTransport({
    url,
    timeout,
    onDisconnect: () => {
      for (const handler of disconnectHandlers) {
        handler();
      }
    },
    onNotification: (method, params) => {
      if (method === 'approval:pending') {
        onApprovalPending?.(params.method as string);
      } else if (method === 'approval:resolved') {
        onApprovalResolved?.(params.method as string, params.result as 'approved' | 'rejected');
      }
    },
  });

  await transport.call('connect', { networkId });

  const client: WalletClient = {
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

    async getTxHistory(pageNumber: number, pageSize: number) {
      return await transport.call('getTxHistory', { pageNumber, pageSize }) as HistoryEntry[];
    },

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

    async signData(data: string, options: SignDataOptions) {
      return await transport.call('signData', { data, options }) as Signature;
    },

    async submitTransaction(tx: string) {
      await transport.call('submitTransaction', { tx });
    },

    async getProvingProvider(_keyMaterialProvider: KeyMaterialProvider): Promise<WalletProvingProvider> {
      const result = await transport.call('getProvingProvider') as {
        provingProvider: string;
        proverServerUri: string;
      };

      return {
        proverServerUri: result.proverServerUri,
        async check(_serializedPreimage: Uint8Array, _keyLocation: string): Promise<(bigint | undefined)[]> {
          throw new Error('Proving over WebSocket is not yet supported — use proverServerUri directly');
        },
        async prove(_serializedPreimage: Uint8Array, _keyLocation: string, _overwriteBindingInput?: bigint): Promise<Uint8Array> {
          throw new Error('Proving over WebSocket is not yet supported — use proverServerUri directly');
        },
      };
    },

    async getConfiguration() {
      return await transport.call('getConfiguration') as Configuration;
    },

    async getConnectionStatus() {
      return await transport.call('getConnectionStatus') as ConnectionStatus;
    },

    async hintUsage(methodNames) {
      await transport.call('hintUsage', { methodNames });
    },

    disconnect() {
      transport.close();
    },

    onDisconnect(handler: () => void) {
      disconnectHandlers.push(handler);
    },
  };

  return client;
}

// ── Browser extension mode (Lace) ──

interface InitialAPI {
  apiVersion: string;
  connect: (networkId: string) => Promise<ConnectedAPI>;
}

async function createExtensionClient(options: WalletClientOptions): Promise<WalletClient> {
  const { networkId } = options;

  const connectedAPI = await discoverExtension(networkId);
  const disconnectHandlers: Array<() => void> = [];

  return {
    ...connectedAPI,
    disconnect() { /* no-op for extension */ },
    onDisconnect(handler: () => void) {
      disconnectHandlers.push(handler);
    },
  };
}

function discoverExtension(networkId: string, timeoutMs = 5000): Promise<ConnectedAPI> {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    const poll = setInterval(() => {
      const midnight = (globalThis as any).midnight;
      if (!midnight) {
        if (Date.now() - start > timeoutMs) {
          clearInterval(poll);
          reject(new Error('Midnight wallet extension not found. Is it installed?'));
        }
        return;
      }

      // Pick the first available provider (mnLace or any future wallet)
      const key = Object.keys(midnight)[0];
      const initialAPI: InitialAPI | undefined = midnight[key];
      if (!initialAPI) {
        if (Date.now() - start > timeoutMs) {
          clearInterval(poll);
          reject(new Error('No wallet provider found under window.midnight'));
        }
        return;
      }

      clearInterval(poll);
      initialAPI.connect(networkId).then(resolve).catch(reject);
    }, 100);
  });
}
