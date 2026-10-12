// mn's Dust wallet: the wallet SDK's, built the way the SDK builds it, with
// one part its builder lets a caller bring: how the coins that pay a fee are
// chosen. The SDK's own choice can loop without end (see dust-balancing-plan.ts),
// freezing the process until the ledger's WASM runs out of memory. Everything
// else is the SDK's.
//
// When the SDK's computeBalancingRecipe ends on its own, this file goes and
// facade.ts imports DustWallet from the SDK again.

import * as ledger from '@midnightntwrk/ledger-v9';
import { Imbalances, InsufficientFundsError as NoCoinsCoverIt, getBalanceRecipe, makeIndexerChainVersionProbe } from '@midnightntwrk/wallet-sdk/capabilities';
import { CustomForkingDustWallet, DustWallet as SdkDustWallet, asV8DustParameters } from '@midnightntwrk/wallet-sdk/dust';
import { V1Builder } from '@midnightntwrk/wallet-sdk/dust/v1';
import { Migration, Transacting, V2Builder, WalletError } from '@midnightntwrk/wallet-sdk/dust/v2';
import { LedgerOps } from '@midnightntwrk/wallet-sdk/utilities';
import { type DustInput, chooseDustCoins, planDustInputs, spreadFeeAcrossInputs } from './dust-balancing-plan.ts';
import { type DustShortfall, withDustShortfall } from './sdk-errors.ts';

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
        choose: (amount) => chooseDustCoins(coins, amount, (several) => this.#combine(coins, several)),
        feeWith: (inputs) => this.dryRunFee(inputs, transactions, secretKey, state, ttl, currentTime, ledgerParams),
      });
    } catch (error) {
      return LedgerOps.ledgerTry(() => { throw error; });
    }

    if (plan.kind === 'covered') {
      const { fee, inputs } = plan;
      return LedgerOps.ledgerTry(() => ({ fee, recipeInputs: spreadFeeAcrossInputs(inputs, fee) }));
    }
    const shortfall = this.#shortfall(args);
    // Too little Dust even before a spend is added: the SDK's first choice
    // refuses it and stops, so its own error stands, with the shortfall added.
    if (plan.atFirstChoice) {
      const refused = super.computeBalancingRecipe(...args);
      if (shortfall && refused._tag === 'Left') withDustShortfall(refused.left, shortfall);
      return refused;
    }
    // Enough for the transactions' own fee, not for the fee with the spends
    // added: where the SDK's loop never ends. Refused as the same shortage.
    return LedgerOps.ledgerTry(() => {
      const shortage = new WalletError.InsufficientFundsError({ message: new NoCoinsCoverIt('dust').message, tokenType: 'dust' });
      throw shortfall ? withDustShortfall(shortage, shortfall) : shortage;
    });
  }

  /**
   * What the wallet is short by, so a caller can tell how long its NIGHT
   * takes to generate it: the fee with a spend of every coin the wallet has,
   * and what those coins hold at the time the spends are made for (the
   * wallet's clock for the chain, which a local chain can run behind).
   * Undefined with no coin to spend, or when the fee can't be worked out.
   */
  #shortfall([secretKey, state, transactions, ttl, currentTime, ledgerParams]: RecipeArguments): DustShortfall | undefined {
    try {
      const coins = this.getCoins().getAvailableCoinsWithGeneratedDust(state, currentTime);
      if (coins.length === 0) return undefined;
      const inputs = coins.map(({ token, value }) => ({ token, value }));
      return {
        needed: this.dryRunFee(inputs, transactions, secretKey, state, ttl, currentTime, ledgerParams),
        available: inputs.reduce((sum, input) => sum + input.value, 0n),
      };
    } catch {
      return undefined;
    }
  }

  /** The SDK balancer's choice of several coins covering `owed`, in the order it takes them. */
  #combine(coins: readonly DustCoin[], owed: bigint): DustInput<DustCoin['token']>[] | undefined {
    try {
      const recipe = getBalanceRecipe({
        coins: coins.map((coin) => ({ type: 'dust' as const, value: coin.value, token: coin.token })),
        initialImbalances: Imbalances.fromEntry('dust', -owed),
        feeTokenType: 'dust',
        coinSelection: this.getCoinSelection(),
        transactionCostModel: { inputFeeOverhead: 0n, outputFeeOverhead: 0n },
        createOutput: (coin) => coin,
        isCoinEqual: (a, b) => a.token.nonce === b.token.nonce,
      });
      return recipe.inputs.map(({ token, value }) => ({ token, value }));
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

/**
 * The SDK's `DustWallet(configuration)`, composed as it composes it (a
 * ledger-8 variant below the fork and a ledger-9 one from it), with the
 * ledger-9 variant's transacting replaced.
 */
export function DustWallet(configuration: Parameters<typeof SdkDustWallet>[0]): ReturnType<typeof SdkDustWallet> {
  const dustParameters = configuration.dustParameters ?? ledger.LedgerParameters.initialParameters().dust;
  const withProbe = {
    ...configuration,
    chainVersionProbe: configuration.chainVersionProbe ?? makeIndexerChainVersionProbe(configuration),
  };
  return CustomForkingDustWallet(
    withProbe,
    {
      builder: new V1Builder().withDefaults(),
      // A WASM object belongs to the ledger module that made it, so the
      // ledger-8 variant gets the same rates rebuilt as ledger-8's.
      configuration: { ...configuration, dustParameters: asV8DustParameters(dustParameters) },
    },
    {
      builder: new V2Builder()
        .withDefaults()
        .withTransacting(makeConvergingTransacting)
        .withMigration(() => Migration.makeCrossLedgerMigration({ dustParameters })),
      configuration,
    },
  );
}
