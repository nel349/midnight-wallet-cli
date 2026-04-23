// `mn dev` — iteration loop for Compact contract development.
// M1: detect project → ensure localnet → watch .compact → compile on save.
// M2: `d` keypress deploys the current compiled artifact, `q` quits cleanly.

import { existsSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { type ParsedArgs } from '../lib/argv.ts';
import { detectProject, type ProjectInfo } from '../lib/dev/detect-project.ts';
import { runCompile, type CompileResult } from '../lib/dev/compile.ts';
import { runTests } from '../lib/dev/test.ts';
import { startWatching, type WatchHandle } from '../lib/dev/watch.ts';
import { ensureLocalnetRunning } from '../lib/dev/localnet-ready.ts';
import {
  provisionDevWallets,
  DEFAULT_DEV_WALLET_NAMES,
  DEFAULT_DEV_AIRDROP_AMOUNT,
} from '../lib/dev/provision-wallets.ts';
import { startKeyDispatcher } from '../lib/dev/keys.ts';
import { captureCommand } from '../lib/run-command.ts';
import { header, divider, keyValue } from '../ui/format.ts';
import { bold, dim, red, teal, yellow } from '../ui/colors.ts';
import { start as startSpinner } from '../ui/spinner.ts';

/** Wallet used when `d` deploys. Must be one of the provisioned dev-* names. */
const DEPLOY_WALLET = 'dev-alice';
const DEPLOY_NETWORK = 'undeployed';

export default async function devCommand(args: ParsedArgs, signal?: AbortSignal): Promise<void> {
  const startDir = resolve(args.positionals[0] ?? process.cwd());

  process.stderr.write('\n' + header('mn dev') + '\n\n');

  // ── Phase 1: detect project ───────────────────────────────
  const project: ProjectInfo = detectProject(startDir);

  if (!project.compileScript) {
    throw new Error(
      `No compile script found in ${project.projectRoot}/package.json.\n` +
      `mn dev looks for a "compact" or "compile" npm script that invokes the\n` +
      `Compact toolchain. Add one of:\n` +
      `  "scripts": { "compact": "compact compile src/my.compact src/managed/my" }\n` +
      `  "scripts": { "compile": "compact compile src/my.compact src/managed/my" }\n` +
      `create-mn-app and midnight-starship templates ship with this already wired.`,
    );
  }

  process.stderr.write(keyValue('Project', project.projectRoot) + '\n');
  process.stderr.write(keyValue('Sources', `${project.sourceFiles.length} .compact file(s)`) + '\n');
  process.stderr.write(keyValue('Compile', `npm run ${project.compileScript}`) + '\n\n');

  // ── Phase 2: ensure localnet running ──────────────────────
  const localnetSpinner = startSpinner('Checking localnet...');
  try {
    const result = await ensureLocalnetRunning((msg) => localnetSpinner.update(msg));
    const stateLabel = {
      'already-running': 'Localnet already running',
      'started': 'Localnet started',
      'started-unhealthy': 'Localnet started (some services not yet healthy)',
    }[result.state];
    localnetSpinner.stop(stateLabel);
  } catch (err) {
    localnetSpinner.fail('Localnet setup failed');
    throw err;
  }

  // ── Phase 3: provision dev wallets ────────────────────────
  const walletSpinner = startSpinner('Provisioning dev wallets...');
  try {
    const provisioned = await provisionDevWallets({
      names: DEFAULT_DEV_WALLET_NAMES,
      amountNight: DEFAULT_DEV_AIRDROP_AMOUNT,
      signal,
      onProgress: (name, phase) => {
        const label = {
          creating: 'generating',
          funding: 'airdropping',
          dust: 'registering dust',
          done: 'ready',
        }[phase];
        walletSpinner.update(`${name}: ${label}`);
      },
    });
    const created = provisioned.filter((w) => w.state === 'created').length;
    const reused = provisioned.length - created;
    const summary = [
      created ? `${created} created` : '',
      reused ? `${reused} reused` : '',
    ].filter(Boolean).join(', ');
    walletSpinner.stop(`Dev wallets: ${provisioned.map((w) => w.name).join(', ')} (${summary})`);
  } catch (err) {
    walletSpinner.fail('Wallet provisioning failed');
    throw err;
  }

  // Shared state threaded through the watcher and keypress handlers.
  let lastCompile: CompileResult | null = null;
  let deployInFlight = false;
  let testInFlight = false;
  let compileInFlight = false;
  let compileQueued = false;

  // ── Phase 4: first compile pass ───────────────────────────
  lastCompile = await compileAndReport(project, signal);
  if (!lastCompile.success) {
    process.stderr.write(dim('\n  Fix the errors above and save — mn dev will recompile automatically.\n'));
  }

  // ── Phase 5: start watcher ────────────────────────────────
  const runPass = async () => {
    if (deployInFlight || testInFlight) {
      // Another exclusive action is holding the line. The save will be picked
      // up after it returns — the user can always save again to force a recompile.
      return;
    }
    if (compileInFlight) {
      compileQueued = true;
      return;
    }
    compileInFlight = true;
    try {
      lastCompile = await compileAndReport(project, signal);
    } finally {
      compileInFlight = false;
      if (compileQueued) {
        compileQueued = false;
        // Drain queued request after in-flight finishes.
        runPass();
      }
    }
  };

  const watcher: WatchHandle = startWatching({
    dirs: project.sourceDirs,
    extension: '.compact',
    onChange: async (changed) => {
      const rel = changed.map((p) => relative(project.projectRoot, p)).join(', ');
      process.stderr.write('\n' + dim(`  Changed: ${rel}`) + '\n');
      await runPass();
    },
    onError: (err) => {
      process.stderr.write(red('  watch error: ') + err.message + '\n');
    },
  });

  process.stderr.write('\n' + divider() + '\n');
  const watchedLabel = project.sourceDirs.map((d) => relative(project.projectRoot, d) || '.').join(', ');
  process.stderr.write(dim('  Watching ') + teal(watchedLabel) + dim(' — save to recompile.') + '\n');
  const testHint = project.testScript ? bold('[t]') + dim(` test (${project.testScript})   `) : '';
  process.stderr.write(dim('  ') + bold('[d]') + dim(' deploy   ') + testHint + bold('[q]') + dim(' quit\n\n'));

  // ── Phase 6: keystroke dispatcher + wait until aborted ────
  const abortController = new AbortController();
  const stopRequest = () => {
    if (!abortController.signal.aborted) abortController.abort();
  };

  const keys = startKeyDispatcher({
    actions: {
      d: async () => {
        if (deployInFlight) {
          process.stderr.write(dim('  Deploy already in flight — ignoring key press.\n'));
          return;
        }
        if (testInFlight) {
          process.stderr.write(dim('  Tests are running — wait for them to finish before deploying.\n'));
          return;
        }
        if (!lastCompile?.success) {
          process.stderr.write(yellow('  Cannot deploy — last compile did not succeed. Fix and save first.\n'));
          return;
        }
        deployInFlight = true;
        try {
          await deployContract(project);
        } finally {
          deployInFlight = false;
        }
      },
      t: async () => {
        if (testInFlight) {
          process.stderr.write(dim('  Tests already in flight — ignoring key press.\n'));
          return;
        }
        if (deployInFlight) {
          process.stderr.write(dim('  Deploy in flight — wait for it to finish before running tests.\n'));
          return;
        }
        if (!project.testScript) {
          process.stderr.write(yellow('  No test script found. Add "test:dev" or "test" to package.json.\n'));
          return;
        }
        if (!lastCompile?.success) {
          process.stderr.write(yellow('  Cannot run tests — last compile did not succeed. Fix and save first.\n'));
          return;
        }
        testInFlight = true;
        try {
          await runProjectTests(project);
        } finally {
          testInFlight = false;
        }
      },
      q: () => stopRequest(),
    },
    onInterrupt: stopRequest,
  });

  await new Promise<void>((resolvePromise) => {
    const onAbort = () => {
      keys.stop();
      watcher.stop();
      process.stderr.write('\n' + dim('  mn dev stopped.') + '\n');
      resolvePromise();
    };
    if (abortController.signal.aborted) { onAbort(); return; }
    abortController.signal.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { stopRequest(); return; }
    signal?.addEventListener('abort', stopRequest, { once: true });
  });
}

async function deployContract(project: ProjectInfo): Promise<void> {
  const previousCwd = process.cwd();
  if (previousCwd !== project.projectRoot) {
    try { process.chdir(project.projectRoot); } catch { /* best-effort */ }
  }

  try {
    // Pre-flight: contracts that declare witnesses need a witnesses.js the
    // runner can load. If declared witnesses exist and no implementation file
    // is present, refuse early with an actionable message rather than letting
    // the SDK throw "first (witnesses) argument does not contain a function-
    // valued field named X" mid-deploy.
    const witnessNames = await readDeclaredWitnesses(project.projectRoot);
    if (witnessNames.length > 0 && !findWitnessFile(project.projectRoot)) {
      process.stderr.write(yellow(`  ✗ Cannot auto-deploy: contract declares ${witnessNames.length} witness(es): ${witnessNames.join(', ')}\n`));
      process.stderr.write(dim(`    Add a witnesses module (src/witnesses.ts compiled to dist/witnesses.js) that\n`));
      process.stderr.write(dim(`    exports a "witnesses" object mapping each name to its implementation. Then\n`));
      process.stderr.write(dim(`    rebuild (e.g. "npm run build") so dist/witnesses.js exists, and try "d" again.\n`));
      return;
    }

    const spinner = startSpinner(`Deploying with ${DEPLOY_WALLET} on ${DEPLOY_NETWORK}...`);
    try {
      const { default: handler } = await import('./contract.ts');
      const result = await captureCommand(handler, {
        command: 'contract',
        subcommand: 'deploy',
        positionals: [],
        flags: { wallet: DEPLOY_WALLET, network: DEPLOY_NETWORK },
      });
      spinner.stop(`Deployed`);
      const address = typeof result.address === 'string' ? result.address : '(unknown)';
      process.stderr.write(`  ${dim('address')}  ${teal(address)}\n`);
    } catch (err) {
      spinner.fail('Deploy failed');
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(red('  ' + message) + '\n');
    }
  } finally {
    if (process.cwd() !== previousCwd) {
      try { process.chdir(previousCwd); } catch { /* best-effort */ }
    }
  }
}

async function runProjectTests(project: ProjectInfo): Promise<void> {
  process.stderr.write(dim(`\n  Running npm run ${project.testScript}...\n`));
  const previousCwd = process.cwd();
  if (previousCwd !== project.projectRoot) {
    try { process.chdir(project.projectRoot); } catch { /* best-effort */ }
  }
  try {
    const result = await runTests({ project });
    if (result.success) {
      process.stderr.write(`  ${dim('─')} Tests passed ${dim(`(${formatDuration(result.durationMs)})`)}\n`);
    } else {
      process.stderr.write(`  ${dim('─')} ${red(`Tests failed`)} ${dim(`(exit ${result.exitCode}, ${formatDuration(result.durationMs)})`)}\n`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(red('  Test runner error: ') + message + '\n');
  } finally {
    if (process.cwd() !== previousCwd) {
      try { process.chdir(previousCwd); } catch { /* best-effort */ }
    }
  }
}

/**
 * Returns the names of witnesses declared in the project's compiled contract,
 * or an empty array if no compiled artifact / witnesses exist.
 * Best-effort — failures (no managed dir yet, malformed info) → empty array.
 */
async function readDeclaredWitnesses(projectRoot: string): Promise<string[]> {
  try {
    const { findContractInfo } = await import('../lib/contract/inspect.ts');
    const { info } = findContractInfo(projectRoot);
    return info.witnesses.map((w) => w.name);
  } catch {
    return [];
  }
}

/**
 * Best-effort check for a witnesses module the deploy runner can load.
 * Mirrors the search paths in src/lib/contract/runner.ts so the preflight
 * matches what the runner actually does.
 */
function findWitnessFile(projectRoot: string): string | null {
  const candidates = [
    'dist/witnesses.js',
    'src/witnesses.js',
    'contract/dist/witnesses.js',
    'contract/src/witnesses.js',
  ];
  for (const rel of candidates) {
    const full = join(projectRoot, rel);
    if (existsSync(full)) return full;
  }
  return null;
}

async function compileAndReport(project: ProjectInfo, signal?: AbortSignal): Promise<CompileResult> {
  const spinner = startSpinner('Compiling...');
  try {
    const result = await runCompile({ project, signal });
    if (result.success) {
      spinner.stop(`Compiled ${dim(`(${formatDuration(result.durationMs)})`)}`);
    } else {
      spinner.fail(`Compile failed ${dim(`(${formatDuration(result.durationMs)})`)}`);
      if (result.stderr.trim()) {
        process.stderr.write(dim('  ─ stderr ─') + '\n');
        process.stderr.write(yellow(indent(result.stderr.trim(), '  ')) + '\n');
      }
    }
    return result;
  } catch (err) {
    spinner.fail('Compile error');
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(red('  ' + message) + '\n');
    return {
      success: false,
      durationMs: 0,
      command: '',
      stdout: '',
      stderr: message,
      exitCode: -1,
    };
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function indent(text: string, prefix: string): string {
  return text.split('\n').map((line) => prefix + line).join('\n');
}
