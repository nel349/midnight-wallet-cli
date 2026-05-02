// Test scaffold codegen — produce dapp.test.json + suite/actions/assertions
// shapes from a contract's compiled metadata. Pure functions, no I/O.
//
// The execution side (mn test run) is already shipped; this module only
// generates the four config files that mn test run needs. Sensible CLI-strategy
// defaults so the user can `mn test create && mn test run` and see a passing
// suite immediately, then edit args / add assertions to taste.

import type { CircuitInfo, CompactType } from '../contract/inspect.ts';
import type {
  DappTestConfig,
  TestSuite,
  TestActions,
  TestAction,
  TestAssertions,
  NetworkName,
  PrepStepId,
} from './types.ts';

// ── Placeholder arg generation ──────────────────────────────────

/**
 * Produce a JSON-serializable placeholder value for a Compact arg type.
 * The runner's coerceArg helper will upgrade these to the runtime types
 * (number → BigInt, number[] → Uint8Array). Strings, booleans, nested
 * structures pass through unchanged.
 *
 * Picks the shape that makes the generated test runnable as-is. Users
 * should still review and replace placeholders with realistic values.
 */
export function placeholderArg(type: CompactType): unknown {
  switch (type['type-name']) {
    case 'Uint':
      return 0;
    case 'Bytes': {
      const len = type.length ?? 32;
      return Array.from({ length: len }, () => 0);
    }
    case 'Boolean':
      return false;
    case 'String':
      return 'test';
    case 'Opaque':
      return type.tsType === 'string' ? 'test' : null;
    case 'Vector':
      return [];
    case 'Map':
      return {};
    case 'Set':
      return [];
    case 'Option':
      return null;
    case 'Tuple':
      return (type.types ?? []).map(placeholderArg);
    default:
      return null;
  }
}

/**
 * Build the args object for a circuit using placeholders for every
 * declared parameter. Returns an empty object if the circuit takes none.
 */
export function placeholderArgsFor(circuit: CircuitInfo): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of circuit.arguments) {
    out[arg.name] = placeholderArg(arg.type);
  }
  return out;
}

// ── Config builders ─────────────────────────────────────────────

export interface CreateOptions {
  /** Contract name from the compiled artifact — used in dapp.test.json `name`. */
  contractName: string;
  /** Network the suite targets. Defaults to undeployed (localnet) for fast feedback. */
  network?: NetworkName;
  /** Suite directory name under tests/suites/. Defaults to "cli-default". */
  suiteName?: string;
  /** Strategy. v1 only supports 'cli'; browser/hybrid land later. */
  strategy?: 'cli';
  /** Per-suite timeout in seconds. */
  timeoutSeconds?: number;
  /** mn-serve port — used for the post-test port-listening assertion. */
  servePort?: number;
}

export interface ScaffoldOutput {
  dappConfig: DappTestConfig;
  suite: TestSuite;
  actions: TestActions;
  assertions: TestAssertions;
  suiteName: string;
}

const DEFAULT_NETWORK: NetworkName = 'undeployed';
const DEFAULT_SUITE_NAME = 'cli-default';
const DEFAULT_TIMEOUT = 300;
const DEFAULT_SERVE_PORT = 9932;

/**
 * Default prep for CLI-strategy suites — wallet ready + serve up, no UI build.
 * Browser strategies need build-and-serve appended.
 */
const CLI_PREP: PrepStepId[] = [
  'cache-clear',
  'localnet-up',
  'balance:1000',
  'dust',
  'mn-serve',
];

export function buildScaffold(circuits: CircuitInfo[], opts: CreateOptions): ScaffoldOutput {
  const suiteName = opts.suiteName ?? DEFAULT_SUITE_NAME;
  const network = opts.network ?? DEFAULT_NETWORK;
  const servePort = opts.servePort ?? DEFAULT_SERVE_PORT;

  const dappConfig: DappTestConfig = {
    name: opts.contractName,
    network,
    prep: CLI_PREP,
  };

  const suite: TestSuite = {
    name: suiteName,
    description: `Auto-generated CLI test suite for ${opts.contractName}. Edit args and add ledger-field assertions to taste.`,
    strategy: 'cli',
    timeout: opts.timeoutSeconds ?? DEFAULT_TIMEOUT,
  };

  const actions: TestActions = {
    actions: buildActions(circuits),
  };

  const assertions: TestAssertions = {
    post: [
      {
        id: 'serve-port-listening',
        type: 'port-listening',
        params: { port: servePort },
        expect: 'pass',
      },
    ],
  };

  return { dappConfig, suite, actions, assertions, suiteName };
}

/**
 * Compose the action sequence: deploy → state read → one call per impure
 * circuit → final state read. Pure circuits are skipped because they don't
 * mutate the ledger and are typically helper queries that the CLI can't
 * meaningfully assert against without per-circuit semantic knowledge.
 */
function buildActions(circuits: CircuitInfo[]): TestAction[] {
  const out: TestAction[] = [
    { id: 'deploy', type: 'contract-deploy' },
    { id: 'check-initial', type: 'contract-state' },
  ];

  const writeable = circuits.filter((c) => !c.pure);
  for (const circuit of writeable) {
    const action: TestAction = {
      id: `call-${circuit.name}`,
      type: 'contract-call',
      circuit: circuit.name,
    };
    if (circuit.arguments.length > 0) {
      action.args = placeholderArgsFor(circuit);
    }
    out.push(action);
  }

  out.push({ id: 'check-final', type: 'contract-state' });
  return out;
}
