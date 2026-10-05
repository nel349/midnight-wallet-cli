// Tests for dust logic in transfer.ts — isDustRelatedError, ensureDust, registerNightUtxos
// Stubs the SDK facade at the interface boundary (per CLAUDE.md: no mocks of our own code).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as rx from 'rxjs';

import { isDustRelatedError, ensureDust, registerNightUtxos } from '../lib/transfer.ts';
import type { FacadeBundle } from '../lib/facade.ts';
import type { DustAddress } from '@midnightntwrk/wallet-sdk/address-format';
import type { UtxoWithMeta } from '@midnightntwrk/wallet-sdk/facade';

// Opaque sentinels: the code under test only passes these through to the SDK,
// so identity is what the assertions check.
const DUST_ADDRESS = { sentinel: 'dust-address' } as unknown as DustAddress;
const VERIFYING_KEY = { tag: 'schnorr', value: 'ab'.repeat(32) };
const NIGHT_UTXO = {
  utxo: { value: 1_000_000n },
  meta: { registeredForDustGeneration: false, ctime: new Date(0) },
} as unknown as UtxoWithMeta;

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
      address: DUST_ADDRESS,
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
  registerNightUtxos?: (...args: any[]) => Promise<any>;
  estimateRegistration?: (...args: any[]) => Promise<any>;
  waitForGeneratedDust?: (...args: any[]) => Promise<void>;
  finalizeRecipe?: () => Promise<any>;
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
      },
      registerNightUtxosForDustGeneration: overrides?.registerNightUtxos
        ?? vi.fn().mockResolvedValue({ type: 'UNPROVEN_TRANSACTION' }),
      estimateRegistration: overrides?.estimateRegistration
        ?? vi.fn().mockResolvedValue({ fee: 0n, dustGenerationEstimations: [] }),
      waitForGeneratedDust: overrides?.waitForGeneratedDust ?? vi.fn().mockResolvedValue(undefined),
      finalizeRecipe: overrides?.finalizeRecipe ?? vi.fn().mockResolvedValue({ finalized: true }),
      submitTransaction: overrides?.submitTransaction ?? vi.fn().mockResolvedValue('mock-tx-hash-001'),
    },
    keystore: {
      signDataAsync: vi.fn().mockResolvedValue({ tag: 'schnorr', value: '00' }),
      getPublicKey: vi.fn().mockReturnValue(VERIFYING_KEY),
    },
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

  it('detects wallet-sdk 2.0\'s registration-fee shortfall (verbatim from a ledger-9 localnet run)', () => {
    const sdkMessage = 'Insufficient generated dust to cover registration fee (have 429884000000000, need 510620549476299). '
      + 'Use WalletFacade.waitForGeneratedDust(utxos, 510620549476299) before retrying.';
    expect(isDustRelatedError(new Error(sdkMessage))).toBe(true);
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
    const registerSpy = vi.fn();
    const bundle = createBundleStub({
      stateFn: () => rx.of(mockState({ dustBalance: 500n, registeredUtxos: 2 })),
      registerNightUtxos: registerSpy,
    });

    await ensureDust(bundle);

    // No unregistered UTXOs and dust available → return immediately
    expect(registerSpy).not.toHaveBeenCalled();
  });

  it('skips registration when dust is available even with unregistered UTXOs', async () => {
    const registerSpy = vi.fn();
    const bundle = createBundleStub({
      stateFn: () => rx.of(mockState({ dustBalance: 500n, unregisteredUtxos: 2 })),
      registerNightUtxos: registerSpy,
    });

    const statuses: string[] = [];
    const result = await ensureDust(bundle, (s) => statuses.push(s));

    // Should skip registration to avoid burning dust on unnecessary registration tx
    expect(result.alreadyAvailable).toBe(true);
    expect(registerSpy).not.toHaveBeenCalled();
    expect(statuses).toContain('Dust available');
  });

  it('fails at once, saying to fund the wallet, when it holds no NIGHT at all', async () => {
    // Found live: it took the "already registered, waiting" branch and polled until its timeout.
    const registerSpy = vi.fn();
    const waitForSyncedStateFn = vi.fn(async () => mockState({ dustBalance: 0n }));
    const bundle = createBundleStub({
      stateFn: () => rx.of(mockState({ dustBalance: 0n })),
      waitForSyncedStateFn,
      registerNightUtxos: registerSpy,
    });

    await expect(ensureDust(bundle)).rejects.toThrow('This wallet has no NIGHT, so it generates no Dust to pay fees. Fund it first');

    expect(registerSpy).not.toHaveBeenCalled();
    expect(waitForSyncedStateFn).toHaveBeenCalledTimes(1);
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
    const registerSpy = vi.fn();

    // First poll: no dust. Second poll (after 5s): dust available.
    let callCount = 0;
    const bundle = createBundleStub({
      stateFn: () => rx.of(mockState({ dustBalance: 0n, registeredUtxos: 2 })),
      waitForSyncedStateFn: async () => {
        callCount++;
        if (callCount <= 1) return mockState({ dustBalance: 0n, registeredUtxos: 2 });
        return mockState({ dustBalance: 100n, registeredUtxos: 2 });
      },
      registerNightUtxos: registerSpy,
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
    expect(registerSpy).not.toHaveBeenCalled();
  });

  it('returns immediately when balance positive but no available coins', async () => {
    const registerSpy = vi.fn();
    // balance > 0 but availableCoins is empty — dust exists (pending),
    // skip registration to avoid burning dust fees
    const bundle = createBundleStub({
      stateFn: () => rx.of(mockState({ dustBalance: 500n, availableDustCoins: 0 })),
      registerNightUtxos: registerSpy,
    });

    const statuses: string[] = [];
    const result = await ensureDust(bundle, (s) => statuses.push(s));

    expect(result.alreadyAvailable).toBe(true);
    expect(result.txHash).toBeUndefined();
    expect(statuses).toContain('Dust available');
    expect(registerSpy).not.toHaveBeenCalled();
  });

  it('skips UTXOs already registered for dust generation', async () => {
    const submitTransaction = vi.fn().mockResolvedValue('only-unreg-tx');
    const registerSpy = vi.fn().mockResolvedValue({ type: 'UNPROVEN_TRANSACTION' });

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
      registerNightUtxos: registerSpy,
    });

    const statuses: string[] = [];
    const promise = ensureDust(bundle, (s) => statuses.push(s));

    // Let registration complete, then advance past the 5s poll interval
    await vi.advanceTimersByTimeAsync(6_000);

    const result = await promise;

    // Exactly the one unregistered UTXO goes to the SDK, signed with the
    // wallet's own key and paid to the wallet's own dust address.
    expect(registerSpy).toHaveBeenCalledTimes(1);
    const [utxos, verifyingKey, signer, receiver] = registerSpy.mock.calls[0]!;
    expect(utxos).toHaveLength(1);
    expect(utxos[0].meta.registeredForDustGeneration).toBe(false);
    expect(verifyingKey).toBe(VERIFYING_KEY);
    expect(signer).toBe(bundle.keystore.signDataAsync);
    expect(receiver).toBe(DUST_ADDRESS);
    expect(result.txHash).toBe('only-unreg-tx');
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

  it('succeeds on first attempt: proves the SDK recipe, then submits the proven tx', async () => {
    const recipe = { type: 'UNPROVEN_TRANSACTION' };
    const finalized = { finalized: true };
    const registerSpy = vi.fn().mockResolvedValue(recipe);
    const finalizeRecipe = vi.fn().mockResolvedValue(finalized);
    const submitTransaction = vi.fn().mockResolvedValue('reg-tx-hash-001');
    const bundle = createBundleStub({ registerNightUtxos: registerSpy, finalizeRecipe, submitTransaction });

    const nightUtxos = [NIGHT_UTXO];
    const result = await registerNightUtxos(bundle, nightUtxos, DUST_ADDRESS);

    expect(result).toBe('reg-tx-hash-001');
    expect(registerSpy).toHaveBeenCalledWith(nightUtxos, VERIFYING_KEY, bundle.keystore.signDataAsync, DUST_ADDRESS);
    expect(finalizeRecipe).toHaveBeenCalledWith(recipe);
    expect(submitTransaction).toHaveBeenCalledWith(finalized);
  });

  it('releases the booked NIGHT UTXOs when proving the registration fails', async () => {
    const recipe = { type: 'UNPROVEN_TRANSACTION' };
    const revert = vi.fn().mockResolvedValue(undefined);
    const bundle = createBundleStub({
      registerNightUtxos: vi.fn().mockResolvedValue(recipe),
      finalizeRecipe: vi.fn().mockRejectedValue(new Error('proof server unreachable')),
    });
    (bundle.facade as any).revert = revert;

    await expect(registerNightUtxos(bundle, [NIGHT_UTXO], DUST_ADDRESS)).rejects.toThrow('proof server unreachable');
    // Registration books the UTXOs; without the revert a retry can't book them again.
    expect(revert).toHaveBeenCalledWith(recipe);
  });

  it('waits for the coins to generate the estimated fee before registering them', async () => {
    const calls: string[] = [];
    const estimateRegistration = vi.fn(async () => { calls.push('estimate'); return { fee: 777n, dustGenerationEstimations: [] }; });
    const waitForGeneratedDust = vi.fn(async () => { calls.push('wait'); });
    const registerSpy = vi.fn(async () => { calls.push('register'); return { type: 'UNPROVEN_TRANSACTION' }; });
    const bundle = createBundleStub({ estimateRegistration, waitForGeneratedDust, registerNightUtxos: registerSpy });

    const nightUtxos = [NIGHT_UTXO];
    await registerNightUtxos(bundle, nightUtxos, DUST_ADDRESS);

    expect(calls).toEqual(['estimate', 'wait', 'register']);
    expect(estimateRegistration).toHaveBeenCalledWith(nightUtxos);
    const [waitUtxos, required, opts] = waitForGeneratedDust.mock.calls[0] as unknown as [unknown, bigint, { timeoutMs: number }];
    expect(waitUtxos).toBe(nightUtxos);
    expect(required).toBe(777n);
    // Bounded by the registration deadline, never unbounded.
    expect(opts.timeoutMs).toBeGreaterThan(0);
    expect(opts.timeoutMs).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it('retries on dust-related error (error 138), then succeeds', async () => {
    const submitTransaction = vi.fn()
      .mockRejectedValueOnce(new Error('Transaction submission error'))
      .mockResolvedValueOnce('retry-tx-hash');

    const bundle = createBundleStub({ submitTransaction });

    const nightUtxos = [NIGHT_UTXO];
    const statuses: string[] = [];

    const promise = registerNightUtxos(bundle, nightUtxos, DUST_ADDRESS, (s) => statuses.push(s));

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

    const nightUtxos = [NIGHT_UTXO];

    await expect(
      registerNightUtxos(bundle, nightUtxos, DUST_ADDRESS)
    ).rejects.toThrow('Network connection refused');

    expect(submitTransaction).toHaveBeenCalledTimes(1);
  });

  it('retries on "Insufficient funds" error', async () => {
    const submitTransaction = vi.fn()
      .mockRejectedValueOnce(new Error('Insufficient funds'))
      .mockResolvedValueOnce('retry-funds-tx');

    const bundle = createBundleStub({ submitTransaction });

    const nightUtxos = [NIGHT_UTXO];

    const promise = registerNightUtxos(bundle, nightUtxos, DUST_ADDRESS);
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

    const nightUtxos = [NIGHT_UTXO];

    const promise = registerNightUtxos(bundle, nightUtxos, DUST_ADDRESS);
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

    const nightUtxos = [NIGHT_UTXO];

    const promise = registerNightUtxos(bundle, nightUtxos, DUST_ADDRESS);

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
