// Braille spinner for stderr — in-place updates via \r
// Supports interleaved log lines without breaking the animation

import { teal, isColorEnabled } from './colors.ts';

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_INTERVAL_MS = 80;

export interface Spinner {
  update(message: string): void;
  stop(finalMessage?: string): void;
  /** Write a log line without breaking the spinner animation. */
  log(line: string): void;
}

// Global reference so external code can call activeSpinner.log() if needed
let active: Spinner | null = null;

/** Get the currently active spinner, if any. */
export function getActiveSpinner(): Spinner | null {
  return active;
}

export function start(message: string): Spinner {
  if (!isColorEnabled()) {
    process.stderr.write(`⠋ ${message}`);
    const spinner: Spinner = {
      update(msg: string) {
        process.stderr.write(`\r⠋ ${msg}\x1b[K`);
      },
      stop(finalMessage?: string) {
        active = null;
        process.stderr.write(`\r✓ ${finalMessage ?? message}\x1b[K\n`);
      },
      log(line: string) {
        process.stderr.write(`\r\x1b[K${line}\n`);
        process.stderr.write(`⠋ ${message}`);
      },
    };
    active = spinner;
    return spinner;
  }

  let frameIndex = 0;
  let currentMessage = message;

  const render = () => {
    const frame = teal(BRAILLE_FRAMES[frameIndex]!);
    // Truncate to terminal width to prevent line wrapping (breaks \r)
    const cols = process.stderr.columns || 80;
    const text = currentMessage.length > cols - 4
      ? currentMessage.slice(0, cols - 4)
      : currentMessage;
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
      clearInterval(timer);
      active = null;
      const final = finalMessage ?? currentMessage;
      process.stderr.write(`\r\x1b[32m✓\x1b[0m ${final}\x1b[K\n`);
    },
    log(line: string) {
      // Clear current spinner line, print the log line, re-render spinner
      process.stderr.write(`\r\x1b[K${line}\n`);
      render();
    },
  };

  active = spinner;
  return spinner;
}

// Convenience wrapper: run async fn with spinner, auto-cleanup on success or error
export async function withSpinner<T>(message: string, fn: () => Promise<T>): Promise<T> {
  const spinner = start(message);
  try {
    const result = await fn();
    spinner.stop();
    return result;
  } catch (err) {
    spinner.stop(`Failed: ${message}`);
    throw err;
  }
}
