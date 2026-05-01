// `mn manual` — long-form human reference, complementing the brief
// `mn help` cheat sheet and the `mn help --agent` AI-format reference.
//
// Pipes through $PAGER (or `less -R`) when stdout is a TTY so users can
// search and scroll. Disable with --no-pager.

import { spawn } from 'node:child_process';
import { type ParsedArgs, hasFlag, getFlag } from '../lib/argv.ts';
import { bold, dim, teal, yellow, white } from '../ui/colors.ts';
import { COMMAND_SPECS, type CommandSpec } from './help.ts';
import { PKG_NAME, PKG_VERSION } from '../lib/pkg.ts';

const SECTION_BAR = '═'.repeat(63);
const RULE = '─'.repeat(64);

function header(title: string): string {
  return `${bold(SECTION_BAR)}\n  ${bold(white(title))}\n${bold(SECTION_BAR)}\n`;
}

function subhead(title: string): string {
  return `\n${dim(RULE)}\n  ${bold(white(title))}\n${dim(RULE)}\n`;
}

/** Render a single command's section using the data already in COMMAND_SPECS. */
function renderCommandSection(spec: CommandSpec): string {
  const lines: string[] = [];
  lines.push(`${teal(bold('▸ ' + spec.name))}${' '.repeat(Math.max(2, 22 - spec.name.length))}${spec.description}`);
  lines.push('');
  lines.push(`  ${bold('USAGE')}`);
  lines.push(`    ${spec.usage}`);
  if (spec.flags && spec.flags.length > 0) {
    lines.push('');
    lines.push(`  ${bold('FLAGS')}`);
    for (const flag of spec.flags) {
      // Re-style lines that look like "--flag <arg>  description". Leave
      // section headers and blank lines untouched.
      const m = flag.match(/^(\s*)(--[\w-]+(?:\s<[^>]+>)?)(\s+)(.*)$/);
      if (m) {
        lines.push(`    ${yellow(m[2]!)}${m[3]}${m[4]}`);
      } else if (/^[A-Za-z][\w -]*:/.test(flag)) {
        lines.push(`    ${dim(flag)}`);
      } else if (flag.trim() === '') {
        lines.push('');
      } else {
        lines.push(`    ${flag}`);
      }
    }
  }
  if (spec.examples && spec.examples.length > 0) {
    lines.push('');
    lines.push(`  ${bold('EXAMPLES')}`);
    for (const example of spec.examples) {
      lines.push(`    ${dim('$')} ${dim(example)}`);
    }
  }
  return lines.join('\n');
}

