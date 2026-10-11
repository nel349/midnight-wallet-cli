// Which Dust coins pay a transaction's fee.
//
// Adding a Dust spend raises the fee it is there to pay, so the choice is a
// loop: choose coins for what is owed, work out the fee with those spends
// added, and if they no longer cover it, choose again for the new fee.
//
// The wallet SDK's own loop (computeBalancingRecipe) never ends when its
// first choice covers the transaction's own fee but not the fee with the
// spends added. It asks its balancer again with the new fee as a positive
// imbalance, which the balancer reads as a surplus: it selects no coin, the
// coverage is zero, and the loop repeats for good, growing the ledger's WASM
// memory until it traps ("unreachable"). The loop is synchronous, so the
// process answers nothing meanwhile. A Dust coin regrowing after a payment
// passes through that range (0.71 to 0.82 DUST for a simple payment on a
// local chain: 13 seconds for a 1000 NIGHT coin, 11 minutes for 20).
//
// planDustInputs is that loop with the amount owed kept as an amount owed, and
// an end: each choice that falls short is followed by one for strictly more,
// and there are only so many coins to choose for it.
//
// chooseDustCoins is the choice itself: one coin when one is enough. The
// SDK's balancer takes the smallest coins first, so a small, young coin beside
// a larger one made every fee a two-spend transaction, and the node refuses a
// small transaction that carries two Dust spends: validating it takes longer
// than its size allows ("exceeded the maximum time to dismiss": 15.478 ms
// against 15 ms for a 6.7 kB payment, on ledger 8 and ledger 9 localnets).

/** A Dust coin and how much of it there is to spend. */
export interface DustInput<TToken> {
  token: TToken;
  value: bigint;
}

export type DustPlan<TToken> =
  /** These coins cover the fee with their own spends counted. */
  | { kind: 'covered'; fee: bigint; inputs: DustInput<TToken>[] }
  /**
   * The wallet's coins can't cover the fee. `atFirstChoice`: not even what
   * the transactions owe before any spend is added.
   */
  | { kind: 'short'; atFirstChoice: boolean };

export interface DustPlanOptions<TToken> {
  /** Dust the transactions owe before any spend is added: their fees, less any Dust they bring. */
  owed: bigint;
  /** How many coins the wallet has to choose from. */
  coinCount: number;
  /** The wallet's choice of coins covering an amount, or undefined when its coins can't. */
  choose: (owed: bigint) => DustInput<TToken>[] | undefined;
  /** The whole fee with these coins' spends added. */
  feeWith: (inputs: readonly DustInput<TToken>[]) => bigint;
}

/**
 * The coins to pay `owed` with: the smallest single coin that covers it, and
 * only when no coin does, whatever `combine` makes of several (undefined when
 * all of them can't).
 */
export function chooseDustCoins<TToken>(
  coins: readonly DustInput<TToken>[],
  owed: bigint,
  combine: (owed: bigint) => DustInput<TToken>[] | undefined,
): DustInput<TToken>[] | undefined {
  let single: DustInput<TToken> | undefined;
  for (const coin of coins) {
    if (coin.value >= owed && (single === undefined || coin.value < single.value)) single = coin;
  }
  return single === undefined ? combine(owed) : [single];
}

export function planDustInputs<TToken>({ owed, coinCount, choose, feeWith }: DustPlanOptions<TToken>): DustPlan<TToken> {
  let stillOwed = owed;
  // A choice that falls short is followed by one for more than it covered: a
  // larger single coin each time while one is enough, then at least one more
  // coin each time. Two passes per coin and one more is every case.
  for (let pass = 0; pass <= coinCount * 2; pass++) {
    const inputs = stillOwed > 0n ? choose(stillOwed) : [];
    if (inputs === undefined) return { kind: 'short', atFirstChoice: pass === 0 };
    const fee = feeWith(inputs);
    const coverage = inputs.reduce((sum, input) => sum + input.value, 0n);
    if (fee <= coverage) return { kind: 'covered', fee, inputs };
    stillOwed = fee;
  }
  return { kind: 'short', atFirstChoice: false };
}

/**
 * How much of the fee each coin pays: each in turn pays all it has until the
 * fee is met. As the SDK's distributeFeeAcrossInputs, which it does not export.
 */
export function spreadFeeAcrossInputs<TToken>(inputs: readonly DustInput<TToken>[], fee: bigint): DustInput<TToken>[] {
  let remaining = fee;
  return inputs.map((input) => {
    const paid = remaining >= input.value ? input.value : remaining;
    remaining -= paid;
    return { ...input, value: paid };
  });
}
