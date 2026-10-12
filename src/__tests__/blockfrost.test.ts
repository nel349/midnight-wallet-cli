// Blockfrost serves preprod's indexer and node since 2026-10-09 and needs the
// user's project id on every request. What mn knows about that, without a
// connection: the endpoints, whose project id is whose, what a refusal means,
// and how the project id is kept out of anything printed.

import { describe, expect, it } from 'vitest';
import {
  BlockfrostLimitError, BlockfrostProjectIdRejectedError, BlockfrostProjectIdRequiredError, EndpointShutDownError,
  assertEndpointUsable, blockfrostEndpoints, checkProjectId, endpointRefusal, endpointRefusalFromWsError, isBlockfrostUrl,
  maskProjectId, mayHoldProjectId, networkOfProjectId, redactProjectId, usesBlockfrost,
} from '../lib/blockfrost.ts';
import { UsageError } from '../lib/errors.ts';
import { ERROR_CODES, EXIT_NETWORK_ERROR, classifyError } from '../lib/exit-codes.ts';

const ID = 'nightpreprodAbCdEfGhIjKlMnOpQrStUv0123';
const WITH_ID = blockfrostEndpoints('preprod', ID);
const WITHOUT_ID = blockfrostEndpoints('preprod', undefined);

describe('which networks Blockfrost serves', () => {
  it('serves preprod, not preview or a local network', () => {
    expect(usesBlockfrost('preprod')).toBe(true);
    expect(usesBlockfrost('preview')).toBe(false);
    expect(usesBlockfrost('undeployed')).toBe(false);
  });
});

describe('a project id', () => {
  it('belongs to the network its prefix names', () => {
    expect(networkOfProjectId(ID)).toBe('preprod');
    expect(networkOfProjectId('nightmainnetAbCdEfGhIjKl')).toBeUndefined();
    expect(networkOfProjectId('preprodAbCdEfGhIjKl')).toBeUndefined();
  });

  it('is accepted with its network, spaces around it dropped', () => {
    expect(checkProjectId(`  ${ID}\n`)).toEqual({ projectId: ID, network: 'preprod' });
  });

  it.each(['nightmainnetAbCdEfGhIjKl', 'abc', '', `${ID}&x=1`, `https://midnight-preprod.blockfrost.io/api/v0?project_id=${ID}`])(
    'is refused when it is %j, saying what one looks like', (given) => {
      expect(() => checkProjectId(given)).toThrow(UsageError);
      expect(() => checkProjectId(given)).toThrow('it should start with "nightpreprod" (preprod)');
    });

  it('is shown as its prefix and last four characters', () => {
    expect(maskProjectId(ID)).toBe('nightpreprod…0123');
  });
});

describe('blockfrostEndpoints', () => {
  it('carries the project id as a query parameter on the indexer and the node', () => {
    expect(WITH_ID).toEqual({
      indexer: `https://midnight-preprod.blockfrost.io/api/v0?project_id=${ID}`,
      indexerWS: `wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${ID}`,
      node: `wss://rpc.midnight-preprod.blockfrost.io?project_id=${ID}`,
    });
  });

  it('is the same hosts with no query when there is no project id', () => {
    expect(WITHOUT_ID).toEqual({
      indexer: 'https://midnight-preprod.blockfrost.io/api/v0',
      indexerWS: 'wss://midnight-preprod.blockfrost.io/api/v0/ws',
      node: 'wss://rpc.midnight-preprod.blockfrost.io',
    });
  });
});

describe('isBlockfrostUrl', () => {
  it('knows Blockfrost\'s hosts from others', () => {
    expect(isBlockfrostUrl(WITH_ID.node)).toBe(true);
    expect(isBlockfrostUrl('https://blockfrost.io/')).toBe(true);
    expect(isBlockfrostUrl('https://notblockfrost.io/')).toBe(false);
    expect(isBlockfrostUrl('https://blockfrost.io.example.org/')).toBe(false);
    expect(isBlockfrostUrl('ws://localhost:8088/api/v4/graphql/ws')).toBe(false);
    expect(isBlockfrostUrl('not a url')).toBe(false);
  });
});

describe('assertEndpointUsable', () => {
  it('lets a Blockfrost endpoint with a project id through, and any other host', () => {
    for (const url of [...Object.values(WITH_ID), 'ws://localhost:9944', 'wss://indexer.preview.midnight.network/api/v4/graphql/ws', 'not a url']) {
      expect(() => assertEndpointUsable(url)).not.toThrow();
    }
  });

  it('stops a Blockfrost endpoint with no project id, saying where to get one and the command to run', () => {
    for (const url of [...Object.values(WITHOUT_ID), 'wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=']) {
      expect(() => assertEndpointUsable(url)).toThrow(BlockfrostProjectIdRequiredError);
      expect(() => assertEndpointUsable(url)).toThrow('midnight config set blockfrost-project-id <project id>');
      expect(() => assertEndpointUsable(url)).toThrow('https://blockfrost.io');
    }
  });

  it('stops the preprod indexer Midnight shut down, saying when and how to drop the setting', () => {
    const old = 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws';
    expect(() => assertEndpointUsable(old)).toThrow(EndpointShutDownError);
    expect(() => assertEndpointUsable(old)).toThrow('indexer.preprod.midnight.network was shut down on 2026-10-09');
    expect(() => assertEndpointUsable(old)).toThrow('midnight config unset indexer-ws');
  });
});

