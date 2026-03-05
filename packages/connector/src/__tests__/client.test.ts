import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import { createWalletClient } from '../client.ts';

// ── Mock server that mimics `midnight serve` protocol ──

const NATIVE_TOKEN = '0000000000000000000000000000000000000000000000000000000000000000';

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

interface MockServerOptions {
  networkId?: string;
  handlers?: Record<string, (params: any) => any>;
}

function createMockServer(options: MockServerOptions = {}): {
  wss: WebSocketServer;
  port: number;
  url: string;
  close: () => Promise<void>;
} {
  const networkId = options.networkId ?? 'Undeployed';

  const defaultHandlers: Record<string, (params: any) => any> = {
    connect: (params: any) => {
      if (params.networkId?.toLowerCase() !== networkId.toLowerCase()) {
        const err = {
          code: -32602,
          message: `Network mismatch: wallet is on ${networkId}, requested ${params.networkId}`,
          data: { type: 'DAppConnectorAPIError', code: 'InvalidRequest' },
        };
        throw err;
      }
      return { networkId };
    },

    getUnshieldedBalances: () => ({ [NATIVE_TOKEN]: 5000000n }),
    getShieldedBalances: () => ({}),
    getDustBalance: () => ({ cap: 300000000000000n, balance: 150000000000000n }),

    getUnshieldedAddress: () => ({ unshieldedAddress: 'midnight1qtest_unshielded_addr' }),
    getShieldedAddresses: () => ({
      shieldedAddress: 'midnight1qtest_shielded_addr',
      shieldedCoinPublicKey: 'ab01',
      shieldedEncryptionPublicKey: 'cd02',
    }),
    getDustAddress: () => ({ dustAddress: 'midnight1qtest_dust_addr' }),

    getTxHistory: () => [
      { txHash: 'aabb', txStatus: { status: 'finalized' } },
      { txHash: 'ccdd', txStatus: { status: 'pending' } },
    ],

    getConfiguration: () => ({
      indexerUri: 'http://localhost:8088/api/v1/graphql',
      indexerWsUri: 'ws://localhost:8088/api/v1/graphql/ws',
      proverServerUri: 'http://localhost:6300',
      substrateNodeUri: 'ws://localhost:9944',
      networkId,
    }),

    getConnectionStatus: () => ({ status: 'connected', networkId }),

    makeTransfer: () => ({ tx: 'deadbeef' }),
    submitTransaction: () => undefined,
    balanceUnsealedTransaction: () => ({ tx: 'balanced_unsealed' }),
    balanceSealedTransaction: () => ({ tx: 'balanced_sealed' }),
    makeIntent: () => ({ tx: 'intent_tx' }),
    signData: () => ({ data: 'hello', signature: 'sig123', verifyingKey: 'vk456' }),
    getProvingProvider: () => ({ provingProvider: 'ready', proverServerUri: 'http://localhost:6300' }),
    hintUsage: () => undefined,
  };

  const handlers = { ...defaultHandlers, ...options.handlers };

  const wss = new WebSocketServer({ port: 0 });
  const port = (wss.address() as any).port as number;

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const handler = handlers[msg.method];

      if (!handler) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        }));
        return;
      }

      try {
        const result = handler(msg.params ?? {});
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }, jsonReplacer));
      } catch (err: any) {
        // If error has code/message, it's a structured RPC error
        if (typeof err.code === 'number') {
          ws.send(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            error: { code: err.code, message: err.message, data: err.data },
          }));
        } else {
          ws.send(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            error: { code: -32603, message: err.message },
          }));
        }
      }
    });
  });

  return {
    wss,
    port,
    url: `ws://127.0.0.1:${port}`,
    close: () => {
      for (const client of wss.clients) {
        client.terminate();
      }
      return new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

// ── Tests ──

let server: ReturnType<typeof createMockServer> | null = null;

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
});

