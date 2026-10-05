// The flags each command accepts. The CLI rejects anything else before the
// command runs: an unrecognised flag used to be silently ignored, so a typo or
// a malformed argument fell back to defaults (for endpoints, a different chain).
// A test keeps this registry equal to the flags each command's code reads.

import { type ParsedArgs } from './argv.ts';
import { UsageError } from './errors.ts';

/** Accepted on every command. */
export const GLOBAL_FLAGS: readonly string[] = ['help', 'h', 'json', 'version', 'v'];

const ENDPOINTS = ['node', 'indexer-ws', 'proof-server'] as const;

export const COMMAND_FLAGS: Readonly<Record<string, readonly string[]>> = {
  'address': ['index', 'network', 'seed', 'wallet'],
  'airdrop': ['network', 'no-cache', 'shielded', 'verbose', 'wallet', ...ENDPOINTS],
  'balance': ['force-shielded', 'network', 'no-cache', 'seed', 'shielded', 'verbose', 'wallet', ...ENDPOINTS],
  'cache': ['network', 'wallet'],
  'config': ['network'],
  'contract': ['address', 'args', 'circuit', 'managed', 'name', 'network', 'path', 'secret-key', 'wallet', ...ENDPOINTS],
  'dev': [],
  'dust': ['network', 'no-cache', 'seed', 'verbose', 'wallet', ...ENDPOINTS],
  'generate': ['force', 'mnemonic', 'network', 'output', 'seed'],
  'genesis-address': ['network'],
  'help': ['agent', 'intro', 'no-intro'],
  'info': ['network', 'wallet'],
  'inspect-cost': ['network', ...ENDPOINTS],
  'localnet': ['tail'],
  'manual': ['no-pager', 'raw'],
  'serve': ['approve-all', 'approve-fees', 'force-shielded', 'max-fee', 'max-pending', 'network', 'no-auto-approve-reads', 'no-cache', 'port', 'verbose', 'wallet', ...ENDPOINTS],
  'status': ['all', 'network', 'watch'],
  'test': [
    'all', 'browser-mode', 'build-cmd', 'build-dir', 'force', 'goal', 'name', 'network', 'no-ai',
    'path', 'port', 'redeploy', 'screen', 'strategy', 'suite', 'url', ...ENDPOINTS],
  'transfer': ['force-shielded', 'network', 'no-cache', 'shielded', 'verbose', 'wallet', ...ENDPOINTS],
  'wallet': ['entropy', 'force', 'mnemonic', 'network', 'seed', 'wallet'],
};

/** Flags on the command line that the command doesn't accept, in the order given. */
export function findUnknownFlags(args: ParsedArgs): string[] {
  const accepted = args.command === undefined ? undefined : COMMAND_FLAGS[args.command];
  if (accepted === undefined) return []; // unknown or missing command: the dispatcher reports it
  return Object.keys(args.flags).filter((f) => !GLOBAL_FLAGS.includes(f) && !accepted.includes(f));
}

/** Throw a UsageError naming every flag the command doesn't accept. */
export function assertKnownFlags(args: ParsedArgs): void {
  const unknown = findUnknownFlags(args);
  if (unknown.length === 0) return;
  const listed = unknown.map((f) => (f.length === 1 ? `-${f}` : `--${f}`)).join(', ');
  throw new UsageError(
    `Unknown flag${unknown.length > 1 ? 's' : ''} for "midnight ${args.command}": ${listed}\n` +
    `Run "midnight help ${args.command}" for the flags it accepts.`,
  );
}
