// The contract runner emits a Node script; these tests evaluate its provider
// fragments against the installed midnight-js 5 / ledger-v9 packages. Only the
// mn serve RPC (`rpcCall`) is stubbed.

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ledger from '@midnightntwrk/ledger-v9';
import {
  createWalletProvider,
  createMidnightProvider,
  assertSeamsSupportEra,
  Transaction,
  type WalletProvider,
  type MidnightProvider,
  type UnboundTransaction,
} from '@midnight-ntwrk/midnight-js-types';
import { toHex, fromHex } from '@midnight-ntwrk/midnight-js-utils';
import { CURRENT_LEDGER_VERSION } from '@midnight-ntwrk/midnight-js-protocol/version';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import {
  PROVIDER_IMPORTS,
  walletProviderCode,
  providerSetupCode,
  generateDeployScript,
  generateCallScript,
  generateStateScript,
  SCRIPT_PRELUDE,
} from '../lib/contract/runner.ts';
import type { NetworkConfig } from '../lib/network.ts';

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...params: string[]
) => (...args: unknown[]) => Promise<any>;

const COIN_PK = 'aa'.repeat(32);
const ENC_PK = 'bb'.repeat(32);

const NETWORK: NetworkConfig = {
  indexer: 'http://127.0.0.1:1/api/v4/graphql',
  indexerWS: 'ws://127.0.0.1:1/api/v4/graphql/ws',
  node: 'ws://127.0.0.1:1',
  proofServer: 'http://127.0.0.1:1',
  networkId: 'Undeployed',
};

type RpcRecord = { method: string; params: Record<string, unknown> };

/** Stub of the mn serve JSON-RPC boundary: records calls, answers from `replies`. */
function makeRpcStub(replies: Record<string, unknown>) {
  const calls: RpcRecord[] = [];
  const rpcCall = async (method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params });
    if (!(method in replies)) throw new Error(`unexpected RPC ${method}`);
    return replies[method];
  };
  return { calls, rpcCall };
}

/** Run the generated wallet/midnight provider fragment with the bindings PROVIDER_IMPORTS gives it. */
async function evalWalletProviders(rpcCall: unknown) {
  const fn = new AsyncFunction(
    'rpcCall', 'createWalletProvider', 'createMidnightProvider', 'Transaction', 'toHex', 'fromHex',
    `${walletProviderCode()}\nreturn { walletProvider, midnightProvider };`,
  );
  return await fn(rpcCall, createWalletProvider, createMidnightProvider, Transaction, toHex, fromHex) as {
    walletProvider: WalletProvider;
    midnightProvider: MidnightProvider;
  };
}

// Real ledger-v9 txs built offline: an empty intent needs no circuit proofs,
// so prove() never reaches the proving provider.
let unboundTx: UnboundTransaction;
let finalizedTx: ledger.FinalizedTransaction;

beforeAll(async () => {
  const neverProves = async () => { throw new Error('proving provider must not be called'); };
  const unproven = ledger.Transaction.fromParts(
    'undeployed', undefined, undefined, ledger.Intent.new(new Date(Date.UTC(2030, 0, 1))),
  );
  unboundTx = await unproven.prove(
    { check: neverProves, prove: neverProves, lookupKey: neverProves },
    ledger.CostModel.initialCostModel(),
  );
  finalizedTx = ledger.Transaction.fromParts(
    'undeployed', undefined, undefined, ledger.Intent.new(new Date(Date.UTC(2030, 0, 1))),
  ).mockProve();
});

describe('generated walletProvider', () => {
  it('declares the current ledger era so midnight-js 5 does not refuse it', async () => {
    const { rpcCall } = makeRpcStub({
      getShieldedAddresses: { shieldedCoinPublicKey: COIN_PK, shieldedEncryptionPublicKey: ENC_PK },
    });
    const { walletProvider, midnightProvider } = await evalWalletProviders(rpcCall);

    expect(walletProvider.supportedEras).toContain(CURRENT_LEDGER_VERSION);
    expect(midnightProvider.supportedEras).toContain(CURRENT_LEDGER_VERSION);
  });

  it('returns the keys mn serve reports', async () => {
    const { rpcCall } = makeRpcStub({
      getShieldedAddresses: { shieldedCoinPublicKey: COIN_PK, shieldedEncryptionPublicKey: ENC_PK },
    });
    const { walletProvider } = await evalWalletProviders(rpcCall);

    expect(walletProvider.getCoinPublicKey()).toBe(COIN_PK);
    expect(walletProvider.getEncryptionPublicKey()).toBe(ENC_PK);
  });

  it('balances a v9-tagged tx via balanceUnsealedTransaction and returns the sealed tx v9-tagged', async () => {
    const sealedHex = toHex(finalizedTx.serialize());
    const { calls, rpcCall } = makeRpcStub({
      getShieldedAddresses: { shieldedCoinPublicKey: COIN_PK, shieldedEncryptionPublicKey: ENC_PK },
      balanceUnsealedTransaction: { tx: sealedHex },
    });
    const { walletProvider } = await evalWalletProviders(rpcCall);

    const balanced = await walletProvider.balanceTx({ version: 'v9', tx: unboundTx });

    const balanceCall = calls.find((c) => c.method === 'balanceUnsealedTransaction');
    expect(balanceCall?.params).toEqual({ tx: toHex(unboundTx.serialize()) });
    expect(balanced.version).toBe('v9');
    if (balanced.version !== 'v9') throw new Error('unreachable');
    expect(balanced.tx).toBeInstanceOf(Transaction);
    expect(toHex(balanced.tx.serialize())).toBe(sealedHex);
  });

  it('surfaces an RPC rejection from mn serve', async () => {
    const { rpcCall } = makeRpcStub({
      getShieldedAddresses: { shieldedCoinPublicKey: COIN_PK, shieldedEncryptionPublicKey: ENC_PK },
    });
    const { walletProvider } = await evalWalletProviders(rpcCall);

    await expect(walletProvider.balanceTx({ version: 'v9', tx: unboundTx }))
      .rejects.toThrow('unexpected RPC balanceUnsealedTransaction');
  });
});

