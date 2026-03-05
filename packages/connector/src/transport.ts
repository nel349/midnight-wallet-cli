// WebSocket JSON-RPC 2.0 transport
// Works in both browser (globalThis.WebSocket) and Node.js (dynamic import('ws'))

import { reconstructError, type JsonRpcError } from './errors.ts';

// ── Types ──

export interface TransportOptions {
  url: string;
  /** Per-call timeout in ms (default: 300_000 = 5 minutes, for proof-heavy ops) */
  timeout?: number;
  /** Called when the WebSocket connection closes */
  onDisconnect?: () => void;
}

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RpcTransport {
  /** Send a JSON-RPC call and await the response */
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Close the WebSocket connection */
  close(): void;
}

// ── Bigint-safe JSON serializer for outbound params ──

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

// ── Transport factory ──

const DEFAULT_TIMEOUT = 300_000; // 5 minutes

export async function createTransport(options: TransportOptions): Promise<RpcTransport> {
  const { url, timeout = DEFAULT_TIMEOUT, onDisconnect } = options;
  const pending = new Map<number, PendingCall>();
  let nextId = 1;
  let closed = false;

  // Import ws for Node.js (browser uses globalThis.WebSocket)
  const WS = typeof globalThis.WebSocket === 'function'
    ? globalThis.WebSocket
    : (await import('ws')).default;

  const ws = new WS(url) as any;

  // Wait for connection to open
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (ev: any) => {
      cleanup();
      const msg = ev?.message ?? ev?.error?.message ?? `Failed to connect to ${url}`;
      reject(new Error(msg));
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`Connection to ${url} was closed before opening`));
    };

    const cleanup = () => {
      ws.removeEventListener?.('open', onOpen);
      ws.removeEventListener?.('error', onError);
      ws.removeEventListener?.('close', onClose);
    };

    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onError);
    ws.addEventListener('close', onClose);
  });

  // Handle incoming messages
  ws.addEventListener('message', (ev: any) => {
    const data = typeof ev.data === 'string' ? ev.data : String(ev.data);
    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // Malformed response — ignore
    }

    const id = parsed.id;
    const call = pending.get(id);
    if (!call) return;

    pending.delete(id);
    clearTimeout(call.timer);

    if (parsed.error) {
      call.reject(reconstructError(parsed.error as JsonRpcError));
    } else {
      call.resolve(parsed.result);
    }
  });

  // Handle disconnection
  ws.addEventListener('close', () => {
    if (closed) return;
    closed = true;
    for (const [id, call] of pending) {
      clearTimeout(call.timer);
      call.reject(new Error('WebSocket connection closed'));
      pending.delete(id);
    }
    onDisconnect?.();
  });

  function call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (closed || ws.readyState !== 1 /* OPEN */) {
      return Promise.reject(new Error('WebSocket is not connected'));
    }

    const id = nextId++;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC call "${method}" timed out after ${timeout}ms`));
      }, timeout);

      pending.set(id, { resolve, reject, timer });

      const request = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params: params ?? {},
      }, jsonReplacer);

      ws.send(request);
    });
  }

  function close(): void {
    if (closed) return;
    closed = true;
    for (const [id, pendingCall] of pending) {
      clearTimeout(pendingCall.timer);
      pendingCall.reject(new Error('Transport closed'));
      pending.delete(id);
    }
    ws.close(1000, 'Client disconnect');
  }

  return { call, close };
}
