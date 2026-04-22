// `mn dev` — iteration loop for Compact contract development.
// M1 scope: detect project → ensure localnet → watch .compact → compile on save.

import { resolve, relative } from 'node:path';
import { type ParsedArgs } from '../lib/argv.ts';
import { detectProject, type ProjectInfo } from '../lib/dev/detect-project.ts';
import { runCompile, type CompileResult } from '../lib/dev/compile.ts';
import { startWatching, type WatchHandle } from '../lib/dev/watch.ts';
import { ensureLocalnetRunning } from '../lib/dev/localnet-ready.ts';
import { header, divider, keyValue } from '../ui/format.ts';
import { bold, dim, red, teal, yellow } from '../ui/colors.ts';
import { start as startSpinner } from '../ui/spinner.ts';

export default async function devCommand(args: ParsedArgs, signal?: AbortSignal): Promise<void> {
  const startDir = resolve(args.positionals[0] ?? process.cwd());

  process.stderr.write('\n' + header('mn dev') + '\n\n');

  // ── Phase 1: detect project ───────────────────────────────
  const project: ProjectInfo = detectProject(startDir);

  process.stderr.write(keyValue('Project', project.projectRoot) + '\n');
  process.stderr.write(keyValue('Sources', `${project.sourceFiles.length} .compact file(s)`) + '\n');
  process.stderr.write(keyValue('Compile', project.hasNpmCompileScript ? 'npm run compile' : 'compact compile') + '\n\n');

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

  // ── Phase 3: first compile pass ───────────────────────────
  const firstCompile = await compileAndReport(project, signal);
  if (!firstCompile.success) {
    process.stderr.write(dim('\n  Fix the errors above and save — mn dev will recompile automatically.\n'));
  }

  // ── Phase 4: start watcher ────────────────────────────────
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
  process.stderr.write(dim('  Watching ') + teal(watchedLabel) + dim(' — save to recompile. Ctrl+C to exit.') + '\n');
  process.stderr.write(dim('  For test wallets: ') + bold('mn wallet generate alice') + dim(' → ') + bold('mn airdrop 1000') + dim(' → ') + bold('mn dust register') + '\n\n');

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
