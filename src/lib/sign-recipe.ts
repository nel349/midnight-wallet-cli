// Signing a balancing recipe with the wallet's keystore, around a wallet-sdk
// 2.0.0-rc.0 defect.
//
// For an unbound recipe the facade signs the dApp's own transaction too. Its
// unshielded signer builds a full per-input signature list (signatures already
// there kept, empty slots filled with the wallet's) and hands it to ledger-v9's
// UnshieldedOffer.addSignatures, which appends. So every signature the dApp
// already attached comes back twice, and the ledger refuses the transaction
// ("mismatch between number of inputs (1) and signatures (2)").
//
// A dApp transaction whose unshielded inputs are all signed leaves the wallet
// nothing to sign in it, so mn signs only its own balancing transaction. One
// with no signed inputs signs correctly through the facade. One that mixes
// signed and unsigned inputs can't be signed correctly, so it is refused.
//
// Balancing unshielded value in an unbound transaction merges the wallet's
// inputs and outputs into the dApp's own intent, which changes the data the
// dApp signed. So a transaction whose unshielded inputs are signed can only be
// balanced for Dust; one that also needs unshielded value is refused.

import type { Signature } from '@midnightntwrk/ledger-v9';
import type { BalancingRecipe, WalletFacade } from '@midnightntwrk/wallet-sdk/facade';
import { readDAppTransaction, segmentsOf, unshieldedInputs, type FeeCheckTransaction } from './fee-only-check.ts';

export type SignSegment = (data: Uint8Array) => Promise<Signature>;

/** Whether a transaction's unshielded inputs carry signatures: none of them, all of them, or some. */
export type UnshieldedSignatures = 'none' | 'all' | 'some';

export function unshieldedSignatures(tx: FeeCheckTransaction): UnshieldedSignatures {
  const inputs = unshieldedInputs(tx);
  const signed = inputs.filter((input) => input.signed).length;
  if (signed === 0) return 'none';
  return signed === inputs.length ? 'all' : 'some';
}

/** A dApp transaction with both signed and unsigned unshielded inputs, which the wallet can't sign correctly. */
export class PartlySignedTransactionError extends Error {
  constructor() {
    super(
      'The transaction has both signed and unsigned unshielded inputs. This wallet can\'t add its signatures to it '
      + 'without duplicating the existing ones (a wallet SDK limitation): send it with every unshielded input signed, '
      + 'or with none signed.',
    );
    this.name = 'PartlySignedTransactionError';
    Object.setPrototypeOf(this, PartlySignedTransactionError.prototype);
  }
}

/** A dApp transaction with signed unshielded inputs that also needs unshielded value from the wallet. */
export class SignedTransactionNeedsUnshieldedError extends Error {
  constructor(segments: number[]) {
    super(
      `The transaction's unshielded inputs are already signed, but segment ${segments.join(', ')} is not balanced in `
      + 'unshielded value. This wallet balances it by adding inputs and outputs to the same intent, which invalidates '
      + 'those signatures. Leave the unshielded inputs unsigned so they are signed after balancing, or balance the '
      + 'sealed transaction with balanceSealedTransaction, which adds a separate intent.',
    );
    this.name = 'SignedTransactionNeedsUnshieldedError';
    Object.setPrototypeOf(this, SignedTransactionNeedsUnshieldedError.prototype);
  }
}

/** The segments whose unshielded value doesn't balance: what the wallet would add inputs or outputs for. */
export function unshieldedImbalanceSegments(tx: FeeCheckTransaction): number[] {
  return [...segmentsOf(tx)].filter((segment) =>
    [...tx.imbalances(segment)].some(([token, value]) => token.tag === 'unshielded' && value !== 0n));
}

/**
 * The dApp's unsealed transaction can be balanced and signed without breaking
 * it. Throws when it can't: some unshielded inputs signed and some not, or all
 * signed while `balancesUnshielded` would add unshielded value to it.
 */
export function assertSignable(tx: FeeCheckTransaction, balancesUnshielded: boolean): void {
  const state = unshieldedSignatures(tx);
  if (state === 'some') throw new PartlySignedTransactionError();
  if (state === 'all' && balancesUnshielded) {
    const segments = unshieldedImbalanceSegments(tx);
    if (segments.length > 0) throw new SignedTransactionNeedsUnshieldedError(segments);
  }
}

/** Sign a balancing recipe as the facade does, without re-signing a dApp transaction that is already signed. */
export async function signRecipe(
  facade: WalletFacade,
  recipe: BalancingRecipe,
  signSegment: SignSegment,
): Promise<BalancingRecipe> {
  if (recipe.type !== 'UNBOUND_TRANSACTION') return facade.signRecipe(recipe, signSegment);

  // Read before anything signs: signing mutates the transaction behind the handle.
  const base = readDAppTransaction(recipe.baseTransaction.serialize(), 'unsealed');
  const state = unshieldedSignatures(base);
  if (state === 'none') return facade.signRecipe(recipe, signSegment);
  if (state === 'some') throw new PartlySignedTransactionError();

  if (!recipe.balancingTransaction) return recipe;
  // The facade's own path for an unproven transaction: unshielded signatures, then a Dust registration's, if any.
  const signed = await facade.signRecipe(
    { type: 'UNPROVEN_TRANSACTION', protocolVersion: recipe.protocolVersion, transaction: recipe.balancingTransaction },
    signSegment,
  );
  if (signed.type !== 'UNPROVEN_TRANSACTION') {
    throw new Error(`The wallet SDK signed an unproven transaction into a ${signed.type} recipe`);
  }
  return { ...recipe, balancingTransaction: signed.transaction };
}
