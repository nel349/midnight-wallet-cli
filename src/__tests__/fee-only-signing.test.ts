// The premise behind fee-only-check.ts, run through the real SDK.
//
// When `mn serve` balances an unsealed dApp transaction it signs the recipe
// with `facade.signRecipe(recipe, keystore.signDataAsync)`, and for an unbound
// recipe the facade signs the dApp's own base transaction. These tests build
// a real WalletFacade offline (its wallets are never started, so nothing
// syncs) and hand that exact call real ledger-v9 transactions, to show:
// - on what feeOnlyRefusals passes, the wallet attaches no signature of its own;
// - on what it refuses for an unsigned input, the wallet does sign, so the
//   checks here would catch an attachment.
//
// Only external I/O is replaced: the chain-version probe (normally an indexer
// query) answers the ledger-v9 fork version, and the submission service
// (normally a node connection) refuses to submit. Endpoints point at a closed
// loopback port.

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
import { InMemoryTransactionHistoryStorage } from '@midnightntwrk/wallet-sdk';
import { DustWallet } from '@midnightntwrk/wallet-sdk/dust';
import {
  WalletFacade,
  WalletEntrySchema,
  mergeWalletEntries,
  type BalancingRecipe,
} from '@midnightntwrk/wallet-sdk/facade';
import { ShieldedWallet } from '@midnightntwrk/wallet-sdk/shielded';
import { PublicKey, UnshieldedWallet, createKeystore } from '@midnightntwrk/wallet-sdk/unshielded';
import { feeOnlyRefusals, readDAppTransaction } from '../lib/fee-only-check.ts';
import { FORK_SCHEDULE } from '../lib/network.ts';
import { DUST_COST_OVERHEAD, DUST_FEE_BLOCKS_MARGIN } from '../lib/constants.ts';
import {
  AGENT_SK, AGENT_VK, NETWORK, TTL, WALLET_SK, WALLET_VK,
  agentPaysMerchant, buildTx, pay, spend, unsealedBytes,
} from './helpers/ledger-tx.ts';

/** The secret behind the helpers' WALLET_SK, as mn's schnorr keystore takes it. */
const keystore = createKeystore({ kind: 'schnorr', secret: new Uint8Array(32).fill(1) }, NETWORK);

/** Nothing listens on port 9: a request that does go out fails instead of reaching a network. */
const CLOSED_HTTP = 'http://127.0.0.1:9';
const CLOSED_WS = 'ws://127.0.0.1:9';

let facade: WalletFacade;

beforeAll(async () => {
  facade = await WalletFacade.init({
    configuration: {
      networkId: NETWORK,
      forks: FORK_SCHEDULE,
      indexerClientConnection: { indexerHttpUrl: CLOSED_HTTP, indexerWsUrl: CLOSED_WS },
      costParameters: { additionalFeeOverhead: DUST_COST_OVERHEAD, feeBlocksMargin: DUST_FEE_BLOCKS_MARGIN },
      txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
      provingServerUrl: new URL(CLOSED_HTTP),
      relayURL: new URL(CLOSED_WS),
      // A ledger-9-native chain reports the fork version, which starts every wallet on its ledger-v9 variant.
      chainVersionProbe: () => Promise.resolve(FORK_SCHEDULE.v9),
    },
    submissionService: () => ({
      submitTransaction: () => Promise.reject<never>(new Error('these tests never submit')),
      close: () => Promise.resolve(),
    }),
    shielded: (cfg) => ShieldedWallet(cfg).startWithSeed(new Uint8Array(32).fill(4)),
    unshielded: (cfg) => UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(keystore)),
    dust: (cfg) => DustWallet(cfg).startWithSeed(new Uint8Array(32).fill(5)),
  });
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
  const signed = await facade.signRecipe(recipe, signer);
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

describe('facade.signRecipe on an unbound recipe, as mn serve calls it', () => {
  it('attaches no signature of the wallet\'s to an agent transaction feeOnlyRefusals passes', async () => {
    const before = await unsealedBytes(agentPaysMerchant());
    expect(feeOnlyRefusals(readDAppTransaction(before, 'unsealed'), WALLET_VK)).toEqual([]);

    const { after, signerCalls } = await signAsServe(before);

    // The wallet's signer is asked to sign the agent's intent, but nothing it returns is kept.
    expect(signerCalls).toBe(1);
    const b = offerAt(before, 'guaranteed');
    const a = offerAt(after, 'guaranteed');
    expect(a.signers).not.toContain('wallet');
    expect(a.inputs).toEqual(b.inputs);
    expect(a.outputs).toEqual(b.outputs);
  });

  it('attaches no signature of the wallet\'s when guaranteed and fallible inputs are all signed', async () => {
    const before = await unsealedBytes(buildTx({
      guaranteed: { inputs: [spend(AGENT_SK, 60n, 0)], outputs: [pay(60n)], signers: [AGENT_SK] },
      fallible: { inputs: [spend(AGENT_SK, 40n, 1)], outputs: [pay(40n)], signers: [AGENT_SK] },
    }));
    expect(feeOnlyRefusals(readDAppTransaction(before, 'unsealed'), WALLET_VK)).toEqual([]);

    const { after } = await signAsServe(before);

    for (const section of ['guaranteed', 'fallible'] as const) {
      const b = offerAt(before, section);
      const a = offerAt(after, section);
      expect(a.signers).not.toContain('wallet');
      expect(a.inputs).toEqual(b.inputs);
      expect(a.outputs).toEqual(b.outputs);
    }
  });

  // An SDK defect, recorded as it behaves today. The SDK builds a full,
  // per-input signature list (existing ones kept, empty slots filled) and hands
  // it to ledger-v9's UnshieldedOffer.addSignatures, which appends rather than
  // replaces. On an offer the agent already signed, every signature comes back
  // twice, and the ledger refuses the result as malformed. When this test
  // fails, the SDK has changed how it attaches signatures: re-check the
  // assertions above and drop this one.
  it('re-appends the agent\'s own signatures, leaving a transaction the ledger refuses', async () => {
    const before = await unsealedBytes(agentPaysMerchant());
    expect(wellFormedError(before)).toBeUndefined();

    const { after } = await signAsServe(before);

    const b = offerAt(before, 'guaranteed');
    const a = offerAt(after, 'guaranteed');
    expect(b.signers).toEqual(['agent']);
    expect(a.signatures).toEqual([...b.signatures, ...b.signatures]);
    expect(wellFormedError(after)).toContain('mismatch between number of inputs (1) and signatures (2)');
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

    const { after, signerCalls } = await signAsServe(before);

    expect(signerCalls).toBe(1);
    expect(Buffer.from(after).equals(Buffer.from(before))).toBe(true);
  });
});
