// Interactive prompts for `mn test create`. Uses Node's native readline (per
// project constraint — no inquirer). Skipped when stdin is not a TTY so
// piped/JSON callers never hang waiting for input.

import * as readline from 'node:readline';
import { teal, dim } from '../../ui/colors.ts';
import type { CreateStrategy, BrowserOptions } from './create.ts';
import type { CircuitInfo } from '../contract/inspect.ts';
import type { ScreenCandidate } from './discover-screens.ts';

export function isInteractive(): boolean {
  return process.stdin.isTTY === true;
}

/**
 * Prompt for a single value. Trimmed; empty input falls back to defaultValue.
 * Reads from stdin, writes to stderr (so any piped stdout consumer is unaffected).
 */
function ask(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const suffix = defaultValue !== undefined ? dim(` [${defaultValue}]`) : '';
  return new Promise<string>((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed === '' && defaultValue !== undefined ? defaultValue : trimmed);
    });
  });
}

/**
 * Ask the user to pick a strategy. Accepts the canonical names ('cli',
 * 'browser') plus the friendlier 'ui' alias. Empty input → 'cli' default.
 * Re-prompts on invalid input rather than silently defaulting, so the user
 * notices the typo.
 */
export async function promptStrategy(): Promise<CreateStrategy> {
  process.stderr.write('\n  ' + teal('Test scaffold setup') + '\n');
  for (;;) {
    const raw = (await ask('Strategy? cli or ui', 'cli')).toLowerCase();
    if (raw === 'cli') return 'cli';
    if (raw === 'ui' || raw === 'browser') return 'browser';
    process.stderr.write(dim(`  Unknown strategy "${raw}". Pick "cli" or "ui".\n`));
  }
}

/**
 * Collect the four browser-specific fields. Each defaults visibly so the
 * user can hit enter through them all for a vanilla Vite-on-4173 setup.
 */
export async function promptBrowserOptions(prefilled: Partial<BrowserOptions> = {}): Promise<BrowserOptions> {
  process.stderr.write('\n  ' + dim('Browser test scaffold needs your dApp UI details:') + '\n');

  const portStr = prefilled.port !== undefined
    ? String(prefilled.port)
    : await ask('Dev server port', '4173');
  const port = parseInt(portStr, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port "${portStr}" — must be a number between 1 and 65535.`);
  }

  const buildCmd = prefilled.buildCmd ?? await ask('Build command', 'npm run dev');
  if (!buildCmd) {
    throw new Error('Build command is required for browser strategy.');
  }

  const buildDirAnswer = prefilled.buildDir !== undefined
    ? prefilled.buildDir
    : await ask('Build dir (blank for project root)', '');
  const buildDir = buildDirAnswer === '' ? undefined : buildDirAnswer;

  const url = prefilled.url ?? await ask('URL', `http://localhost:${port}/`);

  return { port, buildCmd, buildDir, url };
}

// ── AI scaffolder prompts ──────────────────────────────────────────

/**
 * Pick a circuit from the contract's impure circuits to focus a CLI suite
 * on. Pure circuits are excluded — they don't mutate state, so a CLI test
 * with deploy → call(pure) → state can't show change.
 *
 * Returns undefined when the user declines (empty input + no candidates,
 * or types "skip"); caller treats that as "fall back to deterministic
 * scaffold of all circuits".
 */
export async function promptCircuit(circuits: CircuitInfo[]): Promise<CircuitInfo | undefined> {
  const writeable = circuits.filter((c) => !c.pure);
  if (writeable.length === 0) {
    process.stderr.write(dim('  No impure circuits in this contract — nothing to test as a write path.\n'));
    return undefined;
  }

  process.stderr.write('\n  ' + teal('Pick the circuit this suite will exercise:') + '\n');
  for (let i = 0; i < writeable.length; i++) {
    process.stderr.write(`    ${dim(`${i + 1}.`)} ${writeable[i].name}\n`);
  }
  process.stderr.write(dim(`    (or type "skip" to scaffold all circuits without AI)\n`));

  for (;;) {
    const raw = (await ask('Circuit', '1')).trim();
    if (raw.toLowerCase() === 'skip') return undefined;
    const idx = parseInt(raw, 10);
    if (Number.isFinite(idx) && idx >= 1 && idx <= writeable.length) {
      return writeable[idx - 1];
    }
    const byName = writeable.find((c) => c.name === raw);
    if (byName) return byName;
    process.stderr.write(dim(`  Pick a number 1–${writeable.length}, the circuit name, or "skip".\n`));
  }
}

/**
 * Pick a screen for a UI suite. If discovery found candidates, present a
 * numbered list; otherwise fall back to free-form path entry.
 *
 * Returns undefined when the user types "skip" — caller falls back to the
 * deterministic skeleton prompt.md.
 */
export async function promptScreen(candidates: ScreenCandidate[]): Promise<ScreenCandidate | undefined> {
  if (candidates.length === 0) {
    process.stderr.write(dim('\n  Could not auto-discover screens (no src/components, src/pages, or src/screens).\n'));
    const path = await ask('Path to a screen .tsx file (or "skip")');
    if (path.toLowerCase() === 'skip' || !path) return undefined;
    return manualScreenFromPath(path);
  }

  process.stderr.write('\n  ' + teal('Pick the screen this suite will test:') + '\n');
  for (let i = 0; i < candidates.length; i++) {
    process.stderr.write(`    ${dim(`${i + 1}.`)} ${candidates[i].name}  ${dim(`(${candidates[i].relativePath})`)}\n`);
  }
  process.stderr.write(dim(`    (or type "skip" to scaffold a generic prompt.md without AI)\n`));

  for (;;) {
    const raw = (await ask('Screen', '1')).trim();
    if (raw.toLowerCase() === 'skip') return undefined;
    const idx = parseInt(raw, 10);
    if (Number.isFinite(idx) && idx >= 1 && idx <= candidates.length) {
      return candidates[idx - 1];
    }
    const byName = candidates.find((s) => s.name === raw || s.component === raw);
    if (byName) return byName;
    process.stderr.write(dim(`  Pick a number 1–${candidates.length}, the screen name, or "skip".\n`));
  }
}

/**
 * Optional one-line success criterion. Pressing enter skips — the AI
 * infers a reasonable default from the screen/circuit context.
 */
export async function promptGoal(): Promise<string | undefined> {
  const raw = (await ask('What does success look like? (one line, optional)')).trim();
  return raw === '' ? undefined : raw;
}

function manualScreenFromPath(path: string): ScreenCandidate {
  const fileName = path.split('/').pop() ?? path;
  const component = fileName.replace(/\.tsx$/, '');
  const name = component
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
  return { name, component, path, relativePath: path };
}
