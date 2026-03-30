// Serve manager — start mn serve programmatically (in-process) for test runs.
// Replicates the initialization from src/commands/serve.ts but returns a handle
// instead of blocking on a signal. Always runs in approve-all mode.

import { loadWalletConfig, resolveWalletPath } from '../wallet-config.ts';
import { resolveNetwork } from '../resolve-network.ts';
import { buildFacade, startAndSyncFacade, stopFacade, suppressSdkTransientErrors, waitForDustAvailable } from '../facade.ts';
import { loadWalletCache, saveWalletCache } from '../wallet-cache.ts';
import { suppressRpcNoise } from '../transfer.ts';
import { createDAppConnector, type DAppConnectorCallbacks } from '../dapp-connector.ts';
import { createRpcServer, type RpcServer } from '../ws-rpc.ts';
import { DEFAULT_SERVE_PORT } from '../constants.ts';
import type { FacadeBundle } from '../facade.ts';
import type { ServeHandle } from './types.ts';

export interface ServeManagerOptions {
  port?: number;
  network?: string;
  wallet?: string;
  onMessage?: (msg: string) => void;
}

/**
 * Start mn serve in-process with --approve-all mode.
 * Returns a handle with stop() for teardown.
 */
export async function startServe(options: ServeManagerOptions): Promise<ServeHandle> {
  const port = options.port ?? DEFAULT_SERVE_PORT;
  const onMessage = options.onMessage ?? (() => {});

  // Load wallet
  const config = loadWalletConfig(resolveWalletPath(options.wallet));
  const seedBuffer = Buffer.from(config.seed, 'hex');

  const { name: networkName, config: networkConfig } = resolveNetwork({
    args: {
      command: 'serve',
      subcommand: undefined,
      positionals: [],
      flags: options.network ? { network: options.network } : {},
    },
  });
  const address = config.addresses[networkName];

  // Suppress SDK noise
  const unsuppress = suppressSdkTransientErrors((_tag, msg) => {
    onMessage(`SDK: ${msg}`);
  });
  const restoreRpc = suppressRpcNoise();

  // Build & sync facade
  onMessage('Building wallet facade...');
  const cache = loadWalletCache(address, networkName);
  const bundle = await buildFacade(seedBuffer, networkConfig, cache);

  onMessage('Syncing wallet...');
  await startAndSyncFacade(bundle, {
    onProgress: (applied, highest) => {
      if (highest > 0) {
        const pct = Math.min(Math.round((applied / highest) * 100), 100);
        onMessage(`Syncing wallet... ${pct}%`);
      }
    },
  });
  onMessage('Wallet synced');

  // Wait for dust
  onMessage('Waiting for dust...');
  await waitForDustAvailable(bundle);
  onMessage('Dust ready');

  // Save cache after sync
  try { await saveWalletCache(address, networkName, bundle.facade); } catch { /* best-effort */ }

  // Create DApp Connector — approve-all mode for tests
  const connector = createDAppConnector({
    bundle,
    networkConfig,
    approvalOptions: { approveAll: true, autoApproveReads: true },
    callbacks: {
      onPhaseStart: (_connId, _method, phase) => {
        onMessage(`${phase}...`);
      },
      onPhaseComplete: (_connId, _method, phase, durationMs) => {
        onMessage(`${phase} ${Math.round(durationMs)}ms`);
      },
    },
  });

  // Start WebSocket server
  const server = createRpcServer({
    port,
    handlers: connector.handlers,
    onConnect: (conn) => {
      onMessage(`connected ${conn.id}`);
    },
    onDisconnect: (conn) => {
      onMessage(`disconnected ${conn.id}`);
      connector.revertPendingTxs(conn.id).catch(() => {});
    },
    onRequest: (conn, req) => {
      onMessage(`${conn.id} → ${req.method}`);
    },
    onResponse: (conn, req, durationMs, _result, error) => {
      if (error) {
        onMessage(`${conn.id} ← ${req.method} FAILED: ${error.message}`);
      } else {
        onMessage(`${conn.id} ← ${req.method} (${Math.round(durationMs)}ms)`);
      }
    },
  });

  onMessage(`Server ready on ws://localhost:${port}`);

  // Return handle for lifecycle management
  return {
    port,
    async stop() {
      server.close();
      connector.dispose();
      restoreRpc();
      unsuppress();
      try { await stopFacade(bundle); } catch { /* best-effort */ }
    },
  };
}
