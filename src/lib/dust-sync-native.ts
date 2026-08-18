// Native dust-sync bridge: run the Rust `dust-sync` sidecar and adapt its output
// to a `DustDirectResult`, so it drops into the repository's `fetchDust` seam.
// ~5x faster cold dust sync (see tasks/dust-native-sidecar-plan.md). If the
// binary is missing or the run fails, callers fall back to the WASM path — the
// sidecar is an optional accelerator, never a hard dependency.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ledger from '@midnight-ntwrk/ledger-v8';

import { MIDNIGHT_DIR, CACHE_DIR_NAME, DIR_MODE, FILE_MODE } from './constants.ts';
import { deriveDustSeed } from './derivation.ts';
import type { NetworkConfig } from './network.ts';
import type { DustDirectResult, DustRetention } from './dust-direct.ts';
import { dustPublicKeyHexFromSeed } from './dust-direct-cache.ts';

/** Sidecar checkpoint JSON shape (snake_case — matches the Rust `Checkpoint`). */
export interface SidecarCheckpoint {
  dust_state: string;
  last_applied_event_id: number;
  owned_generation_indices: number[];
  generation_frontier: number;
  balance: string;
  available_coins: number;
  events_applied: number;
  partial: boolean;
}

interface NativeFetchOptions {
  startFromId: number;
  initialState?: ledger.DustLocalState;
  initialRetention?: DustRetention;
  signal?: AbortSignal;
  onProgress?: (applied: number, max: number) => void;
}

/**
 * Locate the sidecar binary. Order: explicit env override → the (Phase 3)
 * optional platform package → the dev build under sidecar/dust-sync. Returns
 * null when none resolve (→ WASM fallback).
 */
export function resolveSidecarBinary(): string | null {
  const fromEnv = process.env.MN_DUST_SYNC_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const exe = process.platform === 'win32' ? 'dust-sync.exe' : 'dust-sync';
  // Dev build (repo checkout): sidecar/dust-sync/target/release/dust-sync.
  // Try both nesting depths so it resolves from `src/lib` (tsx) AND the bundled
  // `dist/` — import.meta.url differs between them.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const up of [['..', '..'], ['..']]) {
    const devBuild = join(here, ...up, 'sidecar', 'dust-sync', 'target', 'release', exe);
    if (existsSync(devBuild)) return devBuild;
  }

  // Phase 3 platform package: @midnight-wallet-cli/dust-sync-<os>-<arch>.
  try {
    const pkg = `@midnight-wallet-cli/dust-sync-${process.platform}-${process.arch}`;
    const req = createRequire(import.meta.url);
    const binPath = join(dirname(req.resolve(`${pkg}/package.json`)), exe);
    if (existsSync(binPath)) return binPath;
  } catch { /* package not installed */ }

  return null;
}

// Lazy `require` for the optional-package lookup (ESM has no bare require).
function createRequire(url: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return (globalThis as any).require ?? (require('node:module') as typeof import('node:module')).createRequire(url);
}

/** True when the native sidecar should be used (binary resolves + not disabled). */
export function nativeDustSyncAvailable(): boolean {
  if (process.env.MN_DISABLE_NATIVE_DUST === '1') return false;
  return resolveSidecarBinary() !== null;
}

/**
 * Choose how to resume the sidecar, kill-safely:
 *  - `existing`: an on-disk checkpoint already reaches the requested cursor
 *    (e.g. a prior run was killed mid-sync) — resume from it, don't rewind.
 *  - `seed`: no usable checkpoint but the repo has cached state — seed from it.
 *  - `fresh`: nothing to resume from — sync from the start.
 * `existingCursor` is a last-applied-event-id (-2 if no checkpoint).
 */
export function resumeDecision(existingCursor: number, startFromId: number, hasInitialState: boolean): 'existing' | 'seed' | 'fresh' {
  if (existingCursor + 1 >= startFromId) return 'existing';
  if (hasInitialState) return 'seed';
  return 'fresh';
}

/** Last-applied event id in a sidecar checkpoint file, or -2 if absent/unreadable. */
function readCheckpointCursor(path: string): number {
  if (!existsSync(path)) return -2;
  try {
    const cp: SidecarCheckpoint = JSON.parse(readFileSync(path, 'utf-8'));
    return typeof cp.last_applied_event_id === 'number' ? cp.last_applied_event_id : -2;
  } catch { return -2; }
}

function nativeCheckpointPath(networkName: string, pubkeyHex: string): string {
  const dir = join(homedir(), MIDNIGHT_DIR, CACHE_DIR_NAME, networkName);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  return join(dir, `dust-native-${pubkeyHex.slice(0, 20)}.json`);
}

