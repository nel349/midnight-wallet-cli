// Prep runner — execute prep steps defined in dapp.test.json by calling existing lib functions.

import * as ledger from '@midnightntwrk/ledger-v9';
import { join } from 'node:path';

import { clearWalletCache } from '../wallet-cache.ts';
import { loadWalletConfig, resolveWalletPath } from '../wallet-config.ts';
import { resolveNetwork } from '../resolve-network.ts';
import type { NetworkConfig, NetworkName } from '../network.ts';
import { assertLedger9StackReachable, assertLedgerSupported } from '../ledger-guard.ts';
import { buildFacade, hasDustAvailable, startAndSyncFacade, stopFacade, suppressSdkTransientErrors, waitForDustAvailable } from '../facade.ts';
import { loadWalletCache, saveWalletCache } from '../wallet-cache.ts';
import { executeTransfer, ensureDust, suppressRpcNoise } from '../transfer.ts';
import { GENESIS_SEED } from '../constants.ts';
import { deriveUnshieldedAddress } from '../derive-address.ts';

import type { DappTestConfig, PrepStepId, PrepStepResult, PrepContext, PrepCallbacks } from './types.ts';
import { startServeOrReuse } from './serve-manager.ts';
import { startBuild } from './build-manager.ts';

/**
 * Run all prep steps defined in the config, in order.
 * Accumulates long-running resources (serve, build) in the PrepContext for teardown.
 */
export async function runPrepSteps(
  config: DappTestConfig,
  dappDir: string,
  ctx: PrepContext,
  callbacks: PrepCallbacks,
): Promise<PrepStepResult[]> {
  const results: PrepStepResult[] = [];

  for (const step of config.prep) {
    const start = Date.now();
    callbacks.onStepStart(step);

    try {
      await runStep(step, config, dappDir, ctx, callbacks);
      const duration = Date.now() - start;
      results.push({ step, status: 'pass', duration });
      callbacks.onStepComplete(step, 'pass', duration);
    } catch (err) {
      const duration = Date.now() - start;
      const error = (err as Error).message;
      results.push({ step, status: 'fail', duration, error });
      callbacks.onStepComplete(step, 'fail', duration, error);
      throw new Error(`Prep step "${step}" failed: ${error}`);
    }
  }

  return results;
}

// ── Step dispatch ──

async function runStep(
  step: PrepStepId,
  config: DappTestConfig,
  dappDir: string,
  ctx: PrepContext,
  callbacks: PrepCallbacks,
): Promise<void> {
  if (step === 'cache-clear') {
    return stepCacheClear(config);
  }
  if (step === 'localnet-up') {
    return stepLocalnetUp(config, callbacks);
  }
  if (step.startsWith('balance:')) {
    const amount = parseInt(step.split(':')[1], 10);
    return stepBalance(amount, config, callbacks);
  }
  if (step === 'dust' || step === 'dust-register' || step === 'dust-wait') {
    return stepDust(config, callbacks);
  }
  if (step === 'mn-serve') {
    return stepMnServe(config, ctx, callbacks);
  }
  if (step === 'build-and-serve') {
    return stepBuildAndServe(config, dappDir, ctx, callbacks);
  }

  throw new Error(`Unknown prep step: ${step}`);
}

// ── Step implementations ──

async function stepCacheClear(config: DappTestConfig): Promise<void> {
  const network = config.network ?? 'undeployed';
  // Clear ALL wallet caches for this network — not just the active wallet.
  // After a localnet restart, every wallet (including genesis) has stale state.
  clearWalletCache(undefined, network);
}

async function stepLocalnetUp(config: DappTestConfig, callbacks: PrepCallbacks): Promise<void> {
  // This build can't start a localnet (no published ledger-9 indexer image),
  // so the step requires a running ledger-9 stack at the resolved endpoints.
  const network = config.network ?? 'undeployed';
  const { config: networkConfig } = resolveNetwork({
    args: { command: 'test', subcommand: undefined, positionals: [], flags: { network } },
  });
  await assertLedger9StackReachable(network, networkConfig);
  callbacks.onMessage(`Using the ledger-9 stack at ${networkConfig.node} (indexer ${networkConfig.indexer})`);
}

