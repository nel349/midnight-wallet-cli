// Tests for dapp-connector.ts — createDAppConnector handler map
// Stubs the FacadeBundle at the SDK boundary (per CLAUDE.md: no mocks of our own code).
// SDK address encoding is stubbed at the boundary; transactions reach the code
// as opaque handles the stub facade adopts, and leave as their real hex.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as rx from 'rxjs';

// Stub SDK address encoding — MidnightBech32m.encode returns a mock
vi.mock('@midnightntwrk/wallet-sdk/address-format', () => ({
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

import { createDAppConnector, signatureScheme, type DAppConnector } from '../lib/dapp-connector.ts';
import type { FacadeBundle } from '../lib/facade.ts';
import type { NetworkConfig } from '../lib/network.ts';
import type { RpcHandlerContext } from '../lib/ws-rpc.ts';
import type { ApprovalOptions } from '../lib/approval.ts';
import {
  AGENT_SK, NIGHT, WALLET_SK, WALLET_VK, agentPaysMerchant, buildTx, pay, sealedBytes, spend, unsealedBytes,
} from './helpers/ledger-tx.ts';

/** A finalized transaction handle as the SDK returns it: it serializes to these bytes. */
const finalizedTx = (...bytes: number[]) => ({ serialize: () => new Uint8Array(bytes) });

/** Mock handler context with no-op notify */
const ctx = (connectionId = 'conn_test'): RpcHandlerContext => ({ notify: vi.fn(), connectionId, requestId: 1, metadata: {} });

// ── Helpers ──────────────────────────────────────────────────────────

const TEST_NETWORK_CONFIG: NetworkConfig = {
  indexer: 'http://localhost:8088/api/v4/graphql',
  indexerWS: 'ws://localhost:8088/api/v4/graphql/ws',
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
      availableCoins: [],
      address: { data: 0n },
    },
  };
}

/** Wallet history as the SDK records it: one finalized, one rejected, one pending. */
const HISTORY = [
  { hash: 'tx-hash-001', identifiers: [], lifecycle: { status: 'finalized', finalizedBlock: { hash: 'b1', height: 1, timestamp: new Date(0) } } },
  { hash: 'tx-hash-002', identifiers: [], lifecycle: { status: 'rejected', rejectedAt: new Date(0) } },
  { hash: 'tx-hash-003', identifiers: [], lifecycle: { status: 'pending', submittedAt: new Date(0) } },
];

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
  getAllFromTxHistory?: () => Promise<any[]>;
}): FacadeBundle {
  const defaultStateFn = () => rx.of(mockState());

  return {
    facade: {
      state: overrides?.stateFn ?? defaultStateFn,
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      transferTransaction: overrides?.transferTransaction ?? vi.fn().mockResolvedValue({ type: 'UNPROVEN_TRANSACTION' }),
      signRecipe: overrides?.signRecipe ?? vi.fn().mockResolvedValue({ type: 'SIGNED' }),
      finalizeRecipe: overrides?.finalizeRecipe ?? vi.fn().mockResolvedValue(finalizedTx(0xab, 0xcd)),
      submitTransaction: overrides?.submitTransaction ?? vi.fn().mockResolvedValue('mock-tx-hash'),
      balanceUnboundTransaction: overrides?.balanceUnboundTransaction ?? vi.fn().mockResolvedValue({ type: 'UNBOUND' }),
      balanceFinalizedTransaction: overrides?.balanceFinalizedTransaction ?? vi.fn().mockResolvedValue({ type: 'FINALIZED' }),
      initSwap: overrides?.initSwap ?? vi.fn().mockResolvedValue({ type: 'SWAP' }),
      registerNightUtxosForDustGeneration: vi.fn(),
      adoptTransaction: vi.fn((bytes: Uint8Array, stage: string) => ({ stage, hex: Buffer.from(bytes).toString('hex') })),
      getAllFromTxHistory: overrides?.getAllFromTxHistory ?? vi.fn().mockResolvedValue(HISTORY),
    },
    keystore: {
      signDataAsync: vi.fn().mockResolvedValue({ tag: 'schnorr', value: 'abcd1234signature' }),
      getPublicKey: vi.fn().mockReturnValue({ tag: 'schnorr', value: '5678efghpubkey' }),
    },
  } as unknown as FacadeBundle;
}

