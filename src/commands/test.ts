// test command — run E2E tests for Midnight dApps
// Usage: midnight test <run|list|results> [options]
// Discovers dapp.test.json in the current directory and executes test suites.

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { type ParsedArgs, getFlag, hasFlag } from '../lib/argv.ts';
import { UsageError } from '../lib/errors.ts';
import { writeJsonResult } from '../lib/json-output.ts';
import { header, keyValue, divider } from '../ui/format.ts';
import { bold, dim, green, red, teal } from '../ui/colors.ts';
import { start as startSpinner } from '../ui/spinner.ts';

import { discoverDappConfig, discoverTestSuites, loadAssertions, loadActions, loadPrompt } from '../lib/test/discovery.ts';
import { createPrepContext, type TestRunResult, type PrepStepResult } from '../lib/test/types.ts';
import { runPrepSteps } from '../lib/test/prep-runner.ts';
import { runBrowserTest, resolveBrowserMode } from '../lib/test/browser-test.ts';
import { runAssertions, type AssertionContext } from '../lib/test/assertions.ts';
import { writeResult, readLatestResult, listResults } from '../lib/test/results.ts';
import { runTeardown } from '../lib/test/teardown.ts';

const VALID_SUBCOMMANDS = ['run', 'list', 'results', 'create'] as const;
type Subcommand = typeof VALID_SUBCOMMANDS[number];

function isValidSubcommand(s: string): s is Subcommand {
  return (VALID_SUBCOMMANDS as readonly string[]).includes(s);
}

export default async function testCommand(args: ParsedArgs, signal?: AbortSignal): Promise<void> {
  const subcommand = args.subcommand;

  if (!subcommand || !isValidSubcommand(subcommand)) {
    throw new UsageError(
      `Usage: midnight test <${VALID_SUBCOMMANDS.join('|')}>\n\n` +
      `  create    Generate dapp.test.json + a CLI test suite from the contract\n` +
      `  run       Run test suites for the current dApp\n` +
      `  list      List available test suites\n` +
      `  results   Show latest test results\n\n` +
      `Run from the root of a dApp project containing dapp.test.json.`
    );
  }

  const jsonMode = hasFlag(args, 'json');

  switch (subcommand) {
    case 'create':
      return handleCreate(args, jsonMode);
    case 'run':
      return handleRun(args, jsonMode, signal);
    case 'list':
      return handleList(jsonMode);
    case 'results':
      return handleResults(args, jsonMode);
  }
}

// ── create ──

import type { CreateStrategy, BrowserOptions } from '../lib/test/create.ts';

type NetworkOpt = 'preprod' | 'preview' | 'undeployed';

/** Allow either canonical strategy names or the friendlier "ui" alias. */
function parseStrategyFlag(flag: string | undefined): CreateStrategy | undefined {
  const normalized = (flag ?? '').toLowerCase();
  if (normalized === '') return undefined;
  if (normalized === 'cli' || normalized === 'browser') return normalized;
  if (normalized === 'ui') return 'browser';
  throw new UsageError(`Unknown strategy "${flag}". Use "cli" or "ui".`);
}

/** Narrow a free-form network flag down to the supported set, or undefined. */
function parseNetworkFlag(flag: string | undefined): NetworkOpt | undefined {
  return flag === 'preprod' || flag === 'preview' || flag === 'undeployed' ? flag : undefined;
}

/** Collect browser-specific flags into a partial; throws on bad port or browser-mode. */
function collectBrowserFlags(args: ParsedArgs): Partial<BrowserOptions> {
  const out: Partial<BrowserOptions> = {};
  const portFlag = getFlag(args, 'port');
  if (portFlag !== undefined) {
    const port = parseInt(portFlag, 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      throw new UsageError(`Invalid --port "${portFlag}" — must be 1–65535.`);
    }
    out.port = port;
  }
  const buildCmd = getFlag(args, 'build-cmd');
  if (buildCmd !== undefined) out.buildCmd = buildCmd;
  const buildDir = getFlag(args, 'build-dir');
  if (buildDir !== undefined) out.buildDir = buildDir;
  const url = getFlag(args, 'url');
  if (url !== undefined) out.url = url;
  const mode = getFlag(args, 'browser-mode');
  if (mode !== undefined) {
    if (mode !== 'dom' && mode !== 'vision' && mode !== 'script' && mode !== 'auto') {
      throw new UsageError(`Invalid --browser-mode "${mode}" — must be dom, vision, or script.`);
    }
    out.browserMode = mode;
  }
  return out;
}

