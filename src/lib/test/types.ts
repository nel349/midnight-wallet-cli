// Test framework types — schemas for dapp.test.json, suite configs, assertions, and results.

// ── DApp Test Config (dapp.test.json in dApp root) ──

export interface DappTestConfig {
  name: string;
  network?: NetworkName;
  port?: number;
  buildCmd?: string;
  buildDir?: string;
  url?: string;
  contractEntry?: string;
  prep: PrepStepId[];
}

export type NetworkName = 'undeployed' | 'preprod' | 'preview';

// Prep step identifiers — balance:<amount> is parametric, rest are fixed
export type PrepStepId =
  | 'cache-clear'
  | 'localnet-up'
  | `balance:${number}`
  | 'dust'
  | 'dust-register'   // alias for 'dust' (backward compat)
  | 'dust-wait'        // alias for 'dust' (backward compat)
  | 'mn-serve'
  | 'build-and-serve';

// ── Test Suite (tests/suites/<name>/suite.json) ──

export interface TestSuite {
  name: string;
  description: string;
  strategy: TestStrategy;
  browserMode?: BrowserMode;
  model?: string;
  effort?: string;
  timeout?: number;
  depends?: string[];
}

export type TestStrategy = 'browser' | 'cli' | 'hybrid';
export type BrowserMode = 'dom' | 'script' | 'vision' | 'auto';

// ── Actions (tests/suites/<name>/actions.json) — CLI/hybrid only ──

export interface TestActions {
  actions: TestAction[];
}

export interface TestAction {
  id: string;
  type: 'contract-deploy' | 'contract-call' | 'contract-state' | 'wallet-cmd';
  circuit?: string;
  args?: Record<string, unknown>;
  assert?: Record<string, unknown>;
  cmd?: string;
}

// ── Assertions (tests/suites/<name>/assertions.json) ──

export interface TestAssertions {
  pre?: AssertionCheck[];
  post: AssertionCheck[];
}

export interface AssertionCheck {
  id: string;
  type: AssertionType;
  params: Record<string, unknown>;
  expect: 'pass' | 'fail';
}

export type AssertionType =
  | 'balance-changed'
  | 'process-exit-code'
  | 'port-listening'
  | 'custom-command'
  | 'ledger-field'
  | 'contract-deployed'
  | 'dust-available'
  | 'mn-serve-log-contains';

// ── Results ──

export interface TestRunResult {
  id: string;
  dapp: string;
  suite: string;
  timestamp: string;
  duration: number;
  network: string;
  strategy: string;
  model?: string;
  status: 'pass' | 'fail' | 'timeout' | 'error';
  prep: PrepStepResult[];
  assertions: AssertionResult[];
  testOutput?: {
    exitCode: number;
    logFile: string;
  };
  error?: string;
}

export interface PrepStepResult {
  step: string;
  status: 'pass' | 'fail' | 'skip';
  duration: number;
  error?: string;
}

export interface AssertionResult {
  id: string;
  status: 'pass' | 'fail';
  message?: string;
}

// ── Handles for long-running resources ──

export interface ServeHandle {
  port: number;
  stop(): Promise<void>;
}

export interface BuildHandle {
  port: number;
  child: import('child_process').ChildProcess;
  stop(): void;
}

// ── Prep context — accumulates resources for teardown ──

export interface PrepContext {
  serveHandle?: ServeHandle;
  buildHandle?: BuildHandle;
  cleanups: (() => Promise<void>)[];
  addCleanup(fn: () => Promise<void>): void;
}

export function createPrepContext(): PrepContext {
  const cleanups: (() => Promise<void>)[] = [];
  return {
    cleanups,
    addCleanup(fn: () => Promise<void>) {
      cleanups.push(fn);
    },
  };
}

// ── Callbacks for UI feedback ──

export interface PrepCallbacks {
  onStepStart(step: string): void;
  onStepComplete(step: string, status: 'pass' | 'fail', duration: number, error?: string): void;
  onMessage(message: string): void;
}
