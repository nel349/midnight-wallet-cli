// What deploying an account takes from the wallet in Dust, for a message when
// a deploy runs short. Measured, not enforced: fee prices follow the chain's
// parameters and its load, so mn never refuses a deploy on these numbers.
//
// The wallet spends more than the fee a transaction ends up paying: each is
// paid with the margin the wallet SDK is configured with, for five blocks of
// rising prices (the fee times 1.2519) plus 0.3 DUST. So what counts for an
// owner is what leaves the wallet, and what one transaction needs at once.
//
// Measured 2026-10-11 on a local ledger-9 chain, two deploys, from the fees
// the indexer reports for each transaction (the deploy, three verifier-key
// updates, the activation):
//   12.23, 9.87, 10.00, 1.37, 0.26: 33.74 in fees, 43.74 from the wallet, 15.62 for the largest
//   13.40, 10.74, 10.82, 1.53, 0.27: 36.75 in fees, 47.51 from the wallet, 17.08 for the largest

import { formatDust } from '../../ui/format.ts';

export const MEASURED_ACCOUNT_DEPLOY = {
  transactions: 5,
  /** DUST that leaves the wallet for all of them, rounded up. */
  totalDust: 48,
  /** DUST the largest one (the deploy itself) needs at once, rounded up. */
  largestDust: 17.1,
} as const;

/**
 * What to tell an owner whose deploy stopped for want of Dust. `dustAtStart`
 * is what the wallet had, in Specks, when the command began.
 */
export function deployShortOfDustNote(dustAtStart: bigint): string {
  const { transactions, totalDust, largestDust } = MEASURED_ACCOUNT_DEPLOY;
  return (
    `Deploying an account takes about ${totalDust} DUST from the wallet over ${transactions} transactions, the largest about ${largestDust} DUST at once `
    + `(measured on a local ledger-9 chain; fee prices move with the chain's load). This wallet had ${formatDust(dustAtStart)} when the deploy began.\n`
    + 'Dust builds up with time from the NIGHT registered for it: see how much there is with "midnight dust status", '
    + 'and run the same command again when there is enough. A deploy that stopped part way carries on from where it stopped, '
    + 'so it then needs only what is left.'
  );
}
