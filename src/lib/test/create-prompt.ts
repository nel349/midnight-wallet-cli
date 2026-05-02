// Interactive prompts for `mn test create`. Uses Node's native readline (per
// project constraint — no inquirer). Skipped when stdin is not a TTY so
// piped/JSON callers never hang waiting for input.

import * as readline from 'node:readline';
import { teal, dim } from '../../ui/colors.ts';
import type { CreateStrategy, BrowserOptions } from './create.ts';

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
