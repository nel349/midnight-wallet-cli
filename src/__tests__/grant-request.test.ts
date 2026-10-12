// What `mn grant` is asked to do, checked from its arguments alone.

import { describe, expect, it } from 'vitest';
import { parseArgs } from '../lib/argv.ts';
import { UsageError } from '../lib/errors.ts';
import { describeGrantTerms, ownerArguments, paysAFee, resolveGrantRequest } from '../lib/grant/request.ts';

const request = (...argv: string[]) => resolveGrantRequest(parseArgs(['grant', ...argv]));
const LINK = 'midnight-example:grant-request?r=AAECAw';
const GRANT_ID = 'b1a9094fd044707d484a0193c1aa35a8e15bcf513a33b98a624a24739069fbde';

describe('resolveGrantRequest', () => {
  it('reads each subcommand', () => {
    expect(request('deploy', '--dev-owner-key')).toEqual({ subcommand: 'deploy', devOwnerKey: true });
    expect(request('deploy')).toEqual({ subcommand: 'deploy', devOwnerKey: false });
    expect(request('status')).toEqual({ subcommand: 'status' });
    expect(request('list')).toEqual({ subcommand: 'list' });
    expect(request('revoke-all')).toEqual({ subcommand: 'revoke-all' });
    expect(request('revoke', '3')).toEqual({ subcommand: 'revoke', target: '3' });
    expect(request('revoke', GRANT_ID)).toEqual({ subcommand: 'revoke', target: GRANT_ID });
  });

  it('reads an issue: the link, the limits given, and whether it is confirmed', () => {
    expect(request('issue', LINK)).toEqual({ subcommand: 'issue', link: LINK, limits: {}, confirmed: false });
    expect(request('issue', LINK, '--cap', '500000', '--per-call', '300000', '--max-coin', '2000000', '--expires-in', '3600', '--yes')).toEqual({
      subcommand: 'issue', link: LINK, confirmed: true,
      limits: { cap: '500000', perCall: '300000', maxCoin: '2000000', expiresIn: '3600' },
    });
  });

  it.each([
    [[], 'Usage: midnight grant <deploy|status|list|issue|revoke|revoke-all>'],
    [['grants'], 'Usage: midnight grant <deploy|status|list|issue|revoke|revoke-all>'],
    [['status', 'extra'], 'midnight grant status takes no argument; unexpected: extra'],
    [['deploy', 'now'], 'midnight grant deploy takes no argument; unexpected: now'],
    [['issue'], 'Missing the grant request link.'],
    [['issue', '--yes', LINK], 'Put --yes after the grant request link'],
    [['issue', LINK, 'another'], 'midnight grant issue takes one grant request link; unexpected: another'],
    [['issue', LINK, '--cap', '1.5'], '--cap must be a whole number; got "1.5"'],
    [['issue', LINK, '--per-call', '-5'], '--per-call must be a whole number; got "-5"'],
    [['issue', LINK, '--expires-in', '0'], '--expires-in must be at least 1 second'],
    [['revoke'], 'Missing the grant to revoke.'],
    [['revoke', 'the-first-one'], 'A grant is named by its id (64 hex characters) or its slot (a number); got "the-first-one"'],
    [['status', '--yes'], '--yes only applies to: midnight grant issue'],
    [['revoke', '3', '--cap', '5'], '--cap only applies to: midnight grant issue'],
    [['status', '--dev-owner-key'], '--dev-owner-key only applies to: midnight grant deploy'],
  ])('refuses %j as a usage mistake', (argv, message) => {
    expect(() => request(...argv)).toThrow(UsageError);
    expect(() => request(...argv)).toThrow(message);
  });
});

describe('ownerArguments', () => {
  const owner = (argv: string[], json = false) => {
    const parsed = request(...argv);
    if (parsed.subcommand === 'deploy') throw new Error('deploy is not an owner command');
    return ownerArguments(parsed, json);
  };

  it('puts a request as the account build\'s command line takes it', () => {
    expect(owner(['status'])).toEqual(['status']);
    expect(owner(['list'], true)).toEqual(['grants', '--json']);
    expect(owner(['revoke', '3'], true)).toEqual(['revoke', '3', '--json']);
    expect(owner(['revoke-all'])).toEqual(['revoke-all']);
    expect(owner(['issue', LINK])).toEqual(['issue', LINK]);
    expect(owner(['issue', LINK, '--expires-in', '60', '--cap', '9', '--yes'], true)).toEqual(['issue', LINK, '--cap', '9', '--expires-in', '60', '--yes', '--json']);
  });
});

describe('paysAFee', () => {
  it('is true of what submits transactions, false of what only reads', () => {
    expect(paysAFee(request('deploy', '--dev-owner-key'))).toBe(true);
    expect(paysAFee(request('revoke', '0'))).toBe(true);
    expect(paysAFee(request('revoke-all'))).toBe(true);
    expect(paysAFee(request('issue', LINK, '--yes'))).toBe(true);
    expect(paysAFee(request('issue', LINK))).toBe(false);
    expect(paysAFee(request('status'))).toBe(false);
    expect(paysAFee(request('list'))).toBe(false);
  });
});

describe('describeGrantTerms', () => {
  it('says every field the account build reports, under the build\'s name for it', () => {
    expect(describeGrantTerms({ clientId: 'rdns:example.agent', slot: 1, payee: 'coin key ab12', cap: '250000', expires: '2026-10-13T01:07:14.000Z' }))
      .toBe('clientId rdns:example.agent, slot 1, payee coin key ab12, cap 250000, expires 2026-10-13T01:07:14.000Z');
  });

  it('keeps a field it has never heard of, and one that isn\'t text', () => {
    expect(describeGrantTerms({ cap: '5', renewable: false, object: { color: '00' } })).toBe('cap 5, renewable false, object {"color":"00"}');
  });

  it('refuses to describe nothing: a user can\'t confirm terms that aren\'t there', () => {
    for (const nothing of [undefined, null, {}, [], 'cap 5']) {
      expect(() => describeGrantTerms(nothing)).toThrow('The account build reported no terms for this grant request.');
    }
  });
});
