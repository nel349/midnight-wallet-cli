// serve command — start DApp Connector server over WebSocket JSON-RPC
// Usage: midnight serve [--port 9932] [--wallet path] [--network name]
//                       [--approve-all] [--no-auto-approve-reads] [--json]

import { type ParsedArgs, getFlag, hasFlag } from '../lib/argv.ts';
import { loadWalletConfig } from '../lib/wallet-config.ts';
import { resolveNetwork } from '../lib/resolve-network.ts';
import { applyEndpointOverrides } from '../lib/network.ts';
import { buildFacade, startAndSyncFacade, stopFacade, suppressSdkTransientErrors } from '../lib/facade.ts';
import { loadWalletCache, saveWalletCache } from '../lib/wallet-cache.ts';
import { suppressRpcNoise } from '../lib/transfer.ts';
import { createDAppConnector } from '../lib/dapp-connector.ts';
import { createRpcServer, type RpcServer } from '../lib/ws-rpc.ts';
import { DEFAULT_SERVE_PORT } from '../lib/constants.ts';
import { header, keyValue, divider, formatAddress } from '../ui/format.ts';
import { bold, dim, teal, green, red } from '../ui/colors.ts';
import { start as startSpinner } from '../ui/spinner.ts';
import { writeJsonResult } from '../lib/json-output.ts';

