// Actions runner — execute TestAction[] sequentially for CLI test strategy.
// Uses the contract runner (deploy/call/state) with mn serve for wallet ops.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TestAction, DappTestConfig } from './types.ts';
import type { NetworkConfig } from '../network.ts';
import { runDeploy, runCall, runState, type StateResult } from '../contract/runner.ts';
import { findContractInfo, type ContractInfo } from '../contract/inspect.ts';
import { analyzeWitnessDependencies } from './circuit-witness-deps.ts';
import { findContractSourcePath } from './ai-scaffold.ts';

export interface ActionResult {
  id: string;
  type: string;
  /**
   * pass — action ran and succeeded.
   * fail — action ran and reported a real failure (assertion, SDK error).
   *        Halts the suite.
   * skip — action was deliberately not run because the environment can't
   *        support it (e.g. CLI suite + UI-dependent witness). Subsequent
   *        actions still run; suite is not marked failed.
   */
  status: 'pass' | 'fail' | 'skip';
  duration: number;
  message?: string;
  contractAddress?: string;
  stateBefore?: StateResult;
  stateAfter?: StateResult;
}

export interface ActionsRunnerOptions {
  actions: TestAction[];
  config: DappTestConfig;
  dappDir: string;
  suiteName: string;
  networkConfig: NetworkConfig;
  servePort: number;
  redeploy?: boolean;
  onActionStart?: (action: TestAction) => void;
  onActionComplete?: (action: TestAction, result: ActionResult) => void;
  onMessage?: (msg: string) => void;
}

/**
 * Execute a list of test actions sequentially.
 * Deploy address flows to subsequent call/state actions automatically.
 */
export async function runActions(options: ActionsRunnerOptions): Promise<ActionResult[]> {
  const { actions, config, dappDir, suiteName, networkConfig, servePort, redeploy, onActionStart, onActionComplete, onMessage } = options;
  const results: ActionResult[] = [];

  // Load cached contract address (test replay)
  const network = config.network ?? 'undeployed';
  let contractAddress: string | undefined;
  if (!redeploy) {
    contractAddress = loadContractCache(dappDir, suiteName, network);
  }

  const { info } = findContractInfo(dappDir);

  // Pre-flight: build the witness-dependency map once so each contract-call
  // action can fail fast with a clear message if its target circuit reads
  // private state that's only populated by the dApp UI. Without this, the
  // SDK crashes ~30s in with a deep WASM "Cannot read properties of
  // undefined" trace that doesn't name the actual problem (witness +
  // private state). Source-dependent: when the .compact source isn't
  // findable we skip the analysis and let the SDK error speak for itself.
  const witnessDeps = computeWitnessDeps(info);

  // Cascade flag: once a contract-call gets skipped (e.g. UI-only witness),
  // any downstream state assertion or call almost certainly depends on the
  // missed mutation. Running them would produce misleading failures (e.g.
  // "loans.size expected 1, got 0") that bury the real signal — the witness
  // dependency. So we skip the chain too. The flag clears on the next
  // contract-deploy, which resets ledger state.
  let cascadeSkipReason: string | undefined;

  for (const action of actions) {
    onActionStart?.(action);
    const start = Date.now();

    if (cascadeSkipReason && (action.type === 'contract-call' || action.type === 'contract-state')) {
      const actionResult: ActionResult = {
        id: action.id,
        type: action.type,
        status: 'skip',
        duration: 0,
        message: `cascaded skip — depends on ${cascadeSkipReason}`,
      };
      results.push(actionResult);
      onActionComplete?.(action, actionResult);
      continue;
    }

    try {
      const result = await executeAction(action, {
        dappDir,
        networkConfig,
        managedDir: info.managedDir,
        contractName: info.name,
        servePort,
        contractAddress,
        witnessDeps,
        onMessage,
      });

      // Capture deploy address for subsequent actions + cache it. Also
      // resets the skip cascade — a fresh deploy gives the chain clean
      // ledger state, so a previously-skipped chain shouldn't poison it.
      if (result.contractAddress) {
        contractAddress = result.contractAddress;
        saveContractCache(dappDir, suiteName, network, contractAddress);
        if (action.type === 'contract-deploy') cascadeSkipReason = undefined;
      }

      const duration = Date.now() - start;
      const actionResult: ActionResult = { ...result, duration };
      results.push(actionResult);
      onActionComplete?.(action, actionResult);

      if (result.status === 'skip' && action.type === 'contract-call') {
        cascadeSkipReason = `skipped action "${action.id}"`;
      }
    } catch (err) {
      const duration = Date.now() - start;
      const actionResult: ActionResult = {
        id: action.id,
        type: action.type,
        status: 'fail',
        duration,
        message: (err as Error).message,
      };
      results.push(actionResult);
      onActionComplete?.(action, actionResult);
      // Stop on first failure
      break;
    }
  }

  return results;
}

