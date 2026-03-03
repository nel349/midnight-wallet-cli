import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { createRpcServer, createApiError, type RpcServer } from '../lib/ws-rpc.ts';

// Test helpers
function sendRpc(ws: WebSocket, id: number, method: string, params?: Record<string, unknown>): void {
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
}

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once('message', (data: Buffer) => {
      resolve(JSON.parse(data.toString('utf-8')));
    });
  });
}

function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// Use unique ports to avoid conflicts
let testPort = 19921;
function nextPort(): number {
  return testPort++;
}

describe('ws-rpc', () => {
  let server: RpcServer | undefined;
  const clients: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of clients) {
      ws.close();
    }
    clients.length = 0;
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  describe('createRpcServer', () => {
    it('starts a WebSocket server on the given port', async () => {
      const port = nextPort();
      server = createRpcServer({
        port,
        handlers: {},
      });

      const ws = await connectClient(port);
      clients.push(ws);
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    it('dispatches method calls to handlers', async () => {
      const port = nextPort();
      server = createRpcServer({
        port,
        handlers: {
          echo: async (params) => params,
        },
      });

      const ws = await connectClient(port);
      clients.push(ws);

      const responsePromise = waitForMessage(ws);
      sendRpc(ws, 1, 'echo', { message: 'hello' });
      const response = await responsePromise;

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(1);
      expect(response.result).toEqual({ message: 'hello' });
    });

    it('returns method not found for unknown methods', async () => {
      const port = nextPort();
      server = createRpcServer({
        port,
        handlers: {},
      });

      const ws = await connectClient(port);
      clients.push(ws);

      const responsePromise = waitForMessage(ws);
      sendRpc(ws, 1, 'nonExistentMethod');
      const response = await responsePromise;

      expect(response.error.code).toBe(-32601);
      expect(response.error.message).toContain('nonExistentMethod');
    });

    it('returns parse error for invalid JSON', async () => {
      const port = nextPort();
      server = createRpcServer({
        port,
        handlers: {},
      });

      const ws = await connectClient(port);
      clients.push(ws);

      const responsePromise = waitForMessage(ws);
      ws.send('not json');
      const response = await responsePromise;

      expect(response.error.code).toBe(-32700);
    });

    it('returns invalid request for malformed JSON-RPC', async () => {
      const port = nextPort();
      server = createRpcServer({
        port,
        handlers: {},
      });

      const ws = await connectClient(port);
      clients.push(ws);

      const responsePromise = waitForMessage(ws);
      ws.send(JSON.stringify({ jsonrpc: '1.0', method: 'test' }));
      const response = await responsePromise;

      expect(response.error.code).toBe(-32600);
    });

    it('serializes bigint values as strings in responses', async () => {
      const port = nextPort();
      server = createRpcServer({
        port,
        handlers: {
          getBalance: async () => ({ balance: 5000000n }),
        },
      });

      const ws = await connectClient(port);
      clients.push(ws);

      const responsePromise = waitForMessage(ws);
      sendRpc(ws, 1, 'getBalance');
      const response = await responsePromise;

      expect(response.result.balance).toBe('5000000');
    });

    it('maps APIError to JSON-RPC error with data', async () => {
      const port = nextPort();
      server = createRpcServer({
        port,
        handlers: {
          reject: async () => {
            throw createApiError('Rejected', 'User rejected the request');
          },
        },
      });

      const ws = await connectClient(port);
      clients.push(ws);

      const responsePromise = waitForMessage(ws);
      sendRpc(ws, 1, 'reject');
      const response = await responsePromise;

      expect(response.error.code).toBe(-32000);
      expect(response.error.message).toBe('User rejected the request');
      expect(response.error.data).toEqual({
        type: 'DAppConnectorAPIError',
        code: 'Rejected',
      });
    });

    it('tracks connections', async () => {
      const port = nextPort();
      server = createRpcServer({
        port,
        handlers: {},
      });

      expect(server.connections.size).toBe(0);

      const ws = await connectClient(port);
      clients.push(ws);

      // Small delay for connection to be registered
      await new Promise((r) => setTimeout(r, 50));
      expect(server.connections.size).toBe(1);
    });

    it('calls onConnect and onDisconnect callbacks', async () => {
      const port = nextPort();
      const events: string[] = [];

      server = createRpcServer({
        port,
        handlers: {},
        onConnect: () => events.push('connect'),
        onDisconnect: () => events.push('disconnect'),
      });

      const ws = await connectClient(port);
      await new Promise((r) => setTimeout(r, 50));
      expect(events).toContain('connect');

      ws.close();
      await new Promise((r) => setTimeout(r, 50));
      expect(events).toContain('disconnect');
    });
  });

  describe('createApiError', () => {
    it('creates an APIError with correct properties', () => {
      const err = createApiError('Rejected', 'User said no');

      expect(err).toBeInstanceOf(Error);
      expect(err.type).toBe('DAppConnectorAPIError');
      expect(err.code).toBe('Rejected');
      expect(err.reason).toBe('User said no');
      expect(err.message).toBe('User said no');
    });

    it('creates errors for all error codes', () => {
      const codes = ['InternalError', 'Rejected', 'InvalidRequest', 'PermissionRejected', 'Disconnected'] as const;
      for (const code of codes) {
        const err = createApiError(code, `test ${code}`);
        expect(err.code).toBe(code);
      }
    });
  });

  describe('close', () => {
    it('closes all connections and the server', async () => {
      const port = nextPort();
      server = createRpcServer({
        port,
        handlers: {},
      });

      const ws = await connectClient(port);

      const closePromise = new Promise<void>((resolve) => {
        ws.on('close', () => resolve());
      });

      await server.close();
      await closePromise;
      server = undefined; // Already closed
    });
  });
});
