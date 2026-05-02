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

export type CreateStrategy = 'cli' | 'browser';

export interface BrowserOptions {
  /** Port the dApp's dev server listens on (e.g. 4173 for Vite, 3000 for Next). */
  port: number;
  /** Shell command that builds + serves the UI (e.g. "npm run dev"). Spawned by build-and-serve prep. */
  buildCmd: string;
  /** Subdirectory the build runs in (monorepo case, e.g. "ui"). Empty = project root. */
  buildDir?: string;
  /** Full URL Claude opens in Chrome. Defaults to http://localhost:<port>/. */
  url?: string;
}

export interface CreateOptions {
  /** Contract name from the compiled artifact — used in dapp.test.json `name`. */
  contractName: string;
  /** Network the suite targets. Defaults to undeployed (localnet) for fast feedback. */
  network?: NetworkName;
  /** Suite directory name under tests/suites/. Default depends on strategy. */
  suiteName?: string;
  /** 'cli' (default) drives contracts directly via actions.json. 'browser' drives a real UI via Claude + Chrome. */
  strategy?: CreateStrategy;
  /** Per-suite timeout in seconds. */
  timeoutSeconds?: number;
  /** mn-serve port — used for the post-test port-listening assertion. */
  servePort?: number;
  /** Required when strategy === 'browser'. Ignored otherwise. */
  browser?: BrowserOptions;
}

export interface ScaffoldOutput {
  dappConfig: DappTestConfig;
  suite: TestSuite;
  /** Null for browser-strategy suites — Claude drives the UI from prompt.md, no actions list. */
  actions: TestActions | null;
  assertions: TestAssertions;
  /** Markdown instructions for Claude when strategy === 'browser'; null for cli. */
  prompt: string | null;
  suiteName: string;
}

const DEFAULT_NETWORK: NetworkName = 'undeployed';
const DEFAULT_CLI_SUITE_NAME = 'cli-default';
const DEFAULT_BROWSER_SUITE_NAME = 'ui-default';
const DEFAULT_TIMEOUT_CLI = 300;
const DEFAULT_TIMEOUT_BROWSER = 600;
const DEFAULT_SERVE_PORT = 9932;

/** CLI-strategy prep: wallet + dust + serve, no UI build. */
const CLI_PREP: PrepStepId[] = [
  'cache-clear',
  'localnet-up',
  'balance:1000',
  'dust',
  'mn-serve',
];

/** Browser-strategy prep: same as CLI plus build-and-serve for the dApp UI. */
const BROWSER_PREP: PrepStepId[] = [...CLI_PREP, 'build-and-serve'];

export function buildScaffold(circuits: CircuitInfo[], opts: CreateOptions): ScaffoldOutput {
  const strategy: CreateStrategy = opts.strategy ?? 'cli';
  if (strategy === 'browser') {
    if (!opts.browser) {
      throw new Error('Browser strategy requires browser options (port, buildCmd, buildDir?, url?)');
    }
    return buildBrowserScaffold(opts, opts.browser);
  }
  return buildCliScaffold(circuits, opts);
}

function buildCliScaffold(circuits: CircuitInfo[], opts: CreateOptions): ScaffoldOutput {
  const suiteName = opts.suiteName ?? DEFAULT_CLI_SUITE_NAME;
  const network = opts.network ?? DEFAULT_NETWORK;
  const servePort = opts.servePort ?? DEFAULT_SERVE_PORT;

  return {
    dappConfig: {
      name: opts.contractName,
      network,
      prep: CLI_PREP,
    },
    suite: {
      name: suiteName,
      description: `Auto-generated CLI test suite for ${opts.contractName}. Edit args and add ledger-field assertions to taste.`,
      strategy: 'cli',
      timeout: opts.timeoutSeconds ?? DEFAULT_TIMEOUT_CLI,
    },
    actions: { actions: buildActions(circuits) },
    assertions: { post: [portListeningAssertion(servePort)] },
    prompt: null,
    suiteName,
  };
}

function buildBrowserScaffold(opts: CreateOptions, browser: BrowserOptions): ScaffoldOutput {
  const suiteName = opts.suiteName ?? DEFAULT_BROWSER_SUITE_NAME;
  const network = opts.network ?? DEFAULT_NETWORK;
  const servePort = opts.servePort ?? DEFAULT_SERVE_PORT;
  const url = browser.url ?? `http://localhost:${browser.port}/`;

  const dappConfig: DappTestConfig = {
    name: opts.contractName,
    network,
    port: browser.port,
    buildCmd: browser.buildCmd,
    url,
    prep: BROWSER_PREP,
  };
  if (browser.buildDir) dappConfig.buildDir = browser.buildDir;

  return {
    dappConfig,
    suite: {
      name: suiteName,
      description: `Auto-generated browser test suite for ${opts.contractName}. Edit prompt.md to describe the dApp-specific user flow.`,
      strategy: 'browser',
      timeout: opts.timeoutSeconds ?? DEFAULT_TIMEOUT_BROWSER,
      // browserMode left undefined — runner picks 'auto' which works for most
      // dApps. Override to 'script' for deterministic, faster runs once the
      // flow is stable.
    },
    actions: null,
    assertions: {
      post: [
        // Claude exit 0 = "the agent ran the prompt to completion." Doesn't
        // guarantee semantic success — that comes from prompt.md asking the
        // agent to verify on-screen state and the agent reporting truthfully.
        {
          id: 'claude-exit-ok',
          type: 'process-exit-code',
          params: { code: 0 },
          expect: 'pass',
        },
        portListeningAssertion(servePort),
      ],
    },
    prompt: buildPromptMarkdown(opts.contractName, url),
    suiteName,
  };
}

function portListeningAssertion(port: number) {
  return {
    id: 'serve-port-listening' as const,
    type: 'port-listening' as const,
    params: { port },
    expect: 'pass' as const,
  };
}

/**
 * Skeleton prompt for Claude. Deliberately short and dApp-agnostic — every
 * project's user flow is different and the user must edit this. The `{{url}}`
 * placeholder is templated by the runner from dapp.test.json. Steps are numbered
 * because Claude follows numbered lists more reliably than prose.
 */
export function buildPromptMarkdown(name: string, url: string): string {
  return `You are running an automated E2E test of ${name}.

The UI is at ${url} — open it in Chrome.
mn serve is running with --approve-all so contract calls will auto-approve.

> TODO: replace the steps below with the real user flow for your dApp.
> Keep them numbered — Claude follows numbered lists more reliably than prose.
> Use specific text Claude can find on screen ("WALLET OK", "Submit", etc.)
> rather than vague phrases ("the wallet button").

Follow these steps:

1. Open ${url} in Chrome.
2. Wait for the wallet connection indicator to show success
   (TODO: name the exact text/element your dApp shows on connect).
3. TODO: dApp-specific actions. Examples:
   - Click the button labelled "Deploy".
   - Fill the input named "amount" with 100.
   - Press Enter to submit.
4. Wait for the on-chain confirmation.
   Contract calls take 30–60 seconds because of ZK proof generation.
5. Verify the result on screen
   (TODO: name what your dApp shows after success — a tx hash, a state change, etc.).
6. Report:
   - Did each step succeed?
   - What was the final on-screen state?
   - Any errors?

If any step fails, report exactly what you see on screen and stop.
Take screenshots at each major step to document the test.
`;
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