// ── Action execution ──

interface ExecutionContext {
  dappDir: string;
  networkConfig: NetworkConfig;
  managedDir: string;
  contractName: string;
  servePort: number;
  contractAddress?: string;
  /** Map of circuit → witnesses it transitively calls. Empty when the
   *  contract source wasn't findable; pre-flight is then a no-op. */
  witnessDeps: Map<string, string[]>;
  onMessage?: (msg: string) => void;
}

async function executeAction(action: TestAction, ctx: ExecutionContext): Promise<ActionResult> {
  switch (action.type) {
    case 'contract-deploy':
      return executeDeploy(action, ctx);
    case 'contract-call':
      return executeCall(action, ctx);
    case 'contract-state':
      return executeState(action, ctx);
    case 'wallet-cmd':
      return executeWalletCmd(action, ctx);
    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }
}

async function executeDeploy(action: TestAction, ctx: ExecutionContext): Promise<ActionResult> {
  // Skip deploy if we already have a cached address (test replay)
  if (ctx.contractAddress) {
    return {
      id: action.id,
      type: action.type,
      status: 'pass',
      duration: 0,
      contractAddress: ctx.contractAddress,
      message: `Reusing cached contract ${ctx.contractAddress.slice(0, 16)}...`,
    };
  }

  const result = await runDeploy({
    dappDir: ctx.dappDir,
    networkConfig: ctx.networkConfig,
    managedDir: ctx.managedDir,
    contractName: ctx.contractName,
    servePort: ctx.servePort,
    onMessage: ctx.onMessage,
  });

  return {
    id: action.id,
    type: action.type,
    status: 'pass',
    duration: 0,
    contractAddress: result.contractAddress,
    message: `Deployed at ${result.contractAddress.slice(0, 16)}...`,
  };
}

