// Braille spinner for stderr — in-place updates via \r
// Supports interleaved log lines without breaking the animation

import { teal, isColorEnabled } from './colors.ts';

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_INTERVAL_MS = 80;

export interface Spinner {
  update(message: string): void;
  stop(finalMessage?: string): void;
  /** Stop the spinner with a failure mark (red ✗) instead of the default ✓. */
  fail(finalMessage?: string): void;
  /** Write a log line without breaking the spinner animation. */
  log(line: string): void;
}

let active: Spinner | null = null;

export function getActiveSpinner(): Spinner | null {
  return active;
}

/** Strip ANSI escape codes for accurate visible-length measurement. */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

export function start(message: string): Spinner {
  let stopped = false;

  if (!isColorEnabled()) {
    let currentMessage = message;
    process.stderr.write(`⠋ ${currentMessage}`);
    const spinner: Spinner = {
      update(msg: string) {
        currentMessage = msg;
        process.stderr.write(`\r⠋ ${currentMessage}\x1b[K`);
      },
      stop(finalMessage?: string) {
        if (stopped) return;
        stopped = true;
        active = null;
        process.stderr.write(`\r✓ ${finalMessage ?? currentMessage}\x1b[K\n`);
      },
      fail(finalMessage?: string) {
        if (stopped) return;
        stopped = true;
        active = null;
        process.stderr.write(`\r✗ ${finalMessage ?? currentMessage}\x1b[K\n`);
      },
      log(line: string) {
        process.stderr.write(`\r\x1b[K${line}\n`);
        process.stderr.write(`⠋ ${currentMessage}`);
      },
    };
    active = spinner;
    return spinner;
  }

  let frameIndex = 0;
  let currentMessage = message;

  const render = () => {
    const frame = teal(BRAILLE_FRAMES[frameIndex]!);
    // Truncate by visible length to prevent line wrapping (breaks \r)
    const cols = process.stderr.columns || 80;
    const maxVisible = cols - 4; // "⠋ " prefix + safety margin
    let text = currentMessage;
    if (stripAnsi(text).length > maxVisible) {
      // Truncate the raw message (before any ANSI), then let callers re-apply color
      const plain = stripAnsi(text);
      text = plain.slice(0, maxVisible);
    }
    process.stderr.write(`\r${frame} ${text}\x1b[K`);
    frameIndex = (frameIndex + 1) % BRAILLE_FRAMES.length;
  };

  render();
  const timer = setInterval(render, FRAME_INTERVAL_MS);

  const spinner: Spinner = {
    update(msg: string) {
      currentMessage = msg;
    },
    stop(finalMessage?: string) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      active = null;
      const final = finalMessage ?? currentMessage;
      process.stderr.write(`\r\x1b[32m✓\x1b[0m ${final}\x1b[K\n`);
    },
    fail(finalMessage?: string) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      active = null;
      const final = finalMessage ?? currentMessage;
      process.stderr.write(`\r\x1b[31m✗\x1b[0m ${final}\x1b[K\n`);
    },
    log(line: string) {
      process.stderr.write(`\r\x1b[K${line}\n`);
      render();
    },
  };

  active = spinner;
  return spinner;
}

/**
 * Update `spinner` once a second with `${baseMessage} MM:SS` while `promise`
 * is pending. Used for waits that can't report real progress (e.g. waiting
 * for chain finalization) so users see something is moving, not stuck.
 *
 * The interval clears in a finally block so timeouts and rejections are
 * also clean. Returns whatever `promise` resolves to.
 */
export async function trackElapsed<T>(
  spinner: Spinner,
  baseMessage: string,
  promise: Promise<T>,
): Promise<T> {
  const started = Date.now();
  const formatElapsed = (ms: number): string => {
    const s = Math.floor(ms / 1000);
    const mm = Math.floor(s / 60).toString().padStart(2, '0');
    const ss = (s % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
  };
  const tick = () => spinner.update(`${baseMessage} ${formatElapsed(Date.now() - started)}`);
  tick();
  const interval = setInterval(tick, 1000);
  try {
    return await promise;
  } finally {
    clearInterval(interval);
  }
}

export async function withSpinner<T>(message: string, fn: () => Promise<T>): Promise<T> {
  const spinner = start(message);
  try {
    const result = await fn();
    spinner.stop();
    return result;
  } catch (err) {
    spinner.fail(`Failed: ${message}`);
    throw err;
  }
}
