// Minimal JSON-RPC client for the substrate node.
// Used for readiness checks (`chain_getHeader`) and chain fingerprinting
// (`chain_getBlockHash(0)`). Deliberately avoids pulling in polkadot-js —
// this is used at cold-start moments where heavyweight init would hurt.

import WebSocket from 'ws';

export interface RpcOptions {
  url: string;
  timeoutMs?: number;
}

/** Default per-call timeout — short; both readiness and fingerprint are cheap. */
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Make one JSON-RPC call over a WebSocket connection that we open and close
 * for this request. Returns the `result` field raw; throws on RPC error,
 * transport error, or timeout.
 */
export async function callNodeRpc<T = unknown>(
  opts: RpcOptions,
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const ws = new WebSocket(opts.url);
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    const timer = setTimeout(() => {
      settle(() => {
        try { ws.close(); } catch { /* ignore */ }
        rejectPromise(new Error(`RPC ${method} timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);

    ws.on('open', () => {
      try {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
      } catch (err) {
        clearTimeout(timer);
        settle(() => rejectPromise(err instanceof Error ? err : new Error(String(err))));
      }
    });

    ws.on('message', (data) => {
      clearTimeout(timer);
      settle(() => {
        try {
          const resp = JSON.parse(data.toString()) as { result?: T; error?: { message: string } };
          try { ws.close(); } catch { /* ignore */ }
          if (resp.error) rejectPromise(new Error(`RPC ${method}: ${resp.error.message}`));
          else resolvePromise(resp.result as T);
        } catch (err) {
          rejectPromise(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      settle(() => rejectPromise(err instanceof Error ? err : new Error(String(err))));
    });
  });
}
