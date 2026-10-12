// mn's Dust wallet chooses the coins that pay a fee with a loop that ends.
// These run the SDK's real transacting, mn's replacement for its coin choice,
// and the ledger, on a real two-coin wallet state and a real payment.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as ledger from '@midnightntwrk/ledger-v9';
import { InMemoryTransactionHistoryStorage } from '@midnightntwrk/wallet-sdk';
import { Transacting } from '@midnightntwrk/wallet-sdk/dust/v2';
import { WalletEntrySchema, mergeWalletEntries } from '@midnightntwrk/wallet-sdk/facade';
import { EitherOps } from '@midnightntwrk/wallet-sdk/utilities';
import { ConvergingDustTransacting, DustWallet } from '../lib/dust-wallet.ts';
import { FORK_SCHEDULE } from '../lib/network.ts';
import { dustShortfallOf, isDustShortage } from '../lib/sdk-errors.ts';
import {
  CAPTURED_AT, type FeeRange, coinsAt, computeArguments, feeRange, paymentToBalance, timeWhenSmallestReaches, transacting,
} from './helpers/dust-balancing-case.ts';

let payment: ledger.FinalizedTransaction;
let fees: FeeRange;
/** The smallest coin covers the payment's own fee, not the fee with its spend added. */
let inRange: Date;
/** The smallest coin covers the fee with its spend added. */
let pastRange: Date;

beforeAll(async () => {
  payment = await paymentToBalance();
  fees = feeRange(payment, CAPTURED_AT);
  inRange = timeWhenSmallestReaches(fees.own);
  pastRange = timeWhenSmallestReaches(feeRange(payment, inRange).withOneSpend);
});

const caught = (run: () => unknown): unknown => {
  try { run(); } catch (error) { return error; }
  throw new Error('expected a failure');
};
/**
 * The ledger's fee for the same spends varies by a few parts in a million
 * from one dry run to the next, so two runs are compared within a thousandth.
 */
const expectSameFee = (actual: bigint, expected: bigint): void => {
  const difference = actual > expected ? actual - expected : expected - actual;
  expect(difference * 1000n).toBeLessThanOrEqual(expected);
};
/** An error's message and those of its causes, outermost first. */
const messages = (error: unknown): string[] => {
  const found: string[] = [];
  for (let current = error as { message?: unknown; cause?: unknown } | undefined; current; current = current.cause as typeof current) {
    found.push(String(current.message));
  }
  return found;
};

describe('the range the fixture puts its smallest coin in', () => {
  it('is real: the coin covers the payment\'s own fee and not the fee with its spend', () => {
    const [smallest] = coinsAt(inRange);
    expect(smallest!.value).toBeGreaterThanOrEqual(fees.own);
    expect(smallest!.value).toBeLessThan(feeRange(payment, inRange).withOneSpend);
    expect(coinsAt(pastRange)[0]!.value).toBeGreaterThanOrEqual(feeRange(payment, pastRange).withOneSpend);
  });
});