describe('endpointRefusal', () => {
  it('reads 403 from Blockfrost as a refused project id, or a missing one', () => {
    expect(endpointRefusal(WITH_ID.indexer, 403)).toBeInstanceOf(BlockfrostProjectIdRejectedError);
    expect(endpointRefusal(WITH_ID.node, 403)).toBeInstanceOf(BlockfrostProjectIdRejectedError);
    expect(endpointRefusal(WITHOUT_ID.indexerWS, 403)).toBeInstanceOf(BlockfrostProjectIdRequiredError);
  });

  it('reads 402 and 429 from Blockfrost as its limits', () => {
    expect(endpointRefusal(WITH_ID.indexer, 402)?.message).toContain("used up its plan's daily requests");
    expect(endpointRefusal(WITH_ID.indexer, 429)).toBeInstanceOf(BlockfrostLimitError);
  });

  it('reads 410 from any host as an endpoint that was shut down', () => {
    expect(endpointRefusal('https://indexer.preprod.midnight.network/api/v4/graphql', 410)).toBeInstanceOf(EndpointShutDownError);
    expect(endpointRefusal('https://example.org/graphql', 410)?.message).toContain('example.org was shut down:');
  });

  it('gives no meaning to other statuses, or to a 403 from another host', () => {
    expect(endpointRefusal(WITH_ID.indexer, 500)).toBeUndefined();
    expect(endpointRefusal(WITH_ID.indexer, 200)).toBeUndefined();
    expect(endpointRefusal('https://indexer.preview.midnight.network/api/v4/graphql', 403)).toBeUndefined();
  });

  it('never carries the project id in what it says', () => {
    for (const status of [402, 403, 410, 429]) {
      expect(endpointRefusal(WITH_ID.indexerWS, status)?.message).not.toContain(ID);
    }
  });

  it('reads the status out of the ws package\'s error for a refused upgrade', () => {
    expect(endpointRefusalFromWsError(WITH_ID.indexerWS, new Error('Unexpected server response: 403'))).toBeInstanceOf(BlockfrostProjectIdRejectedError);
    expect(endpointRefusalFromWsError('wss://indexer.preprod.midnight.network/api/v4/graphql/ws', new Error('Unexpected server response: 410')))
      .toBeInstanceOf(EndpointShutDownError);
    expect(endpointRefusalFromWsError(WITH_ID.indexerWS, new Error('connect ECONNREFUSED 127.0.0.1:8088'))).toBeUndefined();
  });
});

describe('the errors\' codes', () => {
  it('are their own, with the network exit code', () => {
    const cases: [Error, string][] = [
      [new BlockfrostProjectIdRequiredError('preprod'), ERROR_CODES.BLOCKFROST_PROJECT_ID_REQUIRED],
      [new BlockfrostProjectIdRejectedError('preprod'), ERROR_CODES.BLOCKFROST_PROJECT_ID_REJECTED],
      [new BlockfrostLimitError(429), ERROR_CODES.BLOCKFROST_LIMIT_REACHED],
      [new EndpointShutDownError('https://indexer.preprod.midnight.network/api/v4/graphql'), ERROR_CODES.ENDPOINT_SHUT_DOWN],
    ];
    for (const [error, errorCode] of cases) {
      expect(classifyError(error)).toEqual({ exitCode: EXIT_NETWORK_ERROR, errorCode });
    }
  });
});

describe('redactProjectId', () => {
  it('hides a project id in a URL\'s query, wherever the URL stands', () => {
    expect(redactProjectId(`Indexer: ${WITH_ID.indexerWS}`)).toBe('Indexer: wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=***');
    expect(redactProjectId(`{"indexerUri":"${WITH_ID.indexer}","next":1}`)).toBe('{"indexerUri":"https://midnight-preprod.blockfrost.io/api/v0?project_id=***","next":1}');
    expect(redactProjectId(`disconnected from ${WITH_ID.node}: 1006`)).toBe('disconnected from wss://rpc.midnight-preprod.blockfrost.io?project_id=***: 1006');
    expect(redactProjectId('https://x.example/a?b=1&project_id=secret&c=2')).toBe('https://x.example/a?b=1&project_id=***&c=2');
  });

  it('hides one standing alone', () => {
    expect(redactProjectId(`blockfrost-project-id = ${ID}`)).toBe('blockfrost-project-id = nightpreprod***');
  });

  it('hides every one in a text', () => {
    expect(redactProjectId(`${WITH_ID.indexer} ${WITH_ID.node}`)).not.toContain(ID);
  });

  it('leaves the prefix, a masked id and unrelated text alone', () => {
    for (const text of ['it should start with "nightpreprod" (preprod)', 'nightpreprod…0123 (preprod)', 'Balance: 5 NIGHT', '']) {
      expect(redactProjectId(text)).toBe(text);
    }
  });
});

describe('mayHoldProjectId', () => {
  it('is true of anything redactProjectId would change', () => {
    expect(mayHoldProjectId(WITH_ID.indexer)).toBe(true);
    expect(mayHoldProjectId(ID)).toBe(true);
    expect(mayHoldProjectId('Balance: 5 NIGHT')).toBe(false);
  });
});
