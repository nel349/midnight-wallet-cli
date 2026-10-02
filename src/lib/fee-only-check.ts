// Fee-wallet scope check for `mn serve --approve-fees`.
//
// Balancing Dust-only limits what the wallet ADDS to a dApp's transaction, not
// what it AUTHORIZES: signing an unbound recipe signs the dApp's own
// transaction, and the unshielded signer fills every empty signature slot of
// every unshielded input, whoever owns it. So before a balance may count as
// fee-only, the dApp's transaction itself has to leave the wallet nothing to
// sign and nothing to fund but the fee.

import {
  Transaction,
  addressFromKey,
  type Binding,
  type Bindingish,
  type PreBinding,
  type Proof,
  type Proofish,
  type SignatureEnabled,
  type SignatureVerifyingKey,
  type UnshieldedOffer,
} from '@midnightntwrk/ledger-v9';

/** How far along the dApp's transaction is: `balanceUnsealedTransaction` or `balanceSealedTransaction`. */
export type DAppTxStage = 'unsealed' | 'sealed';

export type FeeCheckTransaction = Transaction<SignatureEnabled, Proofish, Bindingish>;

/** The guaranteed section is segment 0; each intent's fallible section is its own segment. */
const GUARANTEED_SEGMENT = 0;

/**
 * Read a dApp's transaction as ledger 9 at its stage. Throws when the bytes are
 * not a proven, signature-enabled transaction of that stage.
 */
export function readDAppTransaction(bytes: Uint8Array, stage: DAppTxStage): FeeCheckTransaction {
  return stage === 'unsealed'
    ? Transaction.deserialize<SignatureEnabled, Proof, PreBinding>('signature', 'proof', 'pre-binding', bytes)
    : Transaction.deserialize<SignatureEnabled, Proof, Binding>('signature', 'proof', 'binding', bytes);
}

/**
 * Why paying only the Dust fee for `tx` would not keep the wallet to the fee.
 * Empty when it would. Refuses when:
 * - an unshielded input is owned by `walletKey` (the dApp would spend the wallet's Night);
 * - an unshielded input has no signature (the wallet's signer would sign it);
 * - a segment is short of any non-Dust token (Dust-only balancing can't fund it);
 * - the transaction is a rewards claim, not a standard transaction.
 */
export function feeOnlyRefusals(tx: FeeCheckTransaction, walletKey: SignatureVerifyingKey): string[] {
  if (tx.rewards !== undefined) {
    return ['it is a rewards claim, not a standard transaction'];
  }

  const reasons: string[] = [];
  const walletAddress = addressFromKey(walletKey);

  for (const [segment, intent] of tx.intents ?? new Map()) {
    const offers: Array<[string, UnshieldedOffer<SignatureEnabled> | undefined]> = [
      ['guaranteed', intent.guaranteedUnshieldedOffer],
      ['fallible', intent.fallibleUnshieldedOffer],
    ];
    for (const [section, offer] of offers) {
      if (!offer) continue;
      offer.inputs.forEach((input, i) => {
        const where = `intent ${segment} ${section} unshielded input ${i}`;
        if (addressFromKey(input.owner) === walletAddress) {
          reasons.push(`${where} spends this wallet's own funds`);
        }
        if (offer.signatures[i] === undefined) {
          reasons.push(`${where} is unsigned, so this wallet would sign it`);
        }
      });
    }
  }

  const segments = new Set<number>([
    GUARANTEED_SEGMENT,
    ...(tx.intents?.keys() ?? []),
    ...(tx.fallibleOffer?.keys() ?? []),
  ]);
  for (const segment of segments) {
    let imbalances: Map<{ tag: string; raw?: string }, bigint>;
    try {
      imbalances = tx.imbalances(segment);
    } catch (err) {
      reasons.push(`segment ${segment}'s balance could not be computed: ${(err as Error).message ?? err}`);
      continue;
    }
    for (const [token, value] of imbalances) {
      if (token.tag === 'dust' || value >= 0n) continue;
      reasons.push(`segment ${segment} is short ${-value} of ${token.tag} token ${token.raw}, which a Dust-only balance can't fund`);
    }
  }

  return reasons;
}
