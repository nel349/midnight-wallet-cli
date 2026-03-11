// Tests for dapp-connector.ts — createDAppConnector handler map
// Stubs the FacadeBundle at the SDK boundary (per CLAUDE.md: no mocks of our own code).
// SDK modules (address encoding, tx deserialization) are stubbed at the boundary.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as rx from 'rxjs';

// Stub SDK address encoding — MidnightBech32m.encode returns a mock
vi.mock('@midnight-ntwrk/wallet-sdk-address-format', () => ({
  MidnightBech32m: {
    encode: (_networkId: any, address: any) => ({
      asString: () => 'bech32m_mock_address',
    }),
    parse: (str: string) => ({
      decode: () => ({ parsed: str }),
    }),
  },
  UnshieldedAddress: {},
  ShieldedAddress: {},
}));

// Stub tx-serde — SDK Transaction.deserialize calls
vi.mock('../lib/tx-serde.ts', () => ({
  serializeTx: (tx: any) => 'serialized_' + (tx?.type ?? 'unknown'),
  deserializeUnsealed: (hex: string) => ({ type: 'unsealed', hex }),
  deserializeSealed: (hex: string) => ({ type: 'sealed', hex }),
  fromHex: (hex: string) => new Uint8Array(Buffer.from(hex, 'hex')),
}));

import { createDAppConnector, type DAppConnector } from '../lib/dapp-connector.ts';
import type { FacadeBundle } from '../lib/facade.ts';
import type { NetworkConfig } from '../lib/network.ts';
import type { RpcHandlerContext } from '../lib/ws-rpc.ts';

/** Mock handler context with no-op notify */
const ctx = (connectionId = 'conn_test'): RpcHandlerContext => ({ notify: vi.fn(), connectionId, requestId: 1, metadata: {} });

// ── Helpers ──────────────────────────────────────────────────────────

const TEST_NETWORK_CONFIG: NetworkConfig = {
  indexer: 'http://localhost:8088/api/v3/graphql',
  indexerWS: 'ws://localhost:8088/api/v3/graphql/ws',
  node: 'ws://localhost:9944',
  proofServer: 'http://localhost:6300',
  networkId: 'Undeployed',
};

/** Create a minimal mock FacadeState. */
function mockState(overrides?: {
  unshieldedBalances?: Record<string, bigint>;
  shieldedBalances?: Record<string, bigint>;
  dustBalance?: bigint;
}) {
  return {
    isSynced: true,
    unshielded: {
      balances: overrides?.unshieldedBalances ?? { '0000000000000000000000000000000000000000000000000000000000000000': 5000000n },
      address: { data: Buffer.alloc(32) },
      progress: { appliedId: 1n, highestTransactionId: 1n },
      transactionHistory: {
        async *getAll() {
          yield { hash: 'tx-hash-001', status: 'SUCCESS' };
          yield { hash: 'tx-hash-002', status: 'FAILURE' };
        },
      },
    },
    shielded: {
      balances: overrides?.shieldedBalances ?? {},
      address: {
        coinPublicKeyString: () => 'coin-pub-key-hex',
        encryptionPublicKeyString: () => 'enc-pub-key-hex',
      },
    },
    dust: {
      balance: (_time: Date) => overrides?.dustBalance ?? 1000n,
      address: { data: 0n },
    },
  };
}

