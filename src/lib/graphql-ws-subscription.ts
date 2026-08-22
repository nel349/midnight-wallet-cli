// Shared graphql-transport-ws subscription driver for the direct-from-indexer
// readers (shielded-direct, dust-direct, dust-balance-direct). Each reader used
// to hand-maintain the same connection_init → connection_ack → subscribe →
// next/error/close handshake plus the settle-once / cleanup / idle-timer /
// timeout / abort scaffolding; the guards drifted between copies. This centralizes
// that machinery so it's defined once, and exposes the genuinely per-reader parts
// (what to do with each event, when we're caught up, how to build the result) as
// callbacks.
//
// Settle semantics (uniform across readers):
//   - onNext returns true (caught up to tip)         → resolve, partial=false
//   - idle window elapses                            → resolve, partial=false
//   - initial-silence elapses (resume only)          → resolve, partial=false
//   - the stream closes with no events               → resolve, partial=false
//   - the stream closes mid-stream (events seen)     → resolve, partial=true  (resume next call)
//   - the soft timeout ceiling elapses               → resolve, partial=true  (resume next call)
//   - subscription/GraphQL/socket error, or abort    → reject
// `partial=true` means "state is valid but not caught up — persist and resume".

import WebSocket from 'ws';

/** Why the subscription settled. `timeout`/`closed-early` are the partial cases. */
export type WsFinishReason =
  | 'caught-up'
  | 'idle'
  | 'initial-silence'
  | 'graceful-close'
  | 'closed-early'
  | 'timeout';

export interface GraphqlWsSubscription<TResult> {
  /** Subscription query text. */
  query: string;
  /** Subscription variables. */
  variables: Record<string, unknown>;
  /**
   * Handle one `next` payload's `data` object. Return true when caught up to the
   * tip (finish, non-partial). Throw to fail the whole subscription. Readers with
   * no tip concept (idle-terminated snapshot reads) always return false.
   */
  onNext: (data: unknown) => boolean;
  /**
   * Build the final result once the subscription settles. `partial` is true iff a
   * soft-timeout or a mid-stream close ended it — the accumulated state is still
   * valid and the caller should persist it and resume from the last cursor.
   */
  buildResult: (partial: boolean) => TResult;
  /** Soft ceiling for the whole subscription. On expiry → buildResult(true). */
  timeoutMs: number;
  /** Idle window: once armed, finish (partial=false) after this much silence. */
  idleMs: number;
  /**
   * Arm the idle timer as soon as we subscribe, so an empty/quiet stream finishes
   * without waiting for a first event (snapshot readers). When false (streaming
   * replays), idle only counts after the first event — a cold sync must not finish
   * before its first, possibly slow, event.
   */
  idleBeforeFirstEvent?: boolean;
  /**
   * When > 0 and no event arrives within this window, finish as caught-up
   * (partial=false). Use ONLY when resuming from cached state; a fresh cold sync
   * must keep waiting.
   */
  initialSilenceMs?: number;
  /** Abort the subscription mid-flight (rejects with "Operation cancelled"). */
  signal?: AbortSignal;
}

/**
 * Drive a graphql-transport-ws subscription to completion and return the reader's
 * built result. See the module header for settle semantics.
 */
export function subscribeGraphqlWs<TResult>(
  wsUrl: string,
  sub: GraphqlWsSubscription<TResult>,
): Promise<TResult> {
  const { query, variables, onNext, buildResult, timeoutMs, idleMs, idleBeforeFirstEvent, initialSilenceMs, signal } = sub;

  return new Promise<TResult>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, ['graphql-transport-ws']);
    let sawFirstEvent = false;
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout>;
    let idleTimerId: ReturnType<typeof setTimeout> | undefined;
    let initialSilenceTimerId: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      clearTimeout(timeoutId);
      if (idleTimerId) clearTimeout(idleTimerId);
      if (initialSilenceTimerId) clearTimeout(initialSilenceTimerId);
      try { ws.close(); } catch { /* best-effort */ }
      signal?.removeEventListener('abort', onAbort);
    };

    const finishOk = (_reason: WsFinishReason, partial: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        resolve(buildResult(partial));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    const finishErr = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onAbort = () => finishErr(new Error('Operation cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });

    const resetIdleTimer = () => {
      if (idleTimerId) clearTimeout(idleTimerId);
      idleTimerId = setTimeout(() => {
        if (!settled && (sawFirstEvent || idleBeforeFirstEvent)) finishOk('idle', false);
      }, idleMs);
    };

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'connection_init' }));
    });

    ws.on('message', (raw: WebSocket.Data) => {
      let msg: { type?: string; payload?: { data?: unknown; errors?: Array<{ message?: string }> } };
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'connection_ack') {
        ws.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query, variables } }));
        if (idleBeforeFirstEvent) resetIdleTimer();
        // Resume-from-cache fast path: if nothing arrives in the silence window,
        // we're already at the tip → finish (non-partial).
        if (initialSilenceMs && initialSilenceMs > 0) {
          initialSilenceTimerId = setTimeout(() => {
            if (!sawFirstEvent && !settled) finishOk('initial-silence', false);
          }, initialSilenceMs);
        }
        return;
      }

      if (msg.type === 'error') {
        finishErr(new Error(`GraphQL subscription error: ${JSON.stringify(msg.payload)?.slice(0, 300)}`));
        return;
      }

      if (msg.type !== 'next') return;

      if (msg.payload?.errors) {
        finishErr(new Error(`GraphQL error: ${msg.payload.errors[0]?.message || 'unknown'}`));
        return;
      }

      sawFirstEvent = true;
      if (initialSilenceTimerId) { clearTimeout(initialSilenceTimerId); initialSilenceTimerId = undefined; }

      let caughtUp: boolean;
      try {
        caughtUp = onNext(msg.payload?.data);
      } catch (err) {
        finishErr(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      resetIdleTimer();
      if (caughtUp) finishOk('caught-up', false);
    });

    ws.on('error', (err: Error) => finishErr(new Error(`WebSocket error: ${err.message}`)));

    ws.on('close', () => {
      if (settled) return;
      // No events → empty stream, caught up. Events then a drop → mid-stream close:
      // resolve partial so the caller persists progress and resumes (never silently
      // reports an incomplete sync as complete, and never throws away the work).
      finishOk(sawFirstEvent ? 'closed-early' : 'graceful-close', sawFirstEvent);
    });

    timeoutId = setTimeout(() => finishOk('timeout', true), timeoutMs);
  });
}
