// Prep runner — execute prep steps defined in dapp.test.json by calling existing lib functions.

import * as ledger from '@midnight-ntwrk/ledger-v8';
import { join } from 'node:path';

import { clearWalletCache } from '../wallet-cache.ts';
import { loadWalletConfig, resolveWalletPath } from '../wallet-config.ts';
import { resolveNetwork } from '../resolve-network.ts';
import type { NetworkConfig, NetworkName } from '../network.ts';
import { checkDockerAvailable, ensureComposeFile, dockerCompose, getServiceStatus, waitForHealthy } from '../localnet.ts';
import { buildFacade, startAndSyncFacade, stopFacade, suppressSdkTransientErrors, waitForDustAvailable } from '../facade.ts';
import { loadWalletCache, saveWalletCache } from '../wallet-cache.ts';
import { executeTransfer, ensureDust, suppressRpcNoise } from '../transfer.ts';
import { GENESIS_SEED } from '../constants.ts';
import { deriveUnshieldedAddress } from '../derive-address.ts';

import type { DappTestConfig, PrepStepId, PrepStepResult, PrepContext, PrepCallbacks } from './types.ts';
import { startServe } from './serve-manager.ts';
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
    return stepLocalnetUp(callbacks);
  }
  if (step.startsWith('balance:')) {
    const amount = parseInt(step.split(':')[1], 10);
    return stepBalance(amount, config, callbacks);
  }
  if (step === 'dust-register' || step === 'dust-wait') {
    return stepDust(step, config, callbacks);
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

const LOCALNET_TIMEOUT_MS = 30_000; // 30s per attempt
const LOCALNET_MAX_RETRIES = 2;

async function stepLocalnetUp(callbacks: PrepCallbacks): Promise<void> {
  checkDockerAvailable();
  ensureComposeFile();

  const expected = ['node', 'indexer', 'proof-server'];

  // Always start clean for tests — stale containers cause silent failures
  const services = getServiceStatus();
  const allHealthy = services.length === 3 &&
    services.every(s => s.state === 'running') &&
    services.every(s => !s.health || s.health === 'healthy');

  if (allHealthy) {
    callbacks.onMessage(`Localnet OK (3 services healthy)`);
    return;
  }

  // Something is wrong — tear down and start fresh
  const running = services.filter(s => s.state === 'running').map(s => s.name);
  const missing = expected.filter(name => !running.includes(name));
  if (missing.length > 0) {
    callbacks.onMessage(`Localnet missing: ${missing.join(', ')}. Restarting clean...`);
  } else {
    callbacks.onMessage(`Localnet unhealthy. Restarting clean...`);
  }

  for (let attempt = 1; attempt <= LOCALNET_MAX_RETRIES; attempt++) {
    callbacks.onMessage(`Attempt ${attempt}/${LOCALNET_MAX_RETRIES}: tearing down...`);
    dockerCompose('down');

    callbacks.onMessage(`Attempt ${attempt}/${LOCALNET_MAX_RETRIES}: starting...`);
    dockerCompose('up -d');

    const healthy = waitForHealthy(LOCALNET_TIMEOUT_MS);
    if (healthy) {
      callbacks.onMessage('Localnet running');
      return;
    }

    // Report what went wrong on this attempt
    const postServices = getServiceStatus();
    const stillMissing = expected.filter(name => !postServices.some(s => s.name === name && s.state === 'running'));
    const stillUnhealthy = postServices.filter(s => s.state === 'running' && s.health && s.health !== 'healthy');

    const issues: string[] = [];
    if (stillMissing.length > 0) issues.push(`not running: ${stillMissing.join(', ')}`);
    if (stillUnhealthy.length > 0) issues.push(`unhealthy: ${stillUnhealthy.map(s => s.name).join(', ')}`);
    callbacks.onMessage(`Attempt ${attempt} failed: ${issues.join('; ') || 'timeout'}`);
  }

  throw new Error(`Localnet failed to start after ${LOCALNET_MAX_RETRIES} attempts`);
}

async function stepBalance(amount: number, config: DappTestConfig, callbacks: PrepCallbacks): Promise<void> {
  const network = config.network ?? 'undeployed';
  const { config: networkConfig } = resolveNetwork({
    args: { command: 'test', subcommand: undefined, positionals: [], flags: { network } },
  });

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

  // Balance is zero — airdrop from genesis
  callbacks.onMessage(`Balance is 0. Airdropping ${amount} NIGHT...`);
  const genesisSeedBuffer = Buffer.from(GENESIS_SEED, 'hex');
  const genesisAddress = deriveUnshieldedAddress(genesisSeedBuffer, network as NetworkName);

  await executeTransfer({
    seedBuffer: genesisSeedBuffer,
    networkConfig,
    recipientAddress: address,
    amountNight: amount,
    walletAddress: genesisAddress,
    networkName: network,
    noCache: false,
    onSync(_applied, _highest) {},
    onDust(status) { callbacks.onMessage(`Dust: ${status}`); },
    onProving() { callbacks.onMessage('Generating ZK proof...'); },
    onSubmitting() { callbacks.onMessage('Submitting airdrop transaction...'); },
    onSyncWarning(_tag, msg) { callbacks.onMessage(`Syncing genesis... (${msg})`); },
  });

  callbacks.onMessage(`Airdropped ${amount} NIGHT`);
}

async function stepDust(step: 'dust-register' | 'dust-wait', config: DappTestConfig, callbacks: PrepCallbacks): Promise<void> {
  const network = config.network ?? 'undeployed';
  const { config: networkConfig } = resolveNetwork({
    args: { command: 'test', subcommand: undefined, positionals: [], flags: { network } },
  });

  const walletConfig = loadWalletConfig(resolveWalletPath());
  const seedBuffer = Buffer.from(walletConfig.seed, 'hex');
  const address = walletConfig.addresses[network as NetworkName];

  const unsuppress = suppressSdkTransientErrors();
  const restoreRpc = suppressRpcNoise();
  const cache = loadWalletCache(address, network);
  const bundle = await buildFacade(seedBuffer, networkConfig, cache);

  try {
    await startAndSyncFacade(bundle, { syncMode: 'lite' });

    if (step === 'dust-register') {
      callbacks.onMessage('Registering dust...');
      await ensureDust(bundle, (status) => callbacks.onMessage(`Dust: ${status}`));
      callbacks.onMessage('Dust registered');
    } else {
      callbacks.onMessage('Waiting for dust to become available...');
      await waitForDustAvailable(bundle);
      callbacks.onMessage('Dust is available');
    }

    try { await saveWalletCache(address, network, bundle.facade); } catch {}
  } finally {
    restoreRpc();
    unsuppress();
    try { await stopFacade(bundle); } catch {}
  }
}

async function stepMnServe(config: DappTestConfig, ctx: PrepContext, callbacks: PrepCallbacks): Promise<void> {
  callbacks.onMessage('Starting mn serve...');

  const handle = await startServe({
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
