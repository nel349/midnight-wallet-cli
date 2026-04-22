// `mn dev` — iteration loop for Compact contract development.
// M1 scope: detect project → ensure localnet → watch .compact → compile on save.

import { resolve, relative } from 'node:path';
import { type ParsedArgs } from '../lib/argv.ts';
import { detectProject, type ProjectInfo } from '../lib/dev/detect-project.ts';
import { runCompile, type CompileResult } from '../lib/dev/compile.ts';
import { startWatching, type WatchHandle } from '../lib/dev/watch.ts';
import { ensureLocalnetRunning } from '../lib/dev/localnet-ready.ts';
import {
  provisionDevWallets,
  DEFAULT_DEV_WALLET_NAMES,
  DEFAULT_DEV_AIRDROP_AMOUNT,
} from '../lib/dev/provision-wallets.ts';
import { header, divider, keyValue } from '../ui/format.ts';
import { dim, red, teal, yellow } from '../ui/colors.ts';
import { start as startSpinner } from '../ui/spinner.ts';

export default async function devCommand(args: ParsedArgs, signal?: AbortSignal): Promise<void> {
  const startDir = resolve(args.positionals[0] ?? process.cwd());

  process.stderr.write('\n' + header('mn dev') + '\n\n');

  // ── Phase 1: detect project ───────────────────────────────
  const project: ProjectInfo = detectProject(startDir);

  if (!project.hasNpmCompileScript) {
    throw new Error(
      `No "compile" script found in ${project.projectRoot}/package.json.\n` +
      `Add one that invokes the Compact compiler — e.g.\n` +
      `  "scripts": { "compile": "compactc src/my.compact src/managed/my" }\n` +
      `Projects scaffolded with create-mn-app already include this.`,
    );
  }

  process.stderr.write(keyValue('Project', project.projectRoot) + '\n');
  process.stderr.write(keyValue('Sources', `${project.sourceFiles.length} .compact file(s)`) + '\n');
  process.stderr.write(keyValue('Compile', 'npm run compile') + '\n\n');

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

  // ── Phase 4: first compile pass ───────────────────────────
  const firstCompile = await compileAndReport(project, signal);
  if (!firstCompile.success) {
    process.stderr.write(dim('\n  Fix the errors above and save — mn dev will recompile automatically.\n'));
  }

  // ── Phase 5: start watcher ────────────────────────────────
  let compileInFlight = false;
  let compileQueued = false;

  const runPass = async () => {
    if (compileInFlight) {
      compileQueued = true;
      return;
    }
    compileInFlight = true;
    try {
      await compileAndReport(project, signal);
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
  process.stderr.write(dim('  Watching ') + teal(watchedLabel) + dim(' — save to recompile. Ctrl+C to exit.') + '\n\n');

  // ── Wait until aborted ────────────────────────────────────
  await new Promise<void>((resolvePromise) => {
    const onAbort = () => {
      watcher.stop();
      process.stderr.write('\n' + dim('  mn dev stopped.') + '\n');
      resolvePromise();
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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
    process.stderr.write(red('  ' + (err as Error).message) + '\n');
    return {
      success: false,
      durationMs: 0,
      command: '',
      stdout: '',
      stderr: (err as Error).message,
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
