// Tests for fee-only-check.ts — real ledger-v9 transactions built offline.

import { describe, it, expect } from 'vitest';
import {
  ClaimRewardsTransaction,
  Intent,
  SignatureEnabled,
  Transaction,
  ZswapOffer,
  ZswapOutput,
  createShieldedCoinInfo,
  sampleCoinPublicKey,
  sampleEncryptionPublicKey,
  shieldedToken,
  signData,
} from '@midnightntwrk/ledger-v9';
import { expiredIntents, feeOnlyRefusals, readDAppTransaction } from '../lib/fee-only-check.ts';
import {
  AGENT_SK, AGENT_VK, NETWORK, NIGHT, TTL, WALLET_SK, WALLET_VK,
  agentPaysMerchant, buildTx, pay, sealedBytes, spend, unsealedBytes,
} from './helpers/ledger-tx.ts';

describe('readDAppTransaction', () => {
  it('reads proven pre-binding bytes as unsealed and bound bytes as sealed', async () => {
    const unsealed = readDAppTransaction(await unsealedBytes(agentPaysMerchant()), 'unsealed');
    const sealed = readDAppTransaction(await sealedBytes(agentPaysMerchant()), 'sealed');
    expect(unsealed.intents?.get(1)?.binding.instance).toBe('pre-binding');
    expect(sealed.intents?.get(1)?.binding.instance).toBe('binding');
  });

  it('refuses bytes of another stage, and unproven bytes', async () => {
    const unsealed = await unsealedBytes(agentPaysMerchant());
    const sealed = await sealedBytes(agentPaysMerchant());
    expect(() => readDAppTransaction(unsealed, 'sealed')).toThrow();
    expect(() => readDAppTransaction(sealed, 'unsealed')).toThrow();
    expect(() => readDAppTransaction(agentPaysMerchant().serialize(), 'unsealed')).toThrow();
  });
});

