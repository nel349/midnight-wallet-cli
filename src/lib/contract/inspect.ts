// Contract inspector — parse Compact compiler output (contract-info.json) to discover
// circuits, parameters, witnesses, and types for any compiled Midnight contract.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

// ── Types ──

export interface CompactType {
  'type-name': string;
  length?: number;
  maxval?: number;
  tsType?: string;
  types?: CompactType[];
}

export interface CircuitInfo {
  name: string;
  pure: boolean;
  proof: boolean;
  arguments: { name: string; type: CompactType }[];
  'result-type': CompactType;
}

export interface WitnessInfo {
  name: string;
  arguments: { name: string; type: CompactType }[];
  'result type': CompactType;
}

export interface ContractInfo {
  name: string;
  managedDir: string;
  compilerVersion: string;
  languageVersion: string;
  runtimeVersion: string;
  circuits: CircuitInfo[];
  witnesses: WitnessInfo[];
}

// ── Discovery ──

const CONTRACT_INFO_FILENAME = 'contract-info.json';

/**
 * Find contract-info.json by scanning for managed/<name>/compiler/contract-info.json.
 * Searches the given directory and common subdirectories (contract/src, src).
 */
export function findContractInfo(startDir: string): { info: ContractInfo; infoPath: string } {
  // Try direct managed dir first (--managed flag)
  const directPath = join(startDir, 'compiler', CONTRACT_INFO_FILENAME);
  if (existsSync(directPath)) {
    return loadContractInfo(directPath, startDir);
  }

  // Scan for managed/*/compiler/contract-info.json in candidate directories
  const candidates = [
    startDir,
    join(startDir, 'contract', 'src'),
    join(startDir, 'contract'),
    join(startDir, 'src'),
  ];

  for (const dir of candidates) {
    const managedDir = join(dir, 'managed');
    if (!existsSync(managedDir)) continue;

    let entries: string[];
    try {
      entries = readdirSync(managedDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const infoPath = join(managedDir, entry, 'compiler', CONTRACT_INFO_FILENAME);
      if (existsSync(infoPath)) {
        return loadContractInfo(infoPath, join(managedDir, entry));
      }
    }
  }

  throw new Error(
    `No compiled contract found in ${startDir}\n` +
    `Expected: managed/<name>/compiler/${CONTRACT_INFO_FILENAME}\n` +
    `Run "compact compile" first, or use --managed <path> to specify the managed directory.`
  );
}

function loadContractInfo(infoPath: string, managedDir: string): { info: ContractInfo; infoPath: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(infoPath, 'utf-8'));
  } catch (err) {
    throw new Error(`Failed to parse ${infoPath}: ${(err as Error).message}`);
  }

  const info = parseContractInfo(raw, infoPath, managedDir);
  return { info, infoPath };
}

// ── Parsing & Validation ──

function parseContractInfo(raw: unknown, path: string, managedDir: string): ContractInfo {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${path}: must be a JSON object`);
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj['compiler-version'] !== 'string') {
    throw new Error(`${path}: missing "compiler-version"`);
  }

  if (!Array.isArray(obj.circuits)) {
    throw new Error(`${path}: missing "circuits" array`);
  }

  if (!Array.isArray(obj.witnesses)) {
    throw new Error(`${path}: missing "witnesses" array`);
  }

  // Derive contract name from the managed directory name
  const name = basename(managedDir);

  return {
    name,
    managedDir,
    compilerVersion: obj['compiler-version'] as string,
    languageVersion: (obj['language-version'] as string) ?? 'unknown',
    runtimeVersion: (obj['runtime-version'] as string) ?? 'unknown',
    circuits: obj.circuits as CircuitInfo[],
    witnesses: obj.witnesses as WitnessInfo[],
  };
}

// ── Type Formatting ──

/**
 * Format a Compact type to a human-readable TypeScript-like string.
 */
export function formatCompactType(type: CompactType): string {
  switch (type['type-name']) {
    case 'Uint':
      return 'bigint';
    case 'Bytes':
      return 'Uint8Array';
    case 'Opaque':
      return type.tsType ?? 'unknown';
    case 'Tuple':
      if (!type.types || type.types.length === 0) return 'void';
      return `[${type.types.map(formatCompactType).join(', ')}]`;
    case 'Boolean':
      return 'boolean';
    case 'String':
      return 'string';
    case 'Vector':
      return type.types?.[0] ? `${formatCompactType(type.types[0])}[]` : 'unknown[]';
    case 'Map':
      if (type.types && type.types.length >= 2) {
        return `Map<${formatCompactType(type.types[0])}, ${formatCompactType(type.types[1])}>`;
      }
      return 'Map<unknown, unknown>';
    case 'Set':
      return type.types?.[0] ? `Set<${formatCompactType(type.types[0])}>` : 'Set<unknown>';
    case 'Option':
      return type.types?.[0] ? `${formatCompactType(type.types[0])} | null` : 'unknown | null';
    default:
      return type['type-name'] ?? 'unknown';
  }
}

/**
 * Format a circuit's signature: name(arg1: type1, arg2: type2)
 */
export function formatCircuitSignature(circuit: CircuitInfo): string {
  const args = circuit.arguments
    .map(a => `${a.name}: ${formatCompactType(a.type)}`)
    .join(', ');
  return `${circuit.name}(${args})`;
}

/**
 * Format a circuit's flags: "impure, proof" or "pure"
 */
export function formatCircuitFlags(circuit: CircuitInfo): string {
  if (circuit.pure) return 'pure';
  const flags: string[] = ['impure'];
  if (circuit.proof) flags.push('proof');
  return flags.join(', ');
}

/**
 * Format a witness's signature: name(arg1: type1) → returnType
 */
export function formatWitnessSignature(witness: WitnessInfo): string {
  const args = witness.arguments
    .map(a => `${a.name}: ${formatCompactType(a.type)}`)
    .join(', ');
  const returnType = formatCompactType(witness['result type']);
  const returnSuffix = returnType !== 'void' ? ` → ${returnType}` : '';
  return `${witness.name}(${args})${returnSuffix}`;
}

/**
 * Format contract info as structured JSON for --json output.
 */
export function toJsonOutput(info: ContractInfo): Record<string, unknown> {
  return {
    name: info.name,
    compilerVersion: info.compilerVersion,
    languageVersion: info.languageVersion,
    runtimeVersion: info.runtimeVersion,
    managedDir: info.managedDir,
    circuits: info.circuits.map(c => ({
      name: c.name,
      pure: c.pure,
      proof: c.proof,
      arguments: c.arguments.map(a => ({
        name: a.name,
        type: formatCompactType(a.type),
      })),
      returnType: formatCompactType(c['result-type']),
    })),
    witnesses: info.witnesses.map(w => ({
      name: w.name,
      arguments: w.arguments.map(a => ({
        name: a.name,
        type: formatCompactType(a.type),
      })),
      returnType: formatCompactType(w['result type']),
    })),
  };
}
