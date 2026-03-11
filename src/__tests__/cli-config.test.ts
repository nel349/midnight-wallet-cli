import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  loadCliConfig,
  saveCliConfig,
  getConfigValue,
  setConfigValue,
  getValidConfigKeys,
} from '../lib/cli-config.ts';

const TEST_DIR = path.join(os.tmpdir(), `midnight-cli-config-test-${process.pid}`);

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('loadCliConfig', () => {
  it('returns defaults when config dir does not exist', () => {
    const nonExistent = path.join(TEST_DIR, 'no-such-dir');
    const config = loadCliConfig(nonExistent);
    expect(config.network).toBe('undeployed');
  });

  it('returns defaults when config file is missing from dir', () => {
    const config = loadCliConfig(TEST_DIR);
    expect(config.network).toBe('undeployed');
  });

  it('reads network from config file', () => {
    fs.writeFileSync(
      path.join(TEST_DIR, 'config.json'),
      JSON.stringify({ network: 'preprod' }),
    );
    const config = loadCliConfig(TEST_DIR);
    expect(config.network).toBe('preprod');
  });

  it('falls back to default for invalid network value', () => {
    fs.writeFileSync(
      path.join(TEST_DIR, 'config.json'),
      JSON.stringify({ network: 'mainnet' }),
    );
    const config = loadCliConfig(TEST_DIR);
    expect(config.network).toBe('undeployed');
  });

  it('falls back to default for corrupted JSON', () => {
    fs.writeFileSync(path.join(TEST_DIR, 'config.json'), '{broken json!!');
    const config = loadCliConfig(TEST_DIR);
    expect(config.network).toBe('undeployed');
  });

  it('falls back to default for empty file', () => {
    fs.writeFileSync(path.join(TEST_DIR, 'config.json'), '');
    const config = loadCliConfig(TEST_DIR);
    expect(config.network).toBe('undeployed');
  });

  it('falls back to default when network field is missing from JSON', () => {
    fs.writeFileSync(
      path.join(TEST_DIR, 'config.json'),
      JSON.stringify({ someOtherKey: 'value' }),
    );
    const config = loadCliConfig(TEST_DIR);
    expect(config.network).toBe('undeployed');
  });
});

describe('saveCliConfig', () => {
  it('creates the config file', () => {
    saveCliConfig({ network: 'preview' }, TEST_DIR);
    expect(fs.existsSync(path.join(TEST_DIR, 'config.json'))).toBe(true);
  });

  it('creates config directory if it does not exist', () => {
    const nested = path.join(TEST_DIR, 'deep', 'nested');
    saveCliConfig({ network: 'preprod' }, nested);
    expect(fs.existsSync(path.join(nested, 'config.json'))).toBe(true);
  });

  it('writes valid JSON that can be read back', () => {
    saveCliConfig({ network: 'preview' }, TEST_DIR);
    const config = loadCliConfig(TEST_DIR);
    expect(config.network).toBe('preview');
  });

  it('overwrites previous config completely', () => {
    saveCliConfig({ network: 'preprod' }, TEST_DIR);
    saveCliConfig({ network: 'preview' }, TEST_DIR);
    const config = loadCliConfig(TEST_DIR);
    expect(config.network).toBe('preview');
  });
});

describe('getConfigValue', () => {
  it('returns saved network value', () => {
    saveCliConfig({ network: 'preview' }, TEST_DIR);
    expect(getConfigValue('network', TEST_DIR)).toBe('preview');
  });

  it('returns default when no config exists', () => {
    expect(getConfigValue('network', TEST_DIR)).toBe('undeployed');
  });

  it('throws for unknown key', () => {
    expect(() => getConfigValue('unknown', TEST_DIR)).toThrow('Unknown config key');
    expect(() => getConfigValue('unknown', TEST_DIR)).toThrow('Valid keys:');
  });
});

describe('setConfigValue', () => {
  it('persists a valid network', () => {
    setConfigValue('network', 'preprod', TEST_DIR);
    expect(getConfigValue('network', TEST_DIR)).toBe('preprod');
  });

  it('overwrites a previous network value', () => {
    setConfigValue('network', 'preprod', TEST_DIR);
    setConfigValue('network', 'preview', TEST_DIR);
    expect(getConfigValue('network', TEST_DIR)).toBe('preview');
  });

  it('throws for invalid network value with guidance', () => {
    expect(() => setConfigValue('network', 'mainnet', TEST_DIR)).toThrow('Invalid network');
    expect(() => setConfigValue('network', 'mainnet', TEST_DIR)).toThrow('preprod');
  });

  it('throws for unknown key', () => {
    expect(() => setConfigValue('unknown', 'value', TEST_DIR)).toThrow('Unknown config key');
  });

  it('does not corrupt existing config on validation failure', () => {
    setConfigValue('network', 'preprod', TEST_DIR);
    expect(() => setConfigValue('network', 'invalid', TEST_DIR)).toThrow();
    expect(getConfigValue('network', TEST_DIR)).toBe('preprod');
  });
});

