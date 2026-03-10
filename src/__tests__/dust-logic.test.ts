// Tests for dust logic in transfer.ts — isDustRelatedError, ensureDust, registerNightUtxos
// Stubs the SDK facade at the interface boundary (per CLAUDE.md: no mocks of our own code).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as rx from 'rxjs';

import { isDustRelatedError, ensureDust, registerNightUtxos } from '../lib/transfer.ts';
import type { FacadeBundle } from '../lib/facade.ts';

// ── Helpers ──────────────────────────────────────────────────────────

/** Create a mock facade state object. */
function mockState(opts: {
  dustBalance?: bigint;
  unregisteredUtxos?: number;
  registeredUtxos?: number;
  /** Override availableCoins count. Defaults to: >0 when dustBalance > 0, empty otherwise. */
  availableDustCoins?: number;
}) {
  const unregistered = Array.from({ length: opts.unregisteredUtxos ?? 0 }, (_, i) => ({
    utxo: { value: BigInt(1000000 + i) },
    meta: { registeredForDustGeneration: false, ctime: Date.now() },
  }));
  const registered = Array.from({ length: opts.registeredUtxos ?? 0 }, (_, i) => ({
    utxo: { value: BigInt(2000000 + i) },
    meta: { registeredForDustGeneration: true, ctime: Date.now() },
  }));

  // Derive availableCoins: explicit override > dustBalance > empty
  const dustBal = opts.dustBalance ?? 0n;
  const coinCount = opts.availableDustCoins ?? (dustBal > 0n ? 1 : 0);
  const availableCoins = Array.from({ length: coinCount }, (_, i) => ({
    value: BigInt(100000 + i),
  }));

  return {
    isSynced: true,
    dust: {
      balance: () => dustBal,
      address: 'mock-dust-address',
      availableCoins,
    },
    unshielded: {
      availableCoins: [...unregistered, ...registered],
      balances: {},
      progress: { appliedId: 1n, highestTransactionId: 1n },
    },
  };
}

/**
 * Create a minimal FacadeBundle stub.
 * `stateFn` controls what `facade.state()` returns — defaults to a BehaviorSubject
 * with a single state emission.
 */
function createBundleStub(overrides?: {
  stateFn?: () => rx.Observable<any>;
  waitForSyncedStateFn?: () => Promise<any>;
  dustWaitForSyncedState?: () => Promise<void>;
  dustCreateTx?: () => Promise<any>;
  dustAddSignature?: () => Promise<any>;
  finalizeTransaction?: () => Promise<any>;
  submitTransaction?: () => Promise<string>;
}): FacadeBundle {
  const defaultStateFn = () => rx.of(mockState({ dustBalance: 0n }));
  // waitForSyncedState returns a FacadeState directly (calls each wallet's waitForSyncedState)
  const defaultWaitForSyncedState = async () => {
    const obs = overrides?.stateFn ?? defaultStateFn;
    return rx.firstValueFrom(obs().pipe(rx.filter((s: any) => s.isSynced)));
  };

  return {
    facade: {
      state: overrides?.stateFn ?? defaultStateFn,
      waitForSyncedState: overrides?.waitForSyncedStateFn ?? defaultWaitForSyncedState,
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      dust: {
        waitForSyncedState: overrides?.dustWaitForSyncedState ?? vi.fn().mockResolvedValue(undefined),
        createDustGenerationTransaction: overrides?.dustCreateTx ?? vi.fn().mockResolvedValue({
          intents: new Map([[1, { signatureData: () => new Uint8Array(32) }]]),
        }),
        addDustGenerationSignature: overrides?.dustAddSignature ?? vi.fn().mockResolvedValue({ signed: true }),
      },
      finalizeTransaction: overrides?.finalizeTransaction ?? vi.fn().mockResolvedValue({ finalized: true }),
      submitTransaction: overrides?.submitTransaction ?? vi.fn().mockResolvedValue('mock-tx-hash-001'),
    },
    keystore: {
      signData: vi.fn().mockReturnValue(new Uint8Array(64)),
      getPublicKey: vi.fn().mockReturnValue(new Uint8Array(32)),
    },
    zswapSecretKeys: {} as any,
    dustSecretKey: {} as any,
  } as unknown as FacadeBundle;
}

