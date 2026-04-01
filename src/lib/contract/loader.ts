// Contract loader — auto-discover and load a dApp's compiled contract.
// Mode A (full): Load compiled contract JS + witnesses JS separately, build CompiledContract
// Mode B (vacant): Load compiled contract JS only, vacant witnesses with yellow warnings

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { yellow } from '../../ui/colors.ts';
import { findContractInfo } from './inspect.ts';

// ── Types ──

export interface LoadedContract {
  compiledContract: any;
  privateStateKey: string | undefined;
  createInitialPrivateState: (() => unknown) | undefined;
  mode: 'full' | 'vacant';
  contractName: string;
  managedDir: string;
}

export interface LoadContractOptions {
  dappDir?: string;
  onWarning?: (msg: string) => void;
}

// ── Main loader ──

/**
 * Load a contract from the dApp directory.
 *
 * Strategy: load the compiled Contract class and witnesses as separate JS files,
 * then assemble using mn's own compact-js. This avoids dual-package Symbol issues
 * and broken ESM imports in dApp entry points.
 *
 * Mode A (full): managed/contract/index.js + witnesses.js found → real witnesses
 * Mode B (vacant): managed/contract/index.js only → vacant witnesses + yellow warnings
 */
export async function loadContract(options: LoadContractOptions = {}): Promise<LoadedContract> {
  const dappDir = resolve(options.dappDir ?? process.cwd());
  const warn = options.onWarning ?? ((msg: string) => process.stderr.write(yellow(`  ⚠ ${msg}`) + '\n'));

  // Step 1: Find compiled contract info
  const { info } = findContractInfo(dappDir);
  const { name: contractName, managedDir } = info;

  // Step 2: Load the compiled Contract class
  const contractJsPath = join(managedDir, 'contract', 'index.js');
  if (!existsSync(contractJsPath)) {
    throw new Error(
      `Compiled contract not found at ${contractJsPath}\n` +
      `Run "compact compile" to generate the contract artifacts.`
    );
  }

  const contractMod = await import(pathToFileURL(contractJsPath).href);
  if (!contractMod.Contract) {
    throw new Error(`${contractJsPath} does not export a Contract class`);
  }

  // Step 3: Try to find witnesses
  const witnessesResult = await findAndLoadWitnesses(dappDir, managedDir, contractName);

  if (witnessesResult) {
    // Mode A: full — real witnesses
    const withWitnesses = CompiledContract.withWitnesses as any;
    const withAssets = CompiledContract.withCompiledFileAssets as any;
    const compiledContract = CompiledContract.make(contractName, contractMod.Contract).pipe(
      (c: any) => withWitnesses(c, witnessesResult.witnesses),
      (c: any) => withAssets(c, managedDir),
    );

    return {
      compiledContract,
      privateStateKey: witnessesResult.privateStateKey,
      createInitialPrivateState: witnessesResult.createInitialPrivateState,
      mode: 'full',
      contractName,
      managedDir,
    };
  }

  // Mode B: vacant witnesses
  warn('No witnesses found — using vacant witnesses');
  warn('Deploy may fail if the contract requires witnesses (most do)');
  warn('Ensure contract/dist/witnesses.js exists (run the contract build)');

  const compiledContract = CompiledContract.make(contractName, contractMod.Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(managedDir),
  );

  return {
    compiledContract,
    privateStateKey: undefined,
    createInitialPrivateState: undefined,
    mode: 'vacant',
    contractName,
    managedDir,
  };
}

// ── Witness discovery ──

interface WitnessesResult {
  witnesses: Record<string, Function>;
  privateStateKey: string | undefined;
  createInitialPrivateState: (() => unknown) | undefined;
}

/** Search for witnesses JS in common locations. */
const WITNESSES_CANDIDATES = [
  'contract/dist/witnesses.js',
  'contract/src/witnesses.js',
  'dist/witnesses.js',
  'src/witnesses.js',
];

/** Search for extra exports (privateStateKey, createInitialPrivateState). */
const ENTRY_POINT_CANDIDATES = [
  'contract/dist/index.js',
  'contract/src/index.js',
];

async function findAndLoadWitnesses(
  dappDir: string,
  managedDir: string,
  contractName: string,
): Promise<WitnessesResult | null> {
  // Find witnesses
  let witnesses: Record<string, Function> | null = null;

  for (const candidate of WITNESSES_CANDIDATES) {
    const path = join(dappDir, candidate);
    if (!existsSync(path)) continue;

    try {
      const mod = await import(pathToFileURL(path).href);
      if (mod.witnesses && typeof mod.witnesses === 'object') {
        witnesses = mod.witnesses;
        break;
      }
    } catch {
      // Skip — try next candidate
    }
  }

  if (!witnesses) return null;

  // Try to find privateStateKey and createInitialPrivateState from entry point
  let privateStateKey: string | undefined;
  let createInitialPrivateState: (() => unknown) | undefined;

  for (const candidate of ENTRY_POINT_CANDIDATES) {
    const path = join(dappDir, candidate);
    if (!existsSync(path)) continue;

    try {
      const mod = await import(pathToFileURL(path).href);

      // Auto-discover by naming convention
      for (const key of Object.keys(mod)) {
        if (!privateStateKey && typeof mod[key] === 'string' &&
            (key === 'privateStateKey' || key.toLowerCase().includes('privatestatekey'))) {
          privateStateKey = mod[key];
        }
        if (!createInitialPrivateState && typeof mod[key] === 'function' &&
            (key === 'createInitialPrivateState' ||
             (key.startsWith('create') && key.toLowerCase().includes('privatestate')))) {
          createInitialPrivateState = mod[key];
        }
      }
      break; // Found entry point, stop looking
    } catch {
      // Skip — entry point may have broken imports, but we already have witnesses
    }
  }

  return { witnesses, privateStateKey, createInitialPrivateState };
}
