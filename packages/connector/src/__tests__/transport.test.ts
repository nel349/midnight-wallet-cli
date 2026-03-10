import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import { createTransport } from '../transport.ts';

// ── Test helpers ──

function createTestServer(handler: (method: string, params: any, id: number) => any): {
  wss: WebSocketServer;
  port: number;
  url: string;
  close: () => Promise<void>;
} {
  const wss = new WebSocketServer({ port: 0 });
  const port = (wss.address() as any).port as number;

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      try {
        const result = handler(msg.method, msg.params, msg.id);
        if (result instanceof Promise) {
          result.then((r) => {
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: r }));
          }).catch((err) => {
            ws.send(JSON.stringify({
              jsonrpc: '2.0', id: msg.id,
              error: { code: err.code ?? -32603, message: err.message, data: err.data },
            }));
          });
        } else {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
        }
      } catch (err: any) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          error: { code: err.code ?? -32603, message: err.message, data: err.data },
        }));
      }
    });
  });

  return {
    wss,
    port,
    url: `ws://127.0.0.1:${port}`,
    close: () => {
      // Terminate all connected clients first — wss.close() only stops accepting
      for (const client of wss.clients) {
        client.terminate();
      }
      return new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

// ── Tests ──

let server: ReturnType<typeof createTestServer> | null = null;

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
});