/** Build the full manual as a single string. Caller decides pagination. */
export function buildManual(): string {
  const out: string[] = [];

  // ── Cover ─────────────────────────────────────────────────
  out.push(header(`${PKG_NAME} manual    v${PKG_VERSION}`));
  out.push('');
  out.push(`${bold('NAME')}`);
  out.push(`    midnight (mn) — wallet and development CLI for the Midnight blockchain`);
  out.push('');
  out.push(`${bold('SYNOPSIS')}`);
  out.push(`    mn <command> [subcommand] [options]`);
  out.push(`    midnight <command> [subcommand] [options]`);
  out.push('');
  out.push(`${bold('DESCRIPTION')}`);
  out.push(`    midnight-wallet-cli is a standalone CLI that handles wallet`);
  out.push(`    operations, contract deployment, and a development loop, on three`);
  out.push(`    networks (undeployed, preprod, preview). Every command speaks`);
  out.push(`    JSON via --json for use with AI agents and scripts. An MCP`);
  out.push(`    server ships with the package.`);
  out.push('');
  out.push(`${bold('INSTALLATION')}`);
  out.push(`    ${dim('$')} ${dim('npm install -g midnight-wallet-cli')}`);
  out.push('');
  out.push(`    Optional dependencies:`);
  out.push(`      Compact toolchain: https://docs.midnight.network/develop`);
  out.push(`      Docker:            for the local development network`);

  // ── Concepts ──────────────────────────────────────────────
  out.push(subhead('CONCEPTS'));
  out.push(`  ${bold('Networks')}`);
  out.push(`    ${teal('undeployed')}   Local Docker network. Free dev tokens, fast iteration.`);
  out.push(`    ${teal('preprod')}      Public testnet. Persistent, real ZK proofs.`);
  out.push(`    ${teal('preview')}      Public testnet, smaller scale.`);
  out.push('');
  out.push(`  ${bold('Tokens')}`);
  out.push(`    ${yellow('NIGHT')}        Native asset. Used for transfers and contract value.`);
  out.push(`    ${yellow('DUST')}         Fee token. Generated from registered NIGHT UTXOs.`);
  out.push('');
  out.push(`  ${bold('Wallets')}`);
  out.push(`    Stored at ${dim('~/.midnight/wallets/<name>.json')}`);
  out.push(`    Three networks share one seed; each gets its own derived address.`);
  out.push(`    A tip-aware cache makes repeated reads finish in seconds.`);
  out.push('');
  out.push(`  ${bold('Shielded vs Unshielded')}`);
  out.push(`    ${yellow('Unshielded')} addresses (mn_addr_*) are like UTXOs.`);
  out.push(`    ${yellow('Shielded')} addresses (mn_shield-addr_*) hide amount and recipient.`);

  // ── Commands ──────────────────────────────────────────────
  out.push(subhead('COMMANDS'));
  for (const spec of COMMAND_SPECS) {
    out.push(renderCommandSection(spec));
    out.push('');
  }

  // ── Common flows ──────────────────────────────────────────
  out.push(subhead('COMMON FLOWS'));
  out.push(`  ${bold('First wallet on undeployed')}`);
  out.push(`    ${dim('$')} ${dim('mn localnet up')}`);
  out.push(`    ${dim('$')} ${dim('mn wallet generate alice')}`);
  out.push(`    ${dim('$')} ${dim('mn airdrop 1000 --wallet alice')}`);
  out.push(`    ${dim('$')} ${dim('mn dust register --wallet alice')}`);
  out.push(`    ${dim('$')} ${dim('mn balance --wallet alice')}`);
  out.push('');
  out.push(`  ${bold('First wallet on preprod')}`);
  out.push(`    ${dim('$')} ${dim('mn wallet generate alice --network preprod')}`);
  out.push(`    ${dim('# fund from the preprod faucet:')}`);
  out.push(`    ${dim('# https://faucet.preprod.midnight.network/')}`);
  out.push(`    ${dim('$')} ${dim('mn dust register --wallet alice --network preprod')}`);
  out.push(`    ${dim('$')} ${dim('mn balance --wallet alice --network preprod')}`);
  out.push('');
  out.push(`  ${bold('Deploy and call a contract on undeployed')}`);
  out.push(`    Prerequisite: a compiled artifact at ./src/managed/<name>/`);
  out.push('');
  out.push(`    ${dim('$')} ${dim('mn contract deploy --wallet alice')}`);
  out.push(`    ${dim('  → Address: 64da9d71cb…')}`);
  out.push(`    ${dim('$')} ${dim('mn contract state --address 64da9d71cb… --wallet alice')}`);
  out.push(`    ${dim('  → { "round": 0 }')}`);
  out.push(`    ${dim('$')} ${dim('mn contract call --address 64da9d71cb… --circuit increment --wallet alice')}`);
  out.push(`    ${dim('$')} ${dim('mn contract state --address 64da9d71cb… --wallet alice')}`);
  out.push(`    ${dim('  → { "round": 1 }')}`);
  out.push('');
  out.push(`    Same artifact on preprod — swap one flag:`);
  out.push(`    ${dim('$')} ${dim('mn contract deploy --network preprod --wallet alice')}`);
  out.push('');
  out.push(`  ${bold('Transfer NIGHT between wallets')}`);
  out.push(`    ${dim('$')} ${dim('mn transfer bob 100 --wallet alice')}`);
  out.push(`    ${dim('  shielded variant:')}`);
  out.push(`    ${dim('$')} ${dim('mn transfer bob 100 --shielded --wallet alice')}`);

  // ── Configuration ─────────────────────────────────────────
  out.push(subhead('CONFIGURATION'));
  out.push(`  ${bold('Files')}`);
  out.push(`    ${dim('~/.midnight/config.json')}        Persistent CLI settings`);
  out.push(`    ${dim('~/.midnight/wallets/')}            Per-wallet JSON files (mode 0600)`);
  out.push(`    ${dim('~/.midnight/cache/<network>/')}    Wallet sync cache, per network`);
  out.push('');
  out.push(`  ${bold('Config keys')}`);
  out.push(`    ${yellow('network')}        Default network when --network is omitted`);
  out.push(`    ${yellow('wallet')}         Default wallet when --wallet is omitted`);
  out.push(`    ${yellow('proof-server')}   Override proof server URL`);
  out.push(`    ${yellow('node')}           Override substrate RPC URL`);
  out.push(`    ${yellow('indexer-ws')}     Override indexer WebSocket URL`);
  out.push('');
  out.push(`    ${bold('Compatibility alias')}`);
  out.push(`    ${yellow('network-id')}     Resolves transparently to ${yellow('network')}.`);
  out.push('');
  out.push(`  ${bold('Examples')}`);
  out.push(`    ${dim('$')} ${dim('mn config set network preprod')}`);
  out.push(`    ${dim('$')} ${dim('mn config get network')}`);
  out.push(`    ${dim('$')} ${dim('mn config unset proof-server')}`);

  // ── JSON output ───────────────────────────────────────────
  out.push(subhead('JSON OUTPUT'));
  out.push(`  Every command accepts ${yellow('--json')} for structured output on stdout.`);
  out.push(`  Stderr keeps the chrome (spinners, headers); stdout stays parseable.`);
  out.push('');
  out.push(`  ${dim('$')} ${dim('mn balance <addr> --json | jq -r .NIGHT')}`);
  out.push(`  ${dim('$')} ${dim('mn wallet info alice --json')}`);
  out.push('');
  out.push(`  Stable JSON shapes are documented in ${dim('docs/JSON_CONTRACT.md')}.`);
  out.push(`  We promise not to break those without a major version bump.`);

  // ── Exit codes ────────────────────────────────────────────
  out.push(subhead('EXIT CODES'));
  out.push(`  ${green('0')}  Success`);
  out.push(`  ${dim('1')}  Unknown error`);
  out.push(`  ${yellowText('2')}  Invalid arguments (usage error, see yellow box on stderr)`);
  out.push(`  ${dim('3')}  Wallet not found`);
  out.push(`  ${dim('4')}  Network error`);
  out.push(`  ${dim('5')}  Insufficient balance / DUST_REQUIRED`);
  out.push(`  ${dim('6')}  Transaction rejected / STALE_UTXO / PROOF_TIMEOUT`);
  out.push(`  ${dim('7')}  Cancelled by user`);
  out.push('');
  out.push(`  ${bold('Stable error code strings')} (in JSON ${yellow('--json')} error output):`);
  out.push(`    ${yellow('DUST_REQUIRED')}         No dust available to pay fees`);
  out.push(`    ${yellow('STALE_UTXO')}            UTXO consumed concurrently, retry`);
  out.push(`    ${yellow('PROOF_TIMEOUT')}         Proof generation exceeded deadline`);
  out.push(`    ${yellow('PROOF_FAILURE')}         Proof server rejected the proof`);
  out.push(`    ${yellow('INVALID_DUST_PROOF')}    Stale commitment tree, run ${dim('mn cache clear')}`);
  out.push(`    ${yellow('STALE_CACHE')}           Local cache out of sync, run ${dim('mn cache clear')}`);
  out.push(`    ${yellow('SYNC_TIMEOUT')}          Wallet sync exceeded its deadline`);

  // ── Troubleshooting ───────────────────────────────────────
  out.push(subhead('TROUBLESHOOTING'));
  out.push(`  ${bold('Sync hangs forever or "applied > highest" error')}`);
  out.push(`    Stale cache after a chain reset. Recover with:`);
  out.push(`    ${dim('$')} ${dim('mn cache clear --wallet <name>')}`);
  out.push('');
  out.push(`  ${bold('"DUST_REQUIRED" or "no dust available" on transfer')}`);
  out.push(`    Wallet has NIGHT but no fee token. Register dust:`);
  out.push(`    ${dim('$')} ${dim('mn dust register --wallet <name>')}`);
  out.push(`    Then wait until status shows availability:`);
  out.push(`    ${dim('$')} ${dim('mn dust status --wallet <name>')}`);
  out.push('');
  out.push(`  ${bold('"Cannot find package @midnight-ntwrk/..." on contract deploy')}`);
  out.push(`    The CLI bundles its own SDK. Reinstall to pick up the bundle:`);
  out.push(`    ${dim('$')} ${dim('npm install -g midnight-wallet-cli@latest')}`);
  out.push('');
  out.push(`  ${bold('"witnesses module not found" on contract deploy')}`);
  out.push(`    Your contract declares witnesses but witnesses.js isn't built.`);
  out.push(`    Build the TypeScript source first:`);
  out.push(`    ${dim('$')} ${dim('npm run build')}`);
  out.push('');
  out.push(`  ${bold('"mn serve already running on port 9932 for network X"')}`);
  out.push(`    A leftover serve from a previous network is in the way.`);
  out.push(`    ${dim('$')} ${dim("pkill -f 'mn serve'")}`);

  // ── See also ──────────────────────────────────────────────
  out.push(subhead('SEE ALSO'));
  out.push(`  ${teal('mn help')}              Brief command list`);
  out.push(`  ${teal('mn help <command>')}    Help for one command (flags and examples)`);
  out.push(`  ${teal('mn help --agent')}      Comprehensive AI / MCP reference`);
  out.push('');
  out.push(`  Repository:        ${dim('github.com/nel349/midnight-wallet-cli')}`);
  out.push(`  JSON contract:     ${dim('docs/JSON_CONTRACT.md')}`);
  out.push(`  Agent protocol:    ${dim('docs/AGENT-PROTOCOL.md')}`);
  out.push(`  Beginner journey:  ${dim('docs/BEGINNER_JOURNEY.md')}`);
  out.push('');

  return out.join('\n');
}

