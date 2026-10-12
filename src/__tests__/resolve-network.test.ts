import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveBlockfrostProjectId, resolveNetworkName, resolveNetwork, type NetworkResolutionContext } from '../lib/resolve-network.ts';
import { saveCliConfig, setConfigValue } from '../lib/cli-config.ts';
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

describe('resolveBlockfrostProjectId', () => {
  const FROM_CONFIG = 'nightpreprodConfigConfigConfig0001';
  const FROM_ENV = 'nightpreprodEnvEnvEnvEnvEnvEnv0002';

  it('is undefined when none is set', () => {
    expect(resolveBlockfrostProjectId('preprod', TEST_DIR, {})).toBeUndefined();
  });

  it('is the one set with config set', () => {
    setConfigValue('blockfrost-project-id', FROM_CONFIG, TEST_DIR);
    expect(resolveBlockfrostProjectId('preprod', TEST_DIR, {})).toBe(FROM_CONFIG);
  });

  it('is the environment\'s over the config\'s', () => {
    setConfigValue('blockfrost-project-id', FROM_CONFIG, TEST_DIR);
    expect(resolveBlockfrostProjectId('preprod', TEST_DIR, { MN_BLOCKFROST_PROJECT_ID: FROM_ENV })).toBe(FROM_ENV);
    expect(resolveBlockfrostProjectId('preprod', TEST_DIR, { MN_BLOCKFROST_PROJECT_ID: '  ' })).toBe(FROM_CONFIG);
  });

  it('is undefined on a network Blockfrost doesn\'t serve, whatever is set', () => {
    setConfigValue('blockfrost-project-id', FROM_CONFIG, TEST_DIR);
    expect(resolveBlockfrostProjectId('preview', TEST_DIR, { MN_BLOCKFROST_PROJECT_ID: FROM_ENV })).toBeUndefined();
    expect(resolveBlockfrostProjectId('undeployed', TEST_DIR, { MN_BLOCKFROST_PROJECT_ID: 'garbage' })).toBeUndefined();
  });

  it('takes the variable Midnight\'s docs name, after mn\'s own and before the config', () => {
    const SHARED = 'nightpreprodSharedSharedShared0003';
    setConfigValue('blockfrost-project-id', FROM_CONFIG, TEST_DIR);
    expect(resolveBlockfrostProjectId('preprod', TEST_DIR, { BLOCKFROST_PROJECT_ID: SHARED })).toBe(SHARED);
    expect(resolveBlockfrostProjectId('preprod', TEST_DIR, { BLOCKFROST_PROJECT_ID: `  ${SHARED}\n` })).toBe(SHARED);
    expect(resolveBlockfrostProjectId('preprod', TEST_DIR, { BLOCKFROST_PROJECT_ID: SHARED, MN_BLOCKFROST_PROJECT_ID: FROM_ENV })).toBe(FROM_ENV);
  });

  // Other Blockfrost tools use the same variable for another network's id, or another chain's.
  it('passes over that variable when its id is not this network\'s, without refusing', () => {
    setConfigValue('blockfrost-project-id', FROM_CONFIG, TEST_DIR);
    for (const other of ['nightmainnetAbCdEfGhIjKlMnOp', 'mainnetAbCdEfGhIjKlMnOpQrSt', 'not an id', '']) {
      expect(resolveBlockfrostProjectId('preprod', TEST_DIR, { BLOCKFROST_PROJECT_ID: other })).toBe(FROM_CONFIG);
    }
    expect(resolveBlockfrostProjectId('preprod', TEST_DIR + '-none', { BLOCKFROST_PROJECT_ID: 'mainnetAbCdEfGhIjKlMnOpQrSt' })).toBeUndefined();
  });

  it('refuses an environment value that is no project id', () => {
    expect(() => resolveBlockfrostProjectId('preprod', TEST_DIR, { MN_BLOCKFROST_PROJECT_ID: 'nightmainnetAbCdEfGhIjKl' }))
      .toThrow('it should start with "nightpreprod" (preprod)');
  });
});

describe('resolveNetwork on preprod', () => {
  let origEnv: string | undefined;
  let origShared: string | undefined;
  beforeEach(() => {
    origEnv = process.env.MN_BLOCKFROST_PROJECT_ID; delete process.env.MN_BLOCKFROST_PROJECT_ID;
    origShared = process.env.BLOCKFROST_PROJECT_ID; delete process.env.BLOCKFROST_PROJECT_ID;
  });
  afterEach(() => {
    if (origEnv !== undefined) process.env.MN_BLOCKFROST_PROJECT_ID = origEnv;
    if (origShared !== undefined) process.env.BLOCKFROST_PROJECT_ID = origShared;
  });

  it('gives Blockfrost\'s endpoints with the project id that is set', () => {
    setConfigValue('blockfrost-project-id', 'nightpreprodConfigConfigConfig0001', TEST_DIR);
    const { name, config } = resolveNetwork(makeCtx({ args: makeArgs(['--network', 'preprod']) }));
    expect(name).toBe('preprod');
    expect(config.indexerWS).toBe('wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=nightpreprodConfigConfigConfig0001');
    expect(config.node).toBe('wss://rpc.midnight-preprod.blockfrost.io?project_id=nightpreprodConfigConfigConfig0001');
  });

  it('resolves without one, so a command that never connects is not stopped', () => {
    const { config } = resolveNetwork(makeCtx({ args: makeArgs(['--network', 'preprod']) }));
    expect(config.indexer).toBe('https://midnight-preprod.blockfrost.io/api/v0');
  });
});

// mn contract and mn test resolve the network without reading endpoint flags
// themselves: they used the defaults whatever `config set` held, so a deploy
// went to another chain than the one every other command talked to.
describe('resolveNetwork: endpoints given by config or flag', () => {
  const MN_NO_DOCKER = 'undeployed';

  it('applies the endpoints saved for the network', () => {
    setConfigValue('network', MN_NO_DOCKER, TEST_DIR);
    setConfigValue('node', 'ws://localhost:39944', TEST_DIR);
    setConfigValue('indexer-ws', 'ws://localhost:38088/api/v4/graphql/ws', TEST_DIR);
    setConfigValue('proof-server', 'http://localhost:36300', TEST_DIR);
    const { config } = resolveNetwork(makeCtx());
    expect(config.node).toBe('ws://localhost:39944');
    expect(config.indexerWS).toBe('ws://localhost:38088/api/v4/graphql/ws');
    expect(config.indexer).toBe('http://localhost:38088/api/v4/graphql');
    expect(config.proofServer).toBe('http://localhost:36300');
  });

  it('lets a flag win over the saved endpoint', () => {
    setConfigValue('network', 'preview', TEST_DIR);
    setConfigValue('proof-server', 'http://saved:6300', TEST_DIR);
    const { config } = resolveNetwork(makeCtx({ args: makeArgs(['--proof-server', 'http://flag:6300']) }));
    expect(config.proofServer).toBe('http://flag:6300');
    expect(config.node).toBe('wss://rpc.preview.midnight.network');
  });

  it('keeps one network\'s saved endpoints away from another', () => {
    setConfigValue('network', 'preview', TEST_DIR);
    setConfigValue('proof-server', 'http://preview-prover:6300', TEST_DIR);
    const { config } = resolveNetwork(makeCtx({ args: makeArgs(['--network', 'preprod']) }));
    expect(config.proofServer).toBe('http://localhost:6300');
  });
});