function createConnector(overrides?: {
  bundleOverrides?: Parameters<typeof createBundleStub>[0];
  networkConfig?: NetworkConfig;
  approvalOptions?: ApprovalOptions;
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
      expect(result).toEqual([
        { txHash: 'tx-hash-001', txStatus: { status: 'finalized', executionStatus: {} } },
        { txHash: 'tx-hash-002', txStatus: { status: 'discarded' } },
        { txHash: 'tx-hash-003', txStatus: { status: 'pending' } },
      ]);
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

    it('returns an empty page past the end of the history', async () => {
      connector = createConnector();
      const result = await connector.handlers.getTxHistory({ pageNumber: 5, pageSize: 1 }, ctx());
      expect(result).toEqual([]);
    });

    it('defaults to pageNumber 0 and pageSize 20', async () => {
      const many = Array.from({ length: 25 }, (_, i) => ({ ...HISTORY[2], hash: `h${i}` }));
      connector = createConnector({ bundleOverrides: { getAllFromTxHistory: () => Promise.resolve(many) } });
      const result = await connector.handlers.getTxHistory({}, ctx()) as any[];
      expect(result.map((e) => e.txHash)).toEqual(many.slice(0, 20).map((e) => e.hash));
    });
  });

  describe('getConfiguration', () => {
    it('maps NetworkConfig fields to Configuration shape', async () => {
      connector = createConnector();
      const result = await connector.handlers.getConfiguration({}, ctx()) as any;
      expect(result).toEqual({
        indexerUri: 'http://localhost:8088/api/v4/graphql',
        indexerWsUri: 'ws://localhost:8088/api/v4/graphql/ws',
        proverServerUri: 'http://localhost:6300',
        substrateNodeUri: 'ws://localhost:9944',
        networkId: 'Undeployed',
      });
    });
  });

  describe('getConnectionStatus', () => {
    it('returns connected status with the lowercase abstractions networkId', async () => {
      // Bech32m HRPs are lowercase and addresses are encoded with the lowercase
      // abstractions form ('undeployed'). getConnectionStatus must report the
      // same lowercase form so dApps that round-trip the value back into
      // setNetworkId() before decoding addresses don't see a case-mismatch.
      connector = createConnector();
      const result = await connector.handlers.getConnectionStatus({}, ctx());
      expect(result).toEqual({ status: 'connected', networkId: 'undeployed' });
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
      expect((bundle.keystore as any).signDataAsync).toHaveBeenCalledWith(
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
      expect((bundle.keystore as any).signDataAsync).toHaveBeenCalledWith(
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
      expect((bundle.keystore as any).signDataAsync).toHaveBeenCalledWith(
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

    it('returns the hex values and the scheme, not the SDK\'s { tag, value } objects', async () => {
      connector = createConnector();
      const result = await connector.handlers.signData({
        data: 'aabb',
        options: { encoding: 'hex' },
      }, ctx()) as any;
      expect(result).toEqual({
        data: 'aabb',
        signature: 'abcd1234signature',
        verifyingKey: '5678efghpubkey',
        scheme: 'schnorr_bip340',
      });
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

  // ── Reading the dApp's transaction (the fee-wallet seam) ──

  describe('transaction adoption', () => {
    it.each([
      ['balanceUnsealedTransaction', 'Unbound', 'balanceUnboundTransaction'],
      ['balanceSealedTransaction', 'Finalized', 'balanceFinalizedTransaction'],
    ] as const)('%s reads the hex at stage %s and balances that handle', async (method, stage, sdkMethod) => {
      const balance = vi.fn().mockResolvedValue({ type: 'RECIPE' });
      const bundle = createBundleStub({ [sdkMethod]: balance });
      connector = createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { approveAll: true } });

      await connector.handlers[method]({ tx: 'c0ffee' }, ctx());

      expect(bundle.facade.adoptTransaction).toHaveBeenCalledWith(new Uint8Array([0xc0, 0xff, 0xee]), stage);
      expect(balance).toHaveBeenCalledWith({ stage, hex: 'c0ffee' }, expect.objectContaining({ ttl: expect.any(Date) }));
    });

    it('submitTransaction reads the hex as a finalized transaction and submits that handle', async () => {
      const submit = vi.fn().mockResolvedValue('tx-id');
      const bundle = createBundleStub({ submitTransaction: submit });
      connector = createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { approveAll: true } });

      const result = await connector.handlers.submitTransaction({ tx: 'beef' }, ctx());

      expect(bundle.facade.adoptTransaction).toHaveBeenCalledWith(new Uint8Array([0xbe, 0xef]), 'Finalized');
      expect(submit).toHaveBeenCalledWith({ stage: 'Finalized', hex: 'beef' });
      expect(result).toEqual({ txHash: 'tx-id' });
    });

    it('reports bytes the wallet cannot read as InvalidRequest, naming the stage, without balancing', async () => {
      const balance = vi.fn();
      const bundle = createBundleStub({ balanceUnboundTransaction: balance });
      (bundle.facade as any).adoptTransaction = () => { throw new Error('unknown tag midnight:transaction[v99]'); };
      connector = createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { approveAll: true } });

      const err: any = await connector.handlers.balanceUnsealedTransaction({ tx: 'aabb' }, ctx()).catch((e: any) => e);

      expect(err.code).toBe('InvalidRequest');
      expect(err.message).toContain('stage Unbound');
      expect(err.message).toContain('unknown tag midnight:transaction[v99]');
      expect(balance).not.toHaveBeenCalled();
    });

    it('rejects non-hex input before it reaches the SDK', async () => {
      const bundle = createBundleStub();
      connector = createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { approveAll: true } });

      const err: any = await connector.handlers.balanceUnsealedTransaction({ tx: 'not-hex' }, ctx()).catch((e: any) => e);

      expect(err.code).toBe('InvalidRequest');
      expect(bundle.facade.adoptTransaction).not.toHaveBeenCalled();
    });
  });

  describe('signatureScheme', () => {
    it('names BIP-340 Schnorr, and refuses any other tag rather than mislabel it', () => {
      expect(signatureScheme('schnorr')).toBe('schnorr_bip340');
      expect(() => signatureScheme('ecdsa')).toThrow('mn signs with BIP-340 Schnorr only');
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
          finalizeRecipe: () => Promise.resolve(finalizedTx(0xfe, 0xed)),
        },
      });

      const result = await connector.handlers.balanceUnsealedTransaction({ tx: 'aabb' }, ctx()) as any;
      expect(result.tx).toBe('feed');
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

    it('retries on wallet-sdk 2.0\'s tagged dust shortage', async () => {
      vi.useFakeTimers();
      process.stderr.write = (() => true) as any;
      const dustShortage = Object.assign(new Error('Insufficient Funds: could not balance dust'), {
        _tag: 'Wallet.InsufficientFunds', tokenType: 'dust',
      });
      let callCount = 0;
      connector = createConnector({
        approvalOptions: { approveAll: true },
        bundleOverrides: {
          balanceUnboundTransaction: () => (++callCount === 1 ? Promise.reject(dustShortage) : Promise.resolve({ type: 'UNBOUND' })),
        },
      });

      const promise = connector.handlers.balanceUnsealedTransaction({ tx: 'aabb' }, ctx());
      await vi.advanceTimersByTimeAsync(3_100);
      await promise;
      expect(callCount).toBe(2);
      vi.useRealTimers();
    });

    it('does not wait for dust when the wallet is short of NIGHT, which dust cannot fix', async () => {
      process.stderr.write = (() => true) as any;
      const nightShortage = Object.assign(new Error('Insufficient Funds: could not balance 00'), {
        _tag: 'Wallet.InsufficientFunds', tokenType: '00',
      });
      const balance = vi.fn().mockRejectedValue(nightShortage);
      connector = createConnector({ approvalOptions: { approveAll: true }, bundleOverrides: { balanceUnboundTransaction: balance } });

      await expect(connector.handlers.balanceUnsealedTransaction({ tx: 'aabb' }, ctx())).rejects.toBe(nightShortage);
      expect(balance).toHaveBeenCalledTimes(1);
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
      expect(callCount).toBe(10); // DUST_RETRY_ATTEMPTS = 10
    });
  });

  // ── Hex-based pending tx tracking ──

  // ── What the wallet balances, per mode ──

  describe('token kinds to balance', () => {
    it.each([
      ['balanceUnsealedTransaction', 'balanceUnboundTransaction'],
      ['balanceSealedTransaction', 'balanceFinalizedTransaction'],
    ] as const)('%s balances every kind by default, and leaves the fee out when payFees is false', async (method, sdkMethod) => {
      const balance = vi.fn().mockResolvedValue({ type: 'RECIPE' });
      connector = createConnector({ bundleOverrides: { [sdkMethod]: balance } });

      await connector.handlers[method]({ tx: 'aabb' }, ctx());
      await connector.handlers[method]({ tx: 'aabb', options: { payFees: true } }, ctx());
      await connector.handlers[method]({ tx: 'aabb', options: { payFees: false } }, ctx());

      expect(balance.mock.calls.map(([, opts]) => opts)).toEqual([
        { ttl: expect.any(Date), tokenKindsToBalance: 'all' },
        { ttl: expect.any(Date), tokenKindsToBalance: 'all' },
        { ttl: expect.any(Date), tokenKindsToBalance: ['shielded', 'unshielded'] },
      ]);
    });
  });

  // ── Fee wallet: --approve-fees ──

  describe('fee wallet (approveFees)', () => {
    let origIsTTY: boolean | undefined;
    const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

    beforeEach(() => {
      origIsTTY = process.stdin.isTTY;
      // An agent has no terminal: anything that is not fee-only must be rejected, not prompted.
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      process.stderr.write = (() => true) as any;
    });

    afterEach(() => {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    });

    /** A connector in fee-wallet mode over a bundle whose unshielded key is WALLET_VK. */
    function feeWallet(
      overrides?: Parameters<typeof createBundleStub>[0],
      approvalOptions: ApprovalOptions = { approveFees: true, autoApproveReads: true },
    ) {
      const bundle = createBundleStub(overrides);
      (bundle.keystore as any).getPublicKey = () => WALLET_VK;
      const feeConnector = createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions });
      connector = feeConnector;
      return { bundle, connector: feeConnector };
    }

    it.each([
      ['balanceUnsealedTransaction', 'balanceUnboundTransaction', unsealedBytes],
      ['balanceSealedTransaction', 'balanceFinalizedTransaction', sealedBytes],
    ] as const)('%s balances Dust-only and is approved without a terminal', async (method, sdkMethod, toBytes) => {
      const balance = vi.fn().mockResolvedValue({ type: 'RECIPE' });
      const { connector } = feeWallet({ [sdkMethod]: balance });

      const result = await connector.handlers[method]({ tx: hex(await toBytes(agentPaysMerchant())) }, ctx()) as any;

      expect(balance).toHaveBeenCalledTimes(1);
      expect(balance.mock.calls[0]![1]).toEqual({ ttl: expect.any(Date), tokenKindsToBalance: ['dust'] });
      expect(result).toEqual({ tx: 'abcd' });
    });

    it('approves a fee-only balance as fee-only, not as a prep step, so it holds with --no-auto-approve-reads', async () => {
      const balance = vi.fn().mockResolvedValue({ type: 'RECIPE' });
      const { connector } = feeWallet({ balanceUnboundTransaction: balance }, { approveFees: true, autoApproveReads: false });

      const result = await connector.handlers.balanceUnsealedTransaction({ tx: hex(await unsealedBytes(agentPaysMerchant())) }, ctx()) as any;

      expect(balance).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ tx: 'abcd' });
    });

    it('submits a transaction it balanced fee-only on the same connection, without a terminal', async () => {
      const submit = vi.fn().mockResolvedValue('tx-id');
      const { connector } = feeWallet({ submitTransaction: submit });

      const balanced = await connector.handlers.balanceUnsealedTransaction({ tx: hex(await unsealedBytes(agentPaysMerchant())) }, ctx('agent')) as any;
      const result = await connector.handlers.submitTransaction({ tx: balanced.tx }, ctx('agent'));

      expect(submit).toHaveBeenCalledWith({ stage: 'Finalized', hex: 'abcd' });
      expect(result).toEqual({ txHash: 'tx-id' });
    });

    it('rejects submitting a transaction this server did not balance', async () => {
      const submit = vi.fn();
      const { connector } = feeWallet({ submitTransaction: submit });

      const err: any = await connector.handlers.submitTransaction({ tx: hex(await sealedBytes(agentPaysMerchant())) }, ctx('agent')).catch((e: any) => e);

      expect(err.code).toBe('Rejected');
      expect(submit).not.toHaveBeenCalled();
    });

    it('rejects submitting a fee-only transaction from another connection', async () => {
      const submit = vi.fn();
      const { connector } = feeWallet({ submitTransaction: submit });

      const balanced = await connector.handlers.balanceUnsealedTransaction({ tx: hex(await unsealedBytes(agentPaysMerchant())) }, ctx('agent')) as any;
      const err: any = await connector.handlers.submitTransaction({ tx: balanced.tx }, ctx('someone-else')).catch((e: any) => e);

      expect(err.code).toBe('Rejected');
      expect(submit).not.toHaveBeenCalled();
    });

    it('rejects submitting a transaction this server balanced, but not fee-only', async () => {
      const submit = vi.fn();
      const opts: ApprovalOptions = { approveAll: true };
      const { connector } = feeWallet({ submitTransaction: submit }, opts);

      const balanced = await connector.handlers.balanceUnsealedTransaction({ tx: 'aabb' }, ctx('agent')) as any;
      delete opts.approveAll;
      opts.approveFees = true;
      const err: any = await connector.handlers.submitTransaction({ tx: balanced.tx }, ctx('agent')).catch((e: any) => e);

      expect(err.code).toBe('Rejected');
      expect(submit).not.toHaveBeenCalled();
    });

    it.each([
      ['spends the wallet\'s own Night',
        () => buildTx({ guaranteed: { inputs: [spend(WALLET_SK, 100n)], outputs: [pay(100n)], signers: [WALLET_SK] } }),
        "intent 1 guaranteed unshielded input 0 spends this wallet's own funds"],
      ['leaves an input for the wallet to sign',
        () => buildTx({ guaranteed: { inputs: [spend(AGENT_SK, 100n)], outputs: [pay(100n)], signers: [] } }),
        'intent 1 guaranteed unshielded input 0 is unsigned, so this wallet would sign it'],
      ['leaves an output for the wallet to fund',
        () => buildTx({ guaranteed: { inputs: [], outputs: [pay(100n)], signers: [] } }),
        `segment 0 is short 100 of unshielded token ${NIGHT}, which a Dust-only balance can't fund`],
    ])('refuses, with the reason, a transaction that %s, before balancing anything', async (_label, build, reason) => {
      const balance = vi.fn();
      const { bundle, connector } = feeWallet({ balanceUnboundTransaction: balance });

      const err: any = await connector.handlers.balanceUnsealedTransaction({ tx: hex(await unsealedBytes(build())) }, ctx()).catch((e: any) => e);

      expect(err.code).toBe('Rejected');
      expect(err.message).toContain('--approve-fees');
      expect(err.message).toContain(reason);
      expect(balance).not.toHaveBeenCalled();
      expect(bundle.facade.adoptTransaction).not.toHaveBeenCalled();
    });

    it('refuses payFees: false, which leaves a fee wallet nothing to do', async () => {
      const balance = vi.fn();
      const { connector } = feeWallet({ balanceUnboundTransaction: balance });

      const err: any = await connector.handlers.balanceUnsealedTransaction(
        { tx: hex(await unsealedBytes(agentPaysMerchant())), options: { payFees: false } }, ctx(),
      ).catch((e: any) => e);

      expect(err.code).toBe('InvalidRequest');
      expect(err.message).toContain('payFees');
      expect(balance).not.toHaveBeenCalled();
    });

    it('refuses bytes it cannot read as a ledger-9 transaction of that stage', async () => {
      const balance = vi.fn();
      const { connector } = feeWallet({ balanceFinalizedTransaction: balance });

      const err: any = await connector.handlers.balanceSealedTransaction({ tx: hex(await unsealedBytes(agentPaysMerchant())) }, ctx()).catch((e: any) => e);

      expect(err.code).toBe('InvalidRequest');
      expect(err.message).toContain('sealed');
      expect(balance).not.toHaveBeenCalled();
    });

    it('still needs a prompt for anything else, so an agent\'s makeTransfer is rejected', async () => {
      const transfer = vi.fn();
      const { connector } = feeWallet({ transferTransaction: transfer });

      const err: any = await connector.handlers.makeTransfer({
        desiredOutputs: [{ kind: 'unshielded', type: NIGHT, value: '1', recipient: 'mn_addr_undeployed1xyz' }],
      }, ctx()).catch((e: any) => e);

      expect(err.code).toBe('Rejected');
      expect(transfer).not.toHaveBeenCalled();
    });
  });

  describe('pending tx tracking (hex-based)', () => {
    it('untrackPendingTx works via hex key (not object identity)', async () => {
      // balanceUnsealedTransaction tracks a tx, then submitTransaction untracks by hex.
      // If untracking fails, revertPendingTxs would call revertTransaction.
      const revertFn = vi.fn().mockResolvedValue(undefined);
      process.stderr.write = (() => true) as any;

      const bundle = createBundleStub({
        finalizeRecipe: () => Promise.resolve(finalizedTx(0x01)),
        submitTransaction: () => Promise.resolve('hash-123'),
      });
      (bundle.facade as any).revert = revertFn;

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

      const finalized = finalizedTx(0x02);
      const bundle = createBundleStub({
        finalizeRecipe: () => Promise.resolve(finalized),
      });
      (bundle.facade as any).revert = revertFn;

      connector = createDAppConnector({
        bundle,
        networkConfig: TEST_NETWORK_CONFIG,
        approvalOptions: { approveAll: true },
      });

      const connId = 'conn_revert_test';
      await connector.handlers.balanceUnsealedTransaction({ tx: 'aabb' }, ctx(connId));

      // Disconnect reverts the FINALIZED transaction: that releases its coins in
      // all three wallets and clears its pending entry (the recipe would not).
      await connector.revertPendingTxs(connId);
      expect(revertFn).toHaveBeenCalledTimes(1);
      expect(revertFn).toHaveBeenCalledWith(finalized);
    });

    it('submitTransaction rejection reverts and untracks', async () => {
      const revertFn = vi.fn().mockResolvedValue(undefined);
      const origIsTTY = process.stdin.isTTY;
      process.stderr.write = (() => true) as any;

      const finalized = finalizedTx(0x03);
      const bundle = createBundleStub({
        finalizeRecipe: () => Promise.resolve(finalized),
      });
      (bundle.facade as any).revert = revertFn;

      // Use a single connector — approvalOptions is a mutable object reference.
      // Balance with approveAll, then remove it so submit rejects via non-TTY.
      const opts: Record<string, any> = { approveAll: true };
      connector = createDAppConnector({
        bundle,
        networkConfig: TEST_NETWORK_CONFIG,
        approvalOptions: opts,
      });

      const connId = 'conn_reject_test';

      // Balance first (auto-approved via approveAll) — tracks the tx internally
      const balanceResult = await connector.handlers.balanceUnsealedTransaction(
        { tx: 'aabb' }, ctx(connId),
      ) as any;

      // Switch: remove approveAll + non-TTY → submit will be rejected
      delete opts.approveAll;
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

      // Submit on the SAME connector → rejection → reverts the finalized tx
      await expect(connector.handlers.submitTransaction({ tx: balanceResult.tx }, ctx(connId)))
        .rejects.toMatchObject({ code: 'Rejected' });

      expect(revertFn).toHaveBeenCalledWith(finalized);
      // Untracked: a later disconnect has nothing left to revert.
      revertFn.mockClear();
      await connector.revertPendingTxs(connId);
      expect(revertFn).not.toHaveBeenCalled();

      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    });
  });

  describe('failed proving', () => {
    it('reverts the recipe so its coins are not held until the TTL', async () => {
      const recipe = { type: 'RECIPE' };
      const revertFn = vi.fn().mockResolvedValue(undefined);
      const bundle = createBundleStub({
        balanceUnboundTransaction: () => Promise.resolve(recipe),
        finalizeRecipe: () => Promise.reject(new Error('proof server unreachable')),
      });
      (bundle.facade as any).revert = revertFn;
      connector = createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { approveAll: true } });

      await expect(connector.handlers.balanceUnsealedTransaction({ tx: 'aabb' }, ctx())).rejects.toThrow('proof server unreachable');
      expect(revertFn).toHaveBeenCalledWith(recipe);
    });
  });

  // ── Abandon timer ──

  describe('abandon timer', () => {
    it('auto-reverts after timeout', async () => {
      vi.useFakeTimers();
      const revertFn = vi.fn().mockResolvedValue(undefined);
      process.stderr.write = (() => true) as any;

      const bundle = createBundleStub({
        finalizeRecipe: () => Promise.resolve(finalizedTx(0x04)),
      });
      (bundle.facade as any).revert = revertFn;

      connector = createDAppConnector({
        bundle,
        networkConfig: TEST_NETWORK_CONFIG,
        approvalOptions: { approveAll: true },
      });

      const connId = 'conn_abandon';
      await connector.handlers.balanceUnsealedTransaction({ tx: 'aabb' }, ctx(connId));

      // Advance past ABANDONED_TX_TIMEOUT_MS (120_000ms)
      await vi.advanceTimersByTimeAsync(121_000);

      // Timer fires and reverts the abandoned tx
      expect(revertFn).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it('dispose clears abandon timers', async () => {
      vi.useFakeTimers();
      const revertFn = vi.fn().mockResolvedValue(undefined);
      process.stderr.write = (() => true) as any;

      const bundle = createBundleStub({
        finalizeRecipe: () => Promise.resolve(finalizedTx(0x05)),
      });
      (bundle.facade as any).revert = revertFn;

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