// ── isDustRelatedError ───────────────────────────────────────────────

describe('isDustRelatedError', () => {
  it('detects "not enough dust" message', () => {
    expect(isDustRelatedError(new Error('not enough dust to pay fees'))).toBe(true);
  });

  it('detects "dust generated" message', () => {
    expect(isDustRelatedError(new Error('dust generated capacity too low'))).toBe(true);
  });

  it('detects "Insufficient funds" message (case-insensitive)', () => {
    expect(isDustRelatedError(new Error('Insufficient funds'))).toBe(true);
    expect(isDustRelatedError(new Error('INSUFFICIENT FUNDS for transaction'))).toBe(true);
  });

  it('detects "No dust tokens" message', () => {
    expect(isDustRelatedError(new Error('No dust tokens found in the wallet state'))).toBe(true);
  });

  it('detects "Transaction submission error" via cause chain', () => {
    expect(isDustRelatedError(new Error('Transaction submission error'))).toBe(true);
  });

  it('detects error 138 in message', () => {
    expect(isDustRelatedError(new Error('Custom error: 138'))).toBe(true);
  });

  it('detects error 138 in cause chain', () => {
    const cause = new Error('Custom error: 138');
    const err = new Error('outer error', { cause });
    expect(isDustRelatedError(err)).toBe(true);
  });

  it('detects TransactionInvalidError _tag', () => {
    const err: any = new Error('something');
    err._tag = 'TransactionInvalidError';
    expect(isDustRelatedError(err)).toBe(true);
  });

  it('detects SubmissionError _tag', () => {
    const err: any = new Error('something');
    err._tag = 'SubmissionError';
    expect(isDustRelatedError(err)).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isDustRelatedError(new Error('network timeout'))).toBe(false);
    expect(isDustRelatedError(new Error('ECONNREFUSED'))).toBe(false);
    expect(isDustRelatedError(new Error('syntax error'))).toBe(false);
  });

  it('returns false for error with no message', () => {
    expect(isDustRelatedError({})).toBe(false);
    expect(isDustRelatedError(null)).toBe(false);
    expect(isDustRelatedError(undefined)).toBe(false);
  });
});

// ── ensureDust ───────────────────────────────────────────────────────