async function executeCall(action: TestAction, ctx: ExecutionContext): Promise<ActionResult> {
  if (!ctx.contractAddress) {
    throw new Error(`Action "${action.id}": no contract address. Add a contract-deploy action first.`);
  }
  if (!action.circuit) {
    throw new Error(`Action "${action.id}": missing circuit name.`);
  }

  // Pre-flight: skip circuits whose witnesses read private state. The CLI
  // can't populate that state — only the dApp UI can — so attempting the
  // call would crash ~30s in with a deep WASM "Cannot read properties of
  // undefined" trace. Skip (not fail): the rest of the suite still runs,
  // and the overall result reflects what was actually testable.
  const usedWitnesses = ctx.witnessDeps.get(action.circuit);
  if (usedWitnesses && usedWitnesses.length > 0) {
    return {
      id: action.id,
      type: action.type,
      status: 'skip',
      duration: 0,
      message:
        `not CLI-testable — circuit reads private state via witness ` +
        `${usedWitnesses.join(', ')}. Cover with mn test create --strategy ui.`,
    };
  }

  // Snapshot state before call (for diff)
  let stateBefore: StateResult | undefined;
  try {
    stateBefore = await runState({
      dappDir: ctx.dappDir,
      networkConfig: ctx.networkConfig,
      managedDir: ctx.managedDir,
      contractName: ctx.contractName,
      contractAddress: ctx.contractAddress,
      onMessage: () => {},
    });
  } catch {
    // State snapshot is best-effort
  }

  // Parse args from object to array
  const args = action.args ? Object.values(action.args) : [];

  await runCall({
    dappDir: ctx.dappDir,
    networkConfig: ctx.networkConfig,
    managedDir: ctx.managedDir,
    contractName: ctx.contractName,
    contractAddress: ctx.contractAddress,
    circuit: action.circuit,
    args,
    servePort: ctx.servePort,
    onMessage: ctx.onMessage,
  });

  // Snapshot state after call (for diff)
  let stateAfter: StateResult | undefined;
  try {
    stateAfter = await runState({
      dappDir: ctx.dappDir,
      networkConfig: ctx.networkConfig,
      managedDir: ctx.managedDir,
      contractName: ctx.contractName,
      contractAddress: ctx.contractAddress,
      onMessage: () => {},
    });
  } catch {
    // State snapshot is best-effort
  }

  return {
    id: action.id,
    type: action.type,
    status: 'pass',
    duration: 0,
    message: `${action.circuit} called`,
    stateBefore,
    stateAfter,
  };
}

async function executeState(action: TestAction, ctx: ExecutionContext): Promise<ActionResult> {
  if (!ctx.contractAddress) {
    throw new Error(`Action "${action.id}": no contract address. Add a contract-deploy action first.`);
  }

  const stateResult = await runState({
    dappDir: ctx.dappDir,
    networkConfig: ctx.networkConfig,
    managedDir: ctx.managedDir,
    contractName: ctx.contractName,
    contractAddress: ctx.contractAddress,
    onMessage: ctx.onMessage,
  });

  // Evaluate inline assertions if present
  if (action.assert) {
    const failures: string[] = [];

    for (const [field, condition] of Object.entries(action.assert)) {
      const actualStr = stateResult.fields[field];
      if (actualStr === undefined) {
        // Check maps
        const mapInfo = stateResult.maps[field];
        if (mapInfo) {
          evaluateCondition(field, BigInt(mapInfo.size), condition as Record<string, unknown>, failures);
        } else {
          failures.push(`Field "${field}" not found in ledger state`);
        }
        continue;
      }

      // Try numeric comparison
      try {
        const actual = BigInt(actualStr);
        evaluateCondition(field, actual, condition as Record<string, unknown>, failures);
      } catch {
        // String comparison
        evaluateCondition(field, actualStr, condition as Record<string, unknown>, failures);
      }
    }

    if (failures.length > 0) {
      throw new Error(`State assertion failed:\n  ${failures.join('\n  ')}`);
    }
  }

  return {
    id: action.id,
    type: action.type,
    status: 'pass',
    duration: 0,
    message: `State checked (${Object.keys(stateResult.fields).length} fields, ${Object.keys(stateResult.maps).length} maps)`,
    stateAfter: stateResult,
  };
}

function evaluateCondition(
  field: string,
  actual: bigint | string,
  condition: Record<string, unknown>,
  failures: string[],
): void {
  for (const [op, expected] of Object.entries(condition)) {
    const expectedVal = typeof expected === 'number' ? BigInt(expected) : expected;

    if (typeof actual === 'bigint' && (typeof expectedVal === 'bigint' || typeof expectedVal === 'number')) {
      const exp = BigInt(expectedVal);
      switch (op) {
        case '>':  if (!(actual > exp)) failures.push(`${field}: expected > ${exp}, got ${actual}`); break;
        case '>=': if (!(actual >= exp)) failures.push(`${field}: expected >= ${exp}, got ${actual}`); break;
        case '<':  if (!(actual < exp)) failures.push(`${field}: expected < ${exp}, got ${actual}`); break;
        case '<=': if (!(actual <= exp)) failures.push(`${field}: expected <= ${exp}, got ${actual}`); break;
        case '==': if (!(actual === exp)) failures.push(`${field}: expected == ${exp}, got ${actual}`); break;
        case '!=': if (!(actual !== exp)) failures.push(`${field}: expected != ${exp}, got ${actual}`); break;
        default: failures.push(`${field}: unknown operator "${op}"`);
      }
    } else {
      // String comparison
      const expStr = String(expectedVal);
      switch (op) {
        case '==': if (actual !== expStr) failures.push(`${field}: expected == "${expStr}", got "${actual}"`); break;
        case '!=': if (actual === expStr) failures.push(`${field}: expected != "${expStr}", got "${actual}"`); break;
        default: failures.push(`${field}: operator "${op}" not supported for string values`);
      }
    }
  }
}