/**
 * Resolve browser options for non-interactive mode (--json or piped stdin):
 * port + build-cmd are required, the rest are optional. Throws with an
 * actionable message if either is missing — interactive callers prompt
 * instead of throwing.
 */
function browserOptionsFromFlags(prefilled: Partial<BrowserOptions>): BrowserOptions {
  if (prefilled.port === undefined || prefilled.buildCmd === undefined) {
    throw new UsageError(
      `Browser strategy needs --port and --build-cmd (and optionally --build-dir, --url) when running non-interactively.`,
    );
  }
  return {
    port: prefilled.port,
    buildCmd: prefilled.buildCmd,
    buildDir: prefilled.buildDir,
    url: prefilled.url,
  };
}

async function handleCreate(args: ParsedArgs, jsonMode: boolean): Promise<void> {
  const { resolve } = await import('node:path');
  const { findContractInfo } = await import('../lib/contract/inspect.ts');
  const { buildScaffold } = await import('../lib/test/create.ts');
  const { writeScaffold } = await import('../lib/test/create-writer.ts');
  const promptHelpers = await import('../lib/test/create-prompt.ts');
  const { writeJsonResult } = await import('../lib/json-output.ts');
  const { isInteractive, promptStrategy, promptBrowserOptions, promptCircuit, promptScreen, promptGoal, promptSuiteName } = promptHelpers;
  const ai = await import('../lib/test/ai-scaffold.ts');
  const { discoverScreens } = await import('../lib/test/discover-screens.ts');

  const dappDir = resolve(getFlag(args, 'path') ?? process.cwd());
  const contractName = getFlag(args, 'name');
  const suiteName = getFlag(args, 'suite');
  const network = parseNetworkFlag(getFlag(args, 'network'));
  const force = hasFlag(args, 'force');
  const interactive = !jsonMode && isInteractive();
  const goalFlag = getFlag(args, 'goal');
  const screenFlag = getFlag(args, 'screen');
  const noAi = hasFlag(args, 'no-ai');

  // Strategy: explicit flag → that. Interactive + unset → prompt. Otherwise default
  // to cli (preserves prior behavior; keeps --json / MCP non-blocking).
  const strategyFlag = parseStrategyFlag(getFlag(args, 'strategy'));
  const strategy: CreateStrategy = strategyFlag ?? (interactive ? await promptStrategy() : 'cli');

  // Browser options: flag-driven in non-interactive mode (or hard fail), prompt
  // for missing pieces in interactive mode.
  let browser: BrowserOptions | undefined;
  if (strategy === 'browser') {
    const prefilled = collectBrowserFlags(args);
    browser = interactive
      ? await promptBrowserOptions(prefilled)
      : browserOptionsFromFlags(prefilled);
  }

  const { info } = findContractInfo(dappDir, contractName);

  // AI mode is opt-in (default ON when interactive + claude available, or when
  // --goal/--screen flags are present). --no-ai forces deterministic.
  const aiAvailable = !noAi && ai.isClaudeAvailable();
  const aiOptIn = !noAi && (goalFlag !== undefined || screenFlag !== undefined || (interactive && aiAvailable));

  // tryAiScaffold runs interactive prompts (goal, circuit/screen) inline —
  // spinner can't wrap the whole thing or it'd clobber the readline prompts.
  // The spinner lives one level down, around just the claude subprocess
  // call inside aiCliScaffold / aiUiScaffold.
  const scaffold = aiOptIn
    ? await tryAiScaffold({ strategy, info, dappDir, browser, network, suiteName, goalFlag, screenFlag, interactive, jsonMode, ai, promptCircuit, promptScreen, promptGoal, promptSuiteName, discoverScreens })
      ?? buildScaffold(info.circuits, { contractName: info.name, suiteName, strategy, browser, network })
    : buildScaffold(info.circuits, { contractName: info.name, suiteName, strategy, browser, network });

  // Confirm/override the suite name AFTER the scaffold is built — by now we
  // know the auto-derived default (cli-<circuit>, ui-<screen>, or *-default
  // when AI fell back). Fires for every interactive code path; --suite flag
  // and --json/MCP both bypass.
  if (interactive && !suiteName) {
    const finalName = await promptSuiteName(scaffold.suiteName);
    if (finalName !== scaffold.suiteName) {
      scaffold.suiteName = finalName;
      scaffold.suite.name = finalName;
    }
  }

  const result = writeScaffold(scaffold, { dappDir, force });

  if (jsonMode) {
    writeJsonResult({
      subcommand: 'create',
      contractName: info.name,
      suiteName: scaffold.suiteName,
      strategy,
      aiAssisted: aiOptIn && scaffold.suiteName !== `cli-default` && scaffold.suiteName !== `ui-default`,
      written: result.written,
    });
    return;
  }

  process.stderr.write('\n' + header(`Test scaffold: ${info.name}`) + '\n\n');
  for (const path of result.written) {
    process.stderr.write(`  ${green('✓')} ${path}\n`);
  }
  const editTarget = strategy === 'browser'
    ? {
        file: 'prompt.md',
        hint: 'verify the UI steps match your dApp — exact button labels, expected screens, success criteria. Claude follows these literally.',
      }
    : {
        file: 'actions.json',
        hint: 'review args — placeholder values like 0 may violate contract assertions (e.g. "amount > 0").',
      };
  process.stderr.write('\n' + dim('  Next:') + '\n');
  process.stderr.write(dim('    Edit  ') + teal(`tests/suites/${scaffold.suiteName}/${editTarget.file}`) + '\n');
  process.stderr.write(dim('          ') + dim(editTarget.hint) + '\n');
  process.stderr.write(dim('    Run   ') + teal(`mn test run --suite ${scaffold.suiteName}`) + '\n');
  process.stderr.write(dim('    List  ') + teal('mn test list') + dim('   (see every suite in this project)') + '\n\n');
}