describe('ensureDust', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns immediately when dust balance is already positive', async () => {
    const bundle = createBundleStub({
      stateFn: () => rx.of(mockState({ dustBalance: 1000n })),
    });

    const statuses: string[] = [];
    const result = await ensureDust(bundle, (s) => statuses.push(s));

    expect(result.alreadyAvailable).toBe(true);
    expect(result.txHash).toBeUndefined();
    expect(statuses).toContain('Dust available');
  });

  it('does not call registration when dust is available and all UTXOs registered', async () => {
    const dustCreateTx = vi.fn();
    const bundle = createBundleStub({
      stateFn: () => rx.of(mockState({ dustBalance: 500n, registeredUtxos: 2 })),
      dustCreateTx,
    });

    await ensureDust(bundle);

    // No unregistered UTXOs and dust available → return immediately
    expect(dustCreateTx).not.toHaveBeenCalled();
  });

  it('skips registration when dust is available even with unregistered UTXOs', async () => {
    const dustCreateTx = vi.fn();
    const bundle = createBundleStub({
      stateFn: () => rx.of(mockState({ dustBalance: 500n, unregisteredUtxos: 2 })),
      dustCreateTx,
    });

    const statuses: string[] = [];
    const result = await ensureDust(bundle, (s) => statuses.push(s));

    // Should skip registration to avoid burning dust on unnecessary registration tx
    expect(result.alreadyAvailable).toBe(true);
    expect(dustCreateTx).not.toHaveBeenCalled();
    expect(statuses).toContain('Dust available');
  });

  it('registers unregistered UTXOs when no dust balance', async () => {
    const submitTransaction = vi.fn().mockResolvedValue('dust-reg-tx-hash');

    // waitForSyncedState is called multiple times: initial check, then polling.
    // First call returns no dust; second call (after registration) returns dust.
    let callCount = 0;
    const bundle = createBundleStub({
      stateFn: () => rx.of(mockState({ dustBalance: 0n, unregisteredUtxos: 1 })),
      waitForSyncedStateFn: async () => {
        callCount++;
        if (callCount <= 1) return mockState({ dustBalance: 0n, unregisteredUtxos: 1 });
        return mockState({ dustBalance: 500n, registeredUtxos: 1 });
      },
      submitTransaction,
    });

    const statuses: string[] = [];
    const promise = ensureDust(bundle, (s) => statuses.push(s));

    // Let registration complete, then advance past the 5s poll interval
    await vi.advanceTimersByTimeAsync(6_000);

    const result = await promise;

    expect(result.alreadyAvailable).toBe(false);
    expect(result.txHash).toBe('dust-reg-tx-hash');
    expect(statuses).toContain('Registering 1 UTXO(s) for dust generation...');
    expect(statuses).toContain('Waiting for dust tokens...');
    expect(statuses).toContain('Dust available');
  });

  it('waits for dust when all UTXOs already registered', async () => {
    const dustCreateTx = vi.fn();

    // First poll: no dust. Second poll (after 5s): dust available.
    let callCount = 0;
    const bundle = createBundleStub({
      stateFn: () => rx.of(mockState({ dustBalance: 0n, registeredUtxos: 2 })),
      waitForSyncedStateFn: async () => {
        callCount++;
        if (callCount <= 1) return mockState({ dustBalance: 0n, registeredUtxos: 2 });
        return mockState({ dustBalance: 100n, registeredUtxos: 2 });
      },
      dustCreateTx,
    });

    const statuses: string[] = [];
    const promise = ensureDust(bundle, (s) => statuses.push(s));

    // Advance past the 5s poll interval
    await vi.advanceTimersByTimeAsync(6_000);

    const result = await promise;

    expect(result.alreadyAvailable).toBe(false);
    expect(result.txHash).toBeUndefined();
    expect(statuses).toContain('UTXOs already registered, waiting for dust generation...');
    expect(statuses).toContain('Dust available');
    expect(dustCreateTx).not.toHaveBeenCalled();
  });

  it('returns immediately when balance positive but no available coins', async () => {
    const dustCreateTx = vi.fn();
    // balance > 0 but availableCoins is empty — dust exists (pending),
    // skip registration to avoid burning dust fees
    const bundle = createBundleStub({
      stateFn: () => rx.of(mockState({ dustBalance: 500n, availableDustCoins: 0 })),
      dustCreateTx,
    });

    const statuses: string[] = [];
    const result = await ensureDust(bundle, (s) => statuses.push(s));

    expect(result.alreadyAvailable).toBe(true);
    expect(result.txHash).toBeUndefined();
    expect(statuses).toContain('Dust available');
    expect(dustCreateTx).not.toHaveBeenCalled();
  });

  it('skips UTXOs already registered for dust generation', async () => {
    const submitTransaction = vi.fn().mockResolvedValue('only-unreg-tx');
    const dustCreateTx = vi.fn().mockResolvedValue({
      intents: new Map([[1, { signatureData: () => new Uint8Array(32) }]]),
    });

    // 2 registered + 1 unregistered — first poll: no dust, second: dust available
    let callCount = 0;
    const bundle = createBundleStub({
      stateFn: () => rx.of(mockState({ dustBalance: 0n, unregisteredUtxos: 1, registeredUtxos: 2 })),
      waitForSyncedStateFn: async () => {
        callCount++;
        if (callCount <= 1) return mockState({ dustBalance: 0n, unregisteredUtxos: 1, registeredUtxos: 2 });
        return mockState({ dustBalance: 200n, registeredUtxos: 3 });
      },
      submitTransaction,
      dustCreateTx,
    });

    const statuses: string[] = [];
    const promise = ensureDust(bundle, (s) => statuses.push(s));

    // Let registration complete, then advance past the 5s poll interval
    await vi.advanceTimersByTimeAsync(6_000);

    await promise;

    // Only 1 unregistered UTXO should be registered
    expect(statuses).toContain('Registering 1 UTXO(s) for dust generation...');
  });
});

