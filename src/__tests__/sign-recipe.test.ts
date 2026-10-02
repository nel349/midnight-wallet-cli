// signRecipe works around a wallet-sdk 2.0.0-rc.0 defect: the facade's signer
// re-appends the signatures already on a dApp's unshielded offer. These tests
// run real ledger-v9 transactions through a real WalletFacade built offline,
// and judge every result by the ledger's own well-formedness check.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LedgerState,
  Transaction,
  WellFormedStrictness,
  sampleSigningKey,
  signatureVerifyingKey,
  verifySignature,
  type Bindingish,
  type PreBinding,
  type PreProof,
  type Proofish,
  type Signature,
  type SignatureEnabled,
  type SignatureVerifyingKey,
} from '@midnightntwrk/ledger-v9';
import type { BalancingRecipe, WalletFacade } from '@midnightntwrk/wallet-sdk/facade';
import { feeOnlyRefusals, readDAppTransaction } from '../lib/fee-only-check.ts';
import { PartlySignedTransactionError, assertSignable, signRecipe, unshieldedSignatures } from '../lib/sign-recipe.ts';
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

/** The keystore's signer, counting how many segments it is asked to sign. */
function countingSigner() {
  const signer = (data: Uint8Array): Promise<Signature> => {
    signer.calls++;
    return keystore.signDataAsync(data);
  };
  signer.calls = 0;
  return signer;
}

/** Who signed each input of intent 1's guaranteed offer: the wallet, the agent, or neither. */
function signersOf(tx: Transaction<SignatureEnabled, Proofish, Bindingish>): string[] {
  const intent = tx.intents!.get(1)!;
  const data = intent.signatureData(1);
  const by = (key: SignatureVerifyingKey, s: Signature) => verifySignature(key, data, s);
  return intent.guaranteedUnshieldedOffer!.signatures.map((s) =>
    by(WALLET_VK, s.value) ? 'wallet' : by(AGENT_VK, s.value) ? 'agent' : 'neither');
}

const readUnproven = (bytes: Uint8Array) =>
  Transaction.deserialize<SignatureEnabled, PreProof, PreBinding>('signature', 'pre-proof', 'pre-binding', bytes);

/** The ledger's well-formedness verdict on the bound dApp transaction: signatures checked, balance and proofs not. */
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

/** The wallet's balancing transaction as the facade would book it: an unproven spend of the wallet's own input, unsigned. */
function walletBalancing() {
  return facade.adoptTransaction(
    buildTx({ guaranteed: { inputs: [spend(WALLET_SK, 5n, 7)], outputs: [pay(5n)], signers: [] } }).serialize(),
    'Unproven',
  );
}

function unboundRecipe(dappBytes: Uint8Array, balancingTransaction?: ReturnType<typeof walletBalancing>): BalancingRecipe {
  const baseTransaction = facade.adoptTransaction(dappBytes, 'Unbound');
  return { type: 'UNBOUND_TRANSACTION', protocolVersion: baseTransaction.protocolVersion, baseTransaction, balancingTransaction };
}

const PARTLY_SIGNED = buildTx({
  guaranteed: { inputs: [spend(AGENT_SK, 60n, 0)], outputs: [pay(60n)], signers: [AGENT_SK] },
  fallible: { inputs: [spend(WALLET_SK, 40n, 1)], outputs: [pay(40n)], signers: [] },
});

describe('unshieldedSignatures', () => {
  it.each([
    ['none: no unshielded inputs at all', buildTx({ guaranteed: { inputs: [], outputs: [], signers: [] } }), 'none'],
    ['none: every input unsigned', buildTx({ guaranteed: { inputs: [spend(WALLET_SK, 1n)], outputs: [pay(1n)], signers: [] } }), 'none'],
    ['all: every input signed', agentPaysMerchant(), 'all'],
    ['some: the second of two inputs unsigned', buildTx({
      guaranteed: { inputs: [spend(AGENT_SK, 1n, 0), spend(AGENT_SK, 1n, 1)], outputs: [pay(2n)], signers: [AGENT_SK] },
    }), 'some'],
    ['some: guaranteed signed, fallible unsigned', PARTLY_SIGNED, 'some'],
  ] as const)('%s', async (_name, tx, expected) => {
    expect(unshieldedSignatures(readDAppTransaction(await unsealedBytes(tx), 'unsealed'))).toBe(expected);
  });

  it('assertSignable refuses only the partly signed transaction', async () => {
    const signed = readDAppTransaction(await unsealedBytes(agentPaysMerchant()), 'unsealed');
    expect(() => assertSignable(signed)).not.toThrow();
    const partly = readDAppTransaction(await unsealedBytes(PARTLY_SIGNED), 'unsealed');
    expect(() => assertSignable(partly)).toThrow(PartlySignedTransactionError);
    expect(() => assertSignable(partly)).toThrow('both signed and unsigned unshielded inputs');
  });
});