/**
 * Try the AI scaffolder; return null on any failure so the caller can fall
 * back to the deterministic path. Failures we tolerate: no claude CLI,
 * malformed AI response, hallucinated circuit, user typed "skip" at a prompt.
 */
type AiScaffoldDeps = {
  strategy: CreateStrategy;
  info: import('../lib/contract/inspect.ts').ContractInfo;
  dappDir: string;
  browser: BrowserOptions | undefined;
  network: ReturnType<typeof parseNetworkFlag>;
  suiteName: string | undefined;
  goalFlag: string | undefined;
  screenFlag: string | undefined;
  interactive: boolean;
  jsonMode: boolean;
  ai: typeof import('../lib/test/ai-scaffold.ts');
  promptCircuit: typeof import('../lib/test/create-prompt.ts').promptCircuit;
  promptScreen: typeof import('../lib/test/create-prompt.ts').promptScreen;
  promptGoal: typeof import('../lib/test/create-prompt.ts').promptGoal;
  promptSuiteName: typeof import('../lib/test/create-prompt.ts').promptSuiteName;
  discoverScreens: typeof import('../lib/test/discover-screens.ts').discoverScreens;
};

async function tryAiScaffold(deps: AiScaffoldDeps): Promise<import('../lib/test/create.ts').ScaffoldOutput | null> {
  try {
    if (!deps.ai.isClaudeAvailable()) {
      return null;
    }

    const goal = deps.goalFlag ?? (deps.interactive ? await deps.promptGoal() : undefined);

    if (deps.strategy === 'cli') {
      return await aiCliScaffold(deps, goal);
    }
    return await aiUiScaffold(deps, goal);
  } catch (err) {
    process.stderr.write(`\n  ${dim('AI scaffold failed, falling back to deterministic:')} ${(err as Error).message}\n`);
    return null;
  }
}

/**
 * Run an async task while showing a spinner with a status line. Useful for
 * the AI scaffolder call which can take 30–60s of silence otherwise. Spinner
 * suppressed in non-interactive mode so JSON / piped callers stay clean.
 *
 * The spinner is always stopped — on resolve, reject, or null result — so a
 * thrown error won't leave a stale ⠋ glyph in the terminal.
 */