describe('endpoint config keys', () => {
  it('setConfigValue persists proof-server URL', () => {
    setConfigValue('proof-server', 'http://my-prover:6300', TEST_DIR);
    expect(getConfigValue('proof-server', TEST_DIR)).toBe('http://my-prover:6300');
  });

  it('setConfigValue persists node URL', () => {
    setConfigValue('node', 'wss://rpc.preprod.midnight.network', TEST_DIR);
    expect(getConfigValue('node', TEST_DIR)).toBe('wss://rpc.preprod.midnight.network');
  });

  it('setConfigValue persists indexer-ws URL', () => {
    setConfigValue('indexer-ws', 'wss://indexer.preprod.midnight.network/api/v3/graphql/ws', TEST_DIR);
    expect(getConfigValue('indexer-ws', TEST_DIR)).toBe('wss://indexer.preprod.midnight.network/api/v3/graphql/ws');
  });

  it('rejects invalid URL for endpoint keys', () => {
    expect(() => setConfigValue('proof-server', 'not-a-url', TEST_DIR)).toThrow('Invalid URL');
    expect(() => setConfigValue('node', 'localhost:9944', TEST_DIR)).toThrow('Must start with');
  });

  it('accepts http, https, ws, wss protocols', () => {
    setConfigValue('proof-server', 'http://localhost:6300', TEST_DIR);
    setConfigValue('node', 'ws://localhost:9944', TEST_DIR);
    expect(getConfigValue('proof-server', TEST_DIR)).toBe('http://localhost:6300');
    expect(getConfigValue('node', TEST_DIR)).toBe('ws://localhost:9944');
  });

  it('returns (not set) for unset endpoint keys', () => {
    expect(getConfigValue('proof-server', TEST_DIR)).toBe('(not set)');
    expect(getConfigValue('node', TEST_DIR)).toBe('(not set)');
    expect(getConfigValue('indexer-ws', TEST_DIR)).toBe('(not set)');
  });

  it('does not interfere with network config', () => {
    setConfigValue('network', 'preprod', TEST_DIR);
    setConfigValue('proof-server', 'http://localhost:6300', TEST_DIR);
    expect(getConfigValue('network', TEST_DIR)).toBe('preprod');
    expect(getConfigValue('proof-server', TEST_DIR)).toBe('http://localhost:6300');
  });

  it('loadCliConfig reads endpoint keys from file', () => {
    fs.writeFileSync(
      path.join(TEST_DIR, 'config.json'),
      JSON.stringify({
        network: 'preprod',
        'proof-server': 'http://my-prover:6300',
        node: 'wss://my-node',
        'indexer-ws': 'wss://my-indexer/ws',
      }),
    );
    const config = loadCliConfig(TEST_DIR);
    expect(config.network).toBe('preprod');
    expect(config['proof-server']).toBe('http://my-prover:6300');
    expect(config.node).toBe('wss://my-node');
    expect(config['indexer-ws']).toBe('wss://my-indexer/ws');
  });

  it('loadCliConfig ignores non-string endpoint values', () => {
    fs.writeFileSync(
      path.join(TEST_DIR, 'config.json'),
      JSON.stringify({
        network: 'preprod',
        'proof-server': 123,
        node: true,
      }),
    );
    const config = loadCliConfig(TEST_DIR);
    expect(config['proof-server']).toBeUndefined();
    expect(config.node).toBeUndefined();
  });
});

describe('getValidConfigKeys', () => {
  it('includes network', () => {
    expect(getValidConfigKeys()).toContain('network');
  });

  it('includes endpoint keys', () => {
    const keys = getValidConfigKeys();
    expect(keys).toContain('proof-server');
    expect(keys).toContain('node');
    expect(keys).toContain('indexer-ws');
  });

  it('returns at least one key', () => {
    expect(getValidConfigKeys().length).toBeGreaterThan(0);
  });
});
