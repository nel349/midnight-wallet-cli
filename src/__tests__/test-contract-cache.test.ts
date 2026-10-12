import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadContractCache, saveContractCache } from '../lib/test/contract-cache.ts';

const OLD_CHAIN = '0x' + 'a1'.repeat(32);
const NEW_CHAIN = '0x' + 'b2'.repeat(32);
const ADDRESS = '50e15c5b0a57b67de721417eec3cc087929116e5a4118b62a7b66f68b592d33e';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mn-contract-cache-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** An entry as mn wrote it before the chain was recorded. */
function writeLegacyEntry(network: string): void {
  mkdirSync(join(dir, 'tests', 'results'), { recursive: true });
  writeFileSync(
    join(dir, 'tests', 'results', '.contract-cache-suite.json'),
    JSON.stringify({ address: ADDRESS, network, timestamp: '2026-10-01T00:00:00.000Z' }),
  );
}

describe('contract cache', () => {
  it('gives back the address on the chain it was saved for', () => {
    saveContractCache(dir, 'suite', 'undeployed', ADDRESS, OLD_CHAIN);
    expect(loadContractCache(dir, 'suite', 'undeployed', OLD_CHAIN)).toBe(ADDRESS);
  });

  it('gives nothing on another chain: a localnet that was torn down and started again', () => {
    saveContractCache(dir, 'suite', 'undeployed', ADDRESS, OLD_CHAIN);
    expect(loadContractCache(dir, 'suite', 'undeployed', NEW_CHAIN)).toBeUndefined();
  });

  it('gives nothing for another network or another suite', () => {
    saveContractCache(dir, 'suite', 'undeployed', ADDRESS, OLD_CHAIN);
    expect(loadContractCache(dir, 'suite', 'preview', OLD_CHAIN)).toBeUndefined();
    expect(loadContractCache(dir, 'other', 'undeployed', OLD_CHAIN)).toBeUndefined();
  });

  it('uses the entry as it is when the node could not be asked which chain this is', () => {
    saveContractCache(dir, 'suite', 'undeployed', ADDRESS, OLD_CHAIN);
    expect(loadContractCache(dir, 'suite', 'undeployed', null)).toBe(ADDRESS);
  });

  it('does not trust a local-network entry that records no chain', () => {
    writeLegacyEntry('undeployed');
    expect(loadContractCache(dir, 'suite', 'undeployed', NEW_CHAIN)).toBeUndefined();
  });

  it('keeps a hosted-network entry that records no chain', () => {
    writeLegacyEntry('preview');
    expect(loadContractCache(dir, 'suite', 'preview', NEW_CHAIN)).toBe(ADDRESS);
  });

  it('gives nothing for a file that is not JSON', () => {
    mkdirSync(join(dir, 'tests', 'results'), { recursive: true });
    writeFileSync(join(dir, 'tests', 'results', '.contract-cache-suite.json'), 'not json');
    expect(loadContractCache(dir, 'suite', 'undeployed', OLD_CHAIN)).toBeUndefined();
  });
});
