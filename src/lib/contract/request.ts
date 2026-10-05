// A contract deploy or call, read from its arguments and checked against the
// compiled contract before anything starts: the CLI checks it before the
// wallet syncs, the MCP server before it issues a confirmation token.

import { resolve } from 'node:path';
import { type ParsedArgs, getFlag, requireFlag } from '../argv.ts';
import { UsageError } from '../errors.ts';
import { findContractInfo, type ContractInfo } from './inspect.ts';
import { findWitnessFile, buildMissingWitnessError } from './witness-discovery.ts';
import { validateCallRequest, validateContractAddress } from './validate.ts';

export interface ContractDeployRequest {
  /** The dApp's root: the runner loads witnesses.js and keeps its level-db cache there. */
  dappDir: string;
  info: ContractInfo;
  constructorArgs: unknown[];
  /** --secret-key: seeds the contract's initial private state (32-byte hex). The deploy script gets it via env, never on disk. */
  privateStateSecretKey?: string;
}

export interface ContractCallRequest {
  dappDir: string;
  info: ContractInfo;
  address: string;
  circuit: string;
  callArgs: unknown[];
}

/**
 * Where contract-info.json is looked for: --managed (a managed/<name>/ dir),
 * else --path (the dApp root), else the working directory. --managed wins as
 * the more specific of the two.
 */
export function resolveScanDir(args: ParsedArgs): string {
  return resolve(getFlag(args, 'managed') ?? getFlag(args, 'path') ?? process.cwd());
}

/** `deploy [--args <json>] [--secret-key <hex>]` for the contract found from --managed/--path. */
export function resolveContractDeployRequest(args: ParsedArgs): ContractDeployRequest {
  // --managed only says where contract-info.json lives; the runner still
  // needs the project root (--path or cwd) for witnesses.js.
  const dappDir = resolve(getFlag(args, 'path') ?? process.cwd());
  const { info } = findContractInfo(resolveScanDir(args), getFlag(args, 'name'));

  // A contract that declares witnesses needs its compiled witnesses.js: without
  // it the SDK fails mid-deploy, after a long wait, with "first (witnesses)
  // argument does not contain a function-valued field named X".
  const declaredWitnesses = info.witnesses.map((w) => w.name);
  if (declaredWitnesses.length > 0 && !findWitnessFile(dappDir)) {
    throw new Error(buildMissingWitnessError({ projectRoot: dappDir, witnessNames: declaredWitnesses }));
  }

  const constructorArgs = parseArgsJson(getFlag(args, 'args'));

  // For a contract whose constructor derives its owner from a witness
  // (owner = public_key(secret_key())); without it the owner comes from the deploy wallet.
  const privateStateSecretKey = getFlag(args, 'secret-key');
  if (privateStateSecretKey !== undefined && !/^[0-9a-fA-F]{64}$/.test(privateStateSecretKey)) {
    throw new UsageError('--secret-key must be 32 bytes of hex (64 chars)');
  }

  return { dappDir, info, constructorArgs, privateStateSecretKey };
}

/** `call --address <hex> --circuit <name> [--args <json>]` for the contract found from --managed/--path. */
export function resolveContractCallRequest(args: ParsedArgs): ContractCallRequest {
  const dappDir = resolve(getFlag(args, 'path') ?? process.cwd());
  const address = requireFlag(args, 'address', 'contract address');
  const circuit = requireFlag(args, 'circuit', 'circuit name');
  const { info } = findContractInfo(resolveScanDir(args), getFlag(args, 'name'));
  const callArgs = parseArgsJson(getFlag(args, 'args'));
  validateContractAddress(address);
  validateCallRequest(info, circuit, callArgs);
  return { dappDir, info, address, circuit, callArgs };
}

/** --args '<json>': an array is passed positionally, an object as its values in order. */
function parseArgsJson(argsJson: string | undefined): unknown[] {
  if (!argsJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch (err) {
    throw new UsageError(`Invalid --args JSON: ${(err as Error).message}`);
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed !== null && typeof parsed === 'object') return Object.values(parsed);
  throw new UsageError(`Invalid --args JSON: expected an array or an object, got ${JSON.stringify(parsed)}`);
}
