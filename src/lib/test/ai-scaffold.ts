// AI-assisted test scaffolder — orchestrates the prompt build, calls a
// claude subprocess (or any injected runner), parses the response, and
// produces a ScaffoldOutput that writeScaffold can persist.
//
// The runner is injectable so tests can stub the AI side. In production
// we shell out to `claude --print` and reuse the user's existing Claude
// Code auth — no API key plumbing needed.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { CircuitInfo, ContractInfo } from '../contract/inspect.ts';
import type { BrowserMode, DappTestConfig, NetworkName, TestActions, TestAssertions, TestSuite, PrepStepId } from './types.ts';
import type { ScaffoldOutput } from './create.ts';
import { buildCliPrompt, buildUiPrompt, RESPONSE_FENCE, renderContractSummary } from './ai-prompts.ts';
import type { ScreenCandidate } from './discover-screens.ts';

// ── Public types ───────────────────────────────────────────────────

/**
 * The raw shape we ask Claude for. Validated then merged into a full
 * ScaffoldOutput. Fields are intentionally small — anything we can
 * derive deterministically (suite name, prep chain, dapp.test.json
 * skeleton) is filled in by us, not the model.
 */
export interface AiCliResponse {
  description: string;
  actions: TestActions;
  assertions: TestAssertions;
}

export interface AiUiResponse {
  description: string;
  prompt: string;
  assertions: TestAssertions;
}

/**
 * A claude runner — given a prompt string, return the raw model text.
 * The orchestrator extracts the JSON fence from that text. Injectable so
 * tests provide a deterministic stub instead of spawning a child process.
 */
export type ClaudeRunner = (prompt: string) => Promise<string>;

export interface CliScaffoldInputs {
  contract: ContractInfo;
  contractSourcePath?: string;
  targetCircuit: CircuitInfo;
  goal?: string;
  network?: NetworkName;
  servePort?: number;
  suiteName?: string;
}

export interface UiScaffoldInputs {
  contract: ContractInfo;
  screen: ScreenCandidate;
  url: string;
  port: number;
  buildCmd: string;
  buildDir?: string;
  goal?: string;
  network?: NetworkName;
  servePort?: number;
  suiteName?: string;
  /** Mode for Chrome interaction (dom / vision / script). Sets suite.browserMode. */
  browserMode?: BrowserMode;
  /** Extra component sources to feed Claude — small files imported by the screen. */
  relatedSources?: { path: string; source: string }[];
}

// ── Defaults that mirror create.ts (kept in sync intentionally) ────

const DEFAULT_NETWORK: NetworkName = 'undeployed';
const DEFAULT_SERVE_PORT = 9932;
const DEFAULT_TIMEOUT_CLI = 300;
const DEFAULT_TIMEOUT_BROWSER = 600;

const CLI_PREP: PrepStepId[] = ['cache-clear', 'localnet-up', 'balance:1000', 'dust', 'mn-serve'];
const BROWSER_PREP: PrepStepId[] = [...CLI_PREP, 'build-and-serve'];

// ── Production claude runner ───────────────────────────────────────

/**
 * Spawn `claude --print` and return its stdout. Throws if claude isn't
 * on PATH or if the process exits non-zero. Used as the default runner
 * in production; tests inject a stub instead.
 */
