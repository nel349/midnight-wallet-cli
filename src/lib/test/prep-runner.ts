// Prep runner — execute prep steps defined in dapp.test.json by calling existing lib functions.

import * as ledger from '@midnight-ntwrk/ledger-v8';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { bindCachesToIndexer } from '../cache-indexer.ts';
import { clearWalletCache } from '../wallet-cache.ts';
import { loadWalletConfig, resolveWalletPath } from '../wallet-config.ts';
import { resolveNetwork } from '../resolve-network.ts';
import type { NetworkConfig, NetworkName } from '../network.ts';
import { checkDockerAvailable, ensureComposeFile, dockerCompose, getServiceStatus, waitForHealthy } from '../localnet.ts';
import { buildFacade, currentDustBalance, startAndSyncFacade, stopFacade, suppressSdkTransientErrors, waitForDustAvailable } from '../facade.ts';
import { loadWalletCache, saveWalletCache } from '../wallet-cache.ts';
import { dustToString, executeTransfer, ensureDust, suppressRpcNoise } from '../transfer.ts';
import { GENESIS_SEED, INDEXER_GRAPHQL_PATH, MIN_DUST_FOR_TRANSFER } from '../constants.ts';
import { waitForDustBalance } from '../dust-wait.ts';
import { httpAnswers } from '../http-probe.ts';
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
    return stepLocalnetUp(callbacks);
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

const LOCALNET_TIMEOUT_MS = 30_000; // 30s for Docker health
const LOCALNET_MAX_RETRIES = 2;
const INDEXER_PROBE_TIMEOUT_MS = 30_000; // 30s for indexer to start responding after Docker healthy

/** The local indexer's HTTP endpoint: any answer, a 4xx included, means it is serving. */
const LOCAL_INDEXER_URL = `http://localhost:8088${INDEXER_GRAPHQL_PATH}`;

/** Poll the indexer until it responds or timeout. */
async function waitForIndexer(timeoutMs: number, onMessage?: (msg: string) => void): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await httpAnswers(LOCAL_INDEXER_URL, 3_000)) return true;
    onMessage?.('Waiting for indexer...');
    await sleep(2_000);
  }
  return false;
}

async function stepLocalnetUp(callbacks: PrepCallbacks): Promise<void> {
  checkDockerAvailable();
  ensureComposeFile();

  const expected = ['node', 'indexer', 'proof-server'];

  // Check Docker says all 3 are running and healthy
  const services = getServiceStatus();
  const allHealthy = services.length >= 3 &&
    expected.every(name => services.some(s => s.name === name && s.state === 'running')) &&
    services.every(s => !s.health || s.health === 'healthy');

  if (allHealthy) {
    // Docker thinks they're healthy — verify the indexer is actually responding
    if (await waitForIndexer(10_000, (msg) => callbacks.onMessage(msg))) {
      callbacks.onMessage(`Localnet OK (3 services healthy, indexer responding)`);
      return;
    }
    callbacks.onMessage('Localnet containers running but indexer not responding. Restarting...');
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
    if (healthy && await waitForIndexer(INDEXER_PROBE_TIMEOUT_MS, (msg) => callbacks.onMessage(msg))) {
      callbacks.onMessage('Localnet running (indexer verified)');
      return;
    }
    if (healthy) {
      callbacks.onMessage(`Attempt ${attempt}: Docker healthy but indexer not responding after ${INDEXER_PROBE_TIMEOUT_MS / 1000}s`);
      continue;
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
  bindCachesToIndexer(network, networkConfig.indexerWS);
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
// A 1000 NIGHT wallet accrues the minimum in about 80 s from registration.
const DUST_ACCRUAL_TIMEOUT_MS = 180_000;

async function stepDust(config: DappTestConfig, callbacks: PrepCallbacks): Promise<void> {
  const network = config.network ?? 'undeployed';
  const { config: networkConfig } = resolveNetwork({
    args: { command: 'test', subcommand: undefined, positionals: [], flags: { network } },
  });

  const walletConfig = loadWalletConfig(resolveWalletPath());
  const seedBuffer = Buffer.from(walletConfig.seed, 'hex');
  const address = walletConfig.addresses[network as NetworkName];

  const unsuppress = suppressSdkTransientErrors();
  const restoreRpc = suppressRpcNoise();
  bindCachesToIndexer(network, networkConfig.indexerWS);
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
    } else {
      // Dust was just registered — wait for coins to actually appear on-chain.
      // This MUST use the same facade to get real-time state updates.
      callbacks.onMessage('Dust registered. Waiting for coins to become available...');
      const dustState = await waitForDustAvailable(bundle, DUST_WAIT_TIMEOUT_MS);

      // Verify dust is actually available — don't trust silent timeouts
      const dustAvailable = (() => {
        try {
          const dust = dustState.dust as any;
          return dust?.availableCoins?.length > 0 || dust?.balance(new Date()) > 0n;
        } catch { return false; }
      })();

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
    }

    // Available is not yet enough to pay with: a suite's first transaction
    // right after a registration fails with "could not balance dust". Wait for
    // the amount mn asks for before any transaction.
    const needed = dustToString(MIN_DUST_FOR_TRANSFER);
    const balance = await waitForDustBalance(() => currentDustBalance(bundle), MIN_DUST_FOR_TRANSFER, {
      timeoutMs: DUST_ACCRUAL_TIMEOUT_MS,
      onBalance: (b) => callbacks.onMessage(`Dust: ${dustToString(b)} of the ${needed} DUST a transaction needs, accruing...`),
    });
    if (balance < MIN_DUST_FOR_TRANSFER) {
      throw new Error(
        `Only ${dustToString(balance)} DUST after ${DUST_ACCRUAL_TIMEOUT_MS / 1000}s, and a transaction needs ${needed}. ` +
        'Dust accrues with time, faster the more NIGHT is registered: run the suite again in a while, or fund the wallet with more NIGHT.'
      );
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