describe('the SDK\'s own choice of fee coins', () => {
  // The reason dust-wallet.ts exists. When this fails, the SDK's loop ends on
  // its own: drop ConvergingDustTransacting and build the SDK's DustWallet.
  it('never returns when the wallet\'s only coin is in that range', async () => {
    const canary = fileURLToPath(new URL('./helpers/sdk-dust-loop-canary.ts', import.meta.url));
    // Node itself, loading tsx, not the tsx command: that one runs the script
    // in a child of its own, which a kill of the command leaves looping.
    const child = spawn(process.execPath, ['--import', 'tsx', canary], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const exited = new Promise<void>((resolve) => { child.once('exit', () => resolve()); });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    try {
      // The call is made right after "started"; three seconds is thousands of its passes.
      await vi.waitFor(() => expect(output).toContain('started\n'), { timeout: 60_000, interval: 50 });
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(output).toBe('started\n');
      expect(child.exitCode).toBeNull();
    } finally {
      // The loop never yields, so only SIGKILL ends it; the test waits to see it gone.
      child.kill('SIGKILL');
      await exited;
    }
  }, 90_000);
});

describe('mn\'s choice of fee coins', () => {
  it('refuses as a Dust shortage when the wallet\'s only coin is in that range', () => {
    const mine = transacting(ConvergingDustTransacting, { onlySmallest: true });
    const error = caught(() => EitherOps.getOrThrowLeft(mine.computeBalancingRecipe(...computeArguments(payment, inRange))));
    expect(isDustShortage(error)).toBe(true);
    expect(messages(error)).toContain('Insufficient Funds: could not balance dust');
  });

  // What lets a caller wait the right time: what the fee takes, and what the wallet's coin held.
  it('says what it is short by when the only coin is in that range: the fee with its spend added, against the coin', () => {
    const mine = transacting(ConvergingDustTransacting, { onlySmallest: true });
    const error = caught(() => EitherOps.getOrThrowLeft(mine.computeBalancingRecipe(...computeArguments(payment, inRange))));
    const shortfall = dustShortfallOf(error)!;
    expectSameFee(shortfall.needed, feeRange(payment, inRange).withOneSpend);
    expect(shortfall.available).toBe(coinsAt(inRange)[0]!.value);
    expect(shortfall.needed).toBeGreaterThan(shortfall.available);
  });

  it('says what it is short by when the only coin can\'t cover even the payment\'s own fee', () => {
    const mine = transacting(ConvergingDustTransacting, { onlySmallest: true });
    const error = caught(() => EitherOps.getOrThrowLeft(mine.computeBalancingRecipe(...computeArguments(payment, CAPTURED_AT))));
    expect(isDustShortage(error)).toBe(true);
    const shortfall = dustShortfallOf(error)!;
    expectSameFee(shortfall.needed, feeRange(payment, CAPTURED_AT).withOneSpend);
    expect(shortfall.available).toBe(coinsAt(CAPTURED_AT)[0]!.value);
  });

  it('pays with the larger coin alone when the smallest is in that range, and the fee transaction can be built', () => {
    const mine = transacting(ConvergingDustTransacting);
    const [, large] = coinsAt(inRange);
    const { fee, recipeInputs } = EitherOps.getOrThrowLeft(mine.computeBalancingRecipe(...computeArguments(payment, inRange)));

    // One spend, not two: the node refuses a small transaction carrying two Dust spends.
    expect(recipeInputs.map((input) => input.token.nonce)).toEqual([large!.token.nonce]);
    expectSameFee(fee, feeRange(payment, inRange).withOneSpend);
    expect(recipeInputs[0]!.value).toBe(fee);
    expect(fee).toBeLessThanOrEqual(large!.value);

    const [feeTransaction] = EitherOps.getOrThrowLeft(mine.balanceTransactions(...computeArguments(payment, inRange)));
    expect(feeTransaction.intents?.size).toBe(1);
    expectSameFee(EitherOps.getOrThrowLeft(mine.estimateFee(...computeArguments(payment, inRange))), fee);
  });

  // Found live: a young coin beside a large one made every fee two spends.
  it('pays with the larger coin alone when the smallest can\'t cover even the payment\'s own fee', () => {
    expect(coinsAt(CAPTURED_AT)[0]!.value).toBeLessThan(fees.own);
    const mine = transacting(ConvergingDustTransacting);
    const [, large] = coinsAt(CAPTURED_AT);
    const { recipeInputs } = EitherOps.getOrThrowLeft(mine.computeBalancingRecipe(...computeArguments(payment, CAPTURED_AT)));
    expect(recipeInputs.map((input) => input.token.nonce)).toEqual([large!.token.nonce]);
    // The SDK's own choice, smallest coins first, is both of them.
    const sdk = transacting(Transacting.TransactingCapabilityImplementation);
    expect(EitherOps.getOrThrowLeft(sdk.computeBalancingRecipe(...computeArguments(payment, CAPTURED_AT))).recipeInputs).toHaveLength(2);
  });

  it('gives what the SDK gives when the SDK\'s first choice covers the fee', () => {
    // Past the range the SDK's loop ends at its first pass, so it is safe to run.
    const sdk = transacting(Transacting.TransactingCapabilityImplementation);
    const mine = transacting(ConvergingDustTransacting);
    const expected = EitherOps.getOrThrowLeft(sdk.computeBalancingRecipe(...computeArguments(payment, pastRange)));
    const actual = EitherOps.getOrThrowLeft(mine.computeBalancingRecipe(...computeArguments(payment, pastRange)));
    expect(actual.recipeInputs.map((input) => input.token.nonce)).toEqual(expected.recipeInputs.map((input) => input.token.nonce));
    expectSameFee(actual.fee, expected.fee);
    expect(expected.recipeInputs).toHaveLength(1);
  });

  it('leaves the SDK\'s own refusal as it is when the coins can\'t cover even the payment\'s own fee', () => {
    // At the capture the smaller coin is worth less than the payment's own fee:
    // the SDK's first choice refuses and stops, so it is safe to run.
    expect(coinsAt(CAPTURED_AT)[0]!.value).toBeLessThan(fees.own);
    const sdk = transacting(Transacting.TransactingCapabilityImplementation, { onlySmallest: true });
    const mine = transacting(ConvergingDustTransacting, { onlySmallest: true });
    const expected = caught(() => EitherOps.getOrThrowLeft(sdk.computeBalancingRecipe(...computeArguments(payment, CAPTURED_AT))));
    const actual = caught(() => EitherOps.getOrThrowLeft(mine.computeBalancingRecipe(...computeArguments(payment, CAPTURED_AT))));
    expect(actual).toEqual(expected);
    expect(isDustShortage(actual)).toBe(true);
  });
});

describe('DustWallet', () => {
  it('is the SDK\'s wallet class, built with mn\'s choice of fee coins', () => {
    const Wallet = DustWallet({
      networkId: 'undeployed',
      forks: FORK_SCHEDULE,
      indexerClientConnection: { indexerHttpUrl: 'http://127.0.0.1:9' },
      costParameters: { additionalFeeOverhead: 0n, feeBlocksMargin: 5 },
      chainVersionProbe: () => Promise.resolve(FORK_SCHEDULE.v9),
      txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
    });
    expect(typeof Wallet.startWithSeed).toBe('function');
    expect(typeof Wallet.restore).toBe('function');
  });
});
