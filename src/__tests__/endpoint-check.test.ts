// What is asked of a network's endpoints before a wallet sync starts.

import { describe, expect, it } from 'vitest';
import { BlockfrostProjectIdRejectedError, BlockfrostProjectIdRequiredError, EndpointShutDownError, blockfrostEndpoints } from '../lib/blockfrost.ts';
import { assertNetworkAnswers } from '../lib/endpoint-check.ts';

const ID = 'nightpreprodAbCdEfGhIjKlMnOpQrStUv0123';
const LOCAL = { indexer: 'http://localhost:8088/api/v4/graphql', indexerWS: 'ws://localhost:8088/api/v4/graphql/ws', node: 'ws://localhost:9944' };

/** A `fetch` that answers every request with `status`, and writes down what it was asked. */
function answering(status: number) {
  const asked: { url: string; init?: RequestInit }[] = [];
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(url), init });
    return new Response('{}', { status });
  }) as typeof fetch;
  return { asked, request };
}

describe('assertNetworkAnswers', () => {
  it('asks nothing of a network Blockfrost doesn\'t serve', async () => {
    const { asked, request } = answering(500);
    await assertNetworkAnswers(LOCAL, request);
    expect(asked).toEqual([]);
  });

  it('stops before asking when Blockfrost has no project id to go with', async () => {
    const { asked, request } = answering(200);
    await expect(assertNetworkAnswers(blockfrostEndpoints('preprod', undefined), request)).rejects.toThrow(BlockfrostProjectIdRequiredError);
    expect(asked).toEqual([]);
  });

  it('stops before asking when an endpoint is one that was shut down', async () => {
    const { asked, request } = answering(200);
    const network = { ...LOCAL, indexerWS: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws' };
    await expect(assertNetworkAnswers(network, request)).rejects.toThrow(EndpointShutDownError);
    expect(asked).toEqual([]);
  });

  it('asks Blockfrost\'s indexer one small query, and passes when it answers', async () => {
    const { asked, request } = answering(200);
    const network = blockfrostEndpoints('preprod', ID);
    await assertNetworkAnswers(network, request);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.url).toBe(network.indexer);
    expect(asked[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(asked[0]!.init?.body))).toEqual({ query: '{ __typename }' });
  });

  it('says the project id was refused when Blockfrost answers 403', async () => {
    await expect(assertNetworkAnswers(blockfrostEndpoints('preprod', ID), answering(403).request)).rejects.toThrow(BlockfrostProjectIdRejectedError);
  });

  it('leaves an endpoint that can\'t be reached, or answers something else, to the sync to report', async () => {
    const unreachable = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    await expect(assertNetworkAnswers(blockfrostEndpoints('preprod', ID), unreachable)).resolves.toBeUndefined();
    await expect(assertNetworkAnswers(blockfrostEndpoints('preprod', ID), answering(500).request)).resolves.toBeUndefined();
  });
});
