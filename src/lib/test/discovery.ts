// Test discovery — find and validate dapp.test.json and suite configs from the dApp root.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { DappTestConfig, TestSuite, TestAssertions, NetworkName, PrepStepId, BrowserMode } from './types.ts';

const CONFIG_FILENAME = 'dapp.test.json';
const SUITES_DIR = 'tests/suites';

// ── Config Discovery ──

/**
 * Find and parse dapp.test.json from the given directory (defaults to cwd).
 * Throws with a clear message if not found or invalid.
 */
export function discoverDappConfig(dir?: string): { config: DappTestConfig; configPath: string; dappDir: string } {
  const dappDir = resolve(dir ?? process.cwd());
  const configPath = join(dappDir, CONFIG_FILENAME);

  if (!existsSync(configPath)) {
    throw new Error(
      `No ${CONFIG_FILENAME} found in ${dappDir}\n` +
      `Run this command from the root of a dApp project, or create a ${CONFIG_FILENAME} file.`
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    throw new Error(`Failed to parse ${configPath}: ${(err as Error).message}`);
  }

  const config = validateDappConfig(raw, configPath);
  return { config, configPath, dappDir };
}

// ── Suite Discovery ──

/**
 * Discover all test suites in the dApp's tests/suites/ directory.
 * Each suite is a subdirectory containing a suite.json file.
 */
export function discoverTestSuites(dappDir: string): { suite: TestSuite; suiteDir: string }[] {
  const suitesDir = join(dappDir, SUITES_DIR);

  if (!existsSync(suitesDir)) {
    return [];
  }

  const entries = readdirSync(suitesDir, { withFileTypes: true });
  const suites: { suite: TestSuite; suiteDir: string }[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const suiteDir = join(suitesDir, entry.name);
    const suiteConfigPath = join(suiteDir, 'suite.json');

    if (!existsSync(suiteConfigPath)) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(suiteConfigPath, 'utf-8'));
    } catch (err) {
      throw new Error(`Failed to parse ${suiteConfigPath}: ${(err as Error).message}`);
    }

    suites.push({
      suite: validateTestSuite(raw, suiteConfigPath),
      suiteDir,
    });
  }

  return suites;
}

/**
 * Load assertions from a suite directory, if assertions.json exists.
 */
export function loadAssertions(suiteDir: string): TestAssertions | null {
  const assertionsPath = join(suiteDir, 'assertions.json');

  if (!existsSync(assertionsPath)) {
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(assertionsPath, 'utf-8'));
  } catch (err) {
    throw new Error(`Failed to parse ${assertionsPath}: ${(err as Error).message}`);
  }

  return validateAssertions(raw, assertionsPath);
}

/**
 * Load the prompt file for a browser test suite, if it exists.
 */
export function loadPrompt(suiteDir: string): string | null {
  const promptPath = join(suiteDir, 'prompt.md');

  if (!existsSync(promptPath)) {
    return null;
  }

  return readFileSync(promptPath, 'utf-8');
}

// ── Validation ──

const VALID_NETWORKS: NetworkName[] = ['undeployed', 'preprod', 'preview'];
const VALID_STRATEGIES = ['browser', 'cli', 'hybrid'] as const;
const VALID_BROWSER_MODES: BrowserMode[] = ['dom', 'script', 'vision', 'auto'];

const PREP_STEP_PATTERN = /^(cache-clear|localnet-up|balance:\d+|dust-register|dust-wait|mn-serve|build-and-serve)$/;