async function runWithSpinner<T>(
  message: string,
  task: () => Promise<T>,
  show: boolean,
): Promise<T> {
  if (!show) return task();
  const spinner = startSpinner(message);
  try {
    const result = await task();
    spinner.stop();
    return result;
  } catch (err) {
    spinner.fail('AI scaffold failed');
    throw err;
  }
}

async function aiCliScaffold(deps: AiScaffoldDeps, goal: string | undefined): Promise<import('../lib/test/create.ts').ScaffoldOutput | null> {
  // Interactive: ask which circuit (with "skip" option). Non-interactive:
  // pick the first impure circuit. Either way, undefined is allowed when a
  // goal is given — Claude can still scaffold a goal-driven suite without
  // the user pinning down a specific circuit.
  const targetCircuit = deps.interactive
    ? await deps.promptCircuit(deps.info.circuits)
    : deps.info.circuits.find((c) => !c.pure);

  if (!targetCircuit && !goal) return null;

  const sourcePath = deps.ai.findContractSourcePath(deps.info.managedDir);
  return runWithSpinner(
    'Asking Claude to scaffold the test suite (30–60s)...',
    () => deps.ai.generateCliScaffoldWithAI({
      contract: deps.info,
      contractSourcePath: sourcePath,
      targetCircuit,
      goal,
      network: deps.network,
      suiteName: deps.suiteName,
    }),
    deps.interactive && !deps.jsonMode,
  );
}

async function aiUiScaffold(deps: AiScaffoldDeps, goal: string | undefined): Promise<import('../lib/test/create.ts').ScaffoldOutput | null> {
  if (!deps.browser) return null; // browser opts couldn't be collected
  // The UI lives under buildDir (workspace pattern: `<dappDir>/<name>-ui/`).
  // If buildDir is empty/relative, resolve against dappDir; otherwise use it
  // directly. Falls back to dappDir for projects where buildDir is absent.
  const { join } = await import('node:path');
  const uiRoot = deps.browser.buildDir
    ? join(deps.dappDir, deps.browser.buildDir)
    : deps.dappDir;
  const candidates = deps.discoverScreens(uiRoot);
  const screen = deps.screenFlag
    ? candidates.find((c) => c.name === deps.screenFlag || c.component === deps.screenFlag)
    : (deps.interactive ? await deps.promptScreen(candidates) : candidates[0]);

  // If the user skipped the screen pick AND didn't provide a goal, there's
  // nothing for AI to ground in — fall back to deterministic. With a goal
  // we can still ask Claude to generate a generic Midnight dApp flow keyed
  // off the contract circuits + the goal text.
  if (!screen && !goal) return null;

  return runWithSpinner(
    'Asking Claude to scaffold the test suite (30–60s)...',
    () => deps.ai.generateUiScaffoldWithAI({
      contract: deps.info,
      screen,
      url: deps.browser!.url ?? `http://localhost:${deps.browser!.port}/`,
      port: deps.browser!.port,
      buildCmd: deps.browser!.buildCmd,
      buildDir: deps.browser!.buildDir,
      browserMode: deps.browser!.browserMode,
      goal,
      network: deps.network,
      suiteName: deps.suiteName,
    }),
    deps.interactive && !deps.jsonMode,
  );
}

// ── run ──

