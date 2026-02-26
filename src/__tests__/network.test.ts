import { describe, it, expect } from 'vitest';
import {
  detectNetworkFromAddress,
  isValidNetworkName,
  getNetworkConfig,
  getValidNetworkNames,
  resolveNetworkConfig,
} from '../lib/network.ts';

describe('detectNetworkFromAddress', () => {
  it('detects preprod from address prefix', () => {
    expect(detectNetworkFromAddress('mn_addr_preprod1qqqqqq...')).toBe('preprod');
  });

  it('detects preview from address prefix', () => {
    expect(detectNetworkFromAddress('mn_addr_preview1qqqqqq...')).toBe('preview');
  });

  it('detects undeployed from address prefix', () => {
    expect(detectNetworkFromAddress('mn_addr_undeployed1qqqqqq...')).toBe('undeployed');
  });

  it('returns null for unknown prefix', () => {
    expect(detectNetworkFromAddress('mn_addr_mainnet1qqqqqq...')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(detectNetworkFromAddress('')).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(detectNetworkFromAddress('not-an-address')).toBeNull();
  });

  it('matches prefix exactly, not partial substrings', () => {
    // "preproduction" should not match "preprod"
    expect(detectNetworkFromAddress('mn_addr_preproduction1abc')).toBeNull();
  });
});

describe('isValidNetworkName', () => {
  it('accepts all known networks', () => {
    expect(isValidNetworkName('preprod')).toBe(true);
    expect(isValidNetworkName('preview')).toBe(true);
    expect(isValidNetworkName('undeployed')).toBe(true);
  });

  it('rejects unknown networks', () => {
    expect(isValidNetworkName('mainnet')).toBe(false);
    expect(isValidNetworkName('testnet')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidNetworkName('')).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(isValidNetworkName('PreProd')).toBe(false);
    expect(isValidNetworkName('PREPROD')).toBe(false);
  });
});

describe('getNetworkConfig', () => {
  it('returns exact URLs for preprod', () => {
    const config = getNetworkConfig('preprod');
    expect(config.indexer).toBe('https://indexer.preprod.midnight.network/api/v3/graphql');
    expect(config.indexerWS).toBe('wss://indexer.preprod.midnight.network/api/v3/graphql/ws');
    expect(config.node).toBe('wss://rpc.preprod.midnight.network');
    expect(config.proofServer).toBe('http://localhost:6300');
    expect(config.networkId).toBe('PreProd');
  });

  it('returns exact URLs for preview', () => {
    const config = getNetworkConfig('preview');
    expect(config.indexer).toBe('https://indexer.preview.midnight.network/api/v3/graphql');
    expect(config.indexerWS).toBe('wss://indexer.preview.midnight.network/api/v3/graphql/ws');
    expect(config.node).toBe('wss://rpc.preview.midnight.network');
    expect(config.proofServer).toBe('http://localhost:6300');
    expect(config.networkId).toBe('Preview');
  });

  it('returns localhost URLs for undeployed', () => {
    const config = getNetworkConfig('undeployed');
    expect(config.indexer).toBe('http://localhost:8088/api/v3/graphql');
    expect(config.indexerWS).toBe('ws://localhost:8088/api/v3/graphql/ws');
    expect(config.node).toBe('ws://localhost:9944');
    expect(config.proofServer).toBe('http://localhost:6300');
    expect(config.networkId).toBe('Undeployed');
  });

  it('returns a defensive copy (mutation does not affect source)', () => {
    const a = getNetworkConfig('preprod');
    const b = getNetworkConfig('preprod');
    a.proofServer = 'http://mutated';
    a.indexer = 'http://mutated';
    expect(b.proofServer).toBe('http://localhost:6300');
    expect(b.indexer).toBe('https://indexer.preprod.midnight.network/api/v3/graphql');
  });
});

describe('getValidNetworkNames', () => {
  it('returns all three networks', () => {
    const names = getValidNetworkNames();
    expect(names).toContain('preprod');
    expect(names).toContain('preview');
    expect(names).toContain('undeployed');
    expect(names).toHaveLength(3);
  });

  it('agrees with isValidNetworkName', () => {
    const names = getValidNetworkNames();
    for (const name of names) {
      expect(isValidNetworkName(name)).toBe(true);
    }
  });
});

describe('resolveNetworkConfig', () => {
  it('returns standard config for preprod (no docker override)', () => {
    const resolved = resolveNetworkConfig('preprod');
    const standard = getNetworkConfig('preprod');
    expect(resolved).toEqual(standard);
  });

  it('returns standard config for preview (no docker override)', () => {
    const resolved = resolveNetworkConfig('preview');
    const standard = getNetworkConfig('preview');
    expect(resolved).toEqual(standard);
  });

  it('returns a config object with all required fields for undeployed', () => {
    const resolved = resolveNetworkConfig('undeployed');
    expect(resolved.indexer).toBeDefined();
    expect(resolved.indexerWS).toBeDefined();
    expect(resolved.node).toBeDefined();
    expect(resolved.proofServer).toBeDefined();
    expect(resolved.networkId).toBe('Undeployed');
  });

  it('returns a copy that can be mutated without affecting future calls', () => {
    const a = resolveNetworkConfig('preprod');
    a.node = 'wss://mutated';
    const b = resolveNetworkConfig('preprod');
    expect(b.node).toBe('wss://rpc.preprod.midnight.network');
  });
});