export const claudeSubprocessRunner: ClaudeRunner = async (prompt) => {
  try {
    return execFileSync('claude', ['--print'], {
      input: prompt,
      encoding: 'utf-8',
      // 5 minutes — model + tool roundtrips can be slow on the longer
      // prompts. Surface a clear timeout instead of hanging the user's
      // terminal silently.
      timeout: 5 * 60 * 1_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new Error(
        'claude CLI not found on PATH. Install Claude Code (npm install -g @anthropic-ai/claude-code) ' +
        'or run mn test create without --goal / --screen for the deterministic scaffolder.',
      );
    }
    throw err;
  }
};

/** Cheap pre-flight so callers can show a meaningful error before invoking. */
export function isClaudeAvailable(): boolean {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

// ── Response parsing ───────────────────────────────────────────────

/**
 * Pull the first ```json ... ``` fenced block out of the model's reply
 * and JSON-parse it. The model is instructed to return EXACTLY one fence;
 * we tolerate leading prose by ignoring everything before the first fence
 * and trailing prose by stopping at the first closing fence.
 */
function extractJsonFence<T>(raw: string): T {
  // Match ```json (newline) ...payload... (newline) ```
  // Allow optional whitespace after the opening fence in case the model
  // emits "```json " or similar.
  const fenceRegex = new RegExp('```json\\s*\\n([\\s\\S]*?)\\n```');
  const match = fenceRegex.exec(raw);
  if (!match) {
    throw new Error(
      `Claude response did not contain a ${RESPONSE_FENCE} ... \`\`\` fenced block. ` +
      `First 200 chars: ${raw.slice(0, 200)}`,
    );
  }
  try {
    return JSON.parse(match[1]) as T;
  } catch (err) {
    throw new Error(`JSON inside the fence failed to parse: ${(err as Error).message}`);
  }
}

// ── Validation ─────────────────────────────────────────────────────

/**
 * Validate a CLI response against the runner's expected shape AND verify
 * every circuit name the model used actually exists in the contract.
 * Hallucinated circuit names are the main failure mode; catching them here
 * means we can fall back to deterministic instead of writing a broken suite.
 */
function validateCliResponse(response: AiCliResponse, contract: ContractInfo): void {
  if (!response || typeof response !== 'object') {
    throw new Error('AI response must be an object');
  }
  if (typeof response.description !== 'string' || !response.description) {
    throw new Error('AI response missing string `description`');
  }
  if (!response.actions || !Array.isArray(response.actions.actions)) {
    throw new Error('AI response missing `actions.actions` array');
  }
  if (!response.assertions || !Array.isArray(response.assertions.post)) {
    throw new Error('AI response missing `assertions.post` array');
  }

  const validCircuits = new Set(contract.circuits.map((c) => c.name));
  for (const action of response.actions.actions) {
    if (action.type === 'contract-call' && action.circuit && !validCircuits.has(action.circuit)) {
      throw new Error(
        `AI response references unknown circuit "${action.circuit}". ` +
        `Valid circuits: ${[...validCircuits].join(', ') || '(none)'}`,
      );
    }
  }
}

function validateUiResponse(response: AiUiResponse): void {
  if (!response || typeof response !== 'object') {
    throw new Error('AI response must be an object');
  }
  if (typeof response.description !== 'string' || !response.description) {
    throw new Error('AI response missing string `description`');
  }
  if (typeof response.prompt !== 'string' || !response.prompt.trim()) {
    throw new Error('AI response missing non-empty `prompt`');
  }
  if (!response.assertions || !Array.isArray(response.assertions.post)) {
    throw new Error('AI response missing `assertions.post` array');
  }
}

// ── Public orchestrators ───────────────────────────────────────────

/**
 * Generate a CLI-strategy suite focused on one circuit using AI. Reads
 * the contract's `.compact` source if findable; the model uses it as
 * context to pick realistic args + assertions.
 */
export async function generateCliScaffoldWithAI(
  inputs: CliScaffoldInputs,
  runner: ClaudeRunner = claudeSubprocessRunner,
): Promise<ScaffoldOutput> {
  const contractSource = inputs.contractSourcePath && existsSync(inputs.contractSourcePath)
    ? readFileSync(inputs.contractSourcePath, 'utf-8')
    : undefined;

  const prompt = buildCliPrompt({
    contractName: inputs.contract.name,
    contractSummary: renderContractSummary({
      name: inputs.contract.name,
      circuits: inputs.contract.circuits,
      witnesses: inputs.contract.witnesses,
    }),
    contractSource,
    targetCircuit: inputs.targetCircuit,
    goal: inputs.goal,
  });

  const raw = await runner(prompt);
  const response = extractJsonFence<AiCliResponse>(raw);
  validateCliResponse(response, inputs.contract);

  const suiteName = inputs.suiteName ?? `cli-${inputs.targetCircuit.name.toLowerCase().replace(/_/g, '-')}`;
  const network = inputs.network ?? DEFAULT_NETWORK;
  const servePort = inputs.servePort ?? DEFAULT_SERVE_PORT;

  const dappConfig: DappTestConfig = {
    name: inputs.contract.name,
    network,
    prep: CLI_PREP,
  };

  const suite: TestSuite = {
    name: suiteName,
    description: response.description,
    strategy: 'cli',
    timeout: DEFAULT_TIMEOUT_CLI,
  };

  // Always ensure port-listening is present in post — the model may have
  // dropped it. Cheap to add once; idempotent if it's already there.
  const assertions = ensurePortListening(response.assertions, servePort);

  return {
    dappConfig,
    suite,
    actions: response.actions,
    assertions,
    prompt: null,
    suiteName,
  };
}

/**
 * Generate a UI-strategy suite focused on one screen. Feeds the screen's
 * source to the model so the generated prompt.md uses real on-screen
 * labels rather than guesses.
 */
export async function generateUiScaffoldWithAI(
  inputs: UiScaffoldInputs,
  runner: ClaudeRunner = claudeSubprocessRunner,
): Promise<ScaffoldOutput> {
  const screenSource = readFileSync(inputs.screen.path, 'utf-8');

  const prompt = buildUiPrompt({
    contractName: inputs.contract.name,
    contractSummary: renderContractSummary({
      name: inputs.contract.name,
      circuits: inputs.contract.circuits,
      witnesses: inputs.contract.witnesses,
    }),
    screenComponent: inputs.screen.component,
    screenSource,
    relatedSources: inputs.relatedSources,
    url: inputs.url,
    goal: inputs.goal,
  });

  const raw = await runner(prompt);
  const response = extractJsonFence<AiUiResponse>(raw);
  validateUiResponse(response);

  const suiteName = inputs.suiteName ?? `ui-${inputs.screen.name}`;
  const network = inputs.network ?? DEFAULT_NETWORK;
  const servePort = inputs.servePort ?? DEFAULT_SERVE_PORT;
  const url = inputs.url;

  const dappConfig: DappTestConfig = {
    name: inputs.contract.name,
    network,
    port: inputs.port,
    buildCmd: inputs.buildCmd,
    url,
    prep: BROWSER_PREP,
  };
  if (inputs.buildDir) dappConfig.buildDir = inputs.buildDir;

  const suite: TestSuite = {
    name: suiteName,
    description: response.description,
    strategy: 'browser',
    timeout: DEFAULT_TIMEOUT_BROWSER,
    ...(inputs.browserMode ? { browserMode: inputs.browserMode } : {}),
  };

  const assertions = ensureBrowserBaseline(response.assertions, servePort);

  return {
    dappConfig,
    suite,
    actions: null,
    assertions,
    prompt: response.prompt,
    suiteName,
  };
}

// ── Helpers ────────────────────────────────────────────────────────

/** Add port-listening if the model omitted it; idempotent if already there. */
function ensurePortListening(assertions: TestAssertions, port: number): TestAssertions {
  const hasPortListening = assertions.post.some(
    (a) => a.type === 'port-listening' && (a.params as { port?: number } | undefined)?.port === port,
  );
  if (hasPortListening) return assertions;
  return {
    ...assertions,
    post: [
      ...assertions.post,
      { id: 'serve-port-listening', type: 'port-listening', params: { port }, expect: 'pass' },
    ],
  };
}

/** Browser strategy needs both claude-exit-ok and port-listening; add either if missing. */
function ensureBrowserBaseline(assertions: TestAssertions, port: number): TestAssertions {
  let post = assertions.post;
  const hasClaudeExit = post.some((a) => a.type === 'process-exit-code');
  if (!hasClaudeExit) {
    post = [
      ...post,
      { id: 'claude-exit-ok', type: 'process-exit-code', params: { code: 0 }, expect: 'pass' },
    ];
  }
  const hasPortListening = post.some(
    (a) => a.type === 'port-listening' && (a.params as { port?: number } | undefined)?.port === port,
  );
  if (!hasPortListening) {
    post = [
      ...post,
      { id: 'serve-port-listening', type: 'port-listening', params: { port }, expect: 'pass' },
    ];
  }
  return { ...assertions, post };
}

/**
 * Best-effort lookup of the contract's .compact source given its managed
 * directory. Walks up from `managed/<name>/` looking for `src/<name>.compact`
 * or `src/*.compact`. Returns undefined on miss; caller proceeds without
 * source context and just uses the contract summary.
 */
export function findContractSourcePath(managedDir: string): string | undefined {
  // managed/<name>/ → ../../src/<name>.compact is the create-mn-app convention
  const srcDir = join(dirname(dirname(managedDir)), 'src');
  if (!existsSync(srcDir)) return undefined;

  // Try the conventionally-named one first, then any .compact file in src/.
  const contractName = managedDir.split('/').pop();
  if (contractName) {
    const conventional = join(srcDir, `${contractName}.compact`);
    if (existsSync(conventional)) return conventional;
  }

  let entries: string[];
  try {
    const fs = require('node:fs') as typeof import('node:fs');
    entries = fs.readdirSync(srcDir);
  } catch {
    return undefined;
  }
  const compact = entries.find((e) => e.endsWith('.compact'));
  return compact ? join(srcDir, compact) : undefined;
}