describe('feeOnlyRefusals', () => {
  it.each(['unsealed', 'sealed'] as const)('passes a %s transaction whose value is the caller\'s own, signed and balanced', async (stage) => {
    const bytes = stage === 'unsealed' ? await unsealedBytes(agentPaysMerchant()) : await sealedBytes(agentPaysMerchant());
    expect(feeOnlyRefusals(readDAppTransaction(bytes, stage), WALLET_VK)).toEqual([]);
  });

  it('passes a transaction with no unshielded value at all', async () => {
    const tx = Transaction.fromParts(NETWORK, undefined, undefined, Intent.new(TTL));
    expect(feeOnlyRefusals(readDAppTransaction(await unsealedBytes(tx), 'unsealed'), WALLET_VK)).toEqual([]);
  });

  it('refuses an input owned by the wallet\'s own key, even one already signed', async () => {
    const tx = buildTx({ guaranteed: { inputs: [spend(WALLET_SK, 100n)], outputs: [pay(100n)], signers: [WALLET_SK] } });
    expect(feeOnlyRefusals(readDAppTransaction(await unsealedBytes(tx), 'unsealed'), WALLET_VK)).toEqual([
      "intent 1 guaranteed unshielded input 0 spends this wallet's own funds",
    ]);
  });

  it('refuses an unsigned input the wallet would sign, naming its section', async () => {
    const tx = buildTx({
      guaranteed: { inputs: [spend(AGENT_SK, 60n, 0)], outputs: [pay(60n)], signers: [AGENT_SK] },
      fallible: { inputs: [spend(AGENT_SK, 40n, 1)], outputs: [pay(40n)], signers: [] },
    });
    expect(feeOnlyRefusals(readDAppTransaction(await unsealedBytes(tx), 'unsealed'), WALLET_VK)).toEqual([
      'intent 1 fallible unshielded input 0 is unsigned, so this wallet would sign it',
    ]);
  });

  it('refuses the second of two inputs when only the first is signed', async () => {
    const tx = buildTx({
      guaranteed: { inputs: [spend(AGENT_SK, 60n, 0), spend(AGENT_SK, 40n, 1)], outputs: [pay(100n)], signers: [AGENT_SK] },
    });
    expect(feeOnlyRefusals(readDAppTransaction(await unsealedBytes(tx), 'unsealed'), WALLET_VK)).toEqual([
      'intent 1 guaranteed unshielded input 1 is unsigned, so this wallet would sign it',
    ]);
  });

  it('refuses an unshielded output nobody funds (a deposit left for the wallet to pay)', async () => {
    const tx = buildTx({ guaranteed: { inputs: [], outputs: [pay(100n)], signers: [] } });
    expect(feeOnlyRefusals(readDAppTransaction(await unsealedBytes(tx), 'unsealed'), WALLET_VK)).toEqual([
      `segment 0 is short 100 of unshielded token ${NIGHT}, which a Dust-only balance can't fund`,
    ]);
  });

  it('refuses a shortfall in a fallible segment', async () => {
    const tx = buildTx({ fallible: { inputs: [spend(AGENT_SK, 30n)], outputs: [pay(70n)], signers: [AGENT_SK] } });
    expect(feeOnlyRefusals(readDAppTransaction(await sealedBytes(tx), 'sealed'), WALLET_VK)).toEqual([
      `segment 1 is short 40 of unshielded token ${NIGHT}, which a Dust-only balance can't fund`,
    ]);
  });

  it('refuses a shielded output nobody funds', () => {
    const coin = createShieldedCoinInfo(shieldedToken().raw, 50n);
    const output = ZswapOutput.new(coin, 0, sampleCoinPublicKey(), sampleEncryptionPublicKey());
    const tx = Transaction.fromParts(NETWORK, ZswapOffer.fromOutput(output, coin.type, coin.value));
    expect(feeOnlyRefusals(tx, WALLET_VK)).toEqual([
      `segment 0 is short 50 of shielded token ${shieldedToken().raw}, which a Dust-only balance can't fund`,
    ]);
  });

  it('accepts a surplus: the caller overpaying asks nothing of the wallet', async () => {
    const tx = buildTx({ guaranteed: { inputs: [spend(AGENT_SK, 100n)], outputs: [pay(90n)], signers: [AGENT_SK] } });
    expect(feeOnlyRefusals(readDAppTransaction(await unsealedBytes(tx), 'unsealed'), WALLET_VK)).toEqual([]);
  });

  it('reports every reason at once', async () => {
    const tx = buildTx({ guaranteed: { inputs: [spend(WALLET_SK, 10n)], outputs: [pay(25n)], signers: [] } });
    expect(feeOnlyRefusals(readDAppTransaction(await unsealedBytes(tx), 'unsealed'), WALLET_VK)).toEqual([
      "intent 1 guaranteed unshielded input 0 spends this wallet's own funds",
      'intent 1 guaranteed unshielded input 0 is unsigned, so this wallet would sign it',
      `segment 0 is short 15 of unshielded token ${NIGHT}, which a Dust-only balance can't fund`,
    ]);
  });

  it('refuses a rewards claim, which is not a standard transaction', () => {
    const nonce = 'cd'.repeat(32);
    const unsigned = ClaimRewardsTransaction.new(NETWORK, 100n, AGENT_VK, nonce, 'Reward');
    const signature = new SignatureEnabled(signData(AGENT_SK, unsigned.dataToSign));
    const claim = new ClaimRewardsTransaction('signature', NETWORK, 100n, AGENT_VK, nonce, signature, 'Reward');
    expect(feeOnlyRefusals(Transaction.fromRewards(claim), WALLET_VK)).toEqual([
      'it is a rewards claim, not a standard transaction',
    ]);
  });

  it('checks ownership by the wallet\'s key, not by who signed', async () => {
    // The agent's input carries the wallet's signature: still the agent's coin, so not the wallet's funds.
    const tx = buildTx({ guaranteed: { inputs: [spend(AGENT_SK, 100n)], outputs: [pay(100n)], signers: [WALLET_SK] } });
    expect(feeOnlyRefusals(readDAppTransaction(await unsealedBytes(tx), 'unsealed'), AGENT_VK)).toEqual([
      "intent 1 guaranteed unshielded input 0 spends this wallet's own funds",
    ]);
  });
});

describe('expiredIntents', () => {
  // Whole seconds: the ledger keeps an intent's TTL to the second.
  const at = (iso: string) => new Date(iso);
  const tx = async (ttl: Date) => readDAppTransaction(await unsealedBytes(buildTx({
    guaranteed: { inputs: [spend(AGENT_SK, 100n)], outputs: [pay(100n)], signers: [AGENT_SK] },
  }, ttl)), 'unsealed');

  it('names an intent whose TTL has passed, with its TTL', async () => {
    expect(expiredIntents(await tx(at('2026-10-02T10:00:00Z')), at('2026-10-02T10:00:01Z')))
      .toEqual([{ segment: 1, ttl: at('2026-10-02T10:00:00Z') }]);
  });

  it('counts a TTL equal to now as expired, and a later one as not', async () => {
    const t = await tx(at('2026-10-02T10:00:00Z'));
    expect(expiredIntents(t, at('2026-10-02T10:00:00Z'))).toHaveLength(1);
    expect(expiredIntents(t, at('2026-10-02T09:59:59Z'))).toEqual([]);
  });
});
