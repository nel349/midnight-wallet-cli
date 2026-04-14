// UI-aware dust cache prime for write commands.
//
// Wraps the pure `primeDustCache` with a status callback + graceful error
// handling. Intended to be called once at the start of any write flow
// (transfer, airdrop, dust register, serve) before `buildFacade` — the
// populated dust-direct cache then gets bridged into the facade cache
// automatically.
//
// Does NOT own a spinner: the caller provides an `onStatus` callback (usually
// wired to their existing spinner's `update` method), so multiple commands
// can integrate without spinner lifecycle conflicts.

import { primeDustCache } from './dust-direct-cache.ts';
import { verbose } from './verbose.ts';

export interface PrimeWithFeedbackOptions {
  /**
   * Called with live status text as events arrive and on completion. Callers
   * typically wire this to an existing spinner's `update` method.
   */
  onStatus?: (status: string) => void;
  signal?: AbortSignal;
}

/**
 * Prime the dust-direct cache, reporting progress through `onStatus`.
 * Best-effort: on failure, logs a verbose message and returns without
 * throwing — the caller proceeds without a primed cache (and will hit the
 * slower facade-driven sync path, but the write won't fail outright).
 *
 * Safe to call on every write-command invocation. On a warm cache with no
 * new events, the underlying indexer subscription returns in ~3s via its
 * initial-silence timer — cost is bounded regardless of chain activity.
 */
export async function primeDustCacheWithFeedback(
  seedBuffer: Buffer,
  networkName: string,
  indexerWS: string,
  options: PrimeWithFeedbackOptions = {},
): Promise<void> {
  const { onStatus, signal } = options;
  onStatus?.(`Priming dust cache from ${networkName}...`);
  try {
    const result = await primeDustCache(seedBuffer, networkName, indexerWS, {
      onProgress: (applied, maxId) => {
        if (maxId > 0) onStatus?.(`Priming dust cache... ${applied}/${maxId + 1}`);
        else onStatus?.(`Priming dust cache... ${applied}`);
      },
      signal,
    });

    if (result.eventCount === 0 && result.fromCache) {
      onStatus?.('Dust cache up to date');
    } else if (result.fromCache) {
      onStatus?.(`Dust cache refreshed (${result.eventCount} new events)`);
    } else {
      onStatus?.(`Dust cache primed (${result.eventCount} events)`);
    }
  } catch (err) {
    // Non-fatal: the write path can still proceed via the facade's own sync,
    // it'll just be slower. Don't break the user's command.
    onStatus?.('Dust cache prime skipped');
    verbose('dust-prime', `Prime failed, continuing without primed cache: ${(err as Error).message}`);
  }
}
