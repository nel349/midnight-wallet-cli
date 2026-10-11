// The SDK's Dust transacting on a real wallet state: the two-coin fixture, a
// real ledger-9 payment to balance, the chain's ledger parameters, and the
// SDK's own capabilities. Nothing is faked; a "single-coin wallet" is the same
// state with the larger coin left out of what the wallet offers.

import * as ledger from '@midnightntwrk/ledger-v9';
import { CoinsAndBalances, CoreWallet, Keys, Transacting } from '@midnightntwrk/wallet-sdk/dust/v2';
import { DUST_COST_OVERHEAD, DUST_FEE_BLOCKS_MARGIN } from '../../lib/constants.ts';
import { TWO_COIN_DUST_CAPTURED_AT, TWO_COIN_DUST_SEED_HEX, TWO_COIN_DUST_STATE_HEX } from '../fixtures/dust-state-two-coins.ts';
import { LEDGER9_PARAMETERS_HEX } from '../fixtures/ledger9-parameters.ts';
import { NETWORK, TTL, agentPaysMerchant, unsealedBytes } from './ledger-tx.ts';

type SdkTransacting = Transacting.TransactingCapabilityImplementation<ledger.FinalizedTransaction>;
type TransactingClass = new (...args: ConstructorParameters<typeof Transacting.TransactingCapabilityImplementation<ledger.FinalizedTransaction>>) => SdkTransacting;
export type DustCoin = ReturnType<ReturnType<SdkTransacting['getCoins']>['getAvailableCoinsWithGeneratedDust']>[number];

export const CAPTURED_AT = new Date(TWO_COIN_DUST_CAPTURED_AT);
export const secretKey = ledger.DustSecretKey.fromSeed(Buffer.from(TWO_COIN_DUST_SEED_HEX, 'hex'));
export const state = CoreWallet.init(ledger.DustLocalState.deserialize(Buffer.from(TWO_COIN_DUST_STATE_HEX, 'hex')), secretKey, NETWORK);
export const ledgerParams = ledger.LedgerParameters.deserialize(Buffer.from(LEDGER9_PARAMETERS_HEX, 'hex'));

const keys = Keys.makeDefaultKeysCapability();
const allCoins = CoinsAndBalances.makeDefaultCoinsAndBalancesCapability({}, () => ({ keysCapability: keys }));

/** The wallet's coins at a time, smallest first. */
export const coinsAt = (time: Date): DustCoin[] =>
  [...allCoins.getAvailableCoinsWithGeneratedDust(state, time)].sort((a, b) => Number(a.value - b.value));

/** A transacting capability over the fixture wallet; `onlySmallest` offers it the smaller coin alone. */
export function transacting(Class: TransactingClass, { onlySmallest = false } = {}): SdkTransacting {
  const coins = onlySmallest
    ? { ...allCoins, getAvailableCoinsWithGeneratedDust: (s: typeof state, time: Date) => allCoins.getAvailableCoinsWithGeneratedDust(s, time).filter((c) => c.token.nonce === coinsAt(time)[0]!.token.nonce) }
    : allCoins;
  return new Class(NETWORK, { additionalFeeOverhead: DUST_COST_OVERHEAD, feeBlocksMargin: DUST_FEE_BLOCKS_MARGIN }, () => CoinsAndBalances.chooseCoin, () => coins, () => keys);
}

/** The agent's payment as the wallet receives it to balance: proven, unsealed, owing only its fee. */
export async function paymentToBalance(): Promise<ledger.FinalizedTransaction> {
  return ledger.Transaction.deserialize('signature', 'proof', 'pre-binding', await unsealedBytes(agentPaysMerchant())) as unknown as ledger.FinalizedTransaction;
}

export interface FeeRange {
  /** The payment's own fee: what the first choice of coins must cover. */
  own: bigint;
  /** Its fee with the smallest coin's spend added. */
  withOneSpend: bigint;
}

export function feeRange(payment: ledger.FinalizedTransaction, time: Date): FeeRange {
  const sdk = transacting(Transacting.TransactingCapabilityImplementation);
  return {
    own: sdk.calculateFee(payment, ledgerParams),
    withOneSpend: sdk.dryRunFee([coinsAt(time)[0]!], [payment], secretKey, state, TTL, time, ledgerParams),
  };
}

/**
 * The earliest time, to the millisecond, at which the smallest coin is worth
 * at least `atLeast` specks. Its value grows from the capture onward, and the
 * state says what it is worth at any later time.
 */
export function timeWhenSmallestReaches(atLeast: bigint): Date {
  let low = CAPTURED_AT.getTime();
  let high = low + 60 * 60 * 1000;
  const worth = (ms: number) => coinsAt(new Date(ms))[0]?.value ?? 0n;
  if (worth(low) >= atLeast) throw new Error(`the fixture's smallest coin is already worth ${atLeast} at its capture time`);
  if (worth(high) < atLeast) throw new Error(`the fixture's smallest coin is not worth ${atLeast} within an hour of its capture`);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (worth(middle) >= atLeast) high = middle;
    else low = middle;
  }
  return new Date(high);
}

export const computeArguments = (payment: ledger.FinalizedTransaction, time: Date) =>
  [secretKey, state, [payment], TTL, time, ledgerParams] as const;
