// mn's Dust wallet chooses the coins that pay a fee with a loop that ends.
// These run the SDK's real transacting, mn's replacement for its coin choice,
// and the ledger, on a real two-coin wallet state and a real payment.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as ledger from '@midnight-ntwrk/ledger-v8';
import { Transacting } from '@midnight-ntwrk/wallet-sdk-dust-wallet/v1';
import { EitherOps } from '@midnight-ntwrk/wallet-sdk-utilities';
import { ConvergingDustTransacting } from '../lib/dust-wallet.ts';
import { isDustRelatedError } from '../lib/sdk-errors.ts';
import {
  CAPTURED_AT, type FeeRange, coinsAt, computeArguments, feeRange, paymentToBalance, timeWhenSmallestReaches, transacting,
} from './helpers/dust-balancing-case.ts';

let payment: ledger.FinalizedTransaction;
let fees: FeeRange;
/** The smallest coin covers the payment's own fee, not the fee with its spend added. */
let inRange: Date;
/** The smallest coin covers the fee with its spend added. */
let pastRange: Date;
/** The smallest coin covers neither. */
let beforeRange: Date;

beforeAll(async () => {
  payment = await paymentToBalance();
  fees = feeRange(payment, CAPTURED_AT);
  inRange = timeWhenSmallestReaches(fees.own);
  pastRange = timeWhenSmallestReaches(feeRange(payment, inRange).withOneSpend);
  beforeRange = new Date(inRange.getTime() - 10_000);
});

const caught = (run: () => unknown): unknown => {
  try { run(); } catch (error) { return error; }
  throw new Error('expected a failure');
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
    expect(coinsAt(beforeRange)[0]!.value).toBeLessThan(fees.own);
  });
});

describe('the SDK\'s own choice of fee coins', () => {
  // The reason dust-wallet.ts exists. When this fails, the SDK's loop ends on
  // its own: drop ConvergingDustTransacting and build the SDK's DustWallet.
  it('never returns when the wallet\'s only coin is in that range', async () => {
    const canary = fileURLToPath(new URL('./helpers/sdk-dust-loop-canary.ts', import.meta.url));
    const tsx = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));
    const child = spawn(tsx, [canary], { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    try {
      // The call is made right after "started"; three seconds is thousands of its passes.
      await vi.waitFor(() => expect(output).toContain('started\n'), { timeout: 60_000, interval: 50 });
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(output).toBe('started\n');
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill('SIGKILL');
    }
  }, 90_000);
});

describe('mn\'s choice of fee coins', () => {
  it('refuses as a Dust shortage when the wallet\'s only coin is in that range', () => {
    const mine = transacting(ConvergingDustTransacting, { onlySmallest: true });
    const error = caught(() => EitherOps.getOrThrowLeft(mine.computeBalancingRecipe(...computeArguments(payment, inRange))));
    expect(messages(error)).toContain('Insufficient Funds: could not balance dust');
    expect(messages(error).some((message) => isDustRelatedError({ message }))).toBe(true);
  });

  it('pays with the larger coin alone when the smallest is in that range, and the fee transaction can be built', () => {
    const mine = transacting(ConvergingDustTransacting);
    const [, large] = coinsAt(inRange);
    const { fee, recipeInputs } = EitherOps.getOrThrowLeft(mine.computeBalancingRecipe(...computeArguments(payment, inRange)));

    // One spend, not two: the node refuses a small transaction carrying two Dust spends.
    expect(recipeInputs.map((input) => input.token.nonce)).toEqual([large!.token.nonce]);
    expect(fee).toBe(feeRange(payment, inRange).withOneSpend);
    expect(recipeInputs[0]!.value).toBe(fee);
    expect(fee).toBeLessThanOrEqual(large!.value);

    const [feeTransaction] = EitherOps.getOrThrowLeft(mine.balanceTransactions(...computeArguments(payment, inRange)));
    expect(feeTransaction.intents?.size).toBe(1);
    expect(EitherOps.getOrThrowLeft(mine.estimateFee(...computeArguments(payment, inRange)))).toBe(fee);
  });

  // Found live: a young coin beside a large one made every fee two spends.
  it('pays with the larger coin alone when the smallest can\'t cover even the payment\'s own fee', () => {
    const mine = transacting(ConvergingDustTransacting);
    const [, large] = coinsAt(beforeRange);
    const { recipeInputs } = EitherOps.getOrThrowLeft(mine.computeBalancingRecipe(...computeArguments(payment, beforeRange)));
    expect(recipeInputs.map((input) => input.token.nonce)).toEqual([large!.token.nonce]);
    // The SDK's own choice, smallest coins first, is both of them.
    const sdk = transacting(Transacting.TransactingCapabilityImplementation);
    expect(EitherOps.getOrThrowLeft(sdk.computeBalancingRecipe(...computeArguments(payment, beforeRange))).recipeInputs).toHaveLength(2);
  });

  it('gives what the SDK gives when the SDK\'s first choice covers the fee', () => {
    // Past the range the SDK's loop ends at its first pass, so it is safe to run.
    const sdk = transacting(Transacting.TransactingCapabilityImplementation);
    const mine = transacting(ConvergingDustTransacting);
    const expected = EitherOps.getOrThrowLeft(sdk.computeBalancingRecipe(...computeArguments(payment, pastRange)));
    expect(EitherOps.getOrThrowLeft(mine.computeBalancingRecipe(...computeArguments(payment, pastRange)))).toEqual(expected);
    expect(expected.recipeInputs).toHaveLength(1);
  });

  it('leaves the SDK\'s own refusal as it is when the coins can\'t cover even the payment\'s own fee', () => {
    // Before the range the SDK's first choice refuses and stops, so it is safe to run.
    const sdk = transacting(Transacting.TransactingCapabilityImplementation, { onlySmallest: true });
    const mine = transacting(ConvergingDustTransacting, { onlySmallest: true });
    const expected = caught(() => EitherOps.getOrThrowLeft(sdk.computeBalancingRecipe(...computeArguments(payment, beforeRange))));
    const actual = caught(() => EitherOps.getOrThrowLeft(mine.computeBalancingRecipe(...computeArguments(payment, beforeRange))));
    expect(actual).toEqual(expected);
    expect(messages(actual)).toContain('Insufficient Funds: could not balance dust');
  });
});
