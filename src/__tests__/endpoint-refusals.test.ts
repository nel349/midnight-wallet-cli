// The connections mn opens itself: each stops before connecting when the
// endpoint can only refuse it, and turns a refusal it gets into an error that
// says what to do. A local server answers the WebSocket upgrade with a status.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkBalance } from '../lib/balance-subscription.ts';
import { BlockfrostProjectIdRequiredError, EndpointShutDownError, blockfrostEndpoints } from '../lib/blockfrost.ts';
import { subscribeGraphqlWs } from '../lib/graphql-ws-subscription.ts';
import { callNodeRpc } from '../lib/node-rpc.ts';

const NO_ID = blockfrostEndpoints('preprod', undefined);
const ADDRESS = 'mn_addr_preprod1m5cjx3u3hmfhm5268muqp499y82e3fuxj65jpqq7sd0r9x07n3fqk36yhe';

const subscribe = (url: string) => subscribeGraphqlWs(url, {
  query: 'subscription { x }', variables: {}, onNext: () => true, buildResult: () => 'done', timeoutMs: 5_000, idleMs: 1_000,
});

let server: http.Server;
let gone: string;
let upgrades = 0;

beforeAll(async () => {
  // Answers every upgrade as an endpoint that was shut down does.
  server = http.createServer();
  server.on('upgrade', (_request, socket) => {
    upgrades++;
    socket.end('HTTP/1.1 410 Gone\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  gone = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/v4/graphql/ws`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('a Blockfrost endpoint with no project id', () => {
  it('is refused by an indexer subscription, the balance read and a node call alike, without connecting', async () => {
    await expect(subscribe(NO_ID.indexerWS)).rejects.toThrow(BlockfrostProjectIdRequiredError);
    await expect(checkBalance(ADDRESS, NO_ID.indexerWS)).rejects.toThrow(BlockfrostProjectIdRequiredError);
    await expect(callNodeRpc({ url: NO_ID.node }, 'chain_getBlockHash', [0])).rejects.toThrow(BlockfrostProjectIdRequiredError);
  });
});

describe('an endpoint that answers 410', () => {
  it('is reported as shut down by all three, not as a bare status', async () => {
    const before = upgrades;
    await expect(subscribe(gone)).rejects.toThrow(EndpointShutDownError);
    await expect(checkBalance(ADDRESS, gone)).rejects.toThrow(EndpointShutDownError);
    await expect(callNodeRpc({ url: gone }, 'chain_getBlockHash', [0])).rejects.toThrow(EndpointShutDownError);
    expect(upgrades - before).toBe(3);
  });

  it('says how to drop the setting', async () => {
    await expect(subscribe(gone)).rejects.toThrow('midnight config unset indexer-ws');
  });
});

describe('the preprod indexer Midnight shut down', () => {
  it('is refused by name before any connection is tried', async () => {
    await expect(subscribe('wss://indexer.preprod.midnight.network/api/v4/graphql/ws')).rejects.toThrow('was shut down on 2026-10-09');
  });
});
