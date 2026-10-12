// A generated contract script is a file in the dApp's directory until its run
// ends. On a network Blockfrost serves, the indexer's URLs carry the user's
// project id, so the script reads them from its environment and never holds
// them in its text.

import { describe, expect, it } from 'vitest';
import { BlockfrostProjectIdRequiredError, blockfrostEndpoints } from '../lib/blockfrost.ts';
import { generateCallScript, generateDeployScript, generateStateScript, indexerEnvironment } from '../lib/contract/runner.ts';
import type { NetworkConfig } from '../lib/network.ts';

const ID = 'nightpreprodAbCdEfGhIjKlMnOpQrStUv0123';
const preprod = (projectId: string | undefined): NetworkConfig => ({
  ...blockfrostEndpoints('preprod', projectId),
  proofServer: 'http://localhost:6300',
  networkId: 'PreProd',
});
const common = { dappDir: '/tmp/dapp', networkConfig: preprod(ID), managedDir: '/tmp/dapp/managed/counter', contractName: 'counter', servePort: 9932 };

describe('a generated contract script', () => {
  const scripts = {
    deploy: generateDeployScript(common),
    call: generateCallScript({ ...common, contractAddress: 'ab'.repeat(32), circuit: 'increment' }),
    state: generateStateScript({ ...common, contractAddress: 'ab'.repeat(32) }),
  };

  it.each(Object.entries(scripts))('for %s holds neither the project id nor the indexer\'s host', (_name, script) => {
    expect(script).not.toContain(ID);
    expect(script).not.toContain('blockfrost.io');
  });

  it.each(Object.entries(scripts))('for %s takes the indexer\'s URLs from its environment', (_name, script) => {
    expect(script).toContain('process.env.MN_INDEXER_URL');
    expect(script).toContain('process.env.MN_INDEXER_WS_URL');
  });
});

describe('indexerEnvironment', () => {
  it('carries the indexer\'s two URLs, project id and all', () => {
    expect(indexerEnvironment(preprod(ID))).toEqual({
      MN_INDEXER_URL: `https://midnight-preprod.blockfrost.io/api/v0?project_id=${ID}`,
      MN_INDEXER_WS_URL: `wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${ID}`,
    });
  });

  it('stops a run on Blockfrost with no project id before a script exists', () => {
    expect(() => indexerEnvironment(preprod(undefined))).toThrow(BlockfrostProjectIdRequiredError);
  });
});