async function handleRun(args: ParsedArgs, jsonMode: boolean, signal?: AbortSignal): Promise<void> {
  const { config, dappDir } = discoverDappConfig();
  const suites = discoverTestSuites(dappDir);
  const suiteName = getFlag(args, 'suite');

  // Select suite
  let selectedSuite: typeof suites[number] | undefined;
  if (suiteName) {
    selectedSuite = suites.find(s => s.suite.name === suiteName);
    if (!selectedSuite) {
      const available = suites.map(s => s.suite.name).join(', ') || 'none found';
      throw new UsageError(`Suite "${suiteName}" not found. Available: ${available}`);
    }
  } else if (suites.length > 0) {
    selectedSuite = suites[0];
  }

  // Ensure results directory exists
  mkdirSync(join(dappDir, 'tests', 'results'), { recursive: true });

  const startTime = Date.now();
  const timestamp = new Date().toISOString();

  // Header
  if (!jsonMode) {
    process.stderr.write('\n' + header(`E2E Test: ${config.name}`) + '\n\n');
    process.stderr.write(keyValue('Network', config.network ?? 'undeployed') + '\n');
    if (config.port) process.stderr.write(keyValue('Port', String(config.port)) + '\n');
    if (selectedSuite) {
      process.stderr.write(keyValue('Suite', selectedSuite.suite.name) + '\n');
      process.stderr.write(keyValue('Strategy', selectedSuite.suite.strategy) + '\n');
      if (selectedSuite.suite.strategy === 'browser') {
        const mode = resolveBrowserMode(selectedSuite.suite);
        process.stderr.write(keyValue('Browser Mode', mode) + '\n');
      }
    }
    process.stderr.write('\n');
  }

  // Prep context for resource tracking + teardown
  const ctx = createPrepContext();
  const prepResults: PrepStepResult[] = [];

  // Register teardown on abort
  const teardownLog = (msg: string) => {
    if (!jsonMode) process.stderr.write(dim(`  [teardown] ${msg}`) + '\n');
  };
  signal?.addEventListener('abort', () => runTeardown(ctx, teardownLog), { once: true });

  try {
    // ── Prep phase ──
    if (!jsonMode) process.stderr.write(bold('  Prep\n'));

    let spinner = startSpinner('Starting prep...');

    const results = await runPrepSteps(config, dappDir, ctx, {
      onStepStart(step) {
        spinner.update(`[prep] ${step}...`);
      },
      onStepComplete(step, status, duration, error) {
        if (status === 'pass') {
          spinner.stop(`${green('✓')} ${step} (${formatMs(duration)})`);
        } else {
          spinner.stop(`${red('✗')} ${step}: ${error ?? 'failed'}`);
        }
        spinner = startSpinner('');
      },
      onMessage(msg) {
        spinner.update(msg);
      },
    });

    spinner.stop('');
    prepResults.push(...results);

    if (!jsonMode) process.stderr.write('\n');

    // ── Test execution ──
    let testExitCode = 0;
    let testLogFile = '';

    if (selectedSuite) {
      const suite = selectedSuite.suite;

      if (suite.strategy === 'browser') {
        const prompt = loadPrompt(selectedSuite.suiteDir);
        if (!prompt) {
          throw new Error(`No prompt.md found in ${selectedSuite.suiteDir} — required for browser strategy`);
        }

        testLogFile = join(dappDir, 'tests', 'results', `${suite.name}_${timestamp.replace(/[:.]/g, '-')}_claude.log`);

        if (!jsonMode) {
          process.stderr.write(bold('  Browser Test\n'));
          process.stderr.write(dim('  Claude will take over the terminal. Output is also logged.\n\n'));
        }

        const browserResult = await runBrowserTest({
          suite,
          prompt,
          dappDir,
          logFile: testLogFile,
          onMessage: (msg) => {
            if (!jsonMode) process.stderr.write(dim(`  ${msg}`) + '\n');
          },
        });

        testExitCode = browserResult.exitCode;

        if (!jsonMode) {
          process.stderr.write('\n');
          if (browserResult.timedOut) {
            process.stderr.write(`  ${red('✗')} Browser test timed out\n`);
          } else {
            process.stderr.write(`  ${testExitCode === 0 ? green('✓') : red('✗')} Claude exited with code ${testExitCode}\n`);
          }
        }
      } else if (suite.strategy === 'cli') {
        const actionsConfig = loadActions(selectedSuite.suiteDir);
        if (!actionsConfig) {
          throw new Error(`No actions.json found in ${selectedSuite.suiteDir} — required for CLI strategy`);
        }

        if (!jsonMode) {
          process.stderr.write(bold('  CLI Test\n'));
          process.stderr.write(dim(`  Executing ${actionsConfig.actions.length} action(s)\n\n`));
        }

        const { runActions, diffState } = await import('../lib/test/actions-runner.ts');
        const { resolveNetwork } = await import('../lib/resolve-network.ts');

        const network = config.network ?? 'undeployed';
        const { config: networkConfig } = resolveNetwork({
          args: { command: 'test', subcommand: 'run', positionals: [], flags: { network } },
        });

        // mn serve should already be started by the prep step (mn-serve)
        // Use the serve port from ctx if available, otherwise default
        const { DEFAULT_SERVE_PORT } = await import('../lib/constants.ts');
        const servePort = ctx.serveHandle?.port ?? DEFAULT_SERVE_PORT;

        const redeployFlag = hasFlag(args, 'redeploy');

        const actionResults = await runActions({
          actions: actionsConfig.actions,
          config,
          dappDir,
          suiteName: suite.name,
          networkConfig,
          servePort,
          redeploy: redeployFlag,
          onActionStart: (action) => {
            if (!jsonMode) {
              const spinner = startSpinner(`[${action.id}] ${action.type}${action.circuit ? ` ${action.circuit}` : ''}...`);
              (action as any)._spinner = spinner;
            }
          },
          onActionComplete: (action, result) => {
            if (!jsonMode) {
              const spinner = (action as any)._spinner;
              if (spinner) {
                if (result.status === 'pass') {
                  spinner.stop(`${green('✓')} ${action.id}: ${result.message ?? 'pass'}`);
                } else {
                  spinner.stop(`${red('✗')} ${action.id}: ${result.message ?? 'fail'}`);
                }
              }

              // Show state diff if available
              if (result.stateBefore && result.stateAfter) {
                const diffs = diffState(result.stateBefore, result.stateAfter);
                if (diffs.length > 0) {
                  for (const d of diffs) {
                    process.stderr.write(dim(`      ${d.field}: ${d.before} → `) + teal(d.after) + '\n');
                  }
                }
              }
            }
          },
          onMessage: (msg) => {
            // Messages from the runner (deploy/call progress)
          },
        });

        // Check if any action failed
        const actionsFailed = actionResults.some(r => r.status === 'fail');
        testExitCode = actionsFailed ? 1 : 0;

        if (!jsonMode) {
          process.stderr.write('\n');
          const passed = actionResults.filter(r => r.status === 'pass').length;
          const failed = actionResults.filter(r => r.status === 'fail').length;
          process.stderr.write(`  Actions: ${green(String(passed) + ' passed')}${failed > 0 ? `, ${red(String(failed) + ' failed')}` : ''}\n`);
        }

        // Store action results for the final result JSON
        (ctx as any)._actionResults = actionResults;
      }
    } else {
      if (!jsonMode) {
        process.stderr.write(dim('  No test suites found — only prep was run\n'));
      }
    }

    // ── Assertions ──
    const assertionContext: AssertionContext = {
      processExitCode: testExitCode,
      agentLogPath: testLogFile, // browser-strategy runs only; CLI leaves it undefined
    };

    let assertionResults: { id: string; status: 'pass' | 'fail'; message?: string }[] = [];

    if (selectedSuite) {
      const assertions = loadAssertions(selectedSuite.suiteDir);
      if (assertions && assertions.post.length > 0) {
        if (!jsonMode) process.stderr.write('\n' + bold('  Assertions\n'));
        assertionResults = await runAssertions(assertions.post, assertionContext);

        if (!jsonMode) {
          for (const r of assertionResults) {
            const icon = r.status === 'pass' ? green('✓') : red('✗');
            const msg = r.message ? dim(` — ${r.message}`) : '';
            process.stderr.write(`  ${icon} ${r.id}${msg}\n`);
          }
        }
      }
    }

    // ── Results ──
    const duration = Math.round((Date.now() - startTime) / 1000);
    const allPrepPassed = prepResults.every(r => r.status === 'pass');
    const allAssertionsPassed = assertionResults.every(r => r.status === 'pass');
    const overall = allPrepPassed && allAssertionsPassed && testExitCode === 0 ? 'pass' : 'fail';

    // Collect action results if CLI strategy was used
    const actionResults = (ctx as any)._actionResults as import('../lib/test/actions-runner.ts').ActionResult[] | undefined;

    const runResult: TestRunResult = {
      id: `${config.name}_${timestamp}`,
      dapp: config.name,
      suite: selectedSuite?.suite.name ?? 'prep-only',
      timestamp,
      duration,
      network: config.network ?? 'undeployed',
      strategy: selectedSuite?.suite.strategy ?? 'none',
      model: selectedSuite?.suite.model,
      status: overall,
      prep: prepResults,
      actions: actionResults?.map(r => ({
        id: r.id,
        type: r.type,
        status: r.status,
        duration: r.duration,
        message: r.message,
        contractAddress: r.contractAddress,
      })),
      assertions: assertionResults,
      testOutput: testLogFile ? { exitCode: testExitCode, logFile: testLogFile } : undefined,
    };

    const resultPath = writeResult(runResult, dappDir);

    if (jsonMode) {
      writeJsonResult(runResult as unknown as Record<string, unknown>);
    } else {
      process.stderr.write('\n' + divider() + '\n');
      process.stderr.write(`  ${overall === 'pass' ? green(bold('PASS')) : red(bold('FAIL'))} — ${config.name} (${duration}s)\n`);
      process.stderr.write(dim(`  Results: ${resultPath}`) + '\n\n');
    }

    if (overall === 'fail') {
      process.exitCode = 1;
    }

  } finally {
    await runTeardown(ctx, teardownLog);
  }
}

