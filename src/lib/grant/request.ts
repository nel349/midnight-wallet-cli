// What `mn grant` is asked to do, read from its arguments and checked before
// anything starts: the CLI checks it before the wallet is looked at, the MCP
// server before it issues a confirmation token.

import { parseDeviceCode } from './device-code.ts';
import { type ParsedArgs, getFlag, hasFlag } from '../argv.ts';
import { UsageError } from '../errors.ts';
import { nightToMicro, parseAmount } from '../transfer.ts';

export const GRANT_SUBCOMMANDS = ['deploy', 'deposit', 'status', 'list', 'issue', 'revoke', 'revoke-all', 'export', 'import', 'device'] as const;

/** What `grant device` does: make this machine's device, add one, remove one, or list them. */
export const DEVICE_ACTIONS = ['new', 'add', 'remove', 'list'] as const;
export type DeviceAction = typeof DEVICE_ACTIONS[number];
export type GrantSubcommand = typeof GRANT_SUBCOMMANDS[number];

export type GrantRequest =
  | { subcommand: 'deploy' }
  /** `amount` as given, in NIGHT; `value` the same in the smallest unit, as decimal text. */
  | { subcommand: 'deposit'; amount: string; value: string }
  | { subcommand: 'status' }
  | { subcommand: 'list' }
  | { subcommand: 'issue'; link: string; limits: GrantLimits; confirmed: boolean }
  | { subcommand: 'revoke'; target: string }
  | { subcommand: 'revoke-all' }
  /** The backup file to write, or to read. */
  | { subcommand: 'export'; file: string }
  | { subcommand: 'import'; file: string }
  /** `code`: the device to add or remove; `backup`: where an add writes the new device's backup. */
  | { subcommand: 'device'; action: 'new' }
  | { subcommand: 'device'; action: 'list' }
  | { subcommand: 'device'; action: 'add'; code: string; backup: string }
  | { subcommand: 'device'; action: 'remove'; code: string };

/** Limits an issue may set, each a whole number as text; mn's defaults stand for those not given. */
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
  `  revoke-all   Revoke every grant\n` +
  `  export       Write the account to an encrypted backup file\n` +
  `  import       Bring an account's backup in, for a wallet with none\n` +
  `  device       This machine's device, and the account's others: new, add, remove, list\n\n` +
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

  onlyFor(args, subcommand, [...LIMIT_FLAGS.map(([flag]) => flag), 'yes'], ['issue']);
  onlyFor(args, subcommand, ['backup'], ['device']);

  switch (subcommand) {
    case 'deploy':
      positionalsFor(args, subcommand, 0, 'no argument');
      return { subcommand };
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
    case 'device': {
      const [action, code] = positionalsFor(args, subcommand, 2, 'an action (new, add, remove, list) and, to add or remove, a device code');
      const usage = 'Usage: midnight grant device new | add <device code> --backup <file> | remove <device code> | list';
      if (!(DEVICE_ACTIONS as readonly string[]).includes(action ?? '')) throw new UsageError(`Missing or unknown device action "${action ?? ''}".\n${usage}`);
      const backup = getFlag(args, 'backup');
      if (action !== 'add' && backup !== undefined) throw new UsageError('--backup only applies to: midnight grant device add');
      if (action === 'new' || action === 'list') {
        if (code !== undefined) throw new UsageError(`midnight grant device ${action} takes no device code.\n${usage}`);
        return action === 'new' ? { subcommand, action: 'new' } : { subcommand, action: 'list' };
      }
      if (code === undefined) throw new UsageError(`Missing the device code.\n${usage}`);
      parseDeviceCode(code);
      if (action === 'remove') return { subcommand, action, code };
      if (backup === undefined) throw new UsageError(`Adding a device writes its backup, which it needs to act as an owner: --backup <file>.\n${usage}`);
      return { subcommand, action: 'add', code, backup };
    }
    case 'export':
    case 'import': {
      const [file] = positionalsFor(args, subcommand, 1, 'one backup file');
      if (file === undefined) throw new UsageError(`Missing the backup file.\nUsage: midnight grant ${subcommand} <file>`);
      return { subcommand, file };
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
    case 'export':
    case 'import':
      return false;
    case 'device':
      return request.action === 'add' || request.action === 'remove';
  }
}

/**
 * What an issue would grant, as the account package reads it, in one line for
 * the user to confirm. Every field the package gives is said, under the package's
 * own name for it, so nothing it reports is left out or reworded.
 */
export function describeGrantTerms(terms: unknown): string {
  if (terms === null || typeof terms !== 'object' || Array.isArray(terms) || Object.keys(terms).length === 0) {
    throw new Error('The account package reported no terms for this grant request.');
  }
  return Object.entries(terms).map(([name, value]) => `${name} ${typeof value === 'string' ? value : JSON.stringify(value)}`).join(', ');
}
