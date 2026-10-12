// What deploying an account takes in Dust, for a message when a deploy runs
// short. Measured, not enforced: fees follow the chain's parameters, so mn
// never refuses a deploy on these numbers.
//
// Measured 2026-10-11 on a local ledger-9 chain with the ledger's initial fee
// parameters, from the fees the indexer reports for each transaction: the
// deploy 12.23 DUST, three verifier-key updates 9.87, 10.00 and 1.37, and the
// activation 0.26; 33.74 DUST in all.

import { formatDust } from '../../ui/format.ts';

export const MEASURED_ACCOUNT_DEPLOY = {
  transactions: 5,
  /** DUST for all of them, rounded up. */
  totalDust: 34,
  /** DUST for the largest one (the deploy itself), rounded up to a tenth. */
  largestDust: 12.3,
} as const;

/**
 * What to tell an owner whose deploy stopped for want of Dust. `dustAtStart`
 * is what the wallet had, in Specks, when the command began.
 */
export function deployShortOfDustNote(dustAtStart: bigint): string {
  const { transactions, totalDust, largestDust } = MEASURED_ACCOUNT_DEPLOY;
  return (
    `Deploying an account takes about ${totalDust} DUST over ${transactions} transactions, the largest about ${largestDust} DUST `
    + `(measured on a local ledger-9 chain). This wallet had ${formatDust(dustAtStart)} when the deploy began.\n`
    + 'Dust builds up with time from the NIGHT registered for it: see how much there is with "midnight dust status", '
    + 'and run the same command again when there is enough. A deploy that stopped part way carries on from where it stopped, '
    + 'so it then needs only what is left.'
  );
}