describe('signRecipe', () => {
  it('signs only the balancing transaction when the dApp transaction is fully signed', async () => {
    const before = await unsealedBytes(agentPaysMerchant());
    const signer = countingSigner();

    const signed = await signRecipe(facade, unboundRecipe(before, walletBalancing()), signer);

    if (signed.type !== 'UNBOUND_TRANSACTION') throw new Error(`expected an unbound recipe, got ${signed.type}`);
    // One segment signed: the balancing transaction's intent, not the agent's.
    expect(signer.calls).toBe(1);
    const base = signed.baseTransaction.serialize();
    expect(Buffer.from(base).equals(Buffer.from(before))).toBe(true);
    expect(wellFormedError(base)).toBeUndefined();
    expect(signersOf(readUnproven(signed.balancingTransaction!.serialize()))).toEqual(['wallet']);
  });

  it('signs both through the facade when the dApp transaction has no signed inputs', async () => {
    const before = await unsealedBytes(buildTx({ guaranteed: { inputs: [spend(WALLET_SK, 100n)], outputs: [pay(100n)], signers: [] } }));
    const signer = countingSigner();

    const signed = await signRecipe(facade, unboundRecipe(before, walletBalancing()), signer);

    if (signed.type !== 'UNBOUND_TRANSACTION') throw new Error(`expected an unbound recipe, got ${signed.type}`);
    expect(signer.calls).toBe(2);
    const base = signed.baseTransaction.serialize();
    expect(signersOf(readDAppTransaction(base, 'unsealed'))).toEqual(['wallet']);
    expect(wellFormedError(base)).toBeUndefined();
    expect(signersOf(readUnproven(signed.balancingTransaction!.serialize()))).toEqual(['wallet']);
  });

  it('refuses a partly signed dApp transaction without signing anything', async () => {
    const before = await unsealedBytes(PARTLY_SIGNED);
    const recipe = unboundRecipe(before, walletBalancing());
    const signer = countingSigner();

    await expect(signRecipe(facade, recipe, signer)).rejects.toThrow(PartlySignedTransactionError);

    expect(signer.calls).toBe(0);
    if (recipe.type !== 'UNBOUND_TRANSACTION') throw new Error('unreachable');
    expect(Buffer.from(recipe.baseTransaction.serialize()).equals(Buffer.from(before))).toBe(true);
    expect(readUnproven(recipe.balancingTransaction!.serialize()).intents!.get(1)!.guaranteedUnshieldedOffer!.signatures).toEqual([]);
  });

  it('signs an unproven recipe through the facade', async () => {
    const transaction = walletBalancing();
    const signer = countingSigner();

    const signed = await signRecipe(facade, { type: 'UNPROVEN_TRANSACTION', protocolVersion: transaction.protocolVersion, transaction }, signer);

    if (signed.type !== 'UNPROVEN_TRANSACTION') throw new Error(`expected an unproven recipe, got ${signed.type}`);
    expect(signersOf(readUnproven(signed.transaction.serialize()))).toEqual(['wallet']);
  });
});

describe('the wallet SDK defect signRecipe works around', () => {
  // The facade's own signRecipe, on an offer the agent already signed: the SDK
  // builds the full per-input list (existing signature kept) and ledger-v9's
  // addSignatures appends it, so the signature comes back twice. When this
  // test fails, the SDK has changed how it attaches signatures: re-check
  // whether sign-recipe.ts's workaround is still needed.
  it('facade.signRecipe re-appends the agent\'s signature, leaving a transaction the ledger refuses', async () => {
    const before = await unsealedBytes(agentPaysMerchant());
    expect(wellFormedError(before)).toBeUndefined();

    const signed = await facade.signRecipe(unboundRecipe(before), keystore.signDataAsync);

    if (signed.type !== 'UNBOUND_TRANSACTION') throw new Error(`expected an unbound recipe, got ${signed.type}`);
    const after = signed.baseTransaction.serialize();
    expect(signersOf(readDAppTransaction(after, 'unsealed'))).toEqual(['agent', 'agent']);
    expect(wellFormedError(after)).toContain('mismatch between number of inputs (1) and signatures (2)');
  });
});

describe('an agent paying from an ECDSA (secp256k1) key', () => {
  // Ledger 9 takes unshielded inputs owned by either signature kind; mn's own
  // key is BIP-340 Schnorr.
  const agentEcdsa = sampleSigningKey('ecdsa');

  it('is a transaction the ledger accepts, and one the fee-only check passes', async () => {
    expect(signatureVerifyingKey(agentEcdsa).tag).toBe('ecdsa');
    const before = await unsealedBytes(buildTx({ guaranteed: { inputs: [spend(agentEcdsa, 100n)], outputs: [pay(100n)], signers: [agentEcdsa] } }));

    expect(wellFormedError(before)).toBeUndefined();
    expect(feeOnlyRefusals(readDAppTransaction(before, 'unsealed'), WALLET_VK)).toEqual([]);
  });

  it('comes through signRecipe byte-identical and well-formed', async () => {
    const before = await unsealedBytes(buildTx({ guaranteed: { inputs: [spend(agentEcdsa, 100n)], outputs: [pay(100n)], signers: [agentEcdsa] } }));
    const signer = countingSigner();

    const signed = await signRecipe(facade, unboundRecipe(before, walletBalancing()), signer);

    if (signed.type !== 'UNBOUND_TRANSACTION') throw new Error(`expected an unbound recipe, got ${signed.type}`);
    const base = signed.baseTransaction.serialize();
    expect(Buffer.from(base).equals(Buffer.from(before))).toBe(true);
    expect(wellFormedError(base)).toBeUndefined();
    expect(signer.calls).toBe(1);
  });

  // The SDK's signer checks the wallet's key against every input's owner, even
  // inputs already signed, so without signRecipe's workaround the fee wallet
  // could not serve this agent at all.
  it('is refused by facade.signRecipe, which checks the wallet\'s key against inputs it has nothing to sign', async () => {
    const before = await unsealedBytes(buildTx({ guaranteed: { inputs: [spend(agentEcdsa, 100n)], outputs: [pay(100n)], signers: [agentEcdsa] } }));

    await expect(facade.signRecipe(unboundRecipe(before), keystore.signDataAsync)).rejects.toThrow('Signature scheme does not match');
  });
});
