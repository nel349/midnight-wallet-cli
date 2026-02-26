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

describe('getValidConfigKeys', () => {
  it('includes network', () => {
    expect(getValidConfigKeys()).toContain('network');
  });

  it('returns at least one key', () => {
    expect(getValidConfigKeys().length).toBeGreaterThan(0);
  });
});