describe('createWalletClient', () => {
  it('connects and returns a client', async () => {
    server = createMockServer();
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });
    expect(client).toBeDefined();
    client.disconnect();
  });

  it('throws on network mismatch during connect', async () => {
    server = createMockServer({ networkId: 'Undeployed' });
    try {
      await createWalletClient({ url: server.url, networkId: 'PreProd' });
      expect.fail('Should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('InvalidRequest');
      expect(err.message).toContain('Network mismatch');
    }
  });

  // ── Balance methods — bigint round-trip ──

  it('getUnshieldedBalances returns native bigint values', async () => {
    server = createMockServer();
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    const balances = await client.getUnshieldedBalances();
    expect(balances[NATIVE_TOKEN]).toBe(5000000n);
    expect(typeof balances[NATIVE_TOKEN]).toBe('bigint');
    client.disconnect();
  });

  it('getShieldedBalances returns empty record', async () => {
    server = createMockServer();
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    const balances = await client.getShieldedBalances();
    expect(balances).toEqual({});
    client.disconnect();
  });

  it('getDustBalance returns bigint cap and balance', async () => {
    server = createMockServer();
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    const dust = await client.getDustBalance();
    expect(dust.cap).toBe(300000000000000n);
    expect(dust.balance).toBe(150000000000000n);
    expect(typeof dust.cap).toBe('bigint');
    client.disconnect();
  });

  // ── Address methods ──

  it('getUnshieldedAddress returns address string', async () => {
    server = createMockServer();
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    const { unshieldedAddress } = await client.getUnshieldedAddress();
    expect(unshieldedAddress).toBe('midnight1qtest_unshielded_addr');
    client.disconnect();
  });

  it('getShieldedAddresses returns all three fields', async () => {
    server = createMockServer();
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    const result = await client.getShieldedAddresses();
    expect(result.shieldedAddress).toBe('midnight1qtest_shielded_addr');
    expect(result.shieldedCoinPublicKey).toBe('ab01');
    expect(result.shieldedEncryptionPublicKey).toBe('cd02');
    client.disconnect();
  });

  it('getDustAddress returns dust address', async () => {
    server = createMockServer();
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    const { dustAddress } = await client.getDustAddress();
    expect(dustAddress).toBe('midnight1qtest_dust_addr');
    client.disconnect();
  });

  // ── History ──

  it('getTxHistory returns history entries', async () => {
    server = createMockServer();
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    const history = await client.getTxHistory(0, 20);
    expect(history).toHaveLength(2);
    expect(history[0].txHash).toBe('aabb');
    expect(history[0].txStatus.status).toBe('finalized');
    expect(history[1].txStatus.status).toBe('pending');
    client.disconnect();
  });

  // ── Configuration ──

  it('getConfiguration returns full config', async () => {
    server = createMockServer();
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    const config = await client.getConfiguration();
    expect(config.networkId).toBe('Undeployed');
    expect(config.indexerUri).toContain('localhost');
    expect(config.substrateNodeUri).toContain('9944');
    client.disconnect();
  });

  it('getConnectionStatus returns connected', async () => {
    server = createMockServer();
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    const status = await client.getConnectionStatus();
    expect(status).toEqual({ status: 'connected', networkId: 'Undeployed' });
    client.disconnect();
  });

  // ── Write methods ──

  it('makeTransfer dispatches RPC and returns tx hex', async () => {
    server = createMockServer();
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    const result = await client.makeTransfer([
      { kind: 'unshielded', type: NATIVE_TOKEN, value: 100_000_000n, recipient: 'midnight1qrecipient' },
    ]);
    expect(result.tx).toBe('deadbeef');
    client.disconnect();
  });

  it('submitTransaction dispatches and returns void', async () => {
    server = createMockServer();
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    const result = await client.submitTransaction('aabbccdd');
    expect(result).toBeUndefined();
    client.disconnect();
  });

  it('balanceUnsealedTransaction returns balanced tx', async () => {
    server = createMockServer();
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    const result = await client.balanceUnsealedTransaction('raw_tx_hex');
    expect(result.tx).toBe('balanced_unsealed');
    client.disconnect();
  });

  it('balanceSealedTransaction returns balanced tx', async () => {
    server = createMockServer();
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    const result = await client.balanceSealedTransaction('raw_tx_hex');
    expect(result.tx).toBe('balanced_sealed');
    client.disconnect();
  });

  it('makeIntent dispatches with inputs, outputs, and options', async () => {
    let receivedParams: any;
    server = createMockServer({
      handlers: {
        makeIntent: (params) => {
          receivedParams = params;
          return { tx: 'intent_result' };
        },
      },
    });
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    const result = await client.makeIntent(
      [{ kind: 'unshielded', type: NATIVE_TOKEN, value: 100n }],
      [{ kind: 'unshielded', type: NATIVE_TOKEN, value: 50n, recipient: 'midnight1qaddr' }],
      { intentId: 'random', payFees: true },
    );
    expect(result.tx).toBe('intent_result');
    // Verify bigint was serialized as string on the wire
    expect(receivedParams.desiredInputs[0].value).toBe('100');
    client.disconnect();
  });

  it('signData returns signature', async () => {
    server = createMockServer();
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    const result = await client.signData('hello', { encoding: 'text', keyType: 'unshielded' });
    expect(result.signature).toBe('sig123');
    expect(result.verifyingKey).toBe('vk456');
    client.disconnect();
  });

  // ── Proving provider ──

  it('getProvingProvider returns stub with proverServerUri', async () => {
    server = createMockServer();
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    const provider = await client.getProvingProvider({
      getZKIR: async () => new Uint8Array(),
      getProverKey: async () => new Uint8Array(),
      getVerifierKey: async () => new Uint8Array(),
    });
    expect((provider as any).proverServerUri).toBe('http://localhost:6300');
    client.disconnect();
  });

  // ── Hints ──

  it('hintUsage dispatches without error', async () => {
    server = createMockServer();
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    await client.hintUsage(['getUnshieldedBalances', 'makeTransfer']);
    client.disconnect();
  });

  // ── Disconnect callback ──

  it('onDisconnect fires when server closes', async () => {
    server = createMockServer();
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    let disconnected = false;
    client.onDisconnect(() => { disconnected = true; });

    await server.close();
    server = null;

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(disconnected).toBe(true);
  });

  it('disconnect closes the connection', async () => {
    server = createMockServer();
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    client.disconnect();

    try {
      await client.getConnectionStatus();
      expect.fail('Should have thrown');
    } catch (err: any) {
      expect(err.message).toContain('not connected');
    }
  });
});
