import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveNetworkName, resolveNetwork, type NetworkResolutionContext } from '../lib/resolve-network.ts';
import { saveCliConfig } from '../lib/cli-config.ts';
import { parseArgs, type ParsedArgs } from '../lib/argv.ts';

// Use a temp config dir to avoid polluting the real ~/.midnight/
const TEST_DIR = path.join(os.tmpdir(), `midnight-resolve-network-test-${process.pid}`);

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

function makeArgs(argv: string[]): ParsedArgs {
  return parseArgs(argv);
}

function makeCtx(overrides: Partial<NetworkResolutionContext> = {}): NetworkResolutionContext {
  return {
    args: makeArgs([]),
    configDir: TEST_DIR,
    ...overrides,
  };
}

describe('resolveNetworkName', () => {
  describe('step 1: --network flag', () => {
    it('uses --network flag when provided', () => {
      const ctx = makeCtx({ args: makeArgs(['--network', 'preprod']) });
      expect(resolveNetworkName(ctx)).toBe('preprod');
    });

    it('--network flag overrides wallet network', () => {
      const ctx = makeCtx({
        args: makeArgs(['--network', 'preview']),
        walletNetwork: 'preprod',
      });
      expect(resolveNetworkName(ctx)).toBe('preview');
    });

    it('--network flag overrides address detection', () => {
      const ctx = makeCtx({
        args: makeArgs(['--network', 'undeployed']),
        address: 'mn_addr_preprod1abc',
      });
      expect(resolveNetworkName(ctx)).toBe('undeployed');
    });

    it('throws for invalid --network flag with valid network list', () => {
      const ctx = makeCtx({ args: makeArgs(['--network', 'mainnet']) });
      expect(() => resolveNetworkName(ctx)).toThrow('Invalid network');
      expect(() => resolveNetworkName(ctx)).toThrow('mainnet');
      expect(() => resolveNetworkName(ctx)).toThrow('preprod');
      expect(() => resolveNetworkName(ctx)).toThrow('preview');
      expect(() => resolveNetworkName(ctx)).toThrow('undeployed');
    });
  });

  describe('step 2: wallet network', () => {
    it('uses wallet network when no --network flag', () => {
      const ctx = makeCtx({ walletNetwork: 'preview' });
      expect(resolveNetworkName(ctx)).toBe('preview');
    });

    it('skips invalid wallet network', () => {
      const ctx = makeCtx({ walletNetwork: 'bogus' });
      // Falls through to step 5 (fallback) since no other sources
      expect(resolveNetworkName(ctx)).toBe('undeployed');
    });
  });

  describe('step 3: address prefix detection', () => {
    it('detects network from preprod address', () => {
      const ctx = makeCtx({ address: 'mn_addr_preprod1qqqqqqtest' });
      expect(resolveNetworkName(ctx)).toBe('preprod');
    });

    it('detects network from preview address', () => {
      const ctx = makeCtx({ address: 'mn_addr_preview1qqqqqqtest' });
      expect(resolveNetworkName(ctx)).toBe('preview');
    });

    it('detects network from undeployed address', () => {
      const ctx = makeCtx({ address: 'mn_addr_undeployed1qqqqqqtest' });
      expect(resolveNetworkName(ctx)).toBe('undeployed');
    });

    it('skips unrecognized address prefix', () => {
      const ctx = makeCtx({ address: 'mn_addr_mainnet1abc' });
      // Falls through to fallback
      expect(resolveNetworkName(ctx)).toBe('undeployed');
    });
  });

  describe('step 4: config file default', () => {
    it('uses network from config file when no flag, wallet, or address', () => {
      saveCliConfig({ network: 'preprod' }, TEST_DIR);
      const ctx = makeCtx();
      expect(resolveNetworkName(ctx)).toBe('preprod');
    });

    it('config file is lower priority than address detection', () => {
      saveCliConfig({ network: 'preview' }, TEST_DIR);
      const ctx = makeCtx({ address: 'mn_addr_preprod1abc' });
      expect(resolveNetworkName(ctx)).toBe('preprod');
    });

    it('config file is lower priority than wallet network', () => {
      saveCliConfig({ network: 'preview' }, TEST_DIR);
      const ctx = makeCtx({ walletNetwork: 'preprod' });
      expect(resolveNetworkName(ctx)).toBe('preprod');
    });
  });

  describe('step 5: fallback', () => {
    it('returns undeployed when nothing matches', () => {
      const ctx = makeCtx();
      expect(resolveNetworkName(ctx)).toBe('undeployed');
    });
  });

  describe('priority ordering', () => {
    it('wallet network overrides address detection', () => {
      const ctx = makeCtx({
        walletNetwork: 'preview',
        address: 'mn_addr_preprod1abc',
      });
      expect(resolveNetworkName(ctx)).toBe('preview');
    });

    it('address detection is used when wallet network is absent', () => {
      const ctx = makeCtx({
        address: 'mn_addr_preprod1abc',
      });
      expect(resolveNetworkName(ctx)).toBe('preprod');
    });
  });
});

describe('resolveNetwork', () => {
  it('returns both name and config', () => {
    const ctx = makeCtx({ args: makeArgs(['--network', 'preprod']) });
    const result = resolveNetwork(ctx);
    expect(result.name).toBe('preprod');
    expect(result.config.networkId).toBe('PreProd');
    expect(result.config.indexer).toContain('preprod');
  });

  it('config contains all required fields', () => {
    const ctx = makeCtx({ args: makeArgs(['--network', 'undeployed']) });
    const result = resolveNetwork(ctx);
    expect(result.config.indexer).toBeDefined();
    expect(result.config.indexerWS).toBeDefined();
    expect(result.config.node).toBeDefined();
    expect(result.config.proofServer).toBeDefined();
    expect(result.config.networkId).toBeDefined();
  });
});
