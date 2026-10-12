// A network's cached sync state belongs to the indexer it was read from: the
// ids a wallet resumes from are the indexer's own numbering. Preprod moved to
// Blockfrost on 2026-10-09, where state saved from Midnight's indexer replays
// the wrong events and never finishes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bindCachesToIndexer, describeIndexerChange, indexerIdentity } from '../lib/cache-indexer.ts';

const BLOCKFROST = 'wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=nightpreprodAbCdEfGhIjKlMnOpQrStUv0123';
const OLD_PREPROD = 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws';
const PREVIEW = 'wss://indexer.preview.midnight.network/api/v4/graphql/ws';

let dir: string;
const files = (network: string) => (fs.existsSync(path.join(dir, network)) ? fs.readdirSync(path.join(dir, network)).sort() : []);
const cache = (network: string, ...names: string[]) => {
  fs.mkdirSync(path.join(dir, network), { recursive: true });
  for (const name of names) fs.writeFileSync(path.join(dir, network, name), '{}');
};

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-cache-indexer-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('indexerIdentity', () => {
  it('is the host and port, never the query that carries a project id', () => {
    expect(indexerIdentity(BLOCKFROST)).toBe('midnight-preprod.blockfrost.io');
    expect(indexerIdentity('https://midnight-preprod.blockfrost.io/api/v0?project_id=secret')).toBe('midnight-preprod.blockfrost.io');
    expect(indexerIdentity('ws://localhost:38088/api/v4/graphql/ws')).toBe('localhost:38088');
  });
});

describe('bindCachesToIndexer', () => {
  // What an upgrade from 0.5.6 finds: preprod state with no indexer recorded.
  it('removes preprod state saved before the indexer was recorded, when preprod is read from Blockfrost', () => {
    cache('preprod', 'mn_addr_preprod1abc.json', 'dust-0123.json', 'dust-native-0123.json', 'shielded-4567.json');
    cache('preview', 'mn_addr_preview1abc.json');

    const change = bindCachesToIndexer('preprod', BLOCKFROST, dir);
    expect(change).toEqual({ previous: 'indexer.preprod.midnight.network', current: 'midnight-preprod.blockfrost.io', removed: 4 });
    expect(files('preprod')).toEqual(['indexer.host']);
    expect(files('preview')).toEqual(['mn_addr_preview1abc.json']);
  });

  it('keeps state saved before the indexer was recorded when the network is still on that indexer', () => {
    cache('preview', 'mn_addr_preview1abc.json', 'dust-0123.json');
    expect(bindCachesToIndexer('preview', PREVIEW, dir)).toBeUndefined();
    expect(files('preview')).toEqual(['dust-0123.json', 'indexer.host', 'mn_addr_preview1abc.json']);
  });

  it('keeps a local network\'s unrecorded state: its indexer was never a fixed one', () => {
    cache('undeployed', 'mn_addr_undeployed1abc.json');
    expect(bindCachesToIndexer('undeployed', 'ws://localhost:8088/api/v4/graphql/ws', dir)).toBeUndefined();
    expect(files('undeployed')).toEqual(['indexer.host', 'mn_addr_undeployed1abc.json']);
  });

  it('does nothing more once the directory belongs to the indexer', () => {
    bindCachesToIndexer('preprod', BLOCKFROST, dir);
    cache('preprod', 'dust-0123.json');
    expect(bindCachesToIndexer('preprod', BLOCKFROST, dir)).toBeUndefined();
    expect(files('preprod')).toEqual(['dust-0123.json', 'indexer.host']);
  });

  it('removes the state again when the indexer changes, in either direction', () => {
    bindCachesToIndexer('preprod', BLOCKFROST, dir);
    cache('preprod', 'dust-0123.json');
    expect(bindCachesToIndexer('preprod', 'wss://my-indexer.example/api/v4/graphql/ws', dir))
      .toEqual({ previous: 'midnight-preprod.blockfrost.io', current: 'my-indexer.example', removed: 1 });
    cache('preprod', 'dust-0123.json');
    expect(bindCachesToIndexer('preprod', BLOCKFROST, dir)?.removed).toBe(1);
  });

  it('tells two local stacks apart by their port', () => {
    bindCachesToIndexer('undeployed', 'ws://localhost:8088/api/v4/graphql/ws', dir);
    cache('undeployed', 'dust-0123.json');
    expect(bindCachesToIndexer('undeployed', 'ws://localhost:38088/api/v4/graphql/ws', dir)?.removed).toBe(1);
  });

  it('records the host only: the project id is never written', () => {
    bindCachesToIndexer('preprod', BLOCKFROST, dir);
    expect(fs.readFileSync(path.join(dir, 'preprod', 'indexer.host'), 'utf-8')).toBe('midnight-preprod.blockfrost.io\n');
  });

  it('records the indexer for a network with no cache yet, and reports nothing', () => {
    expect(bindCachesToIndexer('preprod', BLOCKFROST, dir)).toBeUndefined();
    expect(files('preprod')).toEqual(['indexer.host']);
  });

  it('leaves the old preprod state alone while preprod is still pointed at the old indexer', () => {
    cache('preprod', 'dust-0123.json');
    expect(bindCachesToIndexer('preprod', OLD_PREPROD, dir)).toBeUndefined();
    expect(files('preprod')).toEqual(['dust-0123.json', 'indexer.host']);
  });
});

describe('describeIndexerChange', () => {
  it('says where the network is read from now, and that the sync starts over', () => {
    expect(describeIndexerChange('preprod', { previous: 'indexer.preprod.midnight.network', current: 'midnight-preprod.blockfrost.io', removed: 4 }))
      .toBe("preprod is now read from midnight-preprod.blockfrost.io; sync state saved from indexer.preprod.midnight.network can't be resumed there, so this sync starts from the beginning.");
  });
});
