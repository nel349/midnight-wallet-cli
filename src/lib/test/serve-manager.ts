// Serve manager — start mn serve programmatically (in-process) for test runs.
// Replicates the initialization from src/commands/serve.ts but returns a handle
// instead of blocking on a signal. Always runs in approve-all mode.

import { Socket } from 'node:net';
import { loadWalletConfig, resolveWalletPath } from '../wallet-config.ts';
import { resolveNetwork } from '../resolve-network.ts';
import { buildFacade, isFacadeSynced, startAndSyncFacade, stopFacade, suppressSdkTransientErrors, waitForDustAvailable } from '../facade.ts';
import { bindCachesToIndexer, describeIndexerChange } from '../cache-indexer.ts';
import { loadWalletCache, saveWalletCache } from '../wallet-cache.ts';
import { suppressRpcNoise } from '../transfer.ts';
import { createDAppConnector, type DAppConnectorCallbacks } from '../dapp-connector.ts';
import { createRpcServer, type RpcServer } from '../ws-rpc.ts';
import { DEFAULT_SERVE_PORT } from '../constants.ts';
import type { FacadeBundle } from '../facade.ts';
import type { NetworkName } from '../network.ts';
import type { ServeHandle } from './types.ts';

export interface ServeManagerOptions {
  port?: number;
  network?: string;
  wallet?: string;
  onMessage?: (msg: string) => void;
}

/**
 * Why a running serve can't be reused to pay for `wanted`, or undefined if it
 * can. A serve pays from the wallet it was started with, whatever wallet the
 * command asking was given. A serve that doesn't say whose it is (it asks its
 * operator before answering reads) is reused as before: its operator sees and
 * approves each request.
 */
export function serveWalletMismatch(runningAddress: string | null, wanted: { address: string; name: string }): string | undefined {
  if (runningAddress === null || runningAddress === wanted.address) return undefined;
  return `it serves the wallet at ${runningAddress}, and this command pays from ${wanted.name} (${wanted.address})`;
}

// ── Port + serve probe helpers ──────────────────────────────────

/**
 * Probe whether a TCP port on loopback is currently accepting connections.
 * 1s timeout — long enough to be reliable, short enough to feel instant.
 */
export function isPortInUse(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = new Socket();
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
    socket.connect(port, '127.0.0.1');
  });
}

/**
 * Round-trip a getConnectionStatus RPC against a serve on `port`. Returns
 * the SDK networkId string (e.g. "Undeployed", "PreProd") on success, or
 * null on any error/timeout/non-RPC response. Used to decide whether a
 * port-in-use is "our" mn serve (reusable) or some other process.
 */
export async function probeServeNetwork(port: number): Promise<string | null> {
  const result = await probeServeRpc(port, 'getConnectionStatus');
  const id = (result as { networkId?: unknown } | null)?.networkId;
  return typeof id === 'string' ? id : null;
}

/** The unshielded address of the wallet a serve on `port` pays from, or null when it doesn't say. */
export async function probeServeWallet(port: number): Promise<string | null> {
  const result = await probeServeRpc(port, 'getUnshieldedAddress');
  const address = (result as { unshieldedAddress?: unknown } | null)?.unshieldedAddress;
  return typeof address === 'string' ? address : null;
}

/** The Dust the wallet a serve on `port` pays from can spend right now, in specks; null when the serve doesn't say. */
export async function probeServeDust(port: number): Promise<bigint | null> {
  const result = await probeServeRpc(port, 'getDustBalance');
  const balance = (result as { balance?: unknown } | null)?.balance;
  try {
    return typeof balance === 'string' || typeof balance === 'number' ? BigInt(balance) : null;
  } catch {
    return null;
  }
}