// Tiny color helpers for the exit-code table where we want green/yellow on
// the digit but no other color.
function green(s: string): string { return `\x1b[32m${s}\x1b[0m`; }
function yellowText(s: string): string { return `\x1b[33m${s}\x1b[0m`; }

/** Pipe `text` through a pager when stdout is a TTY. Honors $PAGER. */
async function pageOrPrint(text: string, usePager: boolean): Promise<void> {
  if (!usePager || !process.stdout.isTTY) {
    process.stdout.write(text);
    return;
  }

  const pagerEnv = process.env.PAGER ?? 'less -R';
  const [pagerCmd, ...pagerArgs] = pagerEnv.split(/\s+/);
  if (!pagerCmd) {
    process.stdout.write(text);
    return;
  }

  await new Promise<void>((resolve) => {
    const child = spawn(pagerCmd, pagerArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
    child.stdin.on('error', () => { /* pager closed early — ignore */ });
    child.on('close', () => resolve());
    child.on('error', () => {
      // Pager not available; fall back to plain print.
      process.stdout.write(text);
      resolve();
    });
    child.stdin.write(text);
    child.stdin.end();
  });
}

export default async function manualCommand(args: ParsedArgs): Promise<void> {
  const usePager = !hasFlag(args, 'no-pager');

  // --json: emit a structured object so agents can ingest the manual.
  if (hasFlag(args, 'json')) {
    const { writeJsonResult } = await import('../lib/json-output.ts');
    writeJsonResult({
      name: PKG_NAME,
      version: PKG_VERSION,
      manual: buildManual(),
    });
    return;
  }

  // --raw: skip ANSI, useful for piping to a file.
  if (hasFlag(args, 'raw')) {
    process.stdout.write(buildManual().replace(/\x1b\[[0-9;]*m/g, ''));
    return;
  }

  await pageOrPrint(buildManual(), usePager);
}
