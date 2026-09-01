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
import { spawn } from 'node:child_process';

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
 * re-exec happens this Promise never resolves — the parent's only remaining job
 * is to forward signals to the child and mirror its exit — so callers must
 * `await` it before dispatching a command.
 *
 * The child's lifetime is tied to the parent: catchable termination signals
 * (`SIGINT`/`SIGTERM`/`SIGHUP`) are forwarded to it, any parent exit kills it,
 * and — for the uncatchable `kill -9 <parent>` case — the child watches for
 * reparenting and terminates itself. Without this, killing the launcher left the
 * re-exec'd child orphaned and still holding e.g. the `mn serve` port.
 */
export async function ensureHeapForSync(): Promise<void> {
  if (process.env[BUMP_ENV]) {
    // We are the re-exec'd child. Guard against the launcher dying without
    // signalling us (SIGKILL): if we get reparented, the launcher is gone, so
    // terminate rather than orphan and keep holding a port.
    watchParentDeath();
    return;
  }

  const overrideRaw = process.env[OVERRIDE_ENV];
  const desiredMb = overrideRaw !== undefined ? Number(overrideRaw) : undefined;

  const target = computeHeapTargetMb({
    totalMb: Math.floor(os.totalmem() / MB),
    currentLimitMb: Math.floor(v8.getHeapStatistics().heap_size_limit / MB),
    desiredMb,
  });
  if (target === null) return;

  return new Promise<void>((resolve) => {
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${target}`,
        ...process.execArgv,
        process.argv[1],
        ...process.argv.slice(2),
      ],
      { stdio: 'inherit', env: { ...process.env, [BUMP_ENV]: '1' } },
    );

    // Tie the child's lifetime to the parent (forward signals + kill on exit).
    tieChildLifetime(child);

    child.on('error', () => {
      // Couldn't re-exec (rare). Continue in-process with the heap we have —
      // better to try and maybe OOM than to fail before doing any work. The
      // leftover kill handlers are harmless no-ops (the child never started).
      process.env[BUMP_ENV] = '1';
      resolve();
    });
    // Mirror the child's termination. On the normal re-exec path we exit here and
    // the Promise never resolves — the parent never returns to command dispatch.
    child.on('exit', (code, sig) => process.exit(sig ? 1 : (code ?? 0)));
  });
}

/** The subset of a child process we need to signal. */
interface Killable { kill(signal?: NodeJS.Signals): boolean; }

/**
 * Tie a re-exec'd child's lifetime to this (parent) process: forward catchable
 * termination signals (`SIGINT`/`SIGTERM`/`SIGHUP`) to it, and force-kill it on
 * any parent exit. This is what makes killing / Ctrl-C'ing the launcher always
 * take the child down instead of orphaning it (which would leave it holding e.g.
 * the `mn serve` port). `register` is injectable so the wiring is unit-testable.
 */
export function tieChildLifetime(
  child: Killable,
  register: (event: string, handler: () => void) => void = (event, handler) => { process.on(event as NodeJS.Signals, handler); },
): void {
  const forwarded: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const sig of forwarded) {
    register(sig, () => { try { child.kill(sig); } catch { /* already gone */ } });
  }
  register('exit', () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
}

/**
 * Child-side watchdog: if the launcher (our parent) dies without signalling us —
 * e.g. `kill -9 <parent>` — we get reparented (ppid changes). Detect that and
 * terminate gracefully so we don't linger holding a port. Unref'd so it never
 * keeps the process alive on its own.
 */
function watchParentDeath(): void {
  const initialPpid = process.ppid;
  if (!initialPpid || initialPpid <= 1) return; // already top-level; nothing to watch
  const timer = setInterval(() => {
    if (process.ppid !== initialPpid) {
      // Reparented → launcher gone. Prefer a graceful SIGTERM (lets `serve` save
      // its cache / release the port); fall back to a hard exit if unhandled.
      try { process.kill(process.pid, 'SIGTERM'); } catch { process.exit(0); }
    }
  }, 2_000);
  timer.unref();
}
