// What `mn grant` is asked to do, read from its arguments and checked before
// anything starts: the CLI checks it before the wallet is looked at, the MCP
// server before it issues a confirmation token.

import { type ParsedArgs, getFlag, hasFlag } from '../argv.ts';
import { UsageError } from '../errors.ts';
import { nightToMicro, parseAmount } from '../transfer.ts';

export const GRANT_SUBCOMMANDS = ['deploy', 'deposit', 'status', 'list', 'issue', 'revoke', 'revoke-all'] as const;
export type GrantSubcommand = typeof GRANT_SUBCOMMANDS[number];

export type GrantRequest =
  | { subcommand: 'deploy'; devOwnerKey: boolean }
  /** `amount` as given, in NIGHT; `value` the same in the smallest unit, as decimal text. */
  | { subcommand: 'deposit'; amount: string; value: string }
  | { subcommand: 'status' }
  | { subcommand: 'list' }
  | { subcommand: 'issue'; link: string; limits: GrantLimits; confirmed: boolean }
  | { subcommand: 'revoke'; target: string }
  | { subcommand: 'revoke-all' };

/** Limits an issue may set, each a whole number as text; the account build's defaults stand for those not given. */
export interface GrantLimits {
  /** The most the grant may ever pay, in the token's smallest unit. */
  cap?: string;
  /** The most one payment may be. */
  perCall?: string;
  /** The largest coin the agent may take to pay from. */
  maxCoin?: string;
  /** Seconds until the grant expires. */
  expiresIn?: string;
}

const LIMIT_FLAGS = [['cap', 'cap'], ['per-call', 'perCall'], ['max-coin', 'maxCoin'], ['expires-in', 'expiresIn']] as const;

export const GRANT_USAGE =
  `Usage: midnight grant <${GRANT_SUBCOMMANDS.join('|')}>\n\n` +
  `  deploy       Deploy this wallet's account, which holds what an agent may spend\n` +
  `  deposit      Move shielded NIGHT from this wallet into its account\n` +
  `  status       The account, its owner key and what it holds\n` +
  `  list         Every grant on the account\n` +
  `  issue        Show a grant request (an agent's link); issue it with --yes\n` +
  `  revoke       Revoke one grant, by its id or slot\n` +
  `  revoke-all   Revoke every grant\n\n` +
  `Run "midnight help grant" for more info.`;

export function isGrantSubcommand(value: string | undefined): value is GrantSubcommand {
  return (GRANT_SUBCOMMANDS as readonly string[]).includes(value ?? '');
}

/** A grant's id (32 bytes of hex) or its slot number. */
const GRANT_TARGET = /^(?:[0-9a-fA-F]{64}|\d+)$/;

function onlyFor(args: ParsedArgs, subcommand: GrantSubcommand, flags: readonly string[], allowedOn: readonly GrantSubcommand[]): void {
  if (allowedOn.includes(subcommand)) return;
  const given = flags.find((flag) => args.flags[flag] !== undefined);
  if (given !== undefined) throw new UsageError(`--${given} only applies to: midnight grant ${allowedOn.join(', ')}`);
}

function positionalsFor(args: ParsedArgs, subcommand: GrantSubcommand, atMost: number, what: string): string[] {
  if (args.positionals.length > atMost) {
    const extra = args.positionals.slice(atMost).join(' ');
    throw new UsageError(`midnight grant ${subcommand} takes ${what}; unexpected: ${extra}`);
  }
  return args.positionals;
}

