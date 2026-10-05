// The indexer's latest ledger event id, per stream. A cache whose last applied
// event id is beyond it was built on a chain that has since been reset: a
// local chain restarted with the same genesis hash keeps the chain-id check
// quiet, and resuming after the cached id then reads nothing, so the stale
// state would be served as current.

import { subscribeGraphqlWs } from './graphql-ws-subscription.ts';

export type LedgerEventStream = 'dust' | 'zswap';

const FIELD: Record<LedgerEventStream, string> = { dust: 'dustLedgerEvents', zswap: 'zswapLedgerEvents' };

/** The stream's latest event id (from the first event's maxId), or null when it has none or the indexer can't say. */
export async function fetchEventTip(indexerWS: string, stream: LedgerEventStream): Promise<number | null> {
  const field = FIELD[stream];
  let tip: number | null = null;
  try {
    return await subscribeGraphqlWs<number | null>(indexerWS, {
      query: `subscription { ${field}(id: 0) { id maxId } }`,
      variables: {},
      onNext: (data) => {
        const maxId = (data as Record<string, { maxId?: unknown } | undefined>)[field]?.maxId;
        if (typeof maxId === 'number') tip = maxId;
        return tip !== null;
      },
      buildResult: () => tip,
      timeoutMs: 10_000,
      idleMs: 3_000,
      idleBeforeFirstEvent: true,
    });
  } catch {
    return null;
  }
}

/** The cache's cursor is past the chain's latest event: the chain was reset under it. */
export function isCursorBeyondTip(lastAppliedEventId: number, tip: number | null): boolean {
  return tip !== null && lastAppliedEventId > tip;
}
