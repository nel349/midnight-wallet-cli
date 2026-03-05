// JSON-RPC 2.0 over WebSocket server
// Transport layer for the DApp Connector — dispatches RPC calls to handler functions

import { WebSocketServer, WebSocket } from 'ws';
import type { ErrorCode, APIError } from '@midnight-ntwrk/dapp-connector-api';

// ── JSON-RPC 2.0 types ──

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: number | string;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

// ── JSON-RPC 2.0 notification (server → client, no id) ──

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

// ── Handler context & type ──

/** Per-invocation context passed to each handler (scoped to the calling connection) */
export interface RpcHandlerContext {
  /** Send a JSON-RPC notification to the calling client */
  notify: (method: string, params?: Record<string, unknown>) => void;
}

export type RpcHandler = (params: Record<string, unknown>, context: RpcHandlerContext) => Promise<unknown>;

// ── DApp Connector error code → JSON-RPC error code mapping ──

const API_ERROR_TO_RPC_CODE: Record<string, number> = {
  Rejected: -32000,
  PermissionRejected: -32001,
  Disconnected: -32002,
  InvalidRequest: -32602,
  InternalError: -32603,
};

function mapErrorToRpcCode(err: unknown): number {
  if (isApiError(err)) {
    return API_ERROR_TO_RPC_CODE[err.code] ?? -32603;
  }
  return -32603; // Internal error
}

function isApiError(err: unknown): err is APIError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    (err as any).type === 'DAppConnectorAPIError'
  );
}

// ── BigInt-aware JSON serialization ──

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

function jsonReviver(_key: string, value: unknown): unknown {
  // We don't auto-convert strings to bigint on parse —
  // the handler layer is responsible for that conversion
  return value;
}

// ── Connection tracking ──

export interface RpcConnection {
  ws: WebSocket;
  id: string;
  connectedAt: Date;
  /** Whether this connection has completed the 'connect' handshake */
  authenticated: boolean;
  /** Network ID after connect */
  networkId?: string;
  /** Send a JSON-RPC notification to this client (no-op if socket is closed) */
  notify(method: string, params?: Record<string, unknown>): void;
}

// ── Server options ──

export interface RpcServerOptions {
  port: number;
  handlers: Record<string, RpcHandler>;
  /** Called when a new WebSocket connection is established */
  onConnect?: (connection: RpcConnection) => void;
  /** Called when a connection is closed */
  onDisconnect?: (connection: RpcConnection) => void;
  /** Called on every incoming request for logging */
  onRequest?: (connection: RpcConnection, request: JsonRpcRequest) => void;
}

export interface RpcServer {
  /** The underlying WebSocketServer */
  wss: WebSocketServer;
  /** Active connections */
  connections: Map<string, RpcConnection>;
  /** Gracefully close the server and all connections */
  close(): Promise<void>;
}

// ── Parse incoming message ──

function parseRequest(data: string): JsonRpcRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data, jsonReviver);
  } catch {
    throw Object.assign(new Error('Parse error'), { rpcCode: -32700 });
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as any).jsonrpc !== '2.0' ||
    typeof (parsed as any).method !== 'string'
  ) {
    throw Object.assign(new Error('Invalid Request'), { rpcCode: -32600 });
  }

  const req = parsed as JsonRpcRequest;
  if (req.id === undefined || req.id === null) {
    throw Object.assign(new Error('Missing request id'), { rpcCode: -32600 });
  }

  return req;
}

// ── Create server ──

let connectionCounter = 0;

export function createRpcServer(options: RpcServerOptions): RpcServer {
  const { port, handlers, onConnect, onDisconnect, onRequest } = options;
  const connections = new Map<string, RpcConnection>();

  const wss = new WebSocketServer({ port });

  // Prevent unhandled server-level errors (e.g. port conflict) from crashing
  wss.on('error', (err: Error) => {
    // Callers handle this via the close() method or process-level error handling
    // We just need to prevent the uncaught exception
    process.stderr.write(`WebSocket server error: ${err.message}\n`);
  });

  wss.on('connection', (ws: WebSocket) => {
    const id = `conn_${++connectionCounter}`;
    const connection: RpcConnection = {
      ws,
      id,
      connectedAt: new Date(),
      authenticated: false,
      notify(method: string, params?: Record<string, unknown>): void {
        if (ws.readyState !== ws.OPEN) return;
        const notification: JsonRpcNotification = { jsonrpc: '2.0', method, ...(params && { params }) };
        ws.send(JSON.stringify(notification, jsonReplacer));
      },
    };
    connections.set(id, connection);
    onConnect?.(connection);

    // Guard against double-disconnect (error fires before close)
    let disconnected = false;
    const handleDisconnect = () => {
      if (disconnected) return;
      disconnected = true;
      connections.delete(id);
      onDisconnect?.(connection);
    };

    ws.on('message', async (raw: Buffer) => {
      let requestId: number | string | null = null;

      try {
        const request = parseRequest(raw.toString('utf-8'));
        requestId = request.id;
        onRequest?.(connection, request);

        const handler = handlers[request.method];
        if (!handler) {
          const response: JsonRpcErrorResponse = {
            jsonrpc: '2.0',
            id: request.id,
            error: {
              code: -32601,
              message: `Method not found: ${request.method}`,
            },
          };
          ws.send(JSON.stringify(response, jsonReplacer));
          return;
        }

        const context: RpcHandlerContext = { notify: connection.notify.bind(connection) };
        const result = await handler(request.params ?? {}, context);

        // Mark as authenticated after successful connect
        if (request.method === 'connect' && result && typeof result === 'object') {
          connection.authenticated = true;
          connection.networkId = (result as any).networkId;
        }

        const response: JsonRpcSuccessResponse = {
          jsonrpc: '2.0',
          id: request.id,
          result,
        };
        ws.send(JSON.stringify(response, jsonReplacer));
      } catch (err: unknown) {
        const rpcCode = (err as any)?.rpcCode ?? mapErrorToRpcCode(err);
        const message = err instanceof Error ? err.message : 'Internal error';
        const data = isApiError(err)
          ? { type: err.type, code: err.code }
          : undefined;

        const response: JsonRpcErrorResponse = {
          jsonrpc: '2.0',
          id: requestId,
          error: { code: rpcCode, message, data },
        };
        ws.send(JSON.stringify(response, jsonReplacer));
      }
    });

    ws.on('close', handleDisconnect);

    ws.on('error', () => {
      handleDisconnect();
      try { ws.close(); } catch { /* already closing */ }
    });
  });

  async function close(): Promise<void> {
    // Close all active connections
    for (const conn of connections.values()) {
      conn.ws.close(1001, 'Server shutting down');
    }
    connections.clear();

    return new Promise<void>((resolve, reject) => {
      wss.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  return { wss, connections, close };
}

// ── APIError factory ──

export function createApiError(code: ErrorCode, reason: string): APIError {
  const error = new Error(reason) as APIError;
  error.type = 'DAppConnectorAPIError';
  error.code = code;
  error.reason = reason;
  return error;
}