// ── list ──

function handleList(jsonMode: boolean): void {
  const { config, dappDir } = discoverDappConfig();
  const suites = discoverTestSuites(dappDir);

  if (jsonMode) {
    writeJsonResult({
      dapp: config.name,
      suites: suites.map(s => ({
        name: s.suite.name,
        description: s.suite.description,
        strategy: s.suite.strategy,
        timeout: s.suite.timeout,
      })),
    });
    return;
  }

  process.stderr.write('\n' + header(`Tests: ${config.name}`) + '\n\n');

  if (suites.length === 0) {
    process.stderr.write(dim('  No test suites found.\n'));
    process.stderr.write(dim(`  Create tests/suites/<name>/suite.json to add one.\n`));
  } else {
    for (const { suite } of suites) {
      process.stderr.write(`  ${bold(teal(suite.name))}\n`);
      process.stderr.write(`  ${dim(suite.description)}\n`);
      process.stderr.write(dim(`  strategy: ${suite.strategy}`) + (suite.timeout ? dim(`, timeout: ${suite.timeout}s`) : '') + '\n\n');
    }
  }

  process.stderr.write('\n');
}

// ── results ──

function handleResults(args: ParsedArgs, jsonMode: boolean): void {
  const { config, dappDir } = discoverDappConfig();
  const showAll = hasFlag(args, 'all');
  const suiteName = getFlag(args, 'suite');

  const results = showAll
    ? listResults(dappDir, suiteName)
    : (() => {
        const latest = readLatestResult(dappDir, suiteName);
        return latest ? [latest] : [];
      })();

  if (jsonMode) {
    writeJsonResult((showAll ? { dapp: config.name, results } : results[0] ?? {}) as Record<string, unknown>);
    return;
  }

  process.stderr.write('\n' + header(`Results: ${config.name}`) + '\n\n');

  if (results.length === 0) {
    process.stderr.write(dim('  No test results found.\n'));
    process.stderr.write(dim(`  Run "midnight test run" to generate results.\n`));
  } else {
    for (const result of results) {
      const icon = result.status === 'pass' ? green('✓') : red('✗');
      const statusStr = result.status === 'pass' ? green(bold('PASS')) : red(bold('FAIL'));
      process.stderr.write(`  ${icon} ${bold(result.suite)} — ${statusStr} (${result.duration}s)\n`);
      process.stderr.write(dim(`    ${result.timestamp} | ${result.network} | ${result.strategy}`) + '\n');

      // Prep summary
      const prepFailed = result.prep.filter(p => p.status === 'fail');
      if (prepFailed.length > 0) {
        process.stderr.write(red(`    prep: ${prepFailed.length} failed`) + '\n');
      }

      // Assertion summary
      const assertFailed = result.assertions.filter(a => a.status === 'fail');
      if (assertFailed.length > 0) {
        process.stderr.write(red(`    assertions: ${assertFailed.length} failed`) + '\n');
      }

      process.stderr.write('\n');
    }
  }

  process.stderr.write('\n');
}

// ── Helpers ──

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
