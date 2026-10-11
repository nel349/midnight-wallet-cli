// Signing a balancing recipe without duplicating the signatures a dApp
// already attached. The transactions are real ledger-8 ones; the facade is a
// stand-in that records what it is asked to sign, since the point is which
// transaction mn hands it.

import { describe, expect, it } from 'vitest';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import type { BalancingRecipe, WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import {
  PartlySignedTransactionError, SignedTransactionNeedsUnshieldedError, assertSignable, signRecipe, unshieldedImbalanceSegments,
  unshieldedSignatures,
} from '../lib/sign-recipe.ts';
import type { UnsealedTransaction } from '../lib/tx-serde.ts';

const NIGHT = ledger.unshieldedToken().raw;
const TTL = new Date(Date.UTC(2030, 0, 1));
const AGENT = ledger.sampleSigningKey();
const OTHER = ledger.sampleSigningKey();
const MERCHANT = ledger.addressFromKey(ledger.signatureVerifyingKey(ledger.sampleSigningKey()));
const NOTHING_TO_PROVE = {
  check: () => { throw new Error('nothing to check'); },
  prove: () => { throw new Error('nothing to prove'); },
  lookupKey: () => { throw new Error('no key to look up'); },
} as unknown as ledger.ProvingProvider;

const spend = (owner: string, value: bigint, outputNo: number) =>
  ({ value, owner: ledger.signatureVerifyingKey(owner), type: NIGHT, intentHash: '00'.repeat(32), outputNo });

/** A proven, unsealed transaction: `inputs` paying `pays` to the merchant, signed by the first `signers` of them. */
async function transaction(inputs: Array<[string, bigint]>, pays: bigint, signers: number): Promise<UnsealedTransaction> {
  const intent = ledger.Intent.new(TTL);
  intent.guaranteedUnshieldedOffer = ledger.UnshieldedOffer.new(
    inputs.map(([owner, value], i) => spend(owner, value, i)),
    [{ value: pays, owner: MERCHANT, type: NIGHT }],
    [],
  );
  const data = intent.signatureData(1);
  if (signers > 0) {
    intent.guaranteedUnshieldedOffer = intent.guaranteedUnshieldedOffer.addSignatures(inputs.slice(0, signers).map(([owner]) => ledger.signData(owner, data)));
  }
  return ledger.Transaction.fromParts('undeployed', undefined, undefined, intent).prove(NOTHING_TO_PROVE, ledger.CostModel.initialCostModel());
}

const signedAndBalanced = () => transaction([[AGENT, 100n]], 100n, 1);
const unsigned = () => transaction([[AGENT, 100n]], 100n, 0);
const partlySigned = () => transaction([[AGENT, 60n], [OTHER, 40n]], 100n, 1);
const signedWithSurplus = () => transaction([[AGENT, 100n]], 60n, 1);

describe('unshieldedSignatures', () => {
  it('tells all signed, none signed and some signed apart', async () => {
    expect(unshieldedSignatures(await signedAndBalanced())).toBe('all');
    expect(unshieldedSignatures(await unsigned())).toBe('none');
    expect(unshieldedSignatures(await partlySigned())).toBe('some');
  });
});

describe('assertSignable', () => {
  it('accepts a transaction whose inputs are all signed and balanced, and one with none signed', async () => {
    const signed = await signedAndBalanced();
    const bare = await unsigned();
    expect(() => assertSignable(signed)).not.toThrow();
    expect(() => assertSignable(bare)).not.toThrow();
  });

  it('refuses one with some inputs signed and some not', async () => {
    const tx = await partlySigned();
    expect(() => assertSignable(tx)).toThrow(PartlySignedTransactionError);
    expect(() => assertSignable(tx)).toThrow('both signed and unsigned unshielded inputs');
  });

  // Balancing would merge the wallet's output for the 40 left over into the
  // dApp's own intent, which changes what the dApp signed.
  it('refuses a signed one that still needs unshielded value, naming the segment', async () => {
    const tx = await signedWithSurplus();
    expect(unshieldedImbalanceSegments(tx)).toEqual([0]);
    expect(() => assertSignable(tx)).toThrow(SignedTransactionNeedsUnshieldedError);
    expect(() => assertSignable(tx)).toThrow('segment 0 is not balanced in unshielded value');
  });
});

describe('signRecipe', () => {
  /** A facade that signs nothing and records which recipes it was asked to sign. */
  function recordingFacade() {
    const asked: BalancingRecipe[] = [];
    const facade = {
      signRecipe: async (recipe: BalancingRecipe) => {
        asked.push(recipe);
        return recipe.type === 'UNPROVEN_TRANSACTION' ? { ...recipe, transaction: { signed: recipe.transaction } } : { ...recipe, signedBy: 'facade' };
      },
    } as unknown as WalletFacade;
    return { facade, asked };
  }
  const sign = (data: Uint8Array) => ledger.signData(OTHER, data);
  const balancing = { the: 'wallet\'s own balancing transaction' } as never;
  const unbound = (baseTransaction: UnsealedTransaction, balancingTransaction: unknown = balancing) =>
    ({ type: 'UNBOUND_TRANSACTION', baseTransaction, balancingTransaction }) as unknown as BalancingRecipe;

  // Found live: the facade signed the dApp's transaction again, the ledger
  // counted two signatures for its one input, and the node refused it.
  it('signs only the wallet\'s balancing transaction when the dApp\'s inputs are already signed', async () => {
    const { facade, asked } = recordingFacade();
    const base = await signedAndBalanced();

    const signed = await signRecipe(facade, unbound(base), sign) as any;

    expect(asked).toEqual([{ type: 'UNPROVEN_TRANSACTION', transaction: balancing }]);
    expect(signed.type).toBe('UNBOUND_TRANSACTION');
    expect(signed.baseTransaction).toBe(base);
    expect(signed.balancingTransaction).toEqual({ signed: balancing });
    // The dApp's transaction still carries its one signature for its one input.
    expect(base.intents!.get(1)!.guaranteedUnshieldedOffer!.signatures).toHaveLength(1);
  });

  it('has the facade sign the whole recipe when the dApp left its inputs unsigned', async () => {
    const { facade, asked } = recordingFacade();
    const recipe = unbound(await unsigned());

    const signed = await signRecipe(facade, recipe, sign) as any;

    expect(asked).toEqual([recipe]);
    expect(signed.signedBy).toBe('facade');
  });

  it('refuses a partly signed transaction without asking the facade', async () => {
    const { facade, asked } = recordingFacade();
    await expect(signRecipe(facade, unbound(await partlySigned()), sign)).rejects.toThrow(PartlySignedTransactionError);
    expect(asked).toEqual([]);
  });

  it('returns a signed transaction that needed no balancing as it is', async () => {
    const { facade, asked } = recordingFacade();
    const recipe = { type: 'UNBOUND_TRANSACTION', baseTransaction: await signedAndBalanced(), balancingTransaction: undefined } as unknown as BalancingRecipe;
    expect(await signRecipe(facade, recipe, sign)).toBe(recipe);
    expect(asked).toEqual([]);
  });

  it('leaves every other kind of recipe to the facade', async () => {
    const { facade, asked } = recordingFacade();
    const recipe = { type: 'FINALIZED_TRANSACTION', originalTransaction: {}, balancingTransaction: {} } as unknown as BalancingRecipe;
    await signRecipe(facade, recipe, sign);
    expect(asked).toEqual([recipe]);
  });
});
