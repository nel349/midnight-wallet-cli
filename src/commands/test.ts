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

const VALID_SUBCOMMANDS = ['run', 'list', 'results'] as const;
type Subcommand = typeof VALID_SUBCOMMANDS[number];

function isValidSubcommand(s: string): s is Subcommand {
  return (VALID_SUBCOMMANDS as readonly string[]).includes(s);
}

export default async function testCommand(args: ParsedArgs, signal?: AbortSignal): Promise<void> {
  const subcommand = args.subcommand;

  if (!subcommand || !isValidSubcommand(subcommand)) {
    throw new UsageError(
      `Usage: midnight test <${VALID_SUBCOMMANDS.join('|')}>\n\n` +
      `  run       Run test suites for the current dApp\n` +
      `  list      List available test suites\n` +
      `  results   Show latest test results\n\n` +
      `Run from the root of a dApp project containing dapp.test.json.`
    );
  }

  const jsonMode = hasFlag(args, 'json');

  switch (subcommand) {
    case 'run':
      return handleRun(args, jsonMode, signal);
    case 'list':
      return handleList(jsonMode);
    case 'results':
      return handleResults(args, jsonMode);
  }
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
