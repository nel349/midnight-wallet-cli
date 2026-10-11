// mn's Dust wallet: the wallet SDK's, built the way the SDK builds it, with
// one part its builder lets a caller bring: how the coins that pay a fee are
// chosen. The SDK's own choice can loop without end (see dust-balancing-plan.ts),
// freezing the process until the ledger's WASM runs out of memory. Everything
// else is the SDK's.
//
// When the SDK's computeBalancingRecipe ends on its own, this file goes and
// facade.ts imports DustWallet from the SDK again.

import type * as ledger from '@midnight-ntwrk/ledger-v8';
import { Imbalances, InsufficientFundsError as NoCoinsCoverIt, getBalanceRecipe } from '@midnight-ntwrk/wallet-sdk-capabilities';
import { CustomDustWallet, type DustWallet as SdkDustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { Transacting, V1Builder } from '@midnight-ntwrk/wallet-sdk-dust-wallet/v1';
import { LedgerOps } from '@midnight-ntwrk/wallet-sdk-utilities';
import { type DustInput, planDustInputs, spreadFeeAcrossInputs } from './dust-balancing-plan.ts';

type SdkTransacting = Transacting.TransactingCapabilityImplementation<ledger.FinalizedTransaction>;
type RecipeArguments = Parameters<SdkTransacting['computeBalancingRecipe']>;
type Recipe = ReturnType<SdkTransacting['computeBalancingRecipe']>;
type DustCoin = ReturnType<ReturnType<SdkTransacting['getCoins']>['getAvailableCoinsWithGeneratedDust']>[number];

/** The SDK's transacting, with its fee-coin choice replaced by one that ends. */
export class ConvergingDustTransacting extends Transacting.TransactingCapabilityImplementation<ledger.FinalizedTransaction> {
  override computeBalancingRecipe(...args: RecipeArguments): Recipe {
    const [secretKey, state, transactions, ttl, currentTime, ledgerParams] = args;
    let plan;
    try {
      // What the transactions owe in Dust before any spend is added: the
      // SDK's starting imbalance, as an amount owed.
      const owed = -transactions.reduce(
        (total, tx) => total + Transacting.TransactingCapabilityImplementation.feeImbalance(tx, this.calculateFee(tx, ledgerParams)),
        0n,
      );
      const coins = this.getCoins().getAvailableCoinsWithGeneratedDust(state, currentTime);
      plan = planDustInputs<DustCoin['token']>({
        owed,
        coinCount: coins.length,
        choose: (amount) => this.#choose(coins, amount),
        feeWith: (inputs) => this.dryRunFee(inputs, transactions, secretKey, state, ttl, currentTime, ledgerParams),
      });
    } catch (error) {
      return LedgerOps.ledgerTry(() => { throw error; });
    }

    if (plan.kind === 'covered') {
      const { fee, inputs } = plan;
      return LedgerOps.ledgerTry(() => ({ fee, recipeInputs: spreadFeeAcrossInputs(inputs, fee) }));
    }
    // Too little Dust even before a spend is added: the SDK's first choice
    // refuses it and stops, so its own error stands, unchanged.
    if (plan.atFirstChoice) return super.computeBalancingRecipe(...args);
    // Enough for the transactions' own fee, not for the fee with the spends
    // added: where the SDK's loop never ends. Refused as the same shortage.
    return LedgerOps.ledgerTry(() => { throw new NoCoinsCoverIt('dust'); });
  }

  /** The SDK balancer's choice of coins covering `owed`, in the order it takes them. */
  #choose(coins: readonly DustCoin[], owed: bigint): DustInput<DustCoin['token']>[] | undefined {
    try {
      const recipe = getBalanceRecipe({
        coins: coins.map((coin) => ({ type: 'dust' as const, value: coin.value, token: coin.token })),
        initialImbalances: Imbalances.fromEntry('dust', -owed),
        feeTokenType: 'dust',
        transactionCostModel: { inputFeeOverhead: 0n, outputFeeOverhead: 0n },
        createOutput: (coin) => coin,
        isCoinEqual: (a, b) => a.type === b.type && a.value === b.value,
      });
      return recipe.inputs.map((input) => ({ token: input.token, value: input.value }));
    } catch (error) {
      if (error instanceof NoCoinsCoverIt) return undefined;
      throw error;
    }
  }
}

const makeConvergingTransacting: typeof Transacting.makeDefaultTransactingCapability = (config, getContext) =>
  new ConvergingDustTransacting(
    config.networkId,
    config.costParameters,
    () => getContext().coinSelection,
    () => getContext().coinsAndBalancesCapability,
    () => getContext().keysCapability,
  );

/** The SDK's `DustWallet(configuration)`, composed as it composes it, with the transacting replaced. */
export function DustWallet(configuration: Parameters<typeof SdkDustWallet>[0]): ReturnType<typeof SdkDustWallet> {
  return CustomDustWallet(configuration, new V1Builder().withDefaults().withTransacting(makeConvergingTransacting));
}
