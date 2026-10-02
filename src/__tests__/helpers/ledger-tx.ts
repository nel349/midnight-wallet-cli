// Real ledger-v9 transactions built offline, as a dApp would hand them to the
// connector: one intent at segment 1 with unshielded offers, signed over the
// intent's real signature data, proven (there is nothing to prove) and
// serialized at the stage the dApp sends.

import {
  CostModel,
  Intent,
  SignatureEnabled,
  Transaction,
  UnshieldedOffer,
  addressFromKey,
  signData,
  signatureVerifyingKey,
  signingKeyFromBip340,
  unshieldedToken,
  type ProvingProvider,
  type SigningKey,
  type UnprovenTransaction,
  type UtxoOutput,
  type UtxoSpend,
} from '@midnightntwrk/ledger-v9';

export const NETWORK = 'undeployed';
export const TTL = new Date(Date.UTC(2030, 0, 1));
export const NIGHT = unshieldedToken().raw;

/** The wallet `mn serve` runs (the fee wallet). */
export const WALLET_SK = signingKeyFromBip340(new Uint8Array(32).fill(1));
/** The agent: holds its own value, never the wallet's. */
export const AGENT_SK = signingKeyFromBip340(new Uint8Array(32).fill(2));
export const WALLET_VK = signatureVerifyingKey(WALLET_SK);
export const AGENT_VK = signatureVerifyingKey(AGENT_SK);
export const MERCHANT = addressFromKey(signatureVerifyingKey(signingKeyFromBip340(new Uint8Array(32).fill(3))));

/** These transactions hold no zswap or contract parts, so proving them has nothing to prove. */
const NOTHING_TO_PROVE: ProvingProvider = {
  check: () => { throw new Error('unexpected proof check'); },
  prove: () => { throw new Error('unexpected proof'); },
  lookupKey: () => { throw new Error('unexpected key lookup'); },
};

export const spend = (owner: SigningKey, value: bigint, outputNo = 0): UtxoSpend => ({
  value, owner: signatureVerifyingKey(owner), type: NIGHT, intentHash: 'ab'.repeat(32), outputNo,
});
export const pay = (value: bigint): UtxoOutput => ({ value, owner: MERCHANT, type: NIGHT });

export interface OfferSpec {
  inputs: UtxoSpend[];
  outputs: UtxoOutput[];
  /** Who signs each input, in order; a missing entry leaves that input unsigned. */
  signers: SigningKey[];
}

export function buildTx(offers: { guaranteed?: OfferSpec; fallible?: OfferSpec }, ttl: Date = TTL): UnprovenTransaction {
  const intent = Intent.new(ttl);
  if (offers.guaranteed) intent.guaranteedUnshieldedOffer = UnshieldedOffer.new(offers.guaranteed.inputs, offers.guaranteed.outputs, []);
  if (offers.fallible) intent.fallibleUnshieldedOffer = UnshieldedOffer.new(offers.fallible.inputs, offers.fallible.outputs, []);
  const data = intent.signatureData(1);
  const sign = (spec: OfferSpec) => spec.signers.map((sk) => new SignatureEnabled(signData(sk, data)));
  if (offers.guaranteed && offers.guaranteed.signers.length > 0) {
    intent.guaranteedUnshieldedOffer = intent.guaranteedUnshieldedOffer!.addSignatures(sign(offers.guaranteed));
  }
  if (offers.fallible && offers.fallible.signers.length > 0) {
    intent.fallibleUnshieldedOffer = intent.fallibleUnshieldedOffer!.addSignatures(sign(offers.fallible));
  }
  return Transaction.fromParts(NETWORK, undefined, undefined, intent);
}

/** The agent pays the merchant 100 Night from its own signed input: nothing left for the wallet but the fee. */
export const agentPaysMerchant = () => buildTx({ guaranteed: { inputs: [spend(AGENT_SK, 100n)], outputs: [pay(100n)], signers: [AGENT_SK] } });

/** The bytes a dApp sends to balanceUnsealedTransaction. */
export async function unsealedBytes(tx: UnprovenTransaction): Promise<Uint8Array> {
  return (await tx.prove(NOTHING_TO_PROVE, CostModel.initialCostModel())).serialize();
}

/** The bytes a dApp sends to balanceSealedTransaction. */
export async function sealedBytes(tx: UnprovenTransaction): Promise<Uint8Array> {
  return (await tx.prove(NOTHING_TO_PROVE, CostModel.initialCostModel())).bind().serialize();
}