function validateDappConfig(raw: unknown, path: string): DappTestConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${path}: must be a JSON object`);
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    throw new Error(`${path}: "name" is required and must be a non-empty string`);
  }

  if (obj.network !== undefined && !VALID_NETWORKS.includes(obj.network as NetworkName)) {
    throw new Error(`${path}: "network" must be one of: ${VALID_NETWORKS.join(', ')}`);
  }

  if (obj.port !== undefined && (typeof obj.port !== 'number' || obj.port < 1 || obj.port > 65535)) {
    throw new Error(`${path}: "port" must be a number between 1 and 65535`);
  }

  if (obj.buildCmd !== undefined && typeof obj.buildCmd !== 'string') {
    throw new Error(`${path}: "buildCmd" must be a string`);
  }

  if (obj.buildDir !== undefined && typeof obj.buildDir !== 'string') {
    throw new Error(`${path}: "buildDir" must be a string`);
  }

  if (obj.url !== undefined && typeof obj.url !== 'string') {
    throw new Error(`${path}: "url" must be a string`);
  }

  if (!Array.isArray(obj.prep)) {
    throw new Error(`${path}: "prep" is required and must be an array of prep step IDs`);
  }

  for (const step of obj.prep) {
    if (typeof step !== 'string' || !PREP_STEP_PATTERN.test(step)) {
      throw new Error(
        `${path}: invalid prep step "${step}". ` +
        `Valid steps: cache-clear, localnet-up, balance:<amount>, dust-register, dust-wait, mn-serve, build-and-serve`
      );
    }
  }

  return {
    name: obj.name,
    network: (obj.network as NetworkName) ?? 'undeployed',
    port: obj.port as number | undefined,
    buildCmd: obj.buildCmd as string | undefined,
    buildDir: obj.buildDir as string | undefined,
    url: obj.url as string | undefined,
    contractEntry: obj.contractEntry as string | undefined,
    prep: obj.prep as PrepStepId[],
  };
}

function validateTestSuite(raw: unknown, path: string): TestSuite {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${path}: must be a JSON object`);
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    throw new Error(`${path}: "name" is required and must be a non-empty string`);
  }

  if (typeof obj.description !== 'string') {
    throw new Error(`${path}: "description" is required and must be a string`);
  }

  if (!VALID_STRATEGIES.includes(obj.strategy as typeof VALID_STRATEGIES[number])) {
    throw new Error(`${path}: "strategy" must be one of: ${VALID_STRATEGIES.join(', ')}`);
  }

  if (obj.timeout !== undefined && (typeof obj.timeout !== 'number' || obj.timeout <= 0)) {
    throw new Error(`${path}: "timeout" must be a positive number (seconds)`);
  }

  if (obj.browserMode !== undefined && !VALID_BROWSER_MODES.includes(obj.browserMode as BrowserMode)) {
    throw new Error(`${path}: "browserMode" must be one of: ${VALID_BROWSER_MODES.join(', ')}`);
  }

  return {
    name: obj.name,
    description: obj.description,
    strategy: obj.strategy as TestSuite['strategy'],
    browserMode: obj.browserMode as BrowserMode | undefined,
    model: obj.model as string | undefined,
    effort: obj.effort as string | undefined,
    timeout: obj.timeout as number | undefined,
    depends: Array.isArray(obj.depends) ? obj.depends as string[] : undefined,
  };
}

function validateAssertions(raw: unknown, path: string): TestAssertions {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${path}: must be a JSON object`);
  }

  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj.post)) {
    throw new Error(`${path}: "post" is required and must be an array of assertion checks`);
  }

  // Validate each check has required fields
  for (const check of obj.post) {
    if (typeof check !== 'object' || check === null) {
      throw new Error(`${path}: each assertion check must be an object`);
    }
    const c = check as Record<string, unknown>;
    if (typeof c.id !== 'string') {
      throw new Error(`${path}: each assertion check must have a string "id"`);
    }
    if (typeof c.type !== 'string') {
      throw new Error(`${path}: assertion "${c.id}" must have a string "type"`);
    }
    if (typeof c.expect !== 'string' || (c.expect !== 'pass' && c.expect !== 'fail')) {
      throw new Error(`${path}: assertion "${c.id}" must have "expect" set to "pass" or "fail"`);
    }
  }

  return {
    pre: Array.isArray(obj.pre) ? obj.pre as TestAssertions['pre'] : undefined,
    post: obj.post as TestAssertions['post'],
  };
}