export function resolveGrantRequest(args: ParsedArgs): GrantRequest {
  const subcommand = args.subcommand;
  if (!isGrantSubcommand(subcommand)) throw new UsageError(GRANT_USAGE);

  onlyFor(args, subcommand, ['dev-owner-key'], ['deploy']);
  onlyFor(args, subcommand, [...LIMIT_FLAGS.map(([flag]) => flag), 'yes'], ['issue']);

  switch (subcommand) {
    case 'deploy':
      positionalsFor(args, subcommand, 0, 'no argument');
      return { subcommand, devOwnerKey: hasFlag(args, 'dev-owner-key') };
    case 'deposit': {
      const [amount] = positionalsFor(args, subcommand, 1, 'one amount of NIGHT');
      if (amount === undefined) throw new UsageError('Missing the amount of NIGHT to deposit.\nUsage: midnight grant deposit <amount>');
      return { subcommand, amount, value: nightToMicro(parseAmount(amount)).toString() };
    }
    case 'status':
    case 'list':
    case 'revoke-all':
      positionalsFor(args, subcommand, 0, 'no argument');
      return { subcommand };
    case 'issue': {
      const [link] = positionalsFor(args, subcommand, 1, 'one grant request link');
      // `--yes <link>` reads the link as the flag's value: say so instead of "missing".
      if (link === undefined && typeof args.flags.yes === 'string') {
        throw new UsageError('Put --yes after the grant request link: midnight grant issue <link> --yes');
      }
      if (link === undefined) {
        throw new UsageError('Missing the grant request link.\nUsage: midnight grant issue <link> [--cap N] [--per-call N] [--max-coin N] [--expires-in SECONDS] [--yes]');
      }
      const limits: GrantLimits = {};
      for (const [flag, field] of LIMIT_FLAGS) {
        const value = getFlag(args, flag);
        if (value === undefined) continue;
        if (!/^\d+$/.test(value)) throw new UsageError(`--${flag} must be a whole number; got "${value}"`);
        if (flag === 'expires-in' && BigInt(value) === 0n) throw new UsageError('--expires-in must be at least 1 second');
        limits[field] = value;
      }
      return { subcommand, link, limits, confirmed: hasFlag(args, 'yes') };
    }
    case 'revoke': {
      const [target] = positionalsFor(args, subcommand, 1, 'one grant id or slot');
      if (target === undefined) throw new UsageError('Missing the grant to revoke.\nUsage: midnight grant revoke <grant id | slot>');
      if (!GRANT_TARGET.test(target)) throw new UsageError(`A grant is named by its id (64 hex characters) or its slot (a number); got "${target}"`);
      return { subcommand, target };
    }
  }
}

/** The request submits transactions, so the wallet must be able to pay a fee. The others only read. */
export function paysAFee(request: GrantRequest): boolean {
  switch (request.subcommand) {
    case 'deploy':
    case 'deposit':
    case 'revoke':
    case 'revoke-all':
      return true;
    case 'issue':
      return request.confirmed;
    case 'status':
    case 'list':
      return false;
  }
}

/**
 * What an issue would grant, as the account build reports it, in one line for
 * the user to confirm. Every field the build gives is said, under the build's
 * own name for it, so nothing it reports is left out or reworded.
 */
export function describeGrantTerms(terms: unknown): string {
  if (terms === null || typeof terms !== 'object' || Array.isArray(terms) || Object.keys(terms).length === 0) {
    throw new Error('The account build reported no terms for this grant request.');
  }
  return Object.entries(terms).map(([name, value]) => `${name} ${typeof value === 'string' ? value : JSON.stringify(value)}`).join(', ');
}

/** The request as the account build's own command line takes it. Deploy and deposit are not among its commands. */
export function ownerArguments(request: Exclude<GrantRequest, { subcommand: 'deploy' | 'deposit' }>, json: boolean): string[] {
  const tail = json ? ['--json'] : [];
  switch (request.subcommand) {
    case 'status':
      return ['status', ...tail];
    case 'list':
      return ['grants', ...tail];
    case 'revoke-all':
      return ['revoke-all', ...tail];
    case 'revoke':
      return ['revoke', request.target, ...tail];
    case 'issue': {
      const limits = LIMIT_FLAGS.flatMap(([flag, field]) => (request.limits[field] === undefined ? [] : [`--${flag}`, request.limits[field]]));
      return ['issue', request.link, ...limits, ...(request.confirmed ? ['--yes'] : []), ...tail];
    }
  }
}
