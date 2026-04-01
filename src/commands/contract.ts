// Contract commands — inspect compiled Midnight contracts.
// Future: deploy, call, state.

import { resolve } from 'node:path';
import { type ParsedArgs, getFlag, hasFlag } from '../lib/argv.ts';
import { writeJsonResult } from '../lib/json-output.ts';
import { header, keyValue } from '../ui/format.ts';
import { bold, dim, teal, yellow } from '../ui/colors.ts';
import {
  findContractInfo,
  formatCircuitSignature,
  formatCircuitFlags,
  formatWitnessSignature,
  toJsonOutput,
} from '../lib/contract/inspect.ts';

const VALID_SUBCOMMANDS = ['inspect'] as const;
type Subcommand = typeof VALID_SUBCOMMANDS[number];

function isValidSubcommand(s: string): s is Subcommand {
  return (VALID_SUBCOMMANDS as readonly string[]).includes(s);
}

export default async function contractCommand(args: ParsedArgs): Promise<void> {
  const subcommand = args.subcommand;

  if (!subcommand || !isValidSubcommand(subcommand)) {
    throw new Error(
      `Usage: midnight contract <${VALID_SUBCOMMANDS.join('|')}>\n\n` +
      `  inspect   Show circuits, witnesses, and types for a compiled contract\n\n` +
      `Run "midnight help contract" for more info.`
    );
  }

  switch (subcommand) {
    case 'inspect':
      return handleInspect(args);
  }
}

async function handleInspect(args: ParsedArgs): Promise<void> {
  const jsonMode = hasFlag(args, 'json');

  // Resolve the search directory: --managed (direct), --path (search), or cwd
  const managedFlag = getFlag(args, 'managed');
  const pathFlag = getFlag(args, 'path');
  const startDir = resolve(managedFlag ?? pathFlag ?? process.cwd());

  const { info } = findContractInfo(startDir);

  // JSON output
  if (jsonMode) {
    writeJsonResult(toJsonOutput(info));
    return;
  }

  // Human-readable output
  process.stderr.write('\n' + header(`Contract: ${info.name}`) + '\n\n');
  process.stderr.write(keyValue('Compiler', info.compilerVersion) + '\n');
  process.stderr.write(keyValue('Language', info.languageVersion) + '\n');
  process.stderr.write(keyValue('Runtime', info.runtimeVersion) + '\n');

  // Circuits
  process.stderr.write('\n' + bold('  Circuits') + '\n');
  if (info.circuits.length === 0) {
    process.stderr.write(dim('    (none)') + '\n');
  } else {
    for (const circuit of info.circuits) {
      const sig = formatCircuitSignature(circuit);
      const flags = formatCircuitFlags(circuit);
      const flagColor = circuit.pure ? teal(flags) : yellow(flags);
      process.stderr.write(`    ${sig}  ${dim('—')} ${flagColor}\n`);
    }
  }

  // Witnesses
  process.stderr.write('\n' + bold('  Witnesses') + '\n');
  if (info.witnesses.length === 0) {
    process.stderr.write(dim('    (none)') + '\n');
  } else {
    for (const witness of info.witnesses) {
      process.stderr.write(`    ${formatWitnessSignature(witness)}\n`);
    }
  }

  process.stderr.write('\n');
}