/** Create a minimal FacadeBundle stub. */
function createBundleStub(overrides?: {
  stateFn?: () => rx.Observable<any>;
  transferTransaction?: () => Promise<any>;
  signRecipe?: () => Promise<any>;
  finalizeRecipe?: () => Promise<any>;
  submitTransaction?: () => Promise<string>;
  balanceUnboundTransaction?: () => Promise<any>;
  balanceFinalizedTransaction?: () => Promise<any>;
  initSwap?: () => Promise<any>;
}): FacadeBundle {
  const defaultStateFn = () => rx.of(mockState());

  return {
    facade: {
      state: overrides?.stateFn ?? defaultStateFn,
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      transferTransaction: overrides?.transferTransaction ?? vi.fn().mockResolvedValue({ type: 'UNPROVEN_TRANSACTION' }),
      signRecipe: overrides?.signRecipe ?? vi.fn().mockResolvedValue({ type: 'SIGNED' }),
      finalizeRecipe: overrides?.finalizeRecipe ?? vi.fn().mockResolvedValue({ serialize: () => new Uint8Array([0xab, 0xcd]) }),
      submitTransaction: overrides?.submitTransaction ?? vi.fn().mockResolvedValue('mock-tx-hash'),
      balanceUnboundTransaction: overrides?.balanceUnboundTransaction ?? vi.fn().mockResolvedValue({ type: 'UNBOUND' }),
      balanceFinalizedTransaction: overrides?.balanceFinalizedTransaction ?? vi.fn().mockResolvedValue({ type: 'FINALIZED' }),
      initSwap: overrides?.initSwap ?? vi.fn().mockResolvedValue({ type: 'SWAP' }),
      registerNightUtxosForDustGeneration: vi.fn(),
    },
    keystore: {
      signData: vi.fn().mockReturnValue('abcd1234signature'),
      getPublicKey: vi.fn().mockReturnValue('5678efghpubkey'),
    },
    zswapSecretKeys: {} as any,
    dustSecretKey: {} as any,
  } as unknown as FacadeBundle;
}

