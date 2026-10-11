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
// ledger-9 localnet: 13 seconds for a 1000 NIGHT coin, 11 minutes for 20).
//
// planDustInputs is that loop with the amount owed kept as an amount owed, and
// an end: each choice that falls short is followed by one for strictly more,
// so it takes more coins each time and there are only so many.

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

export function planDustInputs<TToken>({ owed, coinCount, choose, feeWith }: DustPlanOptions<TToken>): DustPlan<TToken> {
  let stillOwed = owed;
  // A choice that falls short is followed by one for more than it covered, so
  // each pass takes at least one more coin: coinCount + 1 passes is every case.
  for (let pass = 0; pass <= coinCount; pass++) {
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