async function stepBalance(amount: number, config: DappTestConfig, callbacks: PrepCallbacks): Promise<void> {
  const network = config.network ?? 'undeployed';
  const { config: networkConfig } = resolveNetwork({
    args: { command: 'test', subcommand: undefined, positionals: [], flags: { network } },
  });
  // On a ledger-8 chain the SDK's sync would retry forever.
  await assertLedgerSupported(network, networkConfig);

  const walletConfig = loadWalletConfig(resolveWalletPath());
  const seedBuffer = Buffer.from(walletConfig.seed, 'hex');
  const address = walletConfig.addresses[network as NetworkName];

  // Check current balance — use fresh cache since localnet may have restarted
  callbacks.onMessage('Checking balance...');
  const unsuppress = suppressSdkTransientErrors((_tag, msg) => {
    callbacks.onMessage(`SDK: ${msg}`);
  });
  const restoreRpc = suppressRpcNoise();
  const cache = loadWalletCache(address, network);
  const bundle = await buildFacade(seedBuffer, networkConfig, cache);

  try {
    const state = await startAndSyncFacade(bundle, {
      syncMode: 'lite',
      onProgress: (applied, highest) => {
        if (highest > 0) {
          const pct = Math.min(Math.round((applied / highest) * 100), 100);
          callbacks.onMessage(`Syncing wallet... ${pct}%`);
        }
      },
      onSyncDetail: (detail) => {
        callbacks.onMessage(`Syncing wallet... (${detail})`);
      },
    });
    const nightToken = ledger.unshieldedToken().raw;
    const balance = state.unshielded.balances[nightToken] ?? 0n;

    if (balance > 0n) {
      callbacks.onMessage(`Balance OK: ${balance}`);
      try { await saveWalletCache(address, network, bundle.facade); } catch {}
      return;
    }
  } finally {
    restoreRpc();
    unsuppress();
    try { await stopFacade(bundle); } catch {}
  }

  // Balance is zero
  if (network !== 'undeployed') {
    throw new Error(
      `Wallet has 0 NIGHT on ${network}. Fund your wallet before running tests:\n` +
      `  mn airdrop ${amount}   (if faucet available)\n` +
      `  Or transfer NIGHT from another wallet.`
    );
  }

  // Undeployed (localnet) — auto-airdrop from genesis
  callbacks.onMessage(`Balance is 0. Airdropping ${amount} NIGHT from genesis...`);
  const genesisSeedBuffer = Buffer.from(GENESIS_SEED, 'hex');
  const genesisAddress = deriveUnshieldedAddress(genesisSeedBuffer, network as NetworkName);

  await executeTransfer({
    seedBuffer: genesisSeedBuffer,
    networkConfig,
    recipientAddress: address,
    amountNight: amount,
    onSync(_applied, _highest) {},
    onDust(status) { callbacks.onMessage(`Dust: ${status}`); },
    onProving() { callbacks.onMessage('Generating ZK proof...'); },
    onSubmitting() { callbacks.onMessage('Submitting airdrop transaction...'); },
    onSyncWarning(_tag, msg) { callbacks.onMessage(`Syncing genesis... (${msg})`); },
  });

  callbacks.onMessage(`Airdropped ${amount} NIGHT`);
}

const DUST_WAIT_TIMEOUT_MS = 90_000; // 90s for dust to become available after registration

async function stepDust(config: DappTestConfig, callbacks: PrepCallbacks): Promise<void> {
  const network = config.network ?? 'undeployed';
  const { config: networkConfig } = resolveNetwork({
    args: { command: 'test', subcommand: undefined, positionals: [], flags: { network } },
  });
  await assertLedgerSupported(network, networkConfig);

  const walletConfig = loadWalletConfig(resolveWalletPath());
  const seedBuffer = Buffer.from(walletConfig.seed, 'hex');
  const address = walletConfig.addresses[network as NetworkName];

  const unsuppress = suppressSdkTransientErrors();
  const restoreRpc = suppressRpcNoise();
  const cache = loadWalletCache(address, network);
  const bundle = await buildFacade(seedBuffer, networkConfig, cache);

  try {
    callbacks.onMessage('Syncing wallet...');
    await startAndSyncFacade(bundle, { syncMode: 'lite' });

    // Register dust (auto-registers UTXOs if needed, no-op if already available)
    callbacks.onMessage('Ensuring dust...');
    const result = await ensureDust(bundle, (status) => callbacks.onMessage(`Dust: ${status}`));

    if (result.alreadyAvailable) {
      callbacks.onMessage('Dust already available');
      try { await saveWalletCache(address, network, bundle.facade); } catch {}
      return;
    }

    // Dust was just registered — wait for coins to actually appear on-chain.
    // This MUST use the same facade to get real-time state updates.
    callbacks.onMessage('Dust registered. Waiting for coins to become available...');
    const dustState = await waitForDustAvailable(bundle, DUST_WAIT_TIMEOUT_MS);

    // Verify dust is actually available — don't trust silent timeouts
    const dustAvailable = hasDustAvailable(dustState);

    if (!dustAvailable) {
      if (network !== 'undeployed') {
        throw new Error(
          `Dust not available on ${network}. Register dust and wait for it to generate:\n` +
          `  mn dust register\n` +
          `  mn dust status   (check until dustAvailable: true)`
        );
      }
      throw new Error(`Dust not available after ${DUST_WAIT_TIMEOUT_MS / 1000}s. The chain may be slow — try again.`);
    }

    callbacks.onMessage('Dust is available');
    try { await saveWalletCache(address, network, bundle.facade); } catch {}
  } finally {
    restoreRpc();
    unsuppress();
    try { await stopFacade(bundle); } catch {}
  }
}

async function stepMnServe(config: DappTestConfig, ctx: PrepContext, callbacks: PrepCallbacks): Promise<void> {
  callbacks.onMessage('Starting mn serve...');

  // startServeOrReuse probes the port first: if a compatible mn serve is
  // already running it gets reused (with a no-op stop), if a stale/wrong-
  // network serve owns the port we throw with an actionable message rather
  // than silently double-binding and falling back to whatever was there
  // before.
  const handle = await startServeOrReuse({
    port: undefined, // use default
    network: config.network,
    onMessage: (msg) => callbacks.onMessage(`[serve] ${msg}`),
  });

  ctx.serveHandle = handle;
  ctx.addCleanup(async () => handle.stop());
  callbacks.onMessage(`mn serve ready on port ${handle.port}`);
}

async function stepBuildAndServe(config: DappTestConfig, dappDir: string, ctx: PrepContext, callbacks: PrepCallbacks): Promise<void> {
  if (!config.buildCmd) {
    callbacks.onMessage('No buildCmd in config, skipping build');
    return;
  }

  const port = config.port ?? 4173;
  const url = config.url ?? `http://localhost:${port}/`;
  const logFile = join(dappDir, 'tests', 'results', `build_${Date.now()}.log`);

  const handle = await startBuild({
    dappDir,
    buildCmd: config.buildCmd,
    buildDir: config.buildDir,
    port,
    url,
    logFile,
    onMessage: (msg) => callbacks.onMessage(`[build] ${msg}`),
  });

  ctx.buildHandle = handle;
  ctx.addCleanup(async () => handle.stop());
}
