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

  it('getTxHistory sends pageNumber and pageSize params', async () => {
    let receivedParams: any;
    server = createMockServer({
      handlers: {
        getTxHistory: (params) => {
          receivedParams = params;
          return [
            { txHash: 'aabb', txStatus: { status: 'finalized' } },
            { txHash: 'ccdd', txStatus: { status: 'pending' } },
          ];
        },
      },
    });
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    const history = await client.getTxHistory(2, 10);
    expect(history).toHaveLength(2);
    expect(history[0].txHash).toBe('aabb');
    expect(history[0].txStatus.status).toBe('finalized');
    expect(receivedParams.pageNumber).toBe(2);
    expect(receivedParams.pageSize).toBe(10);
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

  it('makeTransfer sends correct params and returns tx hex', async () => {
    let receivedParams: any;
    server = createMockServer({
      handlers: {
        makeTransfer: (params) => {
          receivedParams = params;
          return { tx: 'deadbeef' };
        },
      },
    });
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    const result = await client.makeTransfer(
      [{ kind: 'unshielded', type: NATIVE_TOKEN, value: 100_000_000n, recipient: 'midnight1qrecipient' }],
      { payFees: true },
    );
    expect(result.tx).toBe('deadbeef');
    // Verify parameter fidelity — bigint serialized as string
    expect(receivedParams.desiredOutputs[0].kind).toBe('unshielded');
    expect(receivedParams.desiredOutputs[0].type).toBe(NATIVE_TOKEN);
    expect(receivedParams.desiredOutputs[0].value).toBe('100000000');
    expect(receivedParams.desiredOutputs[0].recipient).toBe('midnight1qrecipient');
    expect(receivedParams.options.payFees).toBe(true);
    client.disconnect();
  });

  it('submitTransaction sends tx param correctly', async () => {
    let receivedParams: any;
    server = createMockServer({
      handlers: {
        submitTransaction: (params) => {
          receivedParams = params;
          return undefined;
        },
      },
    });
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    const result = await client.submitTransaction('aabbccdd');
    expect(result).toBeUndefined();
    expect(receivedParams.tx).toBe('aabbccdd');
    client.disconnect();
  });

  it('balanceUnsealedTransaction sends tx and options params', async () => {
    let receivedParams: any;
    server = createMockServer({
      handlers: {
        balanceUnsealedTransaction: (params) => {
          receivedParams = params;
          return { tx: 'balanced_unsealed' };
        },
      },
    });
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    const result = await client.balanceUnsealedTransaction('raw_tx_hex', { payFees: false });
    expect(result.tx).toBe('balanced_unsealed');
    expect(receivedParams.tx).toBe('raw_tx_hex');
    expect(receivedParams.options.payFees).toBe(false);
    client.disconnect();
  });

  it('balanceSealedTransaction sends tx param', async () => {
    let receivedParams: any;
    server = createMockServer({
      handlers: {
        balanceSealedTransaction: (params) => {
          receivedParams = params;
          return { tx: 'balanced_sealed' };
        },
      },
    });
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    const result = await client.balanceSealedTransaction('raw_tx_hex');
    expect(result.tx).toBe('balanced_sealed');
    expect(receivedParams.tx).toBe('raw_tx_hex');
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

  it('signData sends correct params and returns signature', async () => {
    let receivedParams: any;
    server = createMockServer({
      handlers: {
        signData: (params) => {
          receivedParams = params;
          return { data: 'hello', signature: 'sig123', verifyingKey: 'vk456' };
        },
      },
    });
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    const result = await client.signData('hello', { encoding: 'text', keyType: 'unshielded' });
    expect(result.signature).toBe('sig123');
    expect(result.verifyingKey).toBe('vk456');
    expect(receivedParams.data).toBe('hello');
    expect(receivedParams.options.encoding).toBe('text');
    expect(receivedParams.options.keyType).toBe('unshielded');
    client.disconnect();
  });

  // ── Proving provider ──

  it('getProvingProvider returns proverServerUri and working stubs', async () => {
    server = createMockServer();
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    const keyMaterialProvider = {
      getZKIR: async () => new Uint8Array(),
      getProverKey: async () => new Uint8Array(),
      getVerifierKey: async () => new Uint8Array(),
    };

    const provider = await client.getProvingProvider(keyMaterialProvider);
    // proverServerUri is now properly typed via WalletProvingProvider
    expect(provider.proverServerUri).toBe('http://localhost:6300');

    // Stubs throw with informative message
    try {
      await provider.check(new Uint8Array(), 'key');
      expect.fail('Should have thrown');
    } catch (err: any) {
      expect(err.message).toContain('not yet supported');
    }

    try {
      await provider.prove(new Uint8Array(), 'key');
      expect.fail('Should have thrown');
    } catch (err: any) {
      expect(err.message).toContain('not yet supported');
    }

    client.disconnect();
  });

  // ── Hints ──

  it('hintUsage sends methodNames array correctly', async () => {
    let receivedParams: any;
    server = createMockServer({
      handlers: {
        hintUsage: (params) => {
          receivedParams = params;
          return undefined;
        },
      },
    });
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    await client.hintUsage(['getUnshieldedBalances', 'makeTransfer']);
    expect(receivedParams.methodNames).toEqual(['getUnshieldedBalances', 'makeTransfer']);
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

  it('multiple onDisconnect handlers all fire', async () => {
    server = createMockServer();
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    const fired: string[] = [];
    client.onDisconnect(() => { fired.push('first'); });
    client.onDisconnect(() => { fired.push('second'); });
    client.onDisconnect(() => { fired.push('third'); });

    await server.close();
    server = null;

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fired).toEqual(['first', 'second', 'third']);
  });

  // ── Approval notifications ──

  it('fires onApprovalPending when server sends approval:pending', async () => {
    server = createMockServer({
      handlers: {
        // Custom submitTransaction that sends notification before responding
        submitTransaction: () => {
          // Send notification to all connected clients
          for (const client of server!.wss.clients) {
            client.send(JSON.stringify({
              jsonrpc: '2.0',
              method: 'approval:pending',
              params: { method: 'submitTransaction' },
            }));
          }
          // Small delay then respond
          return new Promise((resolve) => setTimeout(() => resolve(undefined), 50));
        },
      },
    });

    const pendingMethods: string[] = [];
    const client = await createWalletClient({
      url: server.url,
      networkId: 'Undeployed',
      onApprovalPending: (method) => { pendingMethods.push(method); },
    });

    await client.submitTransaction('aabb');
    expect(pendingMethods).toEqual(['submitTransaction']);
    client.disconnect();
  });

  it('fires onApprovalResolved when server sends approval:resolved', async () => {
    server = createMockServer({
      handlers: {
        submitTransaction: () => {
          for (const client of server!.wss.clients) {
            client.send(JSON.stringify({
              jsonrpc: '2.0',
              method: 'approval:resolved',
              params: { method: 'submitTransaction', result: 'approved' },
            }));
          }
          return new Promise((resolve) => setTimeout(() => resolve(undefined), 50));
        },
      },
    });

    const resolved: Array<{ method: string; result: string }> = [];
    const client = await createWalletClient({
      url: server.url,
      networkId: 'Undeployed',
      onApprovalResolved: (method, result) => { resolved.push({ method, result }); },
    });

    await client.submitTransaction('aabb');
    expect(resolved).toEqual([{ method: 'submitTransaction', result: 'approved' }]);
    client.disconnect();
  });

  // ── Error propagation ──

  it('propagates PermissionRejected error from server', async () => {
    server = createMockServer({
      handlers: {
        makeTransfer: () => {
          throw {
            code: -32001,
            message: 'Permission denied for makeTransfer',
            data: { type: 'DAppConnectorAPIError', code: 'PermissionRejected' },
          };
        },
      },
    });
    const client = await createWalletClient({ url: server.url, networkId: 'Undeployed' });

    try {
      await client.makeTransfer([
        { kind: 'unshielded', type: NATIVE_TOKEN, value: 1n, recipient: 'midnight1q' },
      ]);
      expect.fail('Should have thrown');
    } catch (err: any) {
      expect(err.type).toBe('DAppConnectorAPIError');
      expect(err.code).toBe('PermissionRejected');
    }
    client.disconnect();
  });
});
