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

    it('--network flag overrides config file default', () => {
      saveCliConfig({ network: 'preview' }, TEST_DIR);
      const ctx = makeCtx({ args: makeArgs(['--network', 'preprod']) });
      expect(resolveNetworkName(ctx)).toBe('preprod');
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

  describe('step 2: config file default', () => {
    it('uses network from config file when no --network flag', () => {
      saveCliConfig({ network: 'preprod' }, TEST_DIR);
      const ctx = makeCtx();
      expect(resolveNetworkName(ctx)).toBe('preprod');
    });

    it('config file is lower priority than --network flag', () => {
      saveCliConfig({ network: 'preview' }, TEST_DIR);
      const ctx = makeCtx({ args: makeArgs(['--network', 'preprod']) });
      expect(resolveNetworkName(ctx)).toBe('preprod');
    });
  });

  describe('step 3: fallback', () => {
    it('returns undeployed when nothing matches', () => {
      const ctx = makeCtx();
      expect(resolveNetworkName(ctx)).toBe('undeployed');
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
