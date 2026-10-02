// The premise behind fee-only-check.ts, run through the real SDK.
//
// When `mn serve` balances an unsealed dApp transaction it signs the recipe
// with sign-recipe.ts's `signRecipe`, which hands an unbound recipe to the
// facade's signer unless the dApp's transaction is already fully signed. These
// tests build a real WalletFacade offline and hand that exact call real
// ledger-v9 transactions, to show:
// - on what feeOnlyRefusals passes, the wallet attaches no signature of its own
//   and the transaction stays one the ledger accepts;
// - on what it refuses for an unsigned input, the wallet does sign, so the
//   checks here would catch an attachment.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ContractDeploy,
  ContractState,
  Intent,
  LedgerState,
  Transaction,
  WellFormedStrictness,
  verifySignature,
  type Signature,
  type SignatureVerifyingKey,
} from '@midnightntwrk/ledger-v9';
import type { BalancingRecipe, WalletFacade } from '@midnightntwrk/wallet-sdk/facade';
import { feeOnlyRefusals, readDAppTransaction } from '../lib/fee-only-check.ts';
import { signRecipe } from '../lib/sign-recipe.ts';
import {
  AGENT_SK, AGENT_VK, NETWORK, TTL, WALLET_SK, WALLET_VK,
  agentPaysMerchant, buildTx, pay, spend, unsealedBytes,
} from './helpers/ledger-tx.ts';
import { initOfflineFacade, keystore } from './helpers/offline-facade.ts';

let facade: WalletFacade;

beforeAll(async () => {
  facade = await initOfflineFacade();
});

afterAll(async () => {
  await facade?.stop();
});

/**
 * What `mn serve` does to an unsealed dApp transaction, minus the Dust
 * balancing: adopt the bytes, then sign the unbound recipe with the wallet's
 * keystore. Returns the base transaction's bytes after signing, and how many
 * segments the wallet's signer was asked to sign.
 */
async function signAsServe(dappBytes: Uint8Array): Promise<{ after: Uint8Array; signerCalls: number }> {
  const baseTransaction = facade.adoptTransaction(dappBytes, 'Unbound');
  const recipe: BalancingRecipe = { type: 'UNBOUND_TRANSACTION', protocolVersion: baseTransaction.protocolVersion, baseTransaction };
  let signerCalls = 0;
  const signer = (data: Uint8Array): Promise<Signature> => {
    signerCalls++;
    return keystore.signDataAsync(data);
  };
  const signed = await signRecipe(facade, recipe, signer);
  if (signed.type !== 'UNBOUND_TRANSACTION') throw new Error(`expected an unbound recipe back, got ${signed.type}`);
  expect(signed.balancingTransaction).toBeUndefined();
  return { after: signed.baseTransaction.serialize(), signerCalls };
}

type Section = 'guaranteed' | 'fallible';

/** One unshielded offer of intent 1, with each signature tagged by the key it verifies under. */
function offerAt(bytes: Uint8Array, section: Section) {
  const intent = readDAppTransaction(bytes, 'unsealed').intents!.get(1)!;
  const offer = section === 'guaranteed' ? intent.guaranteedUnshieldedOffer! : intent.fallibleUnshieldedOffer!;
  const data = intent.signatureData(1);
  const signedBy = (key: SignatureVerifyingKey, s: Signature) => verifySignature(key, data, s);
  return {
    inputs: offer.inputs,
    outputs: offer.outputs,
    signatures: offer.signatures.map((s) => s.toString()),
    signers: offer.signatures.map((s) =>
      signedBy(WALLET_VK, s.value) ? 'wallet' : signedBy(AGENT_VK, s.value) ? 'agent' : 'neither'),
  };
}

/** The ledger's own well-formedness verdict on the bound transaction, signatures checked, balance and proofs not. */
function wellFormedError(bytes: Uint8Array): string | undefined {
  const strictness = new WellFormedStrictness();
  strictness.enforceBalancing = false;
  strictness.verifyNativeProofs = false;
  strictness.verifyContractProofs = false;
  strictness.verifySignatures = true;
  // Half an hour before the helpers' TTL: inside the window the ledger accepts a TTL in.
  const blockTime = new Date(TTL.getTime() - 30 * 60 * 1000);
  try {
    readDAppTransaction(bytes, 'unsealed').bind().wellFormed(LedgerState.blank(NETWORK), strictness, blockTime);
    return undefined;
  } catch (err) {
    return String(err);
  }
}