export default async function serveCommand(args: ParsedArgs, signal?: AbortSignal): Promise<void> {
  // ── Parse args ──

  const portStr = getFlag(args, 'port');
  const port = portStr ? parseInt(portStr, 10) : DEFAULT_SERVE_PORT;
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: "${portStr}" — must be 1-65535`);
  }

  const approveAll = hasFlag(args, 'approve-all');
  // Default: auto-approve reads unless --no-auto-approve-reads is set
  const autoApproveReads = approveAll || !hasFlag(args, 'no-auto-approve-reads');
  const jsonMode = hasFlag(args, 'json');

  // ── Load wallet ──

  const walletPath = getFlag(args, 'wallet');
  const config = loadWalletConfig(walletPath);
  const seedBuffer = Buffer.from(config.seed, 'hex');

  const { name: networkName, config: networkConfig } = resolveNetwork({
    args,
    walletNetwork: config.network,
    address: config.address,
  });

  // Apply endpoint overrides: --flag > config > network default
  applyEndpointOverrides(networkConfig, {
    proofServer: getFlag(args, 'proof-server'),
    node: getFlag(args, 'node'),
    indexerWS: getFlag(args, 'indexer-ws'),
  });

  // ── Header ──

  process.stderr.write('\n' + header('DApp Connector Server') + '\n\n');
  process.stderr.write(keyValue('Network', networkName) + '\n');
  process.stderr.write(keyValue('Address', formatAddress(config.address, true)) + '\n');
  process.stderr.write(keyValue('Port', String(port)) + '\n');
  process.stderr.write(keyValue('Auto-approve reads', approveAll || autoApproveReads ? 'yes' : 'no') + '\n');
  process.stderr.write(keyValue('Auto-approve writes', approveAll ? 'yes' : 'no') + '\n');
  process.stderr.write('\n');

  // ── Suppress SDK noise ──

  const unsuppress = suppressSdkTransientErrors((_tag, msg) => {
    process.stderr.write(dim(`  SDK: ${msg}`) + '\n');
  });
  const restoreRpc = suppressRpcNoise();

  const noCache = hasFlag(args, 'no-cache');

  // ── Build & sync facade ──

  const spinner = startSpinner('Building wallet facade...');
  const cache = noCache ? null : loadWalletCache(config.address, networkName);
  const bundle = await buildFacade(seedBuffer, networkConfig, cache);
  if (bundle.restoredFromCache) {
    spinner.update('Restoring from cache...');
  }

  // Cleanup helper — stops facade and restores console
  const cleanup = async () => {
    restoreRpc();
    unsuppress();
    try { await stopFacade(bundle); } catch { /* best-effort */ }
  };

  let server: RpcServer | undefined;
  let connector: ReturnType<typeof createDAppConnector> | undefined;

  try {
    spinner.update('Syncing wallet...');
    await startAndSyncFacade(bundle, {
      onProgress: (applied, highest) => {
        if (highest > 0) {
          const pct = Math.min(Math.round((applied / highest) * 100), 100);
          spinner.update(pct >= 100 ? 'Syncing wallet...' : `Syncing wallet... ${pct}%`);
        }
      },
    });
    spinner.stop('Wallet synced');

    // Save cache after successful sync
    if (!noCache) {
      try { await saveWalletCache(config.address, networkName, bundle.facade); } catch { /* best-effort */ }
    }

    if (signal?.aborted) throw new Error('Operation cancelled');

    // ── Create DApp Connector ──

    connector = createDAppConnector({
      bundle,
      networkConfig,
      approvalOptions: { approveAll, autoApproveReads },
    });

    // ── Start WebSocket server ──

    server = createRpcServer({
      port,
      handlers: connector.handlers,
      onConnect: (conn) => {
        process.stderr.write(dim(`  [${timestamp()}] `) + green('connected') + dim(` ${conn.id}`) + '\n');
      },
      onDisconnect: (conn) => {
        process.stderr.write(dim(`  [${timestamp()}] `) + red('disconnected') + dim(` ${conn.id}`) + '\n');
      },
      onRequest: (conn, req) => {
        process.stderr.write(dim(`  [${timestamp()}] ${conn.id} #${conn.requestCount} → ${req.method}`) + '\n');
      },
      onResponse: (conn, req, durationMs, result, error) => {
        const duration = formatDuration(durationMs);
        if (error) {
          process.stderr.write(`  ${red('✗')} ${dim(`${conn.id} ← ${req.method} (${duration})`)} ${red(error)}` + '\n');
        } else {
          process.stderr.write(`  ${green('✓')} ${dim(`${conn.id} ← ${req.method} (${duration})`)}` + '\n');
          // Log tx hash after successful submit
          const txHash = (result as any)?.txHash;
          if (req.method === 'submitTransaction' && txHash) {
            process.stderr.write(`  ${dim('  tx:')} ${teal(String(txHash))}` + '\n');
          }
        }
      },
    });

    // ── Server ready ──

    process.stderr.write('\n' + divider() + '\n');
    process.stderr.write('  ' + bold(teal(`Server ready — listening on ws://localhost:${port}`)) + '\n');
    process.stderr.write(dim('  Press Ctrl+C to stop') + '\n\n');

    if (jsonMode) {
      writeJsonResult({
        port,
        network: networkName,
        address: config.address,
        status: 'listening',
      });
    }

    // ── Wait for shutdown signal ──
    // The abort signal comes from wallet.ts's global SIGINT/SIGTERM handler.
    // We don't register our own signal handlers — wallet.ts handles that.

    await new Promise<void>((resolve) => {
      if (signal) {
        if (signal.aborted) {
          resolve();
        } else {
          signal.addEventListener('abort', () => resolve(), { once: true });
        }
      }
      // If no signal provided (e.g. direct invocation), the WebSocket server
      // keeps the event loop alive. Process will exit via external SIGKILL.
    });

    // ── Shutdown ──

    process.stderr.write('\n' + dim('  Shutting down...') + '\n');
    // Save cache on graceful shutdown (captures latest state)
    if (!noCache) {
      try { await saveWalletCache(config.address, networkName, bundle.facade); } catch { /* best-effort */ }
    }
    try { await server.close(); } catch { /* best-effort */ }
    connector.dispose();
    connector = undefined;
    server = undefined;
    process.stderr.write(dim('  Server stopped.') + '\n\n');
  } catch (err) {
    spinner.stop('Failed');
    // Clean up anything that was started
    if (server) { try { await server.close(); } catch { /* best-effort */ } }
    connector?.dispose();
    throw err;
  } finally {
    await cleanup();
  }
}

// ── Helpers ──

function timestamp(): string {
  const now = new Date();
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