// ── registerNightUtxos ───────────────────────────────────────────────

describe('registerNightUtxos', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('succeeds on first attempt', async () => {
    const bundle = createBundleStub({
      submitTransaction: vi.fn().mockResolvedValue('reg-tx-hash-001'),
    });

    const dustUtxos = [{ value: 1000000n, ctime: new Date() }] as any;
    const result = await registerNightUtxos(bundle, dustUtxos, 'mock-dust-addr');

    expect(result).toBe('reg-tx-hash-001');
  });

  it('retries on dust-related error (error 138), then succeeds', async () => {
    const submitTransaction = vi.fn()
      .mockRejectedValueOnce(new Error('Transaction submission error'))
      .mockResolvedValueOnce('retry-tx-hash');

    const bundle = createBundleStub({ submitTransaction });

    const dustUtxos = [{ value: 1000000n, ctime: new Date() }] as any;
    const statuses: string[] = [];

    const promise = registerNightUtxos(bundle, dustUtxos, 'mock-dust-addr', (s) => statuses.push(s));

    // Advance past the 15-second retry delay
    await vi.advanceTimersByTimeAsync(15_000);

    const result = await promise;

    expect(result).toBe('retry-tx-hash');
    expect(submitTransaction).toHaveBeenCalledTimes(2);
    expect(statuses.some(s => s.includes('Waiting for dust generation capacity'))).toBe(true);
  });

  it('throws immediately on non-retryable error', async () => {
    const submitTransaction = vi.fn()
      .mockRejectedValueOnce(new Error('Network connection refused'));

    const bundle = createBundleStub({ submitTransaction });

    const dustUtxos = [{ value: 1000000n, ctime: new Date() }] as any;

    await expect(
      registerNightUtxos(bundle, dustUtxos, 'mock-dust-addr')
    ).rejects.toThrow('Network connection refused');

    expect(submitTransaction).toHaveBeenCalledTimes(1);
  });

  it('retries on "Insufficient funds" error', async () => {
    const submitTransaction = vi.fn()
      .mockRejectedValueOnce(new Error('Insufficient funds'))
      .mockResolvedValueOnce('retry-funds-tx');

    const bundle = createBundleStub({ submitTransaction });

    const dustUtxos = [{ value: 1000000n, ctime: new Date() }] as any;

    const promise = registerNightUtxos(bundle, dustUtxos, 'mock-dust-addr');
    await vi.advanceTimersByTimeAsync(15_000);

    const result = await promise;
    expect(result).toBe('retry-funds-tx');
    expect(submitTransaction).toHaveBeenCalledTimes(2);
  });

  it('retries on "No dust tokens" error', async () => {
    const submitTransaction = vi.fn()
      .mockRejectedValueOnce(new Error('No dust tokens found in the wallet state'))
      .mockResolvedValueOnce('retry-nodust-tx');

    const bundle = createBundleStub({ submitTransaction });

    const dustUtxos = [{ value: 1000000n, ctime: new Date() }] as any;

    const promise = registerNightUtxos(bundle, dustUtxos, 'mock-dust-addr');
    await vi.advanceTimersByTimeAsync(15_000);

    const result = await promise;
    expect(result).toBe('retry-nodust-tx');
    expect(submitTransaction).toHaveBeenCalledTimes(2);
  });

  it('gives up when dust-related error exceeds timeout', async () => {
    let callCount = 0;
    const submitTransaction = vi.fn().mockImplementation(async () => {
      callCount++;
      throw new Error('Transaction submission error');
    });

    const bundle = createBundleStub({ submitTransaction });

    const dustUtxos = [{ value: 1000000n, ctime: new Date() }] as any;

    const promise = registerNightUtxos(bundle, dustUtxos, 'mock-dust-addr');

    // Register the rejection handler BEFORE advancing timers so the rejection
    // is caught immediately when it happens (avoids unhandled rejection warning).
    const expectation = expect(promise).rejects.toThrow('Transaction submission error');

    // Advance past the 10-minute deadline in chunks to process each retry cycle
    for (let i = 0; i < 42; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expectation;
    expect(callCount).toBeGreaterThan(1);
  });
});
