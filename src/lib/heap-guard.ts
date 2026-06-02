// Cold-sync heap headroom guard.
//
// The first shielded/dust sync against a hosted network (preprod/preview) streams
// the whole chain history through the wallet SDK. The live working set is small
// (~300 MB), but the scan churns through a firehose of short-lived JS objects;
// under Node's default old-space cap (~4 GB) GC can't keep pace with the
// allocation rate and the process dies with "JavaScript heap out of memory"
// before it can finish — and write the cache that makes every later run cheap.
//
// Fix: before any SDK/WASM module loads, re-exec the process with a larger
// `--max-old-space-size`. Because the CLI dispatches command handlers via dynamic
// import, calling this from the entry point ahead of dispatch means the parent
// re-execs before the SDK is ever loaded — no double load. It is a no-op when the
// heap is already large enough (e.g. the user set NODE_OPTIONS) or when we're
// already running as the re-exec'd child.

import v8 from 'node:v8';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  SYNC_HEAP_TARGET_MB,
  SYNC_HEAP_RAM_FRACTION,
  SYNC_HEAP_MIN_GAIN_MB,
} from './constants.ts';

/** Set on the re-exec'd child so it doesn't recurse. */
const BUMP_ENV = 'MN_HEAP_BUMPED';
/** Power-user override for the target cap, in MB (e.g. on a small machine). */
const OVERRIDE_ENV = 'MN_MAX_OLD_SPACE_MB';
const MB = 1024 * 1024;

/**
 * Decide the old-space cap (in MB) to re-exec with, or `null` when a bump isn't
 * worthwhile. Pure — every input is passed in, so it's unit-testable without a
 * real process.
 *
 *  - never exceed `ramFraction` of physical RAM (avoid thrashing small machines)
 *  - never downgrade below, or only trivially above, the current limit
 */
export function computeHeapTargetMb(opts: {
  totalMb: number;
  currentLimitMb: number;
  desiredMb?: number;
  ramFraction?: number;
  minGainMb?: number;
}): number | null {
  const desired = opts.desiredMb ?? SYNC_HEAP_TARGET_MB;
  const ramFraction = opts.ramFraction ?? SYNC_HEAP_RAM_FRACTION;
  const minGain = opts.minGainMb ?? SYNC_HEAP_MIN_GAIN_MB;

  if (!Number.isFinite(desired) || desired <= 0) return null;
  if (!Number.isFinite(opts.totalMb) || opts.totalMb <= 0) return null;

  const ramCap = Math.floor(opts.totalMb * ramFraction);
  const target = Math.min(Math.floor(desired), ramCap);
  if (target <= opts.currentLimitMb + minGain) return null;
  return target;
}

/**
 * Re-exec the current process with more old-space headroom when a cold sync
 * would otherwise overflow Node's default heap. No-op when not needed. When a
 * re-exec happens this function does not return — it exits with the child's
 * status.
 */
export function ensureHeapForSync(): void {
  if (process.env[BUMP_ENV]) return;

  const overrideRaw = process.env[OVERRIDE_ENV];
  const desiredMb = overrideRaw !== undefined ? Number(overrideRaw) : undefined;

  const target = computeHeapTargetMb({
    totalMb: Math.floor(os.totalmem() / MB),
    currentLimitMb: Math.floor(v8.getHeapStatistics().heap_size_limit / MB),
    desiredMb,
  });
  if (target === null) return;

  // The parent must not steal SIGINT/SIGTERM from the child — the child owns
  // graceful shutdown. Ignore them here so spawnSync keeps waiting until the
  // child exits on its own.
  const ignore = (): void => {};
  process.on('SIGINT', ignore);
  process.on('SIGTERM', ignore);

  const child = spawnSync(
    process.execPath,
    [
      `--max-old-space-size=${target}`,
      ...process.execArgv,
      process.argv[1],
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit', env: { ...process.env, [BUMP_ENV]: '1' } },
  );

  if (child.error) {
    // Couldn't re-exec (rare). Continue in-process with the heap we have — better
    // to try and maybe OOM than to fail outright before doing any work.
    process.env[BUMP_ENV] = '1';
    process.removeListener('SIGINT', ignore);
    process.removeListener('SIGTERM', ignore);
    return;
  }

  // Mirror the child's termination.
  process.exit(child.signal ? 1 : (child.status ?? 0));
}
