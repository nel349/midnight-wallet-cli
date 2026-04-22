// Debounced file watcher for `mn dev`.
// Watches one or more directories for .compact changes and collapses
// rapid save bursts (editor auto-saves, Vim swap files) into single events.

import { watch } from 'node:fs';
import { join } from 'node:path';
import type { FSWatcher } from 'node:fs';

export interface WatchOptions {
  /** Absolute directories to watch. */
  dirs: string[];
  /** Only fire on files matching this extension (e.g. ".compact"). */
  extension: string;
  /** Collapse bursts of events into one trigger. Default 300ms. */
  debounceMs?: number;
  /** Invoked after the debounce window closes. Receives the set of changed paths. */
  onChange: (changedPaths: string[]) => void | Promise<void>;
  /** Signals from native fs.watch that aren't worth surfacing. */
  onError?: (err: Error) => void;
}

export interface WatchHandle {
  /** Stop watching and release OS resources. */
  stop: () => void;
}

/**
 * Watch the given directories for files matching `extension`.
 * Uses native fs.watch — on macOS this relies on FSEvents via libuv, on Linux inotify.
 */
export function startWatching(opts: WatchOptions): WatchHandle {
  const debounceMs = opts.debounceMs ?? 300;
  const watchers: FSWatcher[] = [];
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;

  const flush = () => {
    timer = null;
    if (pending.size === 0) return;
    const changed = [...pending];
    pending.clear();
    // Wrap both sync throws and async rejections so a buggy onChange handler
    // never leaks as an uncaught exception from a setTimeout callback.
    try {
      Promise.resolve(opts.onChange(changed)).catch((err) => {
        opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      });
    } catch (err) {
      opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  };

  for (const dir of opts.dirs) {
    try {
      const watcher = watch(dir, { persistent: true }, (_event, filename) => {
        if (!filename) return;
        if (!filename.endsWith(opts.extension)) return;
        pending.add(join(dir, filename));
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, debounceMs);
      });
      watcher.on('error', (err) => {
        opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      });
      watchers.push(watcher);
    } catch (err) {
      opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  return {
    stop: () => {
      if (timer) { clearTimeout(timer); timer = null; }
      for (const w of watchers) {
        try { w.close(); } catch { /* best-effort */ }
      }
    },
  };
}