describe('generated midnightProvider', () => {
  it('submits the unwrapped tx hex via submitTransaction and returns its first identifier', async () => {
    const { calls, rpcCall } = makeRpcStub({
      getShieldedAddresses: { shieldedCoinPublicKey: COIN_PK, shieldedEncryptionPublicKey: ENC_PK },
      submitTransaction: { txHash: 'ignored-by-provider' },
    });
    const { midnightProvider } = await evalWalletProviders(rpcCall);

    const txId = await midnightProvider.submitTx({ version: 'v9', tx: finalizedTx });

    const submitCall = calls.find((c) => c.method === 'submitTransaction');
    expect(submitCall?.params).toEqual({ tx: toHex(finalizedTx.serialize()) });
    expect(txId).toBe(finalizedTx.identifiers()[0]);
  });
});

describe('generated providers object', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it('passes the era check deployContract/findDeployedContract run first', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mn-runner-'));
    const { rpcCall } = makeRpcStub({
      getShieldedAddresses: { shieldedCoinPublicKey: COIN_PK, shieldedEncryptionPublicKey: ENC_PK },
    });
    const { walletProvider, midnightProvider } = await evalWalletProviders(rpcCall);
    const fn = new AsyncFunction(
      'MANAGED_DIR', 'walletProvider', 'midnightProvider',
      'NodeZkConfigProvider', 'httpClientProofProvider', 'indexerPublicDataProvider', 'levelPrivateStateProvider',
      `${providerSetupCode(NETWORK, 'counterPrivateState')}\nreturn providers;`,
    );
    const providers = await fn(
      dir, walletProvider, midnightProvider,
      NodeZkConfigProvider, httpClientProofProvider, indexerPublicDataProvider, levelPrivateStateProvider,
    );
    try {
      expect(() => assertSeamsSupportEra(CURRENT_LEDGER_VERSION, providers)).not.toThrow();
      expect(providers.midnightProvider).toBe(midnightProvider);
    } finally {
      await providers.publicDataProvider.dispose();
    }
  });
});

describe('generated scripts', () => {
  const scripts = {
    deploy: generateDeployScript({
      dappDir: '/tmp/dapp', networkConfig: NETWORK, managedDir: '/tmp/dapp/managed/counter',
      contractName: 'counter', servePort: 9932, args: [1, 'x'],
    }),
    call: generateCallScript({
      dappDir: '/tmp/dapp', networkConfig: NETWORK, managedDir: '/tmp/dapp/managed/counter',
      contractName: 'counter', servePort: 9932, contractAddress: 'ab'.repeat(32), circuit: 'increment', args: [],
    }),
    state: generateStateScript({
      dappDir: '/tmp/dapp', networkConfig: NETWORK, managedDir: '/tmp/dapp/managed/counter',
      contractName: 'counter', contractAddress: 'ab'.repeat(32),
    }),
  };

  it('starts every script with the prelude that reports failures as one marked line', () => {
    for (const script of Object.values(scripts)) {
      expect(script.startsWith(SCRIPT_PRELUDE)).toBe(true);
    }
  });

  it('includes the provider imports in deploy and call scripts', () => {
    expect(scripts.deploy).toContain(PROVIDER_IMPORTS);
    expect(scripts.call).toContain(PROVIDER_IMPORTS);
  });

  for (const [name, script] of Object.entries(scripts)) {
    it(`${name} script: every named import exists in the installed package`, async () => {
      const imports = [...script.matchAll(/^import \{([^}]+)\} from '([^']+)';$/gm)];
      expect(imports.length).toBeGreaterThan(0);
      for (const [, names, specifier] of imports) {
        if (specifier.startsWith('node:')) continue;
        const mod = await import(specifier);
        for (const raw of names.split(',')) {
          const exported = raw.trim().split(/\s+as\s+/)[0];
          expect(mod[exported], `${exported} from ${specifier}`).toBeDefined();
        }
      }
    });

    it(`${name} script: parses as an ES module`, () => {
      const tmp = mkdtempSync(join(tmpdir(), 'mn-runner-syntax-'));
      try {
        const file = join(tmp, 'script.mjs');
        writeFileSync(file, script);
        const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
        expect(res.stderr).toBe('');
        expect(res.status).toBe(0);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
});
