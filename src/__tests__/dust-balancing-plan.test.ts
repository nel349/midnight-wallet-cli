// Which Dust coins pay a fee: the loop that chooses them must end, whatever
// the coins are worth, and one coin pays when one is enough. Coins and fees
// here are plain numbers. Several coins are combined as the SDK balancer
// combines them: the smallest first, until they cover what is owed.

import { describe, expect, it } from 'vitest';
import { type DustInput, chooseDustCoins, planDustInputs, spreadFeeAcrossInputs } from '../lib/dust-balancing-plan.ts';

type Coin = DustInput<string>;
const coin = (token: string, value: bigint): Coin => ({ token, value });

/** Smallest first until the amount is covered; undefined when all of them can't. */
const smallestFirst = (coins: readonly Coin[]) => (owed: bigint): Coin[] | undefined => {
  const chosen: Coin[] = [];
  let covered = 0n;
  for (const c of [...coins].sort((a, b) => Number(a.value - b.value))) {
    if (covered >= owed) break;
    chosen.push(c);
    covered += c.value;
  }
  return covered >= owed ? chosen : undefined;
};

/** A fee of `own` for the transaction, plus `perSpend` for each Dust spend added. */
const fee = (own: bigint, perSpend: bigint) => (inputs: readonly Coin[]) => own + perSpend * BigInt(inputs.length);

const plan = (coins: Coin[], own: bigint, perSpend: bigint, owed = own) => {
  const choices: bigint[] = [];
  const result = planDustInputs({
    owed,
    coinCount: coins.length,
    choose: (amount) => (choices.push(amount), chooseDustCoins(coins, amount, smallestFirst(coins))),
    feeWith: fee(own, perSpend),
  });
  return { result, choices };
};

describe('chooseDustCoins', () => {
  const coins = [coin('a', 100n), coin('b', 5000n), coin('c', 900n)];

  it('takes the smallest single coin that covers the amount', () => {
    expect(chooseDustCoins(coins, 800n, smallestFirst(coins))).toEqual([coin('c', 900n)]);
    expect(chooseDustCoins(coins, 900n, smallestFirst(coins))).toEqual([coin('c', 900n)]);
    expect(chooseDustCoins(coins, 901n, smallestFirst(coins))).toEqual([coin('b', 5000n)]);
    expect(chooseDustCoins(coins, 50n, smallestFirst(coins))).toEqual([coin('a', 100n)]);
  });

  it('combines several only when no single coin covers it', () => {
    expect(chooseDustCoins(coins, 5500n, smallestFirst(coins))).toEqual([coin('a', 100n), coin('c', 900n), coin('b', 5000n)]);
  });

  it('is undefined when all of them can\'t', () => {
    expect(chooseDustCoins(coins, 7000n, smallestFirst(coins))).toBeUndefined();
    expect(chooseDustCoins([], 1n, smallestFirst([]))).toBeUndefined();
  });
});

describe('planDustInputs', () => {
  it('takes the first choice when it covers the fee with its own spend counted', () => {
    const { result, choices } = plan([coin('a', 900n), coin('b', 5000n)], 700n, 100n);
    expect(result).toEqual({ kind: 'covered', fee: 800n, inputs: [coin('a', 900n)] });
    expect(choices).toEqual([700n]);
  });

  // Where the SDK's loop never ended: 750 covers the transaction's own 700,
  // not the 800 it costs with the spend added.
  it('chooses again for the higher fee when the first choice covers the transaction\'s fee but not its own spend', () => {
    const { result, choices } = plan([coin('a', 750n), coin('b', 5000n)], 700n, 100n);
    // The larger coin alone: one spend, where the two together would be two.
    expect(result).toEqual({ kind: 'covered', fee: 800n, inputs: [coin('b', 5000n)] });
    expect(choices).toEqual([700n, 800n]);
  });

  // Found live: a young coin of 0.1 DUST beside one of 29 made a 0.82 DUST fee
  // a two-spend transaction, which the node refused.
  it('pays with the larger coin alone when the smallest can\'t cover the fee', () => {
    const { result, choices } = plan([coin('young', 100n), coin('b', 5000n)], 700n, 100n);
    expect(result).toEqual({ kind: 'covered', fee: 800n, inputs: [coin('b', 5000n)] });
    expect(choices).toEqual([700n]);
  });

  it('ends as short when the only coin is in that range', () => {
    const { result, choices } = plan([coin('a', 750n)], 700n, 100n);
    expect(result).toEqual({ kind: 'short', atFirstChoice: false });
    expect(choices).toEqual([700n, 800n]);
  });

  it('says so when the coins can\'t even cover what the transaction owes', () => {
    expect(plan([coin('a', 500n)], 700n, 100n).result).toEqual({ kind: 'short', atFirstChoice: true });
    expect(plan([], 700n, 100n).result).toEqual({ kind: 'short', atFirstChoice: true });
  });

  it('combines coins, and keeps adding them while each added spend outruns what they cover, when no single coin is enough', () => {
    const coins = [coin('a', 400n), coin('b', 300n), coin('c', 300n), coin('d', 450n)];
    const { result, choices } = plan(coins, 700n, 100n);
    // b + c + a = 1000 covers 700 and the 1000 three spends cost.
    expect(result).toEqual({ kind: 'covered', fee: 1000n, inputs: [coin('b', 300n), coin('c', 300n), coin('a', 400n)] });
    expect(choices).toEqual([700n]);

    const tighter = plan([coin('a', 380n), coin('b', 300n), coin('c', 300n), coin('d', 450n)], 700n, 100n);
    // b + c + a = 980 covers 700, not the 1000 three spends cost; d makes it four spends at 1100.
    expect(tighter.result).toEqual({ kind: 'covered', fee: 1100n, inputs: [coin('b', 300n), coin('c', 300n), coin('a', 380n), coin('d', 450n)] });
    expect(tighter.choices).toEqual([700n, 1000n]);
  });

  it('chooses for the whole fee when the transactions owe nothing before a spend is added', () => {
    const { result, choices } = plan([coin('a', 900n)], 700n, 100n, 0n);
    expect(result).toEqual({ kind: 'covered', fee: 800n, inputs: [coin('a', 900n)] });
    expect(choices).toEqual([700n]);
  });

  it('ends within two passes per coin and one more, even when no choice ever covers its fee', () => {
    const coins = [coin('a', 10n), coin('b', 10n), coin('c', 10n)];
    let passes = 0;
    const result = planDustInputs({
      owed: 5n,
      coinCount: coins.length,
      // A wallet that always offers one coin, whatever is owed: no choice can cover a fee of 1000.
      choose: () => (passes++, [coins[0]!]),
      feeWith: () => 1000n,
    });
    expect(result).toEqual({ kind: 'short', atFirstChoice: false });
    expect(passes).toBe(coins.length * 2 + 1);
  });
});

describe('spreadFeeAcrossInputs', () => {
  it('has each coin in turn pay all it has until the fee is met', () => {
    expect(spreadFeeAcrossInputs([coin('a', 750n), coin('b', 5000n)], 900n)).toEqual([coin('a', 750n), coin('b', 150n)]);
    expect(spreadFeeAcrossInputs([coin('a', 900n)], 800n)).toEqual([coin('a', 800n)]);
    expect(spreadFeeAcrossInputs([coin('a', 100n), coin('b', 100n), coin('c', 100n)], 150n)).toEqual([coin('a', 100n), coin('b', 50n), coin('c', 0n)]);
    expect(spreadFeeAcrossInputs([], 0n)).toEqual([]);
  });
});
