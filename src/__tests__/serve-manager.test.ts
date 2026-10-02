// Reusing a running `mn serve` is only safe on the same chain. Two local
// stacks both call themselves `undeployed`, so the network name alone can't
// tell them apart; the node and indexer the serve reports can.

import { describe, it, expect } from 'vitest';
import { serveEndpointMismatch } from '../lib/test/serve-manager.ts';

const scratch = { node: 'ws://localhost:29944', indexerWS: 'ws://localhost:28088/api/v4/graphql/ws' };

describe('serveEndpointMismatch', () => {
  it('allows reuse when the serve reports the requested node and indexer', () => {
    expect(serveEndpointMismatch(
      { substrateNodeUri: scratch.node, indexerWsUri: scratch.indexerWS },
      scratch,
    )).toBeUndefined();
  });

  it('refuses a serve on another local stack with the same network name, naming both sides', () => {
    const reason = serveEndpointMismatch(
      { substrateNodeUri: 'ws://localhost:9944', indexerWsUri: 'ws://localhost:8088/api/v4/graphql/ws' },
      scratch,
    );
    expect(reason).toContain('node ws://localhost:9944 (need ws://localhost:29944)');
    expect(reason).toContain('indexer ws://localhost:8088/api/v4/graphql/ws (need ws://localhost:28088/api/v4/graphql/ws)');
  });

  it('refuses when only one endpoint differs', () => {
    expect(serveEndpointMismatch({ substrateNodeUri: scratch.node, indexerWsUri: 'ws://elsewhere/ws' }, scratch))
      .toBe('indexer ws://elsewhere/ws (need ws://localhost:28088/api/v4/graphql/ws)');
  });

  it('refuses a serve that does not report its endpoints', () => {
    expect(serveEndpointMismatch({}, scratch)).toBeDefined();
  });
});
