// Braille spinner for stderr — in-place updates via \r
// Degrades to static text when NO_COLOR is set

import { teal, isColorEnabled } from './colors.ts';

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_INTERVAL_MS = 80;

export interface Spinner {
  update(message: string): void;
  stop(finalMessage?: string): void;
}

export function start(message: string): Spinner {
  if (!isColorEnabled()) {
    // Static fallback — print once
    process.stderr.write(`⠋ ${message}`);
    return {
      update(msg: string) {
        process.stderr.write(`\r⠋ ${msg}`);
      },
      stop(finalMessage?: string) {
        const final = finalMessage ?? message;
        process.stderr.write(`\r✓ ${final}\n`);
      },
    };
  }

  let frameIndex = 0;
  let currentMessage = message;

  const render = () => {
    const frame = teal(BRAILLE_FRAMES[frameIndex]!);
    process.stderr.write(`\r${frame} ${currentMessage}\x1b[K`);
    frameIndex = (frameIndex + 1) % BRAILLE_FRAMES.length;
  };

  render();
  const timer = setInterval(render, FRAME_INTERVAL_MS);

  return {
    update(msg: string) {
      currentMessage = msg;
    },
    stop(finalMessage?: string) {
      clearInterval(timer);
      const final = finalMessage ?? currentMessage;
      process.stderr.write(`\r\x1b[32m✓\x1b[0m ${final}\x1b[K\n`);
    },
  };
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
