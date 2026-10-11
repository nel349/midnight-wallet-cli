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
import { isDustShortage } from '../lib/sdk-errors.ts';
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

const sum = (inputs: readonly { value: bigint }[]) => inputs.reduce((total, input) => total + input.value, 0n);
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
    expect(isDustShortage(error)).toBe(true);
    expect(messages(error)).toContain('Insufficient Funds: could not balance dust');
  });

  it('adds the next coin when the smallest is in that range, and the fee transaction can be built', () => {
    const mine = transacting(ConvergingDustTransacting);
    const [small, large] = coinsAt(inRange);
    const { fee, recipeInputs } = EitherOps.getOrThrowLeft(mine.computeBalancingRecipe(...computeArguments(payment, inRange)));

    expect(recipeInputs.map((input) => input.token.nonce)).toEqual([small!.token.nonce, large!.token.nonce]);
    // Two spends cost more than one, and the two coins cover it. (The ledger's
    // fee for the same two spends varies by a few parts in a million from one
    // dry run to the next, so the fee is not compared to a second run.)
    expect(fee).toBeGreaterThan(feeRange(payment, inRange).withOneSpend);
    expect(fee).toBeLessThanOrEqual(small!.value + large!.value);
    // Each coin in turn pays all it has: the small one whole, the large one the rest.
    expect(recipeInputs[0]!.value).toBe(small!.value);
    expect(sum(recipeInputs)).toBe(fee);

    const [feeTransaction] = EitherOps.getOrThrowLeft(mine.balanceTransactions(...computeArguments(payment, inRange)));
    expect(feeTransaction.intents?.size).toBe(1);
    const estimate = EitherOps.getOrThrowLeft(mine.estimateFee(...computeArguments(payment, inRange)));
    expect(estimate).toBeGreaterThan(feeRange(payment, inRange).withOneSpend);
    expect(estimate).toBeLessThanOrEqual(small!.value + large!.value);
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
