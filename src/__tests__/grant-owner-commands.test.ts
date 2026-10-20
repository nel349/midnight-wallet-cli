// The owner's commands as mn gives them, for what needs no chain: reading a
// grant request link, and the terms an issue would grant before anything is
// signed, with mn's defaults for the limits not given.

import { describe, expect, it } from 'vitest';
import { freshGrantee, grantRequestFor, grantRequestLink } from '@kuiralabs/midnight-account-chain/agent';
import { UsageError } from '../lib/errors.ts';
import { DEFAULT_GRANT_LIMITS, grantRequestOf, issuePreview } from '../lib/grant/owner-commands.ts';

const ACCOUNT = '5e'.repeat(32);
const NOW = new Date('2026-10-18T12:00:00.000Z');
const MERCHANT = new Uint8Array(32).fill(0x9a);

// A request as an agent sends it, for a payment to one coin key (kind 2) or to any (kind 0), and through a calling contract if one is named.
const linkFor = (payToKind: 0 | 2, caller?: Uint8Array) => {
  const grantee = freshGrantee('k1');
  const identity = { account: ACCOUNT, clientId: 'rdns:org.example.agent', grantee, readSecret: new Uint8Array(32).fill(7) };
  return grantRequestLink(grantRequestFor(identity, 3, payToKind === 0 ? new Uint8Array(32) : MERCHANT, payToKind, caller));
};

describe('a grant request link', () => {
  it('is read as the request the agent sent', () => {
    const request = grantRequestOf(linkFor(2));
    expect(request.account).toBe(ACCOUNT);
    expect(request.slot).toBe(3);
    expect(request.clientId).toBe('rdns:org.example.agent');
  });

  it('is refused as a usage error when it is not one', () => {
    expect(() => grantRequestOf('midnight-example:grant-request?r=AAECAw')).toThrow(UsageError);
  });
});

describe('what an issue would grant', () => {
  it("takes mn's defaults for the limits not given, and signs nothing", () => {
    const { result, lines } = issuePreview(grantRequestOf(linkFor(2)), {}, NOW);
    expect(result).toEqual({
      confirmed: false,
      request: {
        account: ACCOUNT,
        clientId: 'rdns:org.example.agent',
        slot: 3,
        grantee: 'k1',
        payee: `coin key ${'9a'.repeat(32)}`,
        caller: 'via any caller',
        perCallCap: DEFAULT_GRANT_LIMITS.perCallCap.toString(),
        cap: DEFAULT_GRANT_LIMITS.cap.toString(),
        maxCoinValue: DEFAULT_GRANT_LIMITS.maxCoinValue.toString(),
        expires: new Date(NOW.getTime() + DEFAULT_GRANT_LIMITS.expiresInSeconds * 1000).toISOString(),
      },
    });
    expect(lines[0]).toBe('the request asks for:');
    expect(lines.at(-1)).toBe('re-run with --yes to issue it');
  });

  it('takes the limits given', () => {
    const { result } = issuePreview(grantRequestOf(linkFor(0)), { cap: '900', perCall: '100', maxCoin: '50', expiresIn: '60' }, NOW);
    expect(result.request).toMatchObject({ payee: 'any shielded coin key', perCallCap: '100', cap: '900', maxCoinValue: '50', expires: '2026-10-18T12:01:00.000Z' });
  });

  it('names the calling contract a request pins, in full, and what the pin means', () => {
    const { result, lines } = issuePreview(grantRequestOf(linkFor(2, new Uint8Array(32).fill(0xc4))), {}, NOW);
    const caller = `via contract ${'c4'.repeat(32)} only: the agent spends only when that contract calls the account, and that call is public on chain`;
    expect(result.request).toMatchObject({ caller });
    expect(lines).toContain(`  caller: ${caller}`);
  });
});