describe('the keystore mn signs with', () => {
  it('is the fee wallet the transaction helpers build against', () => {
    expect(keystore.getPublicKey()).toEqual(WALLET_VK);
  });
});

describe('signRecipe on an unbound recipe, as mn serve calls it', () => {
  it('leaves an agent transaction feeOnlyRefusals passes byte-identical and well-formed, signing nothing', async () => {
    const before = await unsealedBytes(agentPaysMerchant());
    expect(feeOnlyRefusals(readDAppTransaction(before, 'unsealed'), WALLET_VK)).toEqual([]);
    expect(wellFormedError(before)).toBeUndefined();

    const { after, signerCalls } = await signAsServe(before);

    expect(signerCalls).toBe(0);
    expect(offerAt(after, 'guaranteed').signers).toEqual(['agent']);
    expect(Buffer.from(after).equals(Buffer.from(before))).toBe(true);
    expect(wellFormedError(after)).toBeUndefined();
  });

  it('leaves a transaction whose guaranteed and fallible inputs are all signed byte-identical and well-formed', async () => {
    const before = await unsealedBytes(buildTx({
      guaranteed: { inputs: [spend(AGENT_SK, 60n, 0)], outputs: [pay(60n)], signers: [AGENT_SK] },
      fallible: { inputs: [spend(AGENT_SK, 40n, 1)], outputs: [pay(40n)], signers: [AGENT_SK] },
    }));
    expect(feeOnlyRefusals(readDAppTransaction(before, 'unsealed'), WALLET_VK)).toEqual([]);

    const { after, signerCalls } = await signAsServe(before);

    expect(signerCalls).toBe(0);
    for (const section of ['guaranteed', 'fallible'] as const) {
      expect(offerAt(after, section).signers).toEqual(['agent']);
    }
    expect(Buffer.from(after).equals(Buffer.from(before))).toBe(true);
    expect(wellFormedError(after)).toBeUndefined();
  });

  it('does sign an unsigned input the wallet owns, which feeOnlyRefusals refuses', async () => {
    const before = await unsealedBytes(buildTx({ guaranteed: { inputs: [spend(WALLET_SK, 100n)], outputs: [pay(100n)], signers: [] } }));
    expect(feeOnlyRefusals(readDAppTransaction(before, 'unsealed'), WALLET_VK)).toEqual([
      "intent 1 guaranteed unshielded input 0 spends this wallet's own funds",
      'intent 1 guaranteed unshielded input 0 is unsigned, so this wallet would sign it',
    ]);

    const { after } = await signAsServe(before);

    expect(offerAt(before, 'guaranteed').signers).toEqual([]);
    expect(offerAt(after, 'guaranteed').signers).toEqual(['wallet']);
    // Signed for real: the wallet has just authorized spending its own Night.
    expect(wellFormedError(after)).toBeUndefined();
  });

  it('signs an unsigned input it does not own too, which feeOnlyRefusals refuses', async () => {
    const before = await unsealedBytes(buildTx({ guaranteed: { inputs: [spend(AGENT_SK, 100n)], outputs: [pay(100n)], signers: [] } }));
    expect(feeOnlyRefusals(readDAppTransaction(before, 'unsealed'), WALLET_VK)).toEqual([
      'intent 1 guaranteed unshielded input 0 is unsigned, so this wallet would sign it',
    ]);

    const { after } = await signAsServe(before);

    expect(offerAt(after, 'guaranteed').signers).toEqual(['wallet']);
  });

  it('leaves a contract-action transaction with no unshielded offers byte-identical', async () => {
    // A contract call needs a proof server to prove; a deploy is the contract action that proves offline.
    const intent = Intent.new(TTL).addDeploy(new ContractDeploy(new ContractState()));
    const before = await unsealedBytes(Transaction.fromParts(NETWORK, undefined, undefined, intent));
    const read = readDAppTransaction(before, 'unsealed').intents!.get(1)!;
    expect(read.actions).toHaveLength(1);
    expect(read.guaranteedUnshieldedOffer).toBeUndefined();
    expect(read.fallibleUnshieldedOffer).toBeUndefined();
    expect(feeOnlyRefusals(readDAppTransaction(before, 'unsealed'), WALLET_VK)).toEqual([]);

    const { after } = await signAsServe(before);

    expect(Buffer.from(after).equals(Buffer.from(before))).toBe(true);
  });
});