/**
 * Run the native sidecar for a dust sync and adapt to `DustDirectResult`.
 * Rejects (so the caller can fall back) if the binary is missing or the run
 * fails. Aborting via `signal` sends SIGINT — the sidecar checkpoints and exits,
 * yielding a `partial` result the repo persists and resumes from.
 */
export function runDustSyncNative(
  seed: Buffer,
  network: NetworkConfig,
  opts: NativeFetchOptions,
): Promise<DustDirectResult> {
  return new Promise((resolve, reject) => {
    const bin = resolveSidecarBinary();
    if (!bin) { reject(new Error('dust-sync sidecar not found')); return; }

    const networkName = network.networkId.toLowerCase();
    const pubkeyHex = dustPublicKeyHexFromSeed(seed);
    const out = nativeCheckpointPath(networkName, pubkeyHex);

    // Resume selection (out == resume file; the sidecar reads it once at start,
    // then overwrites it with its own checkpoints — kill-safe at this path):
    //  - if an existing sidecar checkpoint is already AT/PAST the repo's cursor
    //    (e.g. a prior run was killed mid-sync), keep it — don't rewind it.
    //  - else seed it from the repo's cached state so we resume from there.
    //  - else (no cache) let the sidecar start fresh.
    const args = ['--indexer-ws', network.indexerWS, '--out', out];
    const decision = resumeDecision(readCheckpointCursor(out), opts.startFromId, !!opts.initialState);
    if (decision === 'seed') {
      const seedCp: SidecarCheckpoint = {
        dust_state: Buffer.from(opts.initialState!.serialize()).toString('hex'),
        last_applied_event_id: opts.startFromId - 1,
        owned_generation_indices: opts.initialRetention?.ownedGenerationIndices ?? [],
        generation_frontier: opts.initialRetention?.generationFrontier ?? 0,
        balance: '0', available_coins: 0, events_applied: 0, partial: true,
      };
      writeFileSync(out, JSON.stringify(seedCp), { mode: FILE_MODE });
    }
    if (decision !== 'fresh') args.push('--resume', out);

    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    const onAbort = () => { try { child.kill('SIGINT'); } catch { /* already gone */ } };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    // Feed the derived dust seed on stdin (sidecar zeroizes it), then close.
    const dustSeedHex = Buffer.from(deriveDustSeed(seed)).toString('hex');
    child.stdin.write(dustSeedHex + '\n');
    child.stdin.end();

    let stdout = '';
    let stderrTail = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderrTail = (stderrTail + s).slice(-2000);
      // Parse "dust-sync: applied <n> / <max>" progress lines.
      for (const m of s.matchAll(/applied (\d+) \/ (\d+)/g)) {
        opts.onProgress?.(Number(m[1]), Number(m[2]));
      }
    });

    child.on('error', (err) => { opts.signal?.removeEventListener('abort', onAbort); reject(err); });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (code !== 0 && !existsSync(out)) {
        reject(new Error(`dust-sync exited ${code}: ${stderrTail.trim().slice(-300)}`));
        return;
      }
      try {
        // Prefer the final stdout line; fall back to the checkpoint file.
        const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
        const cp: SidecarCheckpoint = lastLine
          ? JSON.parse(lastLine)
          : JSON.parse(readFileSync(out, 'utf-8'));
        resolve(adaptResult(cp));
      } catch (err) {
        reject(new Error(`dust-sync output parse failed: ${(err as Error).message}`));
      }
    });
  });
}

/** Map the sidecar's checkpoint JSON to a `DustDirectResult`. Exported for tests. */
export function adaptResult(cp: SidecarCheckpoint): DustDirectResult {
  const now = new Date();
  // processTtls is immutable (returns a new state) — parity with the WASM reader,
  // which drops expired coins before reading the balance.
  const state = ledger.DustLocalState.deserialize(new Uint8Array(Buffer.from(cp.dust_state, 'hex'))).processTtls(now);
  const utxoCount = state.utxos.length;
  return {
    balance: state.walletBalance(now),
    availableCoins: utxoCount,
    eventCount: cp.events_applied,
    ownedUtxoCount: utxoCount,
    syncTime: state.syncTime instanceof Date ? state.syncTime : new Date(String(state.syncTime)),
    state,
    retention: {
      ownedGenerationIndices: cp.owned_generation_indices,
      generationFrontier: cp.generation_frontier,
    },
    lastAppliedEventId: cp.last_applied_event_id,
    partial: cp.partial,
  };
}