function createConnector(overrides?: {
  bundleOverrides?: Parameters<typeof createBundleStub>[0];
  networkConfig?: NetworkConfig;
  approvalOptions?: { approveAll?: boolean; autoApproveReads?: boolean };
}): DAppConnector {
  return createDAppConnector({
    bundle: createBundleStub(overrides?.bundleOverrides),
    networkConfig: overrides?.networkConfig ?? TEST_NETWORK_CONFIG,
    approvalOptions: overrides?.approvalOptions ?? { approveAll: true },
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('dapp-connector', () => {
  let connector: DAppConnector | undefined;
  let origStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    origStderrWrite = process.stderr.write;
  });

  afterEach(() => {
    // Always restore stderr first, even if dispose throws
    process.stderr.write = origStderrWrite;
    connector?.dispose();
    connector = undefined;
  });

  describe('createDAppConnector', () => {
    it('throws for unknown networkId', () => {
      expect(() => createConnector({
        networkConfig: { ...TEST_NETWORK_CONFIG, networkId: 'Mainnet' },
      })).toThrow('Unknown networkId: Mainnet');
    });

    it('returns all 18 handler methods', () => {
      connector = createConnector();
      const methods = Object.keys(connector.handlers);
      expect(methods).toContain('connect');
      expect(methods).toContain('getUnshieldedBalances');
      expect(methods).toContain('getShieldedBalances');
      expect(methods).toContain('getDustBalance');
      expect(methods).toContain('getUnshieldedAddress');
      expect(methods).toContain('getShieldedAddresses');
      expect(methods).toContain('getDustAddress');
      expect(methods).toContain('getTxHistory');
      expect(methods).toContain('getConfiguration');
      expect(methods).toContain('getConnectionStatus');
      expect(methods).toContain('makeTransfer');
      expect(methods).toContain('submitTransaction');
      expect(methods).toContain('balanceUnsealedTransaction');
      expect(methods).toContain('balanceSealedTransaction');
      expect(methods).toContain('makeIntent');
      expect(methods).toContain('signData');
      expect(methods).toContain('getProvingProvider');
      expect(methods).toContain('hintUsage');
      expect(methods.length).toBe(18);
    });

    it('dispose() unsubscribes from state', () => {
      const subject = new rx.BehaviorSubject(mockState());
      connector = createConnector({
        bundleOverrides: { stateFn: () => subject.asObservable() },
      });
      expect(subject.observed).toBe(true);
      connector.dispose();
      expect(subject.observed).toBe(false);
      connector = undefined; // Already disposed
    });
  });

  // ── Handshake ──

  describe('connect', () => {
    it('returns networkId on match', async () => {
      connector = createConnector();
      const result = await connector.handlers.connect({ networkId: 'Undeployed' }, ctx());
      expect(result).toEqual({ networkId: 'Undeployed' });
    });

    it('matches case-insensitively', async () => {
      connector = createConnector();
      const result = await connector.handlers.connect({ networkId: 'undeployed' }, ctx());
      expect(result).toEqual({ networkId: 'Undeployed' });
    });

    it('throws InvalidRequest on network mismatch', async () => {
      connector = createConnector();
      await expect(connector.handlers.connect({ networkId: 'PreProd' }, ctx()))
        .rejects.toThrow('Network mismatch');
    });

    it('throws InvalidRequest when networkId is missing', async () => {
      connector = createConnector();
      await expect(connector.handlers.connect({}, ctx()))
        .rejects.toThrow('Network mismatch');
    });
  });

  // ── Read-Only Methods ──

  describe('getUnshieldedBalances', () => {
    it('returns balances from state', async () => {
      const balances = { 'token-a': 100n, 'token-b': 200n };
      connector = createConnector({
        bundleOverrides: { stateFn: () => rx.of(mockState({ unshieldedBalances: balances })) },
      });
      const result = await connector.handlers.getUnshieldedBalances({}, ctx());
      expect(result).toEqual(balances);
    });
  });

  describe('getShieldedBalances', () => {
    it('returns balances from state', async () => {
      const balances = { 'shielded-token': 999n };
      connector = createConnector({
        bundleOverrides: { stateFn: () => rx.of(mockState({ shieldedBalances: balances })) },
      });
      const result = await connector.handlers.getShieldedBalances({}, ctx());
      expect(result).toEqual(balances);
    });
  });

  describe('getDustBalance', () => {
    it('returns { cap, balance } with balance from state.dust.balance()', async () => {
      connector = createConnector({
        bundleOverrides: { stateFn: () => rx.of(mockState({ dustBalance: 42000n })) },
      });
      const result = await connector.handlers.getDustBalance({}, ctx()) as any;
      expect(result.balance).toBe(42000n);
      expect(result.cap).toBe(42000n);
    });
  });

  describe('getTxHistory', () => {
    it('returns entries with correct TxStatus object shape', async () => {
      connector = createConnector();
      const result = await connector.handlers.getTxHistory({ pageNumber: 0, pageSize: 10 }, ctx()) as any[];
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ txHash: 'tx-hash-001', txStatus: { status: 'finalized' } });
      expect(result[1]).toEqual({ txHash: 'tx-hash-002', txStatus: { status: 'pending' } });
    });

    it('paginates correctly', async () => {
      connector = createConnector();
      const result = await connector.handlers.getTxHistory({ pageNumber: 0, pageSize: 1 }, ctx()) as any[];
      expect(result).toHaveLength(1);
      expect(result[0].txHash).toBe('tx-hash-001');
    });

    it('returns page 2', async () => {
      connector = createConnector();
      const result = await connector.handlers.getTxHistory({ pageNumber: 1, pageSize: 1 }, ctx()) as any[];
      expect(result).toHaveLength(1);
      expect(result[0].txHash).toBe('tx-hash-002');
    });

    it('returns empty array when SDK throws', async () => {
      const state = mockState();
      (state.unshielded as any).transactionHistory = {
        async *getAll() { throw new Error('Not yet implemented'); },
      };
      connector = createConnector({
        bundleOverrides: { stateFn: () => rx.of(state) },
      });
      const result = await connector.handlers.getTxHistory({}, ctx());
      expect(result).toEqual([]);
    });

    it('defaults to pageNumber 0 and pageSize 20', async () => {
      connector = createConnector();
      const result = await connector.handlers.getTxHistory({}, ctx()) as any[];
      expect(result).toHaveLength(2);
    });
  });

  describe('getConfiguration', () => {
    it('maps NetworkConfig fields to Configuration shape', async () => {
      connector = createConnector();
      const result = await connector.handlers.getConfiguration({}, ctx()) as any;
      expect(result).toEqual({
        indexerUri: 'http://localhost:8088/api/v3/graphql',
        indexerWsUri: 'ws://localhost:8088/api/v3/graphql/ws',
        proverServerUri: 'http://localhost:6300',
        substrateNodeUri: 'ws://localhost:9944',
        networkId: 'Undeployed',
      });
    });
  });

  describe('getConnectionStatus', () => {
    it('returns connected status with networkId', async () => {
      connector = createConnector();
      const result = await connector.handlers.getConnectionStatus({}, ctx());
      expect(result).toEqual({ status: 'connected', networkId: 'Undeployed' });
    });
  });

  // ── State guard ──

  describe('state guard', () => {
    it('throws Disconnected when wallet not synced', async () => {
      const neverSynced = new rx.Subject<any>();
      connector = createConnector({
        bundleOverrides: { stateFn: () => neverSynced.asObservable() },
      });
      await expect(connector.handlers.getUnshieldedBalances({}, ctx()))
        .rejects.toThrow('Wallet not synced yet');
    });

    it('throws Disconnected with correct error code', async () => {
      const neverSynced = new rx.Subject<any>();
      connector = createConnector({
        bundleOverrides: { stateFn: () => neverSynced.asObservable() },
      });
      try {
        await connector.handlers.getUnshieldedBalances({}, ctx());
        expect.unreachable('should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('Disconnected');
        expect(err.type).toBe('DAppConnectorAPIError');
      }
    });
  });

  // ── Write method approval gating ──

  describe('write method approval', () => {
    it('proceeds when approveAll is true', async () => {
      connector = createConnector({ approvalOptions: { approveAll: true } });
      const result = await connector.handlers.signData({
        data: 'deadbeef',
        options: { encoding: 'hex', keyType: 'unshielded' },
      }, ctx()) as any;
      expect(result.data).toBe('deadbeef');
      expect(result.signature).toBe('abcd1234signature');
      expect(result.verifyingKey).toBe('5678efghpubkey');
    });

    it('rejects when stdin is not TTY and no approveAll', async () => {
      const origIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      process.stderr.write = (() => true) as any;

      try {
        connector = createConnector({ approvalOptions: {} });
        await expect(connector.handlers.signData({
          data: 'deadbeef',
          options: { encoding: 'hex', keyType: 'unshielded' },
        }, ctx())).rejects.toThrow('User rejected the request');
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
      }
    });

    it('rejects with Rejected error code', async () => {
      const origIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      process.stderr.write = (() => true) as any;

      try {
        connector = createConnector({ approvalOptions: {} });
        try {
          await connector.handlers.submitTransaction({ tx: 'aabb' }, ctx());
          expect.unreachable('should have thrown');
        } catch (err: any) {
          expect(err.code).toBe('Rejected');
          expect(err.type).toBe('DAppConnectorAPIError');
        }
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
      }
    });
  });

  // ── signData ──

  describe('signData', () => {
    it('handles hex encoding', async () => {
      const bundle = createBundleStub();
      connector = createDAppConnector({
        bundle,
        networkConfig: TEST_NETWORK_CONFIG,
        approvalOptions: { approveAll: true },
      });

      const result = await connector.handlers.signData({
        data: 'cafebabe',
        options: { encoding: 'hex', keyType: 'unshielded' },
      }, ctx()) as any;

      expect(result.data).toBe('cafebabe');
      expect((bundle.keystore as any).signData).toHaveBeenCalledWith(
        new Uint8Array([0xca, 0xfe, 0xba, 0xbe])
      );
    });

    it('handles base64 encoding', async () => {
      const bundle = createBundleStub();
      connector = createDAppConnector({
        bundle,
        networkConfig: TEST_NETWORK_CONFIG,
        approvalOptions: { approveAll: true },
      });

      const b64Data = Buffer.from('hello world').toString('base64');
      const result = await connector.handlers.signData({
        data: b64Data,
        options: { encoding: 'base64' },
      }, ctx()) as any;

      expect(result.data).toBe(b64Data);
      expect((bundle.keystore as any).signData).toHaveBeenCalledWith(
        new Uint8Array(Buffer.from('hello world'))
      );
    });

    it('handles text encoding', async () => {
      const bundle = createBundleStub();
      connector = createDAppConnector({
        bundle,
        networkConfig: TEST_NETWORK_CONFIG,
        approvalOptions: { approveAll: true },
      });

      const result = await connector.handlers.signData({
        data: 'sign me',
        options: { encoding: 'text' },
      }, ctx()) as any;

      expect(result.data).toBe('sign me');
      expect((bundle.keystore as any).signData).toHaveBeenCalledWith(
        new Uint8Array(Buffer.from('sign me', 'utf-8'))
      );
    });

    it('throws for unknown encoding', async () => {
      connector = createConnector();
      await expect(connector.handlers.signData({
        data: 'test',
        options: { encoding: 'binary' },
      }, ctx())).rejects.toThrow('Unknown encoding: binary');
    });

    it('throws for unsupported keyType', async () => {
      connector = createConnector();
      await expect(connector.handlers.signData({
        data: 'test',
        options: { encoding: 'text', keyType: 'shielded' },
      }, ctx())).rejects.toThrow('Unsupported keyType');
    });

    it('throws when data is missing', async () => {
      connector = createConnector();
      await expect(connector.handlers.signData({
        options: { encoding: 'hex' },
      }, ctx())).rejects.toThrow('data and options.encoding are required');
    });

    it('throws when encoding is missing', async () => {
      connector = createConnector();
      await expect(connector.handlers.signData({
        data: 'test',
        options: {},
      }, ctx())).rejects.toThrow('data and options.encoding are required');
    });

    it('returns signature and verifyingKey as strings', async () => {
      connector = createConnector();
      const result = await connector.handlers.signData({
        data: 'aabb',
        options: { encoding: 'hex' },
      }, ctx()) as any;
      expect(typeof result.signature).toBe('string');
      expect(typeof result.verifyingKey).toBe('string');
    });
  });

  // ── Input validation on write methods ──

  describe('input validation', () => {
    it('makeTransfer throws when desiredOutputs is missing', async () => {
      connector = createConnector();
      await expect(connector.handlers.makeTransfer({}, ctx()))
        .rejects.toThrow('desiredOutputs must be a non-empty array');
    });

    it('makeTransfer throws when desiredOutputs is empty', async () => {
      connector = createConnector();
      await expect(connector.handlers.makeTransfer({ desiredOutputs: [] }, ctx()))
        .rejects.toThrow('desiredOutputs must be a non-empty array');
    });

    it('makeTransfer throws for invalid output kind', async () => {
      connector = createConnector();
      await expect(connector.handlers.makeTransfer({
        desiredOutputs: [{ kind: 'public', type: '0000', value: '100', recipient: 'addr' }],
      }, ctx())).rejects.toThrow('Invalid output kind: "public"');
    });

    it('submitTransaction throws when tx is missing', async () => {
      connector = createConnector();
      await expect(connector.handlers.submitTransaction({}, ctx()))
        .rejects.toThrow('tx is required');
    });

    it('balanceUnsealedTransaction throws when tx is missing', async () => {
      connector = createConnector();
      await expect(connector.handlers.balanceUnsealedTransaction({}, ctx()))
        .rejects.toThrow('tx is required');
    });

    it('balanceSealedTransaction throws when tx is missing', async () => {
      connector = createConnector();
      await expect(connector.handlers.balanceSealedTransaction({}, ctx()))
        .rejects.toThrow('tx is required');
    });

    it('makeIntent throws when options is missing', async () => {
      connector = createConnector();
      await expect(connector.handlers.makeIntent({
        desiredInputs: [],
        desiredOutputs: [],
      }, ctx())).rejects.toThrow('options is required for makeIntent');
    });
  });

  // ── Address methods ──

  describe('getUnshieldedAddress', () => {
    it('returns bech32m-encoded unshielded address', async () => {
      connector = createConnector();
      const result = await connector.handlers.getUnshieldedAddress({}, ctx()) as any;
      expect(result).toHaveProperty('unshieldedAddress');
      expect(typeof result.unshieldedAddress).toBe('string');
    });
  });

  describe('getShieldedAddresses', () => {
    it('returns shielded address and public keys', async () => {
      connector = createConnector();
      const result = await connector.handlers.getShieldedAddresses({}, ctx()) as any;
      expect(result).toHaveProperty('shieldedAddress');
      expect(result.shieldedCoinPublicKey).toBe('coin-pub-key-hex');
      expect(result.shieldedEncryptionPublicKey).toBe('enc-pub-key-hex');
    });
  });

  describe('getDustAddress', () => {
    it('returns bech32m-encoded dust address', async () => {
      connector = createConnector();
      const result = await connector.handlers.getDustAddress({}, ctx()) as any;
      expect(result).toHaveProperty('dustAddress');
      expect(typeof result.dustAddress).toBe('string');
    });
  });

  // ── processRecipe (tested via write methods) ──

  describe('processRecipe', () => {
    it('rejects with timeout error when proof generation fails', async () => {
      // Tests the error path through processRecipe — finalizeRecipe rejection
      // propagates correctly through Promise.race and surfaces to the caller.
      connector = createConnector({
        approvalOptions: { approveAll: true },
        bundleOverrides: {
          finalizeRecipe: () => Promise.reject(new Error('ZK proof generation timed out')),
        },
      });

      await expect(connector.handlers.balanceUnsealedTransaction({ tx: 'aabb' }, ctx()))
        .rejects.toThrow('ZK proof generation timed out');
    });

    it('returns serialized tx when finalizeRecipe resolves', async () => {
      connector = createConnector({
        approvalOptions: { approveAll: true },
        bundleOverrides: {
          finalizeRecipe: () => Promise.resolve({ type: 'FINALIZED_TX' }),
        },
      });

      const result = await connector.handlers.balanceUnsealedTransaction({ tx: 'aabb' }, ctx()) as any;
      expect(result.tx).toBe('serialized_FINALIZED_TX');
    });

    it('propagates signRecipe errors', async () => {
      connector = createConnector({
        approvalOptions: { approveAll: true },
        bundleOverrides: {
          signRecipe: () => Promise.reject(new Error('signing failed')),
        },
      });

      await expect(connector.handlers.balanceUnsealedTransaction({ tx: 'aabb' }, ctx()))
        .rejects.toThrow('signing failed');
    });

    it('propagates finalizeRecipe errors', async () => {
      connector = createConnector({
        approvalOptions: { approveAll: true },
        bundleOverrides: {
          finalizeRecipe: () => Promise.reject(new Error('proof generation failed')),
        },
      });

      await expect(connector.handlers.balanceSealedTransaction({ tx: 'aabb' }, ctx()))
        .rejects.toThrow('proof generation failed');
    });
  });

  // ── getProvingProvider ──

  describe('getProvingProvider', () => {
    it('returns proof server URI', async () => {
      connector = createConnector();
      const result = await connector.handlers.getProvingProvider({}, ctx()) as any;
      expect(result.provingProvider).toBe('ready');
      expect(result.proverServerUri).toBe('http://localhost:6300');
    });
  });

  // ── hintUsage ──

  describe('hintUsage', () => {
    it('resolves without error', async () => {
      process.stderr.write = (() => true) as any;

      connector = createConnector();
      const result = await connector.handlers.hintUsage({
        methodNames: ['getUnshieldedBalances', 'makeTransfer'],
      }, ctx());
      expect(result).toBeUndefined();
    });
  });

  // ── Dust retry ──

  describe('withDustRetry', () => {
    it('retries on "No dust tokens" error and succeeds', async () => {
      vi.useFakeTimers();
      process.stderr.write = (() => true) as any;
      let callCount = 0;
      connector = createConnector({
        approvalOptions: { approveAll: true },
        bundleOverrides: {
          balanceUnboundTransaction: () => {
            callCount++;
            if (callCount === 1) return Promise.reject(new Error('No dust tokens found in the wallet state'));
            return Promise.resolve({ type: 'UNBOUND' });
          },
        },
      });

      const promise = connector.handlers.balanceUnsealedTransaction({ tx: 'aabb' }, ctx());
      await vi.advanceTimersByTimeAsync(3_100);
      const result = await promise as any;
      expect(result.tx).toBeDefined();
      expect(callCount).toBe(2);
      vi.useRealTimers();
    });

    it('does not retry on non-dust errors', async () => {
      process.stderr.write = (() => true) as any;
      connector = createConnector({
        approvalOptions: { approveAll: true },
        bundleOverrides: {
          balanceUnboundTransaction: () => Promise.reject(new Error('some other error')),
        },
      });

      await expect(connector.handlers.balanceUnsealedTransaction({ tx: 'aabb' }, ctx()))
        .rejects.toThrow('some other error');
    });

    it('fails after max retry attempts', { timeout: 20_000 }, async () => {
      process.stderr.write = (() => true) as any;
      let callCount = 0;
      connector = createConnector({
        approvalOptions: { approveAll: true },
        bundleOverrides: {
          balanceUnboundTransaction: () => {
            callCount++;
            return Promise.reject(new Error('No dust tokens found in the wallet state'));
          },
        },
      });

      await expect(connector.handlers.balanceUnsealedTransaction({ tx: 'aabb' }, ctx()))
        .rejects.toThrow('No dust tokens');
      expect(callCount).toBe(5); // DUST_RETRY_ATTEMPTS = 5
    });
  });

  // ── Hex-based pending tx tracking ──

  describe('pending tx tracking (hex-based)', () => {
    it('untrackPendingTx works via hex key (not object identity)', async () => {
      // balanceUnsealedTransaction tracks a tx, then submitTransaction untracks by hex.
      // If untracking fails, revertPendingTxs would call revertTransaction.
      const revertFn = vi.fn().mockResolvedValue(undefined);
      process.stderr.write = (() => true) as any;

      const bundle = createBundleStub({
        finalizeRecipe: () => Promise.resolve({ type: 'FINALIZED_TX' }),
        submitTransaction: () => Promise.resolve('hash-123'),
      });
      (bundle.facade as any).revertTransaction = revertFn;

      connector = createDAppConnector({
        bundle,
        networkConfig: TEST_NETWORK_CONFIG,
        approvalOptions: { approveAll: true },
      });

      const connId = 'conn_hex_test';

      // Balance a tx — this tracks it
      const balanceResult = await connector.handlers.balanceUnsealedTransaction(
        { tx: 'aabb' }, ctx(connId),
      ) as any;

      // Submit using the hex from balance result — this untracks by hex
      await connector.handlers.submitTransaction(
        { tx: balanceResult.tx }, ctx(connId),
      );

      // revertPendingTxs should have nothing to revert
      await connector.revertPendingTxs(connId);
      expect(revertFn).not.toHaveBeenCalled();
    });

    it('revertPendingTxs reverts tracked txs on disconnect', async () => {
      const revertFn = vi.fn().mockResolvedValue(undefined);
      process.stderr.write = (() => true) as any;

      const bundle = createBundleStub({
        finalizeRecipe: () => Promise.resolve({ type: 'TRACKED_TX' }),
      });
      (bundle.facade as any).revertTransaction = revertFn;

      connector = createDAppConnector({
        bundle,
        networkConfig: TEST_NETWORK_CONFIG,
        approvalOptions: { approveAll: true },
      });

      const connId = 'conn_revert_test';
      await connector.handlers.balanceUnsealedTransaction({ tx: 'aabb' }, ctx(connId));

      // Simulate disconnect — should revert
      await connector.revertPendingTxs(connId);
      expect(revertFn).toHaveBeenCalledTimes(1);
    });

    it('submitTransaction rejection reverts and untracks', async () => {
      const revertFn = vi.fn().mockResolvedValue(undefined);
      const origIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      process.stderr.write = (() => true) as any;

      const bundle = createBundleStub({
        finalizeRecipe: () => Promise.resolve({ type: 'REJECTED_TX' }),
      });
      (bundle.facade as any).revertTransaction = revertFn;

      connector = createDAppConnector({
        bundle,
        networkConfig: TEST_NETWORK_CONFIG,
        approvalOptions: {}, // No approveAll → rejection via non-TTY
      });

      const connId = 'conn_reject_test';

      // Balance first (with auto-approve to get past approval)
      const balanceConnector = createDAppConnector({
        bundle,
        networkConfig: TEST_NETWORK_CONFIG,
        approvalOptions: { approveAll: true },
      });
      const balanceResult = await balanceConnector.handlers.balanceUnsealedTransaction(
        { tx: 'aabb' }, ctx(connId),
      ) as any;

      // Submit on the non-approveAll connector → rejection
      try {
        await connector.handlers.submitTransaction({ tx: balanceResult.tx }, ctx(connId));
      } catch (err: any) {
        expect(err.code).toBe('Rejected');
      }

      // revertTransaction should have been called during rejection
      expect(revertFn).toHaveBeenCalled();

      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    });
  });

  // ── Abandon timer ──

  describe('abandon timer', () => {
    it('auto-reverts after timeout', async () => {
      vi.useFakeTimers();
      const revertFn = vi.fn().mockResolvedValue(undefined);
      process.stderr.write = (() => true) as any;

      const bundle = createBundleStub({
        finalizeRecipe: () => Promise.resolve({ type: 'ABANDON_TX' }),
      });
      (bundle.facade as any).revertTransaction = revertFn;

      connector = createDAppConnector({
        bundle,
        networkConfig: TEST_NETWORK_CONFIG,
        approvalOptions: { approveAll: true },
      });

      const connId = 'conn_abandon';
      await connector.handlers.balanceUnsealedTransaction({ tx: 'aabb' }, ctx(connId));

      // Advance past ABANDONED_TX_TIMEOUT_MS (120_000ms)
      await vi.advanceTimersByTimeAsync(121_000);

      expect(revertFn).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it('dispose clears abandon timers', async () => {
      vi.useFakeTimers();
      const revertFn = vi.fn().mockResolvedValue(undefined);
      process.stderr.write = (() => true) as any;

      const bundle = createBundleStub({
        finalizeRecipe: () => Promise.resolve({ type: 'DISPOSE_TX' }),
      });
      (bundle.facade as any).revertTransaction = revertFn;

      connector = createDAppConnector({
        bundle,
        networkConfig: TEST_NETWORK_CONFIG,
        approvalOptions: { approveAll: true },
      });

      await connector.handlers.balanceUnsealedTransaction({ tx: 'aabb' }, ctx('conn_dispose'));

      // Dispose before timeout fires
      connector.dispose();
      connector = undefined;

      await vi.advanceTimersByTimeAsync(121_000);
      expect(revertFn).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });
});