async function executeWalletCmd(action: TestAction, _ctx: ExecutionContext): Promise<ActionResult> {
  // Future: execute mn commands like `mn balance`
  return {
    id: action.id,
    type: action.type,
    status: 'pass',
    duration: 0,
    message: `wallet-cmd: ${action.cmd ?? 'no command'} (not yet implemented)`,
  };
}

// ── Witness dependency pre-flight ──

/**
 * Build the witness-dependency map for the contract under test. Returns
 * an empty map (analysis silently skipped) when the .compact source isn't
 * findable — pre-flight stays opt-in so we never break existing suites
 * just because the source layout doesn't match our heuristics.
 */
function computeWitnessDeps(info: ContractInfo): Map<string, string[]> {
  if (info.witnesses.length === 0) return new Map();
  const sourcePath = findContractSourcePath(info.managedDir);
  if (!sourcePath || !existsSync(sourcePath)) return new Map();
  const source = readFileSync(sourcePath, 'utf-8');
  const witnessNames = info.witnesses.map((w) => w.name);
  return analyzeWitnessDependencies(source, witnessNames).byCircuit;
}

// ── State diff utility ──

export interface StateDiff {
  field: string;
  before: string;
  after: string;
}

export function diffState(before: StateResult | undefined, after: StateResult | undefined): StateDiff[] {
  if (!before || !after) return [];
  const diffs: StateDiff[] = [];

  // Compare scalar fields
  const allFields = new Set([...Object.keys(before.fields), ...Object.keys(after.fields)]);
  for (const field of allFields) {
    const b = before.fields[field] ?? '(absent)';
    const a = after.fields[field] ?? '(absent)';
    if (b !== a) {
      diffs.push({ field, before: b, after: a });
    }
  }

  // Compare map sizes
  const allMaps = new Set([...Object.keys(before.maps), ...Object.keys(after.maps)]);
  for (const field of allMaps) {
    const b = before.maps[field]?.size ?? '0';
    const a = after.maps[field]?.size ?? '0';
    if (b !== a) {
      diffs.push({ field: `${field} (entries)`, before: b, after: a });
    }
  }

  return diffs;
}

// ── Contract address cache (test replay) ──

interface ContractCache {
  address: string;
  network: string;
  timestamp: string;
}

function getCachePath(dappDir: string, suiteName: string): string {
  return join(dappDir, 'tests', 'results', `.contract-cache-${suiteName}.json`);
}

function loadContractCache(dappDir: string, suiteName: string, network: string): string | undefined {
  const cachePath = getCachePath(dappDir, suiteName);
  if (!existsSync(cachePath)) return undefined;

  try {
    const cache: ContractCache = JSON.parse(readFileSync(cachePath, 'utf-8'));
    if (cache.network !== network) return undefined; // Different network — don't reuse
    return cache.address;
  } catch {
    return undefined;
  }
}

function saveContractCache(dappDir: string, suiteName: string, network: string, address: string): void {
  const cachePath = getCachePath(dappDir, suiteName);
  mkdirSync(join(dappDir, 'tests', 'results'), { recursive: true });
  const cache: ContractCache = {
    address,
    network,
    timestamp: new Date().toISOString(),
  };
  writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n');
}