/** One JSON-RPC call to a serve on `port`: its `result`, or null on any error/timeout. */
async function probeServeRpc(port: number, method: string): Promise<unknown | null> {
  const WebSocket = (await import('ws')).default;
  return new Promise<unknown | null>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timeout = setTimeout(() => { try { ws.close(); } catch {} resolve(null); }, 2000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }));
    });
    ws.on('message', (data: Buffer) => {
      clearTimeout(timeout);
      try {
        const msg = JSON.parse(data.toString());
        ws.close();
        resolve(msg?.result ?? null);
      } catch {
        ws.close();
        resolve(null);
      }
    });
    ws.on('error', () => { clearTimeout(timeout); resolve(null); });
  });
}

/**
 * Ensure a serve is running on the configured port. If one already runs and
 * matches the requested network, reuses it (returned handle's stop() is a
 * no-op so we don't tear down something we didn't start). If a different
 * network's serve is bound, throws with a clear, actionable message —
 * silently reusing the wrong network leads to deeply confusing test failures.
 * A serve for another wallet is refused too: it would pay from that wallet.
 * If nothing is bound, starts a fresh serve.
 *
 * Network comparison is case-insensitive: the running serve reports its
 * network in the lowercase abstractions form ('undeployed') as of the
 * getConnectionStatus fix, but the requestedNetwork may arrive in either
 * form depending on caller. Normalizing both sides keeps the check robust
 * across that change without re-introducing the case-sensitivity bug.
 */
export async function startServeOrReuse(options: ServeManagerOptions): Promise<ServeHandle> {
  const port = options.port ?? DEFAULT_SERVE_PORT;
  const requestedNetwork = (options.network ?? 'undeployed').toLowerCase();
  const onMessage = options.onMessage ?? (() => {});

  if (await isPortInUse(port)) {
    const actualSdkId = await probeServeNetwork(port);

    if (!actualSdkId) {
      throw new Error(
        `Port ${port} is in use by a process that does not look like mn serve. ` +
        `Free the port (e.g. \`lsof -nP -iTCP:${port} -sTCP:LISTEN\` then \`kill <pid>\`) and retry.`,
      );
    }
    const actualNetwork = actualSdkId.toLowerCase();
    if (actualNetwork !== requestedNetwork) {
      throw new Error(
        `mn serve is already running on port ${port} for network ${actualNetwork}, ` +
        `but this run needs ${requestedNetwork}. Stop the wrong-network serve first ` +
        `(\`pkill -f 'mn serve'\`) and retry.`,
      );
    }

    const runningAddress = await probeServeWallet(port);
    if (runningAddress !== null) {
      const wanted = loadWalletConfig(resolveWalletPath(options.wallet)).addresses[actualNetwork as NetworkName];
      const walletMismatch = serveWalletMismatch(runningAddress, { address: wanted, name: options.wallet ?? 'the active wallet' });
      if (walletMismatch) {
        throw new Error(
          `mn serve on port ${port} can't pay for this command: ${walletMismatch}. ` +
          `Stop it first (\`pkill -f 'mn serve'\`) and retry, or run the command for the wallet it serves.`,
        );
      }
    }

    onMessage(`Reusing existing mn serve on port ${port}`);
    return {
      port,
      async stop() { /* not ours to stop */ },
    };
  }

  return startServe(options);
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
  const indexerChange = bindCachesToIndexer(networkName, networkConfig.indexerWS);
  if (indexerChange) onMessage(describeIndexerChange(networkName, indexerChange));
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
  const syncedState = await waitForDustAvailable(bundle);
  onMessage('Dust ready');

  // Save cache after sync
  try { await saveWalletCache(address, networkName, bundle.facade); } catch { /* best-effort */ }

  // Create DApp Connector — approve-all mode for tests
  const connector = createDAppConnector({
    bundle,
    networkConfig,
    approvalOptions: { approveAll: true, autoApproveReads: true },
    // Reads answer from the state this sync ended on, and from every later
    // one that is synced by the rule the sync used.
    initialState: syncedState,
    isCurrent: (state) => isFacadeSynced(state),
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
