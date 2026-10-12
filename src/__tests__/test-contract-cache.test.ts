import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadContractCache, saveContractCache } from '../lib/test/contract-cache.ts';

const ADDRESS = '50e15c5b0a57b67de721417eec3cc087929116e5a4118b62a7b66f68b592d33e';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mn-contract-cache-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('contract cache', () => {
  it('gives back the address saved for the suite and network', () => {
    saveContractCache(dir, 'suite', 'undeployed', ADDRESS);
    expect(loadContractCache(dir, 'suite', 'undeployed')).toBe(ADDRESS);
  });

  it('gives nothing for another network or another suite', () => {
    saveContractCache(dir, 'suite', 'undeployed', ADDRESS);
    expect(loadContractCache(dir, 'suite', 'preview')).toBeUndefined();
    expect(loadContractCache(dir, 'other', 'undeployed')).toBeUndefined();
  });

  it('gives nothing when there is no file, or it is not JSON', () => {
    expect(loadContractCache(dir, 'suite', 'undeployed')).toBeUndefined();
    mkdirSync(join(dir, 'tests', 'results'), { recursive: true });
    writeFileSync(join(dir, 'tests', 'results', '.contract-cache-suite.json'), 'not json');
    expect(loadContractCache(dir, 'suite', 'undeployed')).toBeUndefined();
  });
});
