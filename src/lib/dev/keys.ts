// Raw-mode single-keystroke dispatcher for `mn dev`.
// Registers {key → handler} pairs; reads one char at a time from stdin.
// Always restores the terminal's cooked mode on stop() so a crash or Ctrl+C
// doesn't leave the shell in a broken state.

export type KeyHandler = () => void | Promise<void>;

export interface KeyDispatcherOptions {
  /** Map of printable key → action. Lower-case only; we lowercase input. */
  actions: Record<string, KeyHandler>;
  /** Called on Ctrl+C (SIGINT via raw stdin). */
  onInterrupt: () => void;
  /** Called on an unbound key. Defaults to a silent no-op. */
  onUnknown?: (key: string) => void;
  /** Called when any action handler throws. Defaults to printing to stderr. */
  onError?: (key: string, err: Error) => void;
}

export interface KeyDispatcher {
  /** Stop listening and restore cooked mode. Safe to call multiple times. */
  stop(): void;
}

const CTRL_C = '\u0003';
const RAW_MODE_SUPPORTED = typeof process.stdin.isTTY === 'boolean' && process.stdin.isTTY === true;

/**
 * Attach to process.stdin in raw mode and route keystrokes to actions.
 * No-op on non-TTY stdin (e.g. when piped) — returns a stub that does nothing.
 */
export function startKeyDispatcher(opts: KeyDispatcherOptions): KeyDispatcher {
  if (!RAW_MODE_SUPPORTED) {
    return { stop() { /* nothing to restore */ } };
  }

  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  let stopped = false;

  const onData = (chunk: string) => {
    if (stopped) return;
    if (chunk === CTRL_C) {
      opts.onInterrupt();
      return;
    }
    const key = chunk.toLowerCase();
    const action = opts.actions[key];
    if (!action) {
      opts.onUnknown?.(chunk);
      return;
    }
    Promise.resolve()
      .then(action)
      .catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (opts.onError) opts.onError(key, error);
        else process.stderr.write(`key handler error (${key}): ${error.message}\n`);
      });
  };

  stdin.on('data', onData);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      stdin.off('data', onData);
      try {
        stdin.setRawMode(wasRaw);
      } catch { /* stdin already closed */ }
      // Don't call stdin.pause() — other parts of the process may want to read.
    },
  };
}