describe('createTransport', () => {
  it('sends JSON-RPC request and receives response', async () => {
    server = createTestServer((method) => {
      if (method === 'ping') return 'pong';
      return null;
    });

    const transport = await createTransport({ url: server.url });
    const result = await transport.call('ping');
    expect(result).toBe('pong');
    transport.close();
  });

  it('passes params in the request', async () => {
    server = createTestServer((_method, params) => {
      return { echo: params };
    });

    const transport = await createTransport({ url: server.url });
    const result = await transport.call('test', { foo: 'bar', num: 42 }) as any;
    expect(result.echo.foo).toBe('bar');
    expect(result.echo.num).toBe(42);
    transport.close();
  });

  it('serializes bigint params as strings', async () => {
    server = createTestServer((_method, params) => {
      return { received: params.amount };
    });

    const transport = await createTransport({ url: server.url });
    const result = await transport.call('test', { amount: 5000000n } as any) as any;
    // Server receives the stringified bigint
    expect(result.received).toBe('5000000');
    transport.close();
  });

  it('reconstructs APIError from JSON-RPC error response', async () => {
    server = createTestServer(() => {
      const err = { code: -32000, message: 'User rejected', data: { type: 'DAppConnectorAPIError', code: 'Rejected' } };
      throw err;
    });

    const transport = await createTransport({ url: server.url });
    try {
      await transport.call('forbidden');
      expect.fail('Should have thrown');
    } catch (err: any) {
      expect(err.type).toBe('DAppConnectorAPIError');
      expect(err.code).toBe('Rejected');
      expect(err.message).toBe('User rejected');
    }
    transport.close();
  });

  it('times out after configured duration', async () => {
    server = createTestServer(() => {
      // Never respond
      return new Promise(() => {});
    });

    const transport = await createTransport({ url: server.url, timeout: 100 });
    try {
      await transport.call('slow');
      expect.fail('Should have thrown');
    } catch (err: any) {
      expect(err.message).toContain('timed out');
    }
    transport.close();
  });

  it('rejects calls after close', async () => {
    server = createTestServer(() => 'ok');

    const transport = await createTransport({ url: server.url });
    transport.close();

    try {
      await transport.call('test');
      expect.fail('Should have thrown');
    } catch (err: any) {
      expect(err.message).toContain('not connected');
    }
  });

  it('calls onDisconnect when server closes', async () => {
    server = createTestServer(() => 'ok');

    let disconnected = false;
    const transport = await createTransport({
      url: server.url,
      onDisconnect: () => { disconnected = true; },
    });

    // Close the server — should trigger onDisconnect
    await server.close();
    server = null;

    // Give the event loop a tick
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(disconnected).toBe(true);
    transport.close();
  });

  it('rejects with error when connection fails', async () => {
    try {
      await createTransport({ url: 'ws://127.0.0.1:1' });
      expect.fail('Should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('resolves concurrent calls independently by ID', async () => {
    server = createTestServer((method) => {
      // Respond with method name so we can verify correct matching
      if (method === 'slow') {
        return new Promise((resolve) => setTimeout(() => resolve('slow_result'), 50));
      }
      return `fast_${method}`;
    });

    const transport = await createTransport({ url: server.url });

    // Fire 3 calls concurrently
    const [r1, r2, r3] = await Promise.all([
      transport.call('alpha'),
      transport.call('slow'),
      transport.call('gamma'),
    ]);

    expect(r1).toBe('fast_alpha');
    expect(r2).toBe('slow_result');
    expect(r3).toBe('fast_gamma');
    transport.close();
  });

  it('rejects in-flight calls when close() is called', async () => {
    server = createTestServer(() => {
      // Never respond — call stays pending
      return new Promise(() => {});
    });

    const transport = await createTransport({ url: server.url, timeout: 10_000 });
    const pending = transport.call('hanging');

    // Close while call is in-flight
    transport.close();

    try {
      await pending;
      expect.fail('Should have thrown');
    } catch (err: any) {
      expect(err.message).toBe('Transport closed');
    }
  });

  it('rejects in-flight calls when server disconnects', async () => {
    server = createTestServer(() => {
      // Never respond
      return new Promise(() => {});
    });

    const transport = await createTransport({ url: server.url, timeout: 10_000 });
    const pending = transport.call('hanging');

    // Server terminates the connection
    await server.close();
    server = null;

    try {
      await pending;
      expect.fail('Should have thrown');
    } catch (err: any) {
      expect(err.message).toBe('WebSocket connection closed');
    }
    transport.close();
  });

  it('close() is idempotent — calling twice does not throw', async () => {
    server = createTestServer(() => 'ok');

    const transport = await createTransport({ url: server.url });
    transport.close();
    transport.close(); // Should not throw
  });

  it('calls onNotification when server sends a notification (no id)', async () => {
    server = createTestServer((method) => {
      if (method === 'trigger') return 'ok';
      return null;
    });

    const notifications: Array<{ method: string; params: any }> = [];

    const transport = await createTransport({
      url: server.url,
      onNotification: (method, params) => {
        notifications.push({ method, params });
      },
    });

    // Server sends a notification to all connected clients
    for (const client of server.wss.clients) {
      client.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'approval:pending',
        params: { method: 'submitTransaction' },
      }));
    }

    // Give the event loop a tick
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(notifications).toHaveLength(1);
    expect(notifications[0].method).toBe('approval:pending');
    expect(notifications[0].params.method).toBe('submitTransaction');
    transport.close();
  });

  it('ignores notifications when onNotification is not set', async () => {
    server = createTestServer((method) => {
      if (method === 'ping') return 'pong';
      return null;
    });

    const transport = await createTransport({ url: server.url });

    // Server sends a notification — should not crash
    for (const client of server.wss.clients) {
      client.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'approval:pending',
        params: { method: 'test' },
      }));
    }

    // Regular call still works
    const result = await transport.call('ping');
    expect(result).toBe('pong');
    transport.close();
  });

  it('uses auto-incrementing request IDs', async () => {
    const ids: number[] = [];
    server = createTestServer((_method, _params, id) => {
      ids.push(id);
      return 'ok';
    });

    const transport = await createTransport({ url: server.url });
    await transport.call('a');
    await transport.call('b');
    await transport.call('c');

    expect(ids[1]).toBe(ids[0] + 1);
    expect(ids[2]).toBe(ids[1] + 1);
    transport.close();
  });
});
