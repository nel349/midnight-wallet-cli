// Interactive prompts for `mn test create`. Uses Node's native readline (per
// project constraint — no inquirer). Skipped when stdin is not a TTY so
// piped/JSON callers never hang waiting for input.

import { existsSync, statSync } from 'node:fs';
import * as readline from 'node:readline';
import { teal, dim, yellow } from '../../ui/colors.ts';
import type { CreateStrategy, BrowserOptions } from './create.ts';
import type { CircuitInfo } from '../contract/inspect.ts';
import type { BrowserMode } from './types.ts';
import { discoverScreens, discoverScreensInDir, type ScreenCandidate } from './discover-screens.ts';

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
 * Collect the five browser-specific fields. Each defaults visibly so the
 * user can hit enter through them all for a vanilla Vite-on-4173 setup
 * with dom mode.
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

  const browserMode = prefilled.browserMode ?? await promptBrowserMode();

  return { port, buildCmd, buildDir, url, browserMode };
}

/**
 * Pick how Claude perceives the page during the test. The right answer
 * depends entirely on what the dApp renders:
 *
 * - dom — accessibility tree (text). Fast (~3× speed of vision). Right
 *         for HTML/React/Vue UIs because Claude can target elements by
 *         their actual labels ("Save PIN", "Request loan →"). Requires
 *         chrome-devtools-mcp.
 *
 * - vision — screenshots. Slow. Right for canvas games (a Phaser/three.js
 *            app) or anything where the meaningful state is rendered as
 *            pixels with no DOM equivalent. Default for back-compat.
 *
 * - script — direct JS evaluation. Fastest. Right when you control the
 *            dApp enough to expose deterministic test hooks. Requires
 *            chrome-devtools-mcp + bridge code in the dApp.
 *
 * Default is dom because that's the right answer for the vast majority
 * of Midnight dApps shipping today.
 */
export async function promptBrowserMode(): Promise<BrowserMode> {
  process.stderr.write('\n  ' + teal('Browser mode — how should Claude perceive the page?') + '\n');
  process.stderr.write(`    ${dim('1.')} dom      ${dim('— accessibility tree (text). Fast. HTML / React / Vue UIs.')}\n`);
  process.stderr.write(`    ${dim('2.')} vision   ${dim('— screenshots. Slow. Canvas games (no DOM).')}\n`);
  process.stderr.write(`    ${dim('3.')} script   ${dim('— direct JS. Fastest. Needs dApp-side hooks (advanced).')}\n`);
  process.stderr.write(dim('    dom and script need chrome-devtools-mcp installed.\n'));

  for (;;) {
    const raw = (await ask('Mode', 'dom')).toLowerCase().trim();
    if (raw === '1' || raw === 'dom') return 'dom';
    if (raw === '2' || raw === 'vision') return 'vision';
    if (raw === '3' || raw === 'script') return 'script';
    process.stderr.write(yellow(`  Pick 1 (dom), 2 (vision), or 3 (script).\n`));
  }
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
 * numbered list. If empty, ask for a path — accepts either a single .tsx
 * file OR a directory (in which case we re-run discovery against that
 * directory and offer those candidates).
 *
 * Returns undefined when the user types "skip" — caller falls back to the
 * deterministic skeleton prompt.md.
 */
export async function promptScreen(candidates: ScreenCandidate[]): Promise<ScreenCandidate | undefined> {
  if (candidates.length === 0) {
    return promptScreenByPath();
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
 * Free-form path fallback when auto-discovery finds nothing. Accepts either
 * a single .tsx file (returned as a single candidate) or a directory (in
 * which case we re-discover inside it and re-prompt).
 */
async function promptScreenByPath(): Promise<ScreenCandidate | undefined> {
  process.stderr.write(
    dim('\n  Could not auto-discover screens (no src/components, src/pages, or src/screens under the build dir).\n'),
  );

  for (;;) {
    const path = (await ask('Path to a .tsx file or a UI directory (or "skip")')).trim();
    if (path.toLowerCase() === 'skip' || path === '') return undefined;

    if (!existsSync(path)) {
      process.stderr.write(dim(`  No such path: ${path}\n`));
      continue;
    }

    let stat;
    try {
      stat = statSync(path);
    } catch {
      process.stderr.write(dim(`  Cannot stat: ${path}\n`));
      continue;
    }

    if (stat.isDirectory()) {
      // Walk the dir directly for .tsx candidates — caller pointed us at
      // a UI directory (often `<workspace>/<name>-ui/src/components`), so
      // we don't need to assume a project-root shape above it.
      const found = discoverScreensInDir(path);
      if (found.length === 0) {
        process.stderr.write(dim(`  No PascalCase .tsx components in ${path}\n`));
        continue;
      }
      return promptScreen(found);
    }

    if (!path.endsWith('.tsx')) {
      process.stderr.write(dim(`  Not a .tsx file: ${path}\n`));
      continue;
    }

    return manualScreenFromPath(path);
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

/**
 * Prompt for the suite directory name. Auto-derived from the selected
 * circuit/screen by the caller; this prompt lets the user override before
 * anything is written. Re-prompts on invalid input rather than silently
 * sanitizing — a typo in the suite name should surface immediately so the
 * user catches it (e.g. spaces, slashes, capital letters).
 */
export async function promptSuiteName(defaultName: string): Promise<string> {
  for (;;) {
    const raw = (await ask('Suite name', defaultName)).trim();
    if (isValidSuiteName(raw)) return raw;
    process.stderr.write(yellow(`  Suite names must be kebab-case (a–z, 0–9, dashes, underscores). Try again.\n`));
  }
}

/** Kebab-case enforcement — same charset the test discovery uses for filesystem names. */
function isValidSuiteName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name);
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
