import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { discoverDappConfig, discoverTestSuites, loadAssertions, loadPrompt } from '../lib/test/discovery.ts';

// Create a unique temp dir per test run
function makeTempDir(): string {
  const dir = join(tmpdir(), `mn-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('discoverDappConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('throws when no dapp.test.json exists', () => {
    expect(() => discoverDappConfig(tempDir)).toThrow('No dapp.test.json found');
  });

  it('throws on invalid JSON', () => {
    writeFileSync(join(tempDir, 'dapp.test.json'), 'not json');
    expect(() => discoverDappConfig(tempDir)).toThrow('Failed to parse');
  });

  it('throws when name is missing', () => {
    writeFileSync(join(tempDir, 'dapp.test.json'), JSON.stringify({ prep: [] }));
    expect(() => discoverDappConfig(tempDir)).toThrow('"name" is required');
  });

  it('throws when prep is missing', () => {
    writeFileSync(join(tempDir, 'dapp.test.json'), JSON.stringify({ name: 'test' }));
    expect(() => discoverDappConfig(tempDir)).toThrow('"prep" is required');
  });

  it('throws on invalid network', () => {
    writeFileSync(join(tempDir, 'dapp.test.json'), JSON.stringify({
      name: 'test', network: 'mainnet', prep: [],
    }));
    expect(() => discoverDappConfig(tempDir)).toThrow('"network" must be one of');
  });

  it('throws on invalid port', () => {
    writeFileSync(join(tempDir, 'dapp.test.json'), JSON.stringify({
      name: 'test', port: 99999, prep: [],
    }));
    expect(() => discoverDappConfig(tempDir)).toThrow('"port" must be a number between 1 and 65535');
  });

  it('throws on invalid prep step', () => {
    writeFileSync(join(tempDir, 'dapp.test.json'), JSON.stringify({
      name: 'test', prep: ['invalid-step'],
    }));
    expect(() => discoverDappConfig(tempDir)).toThrow('invalid prep step "invalid-step"');
  });

  it('parses a valid minimal config', () => {
    writeFileSync(join(tempDir, 'dapp.test.json'), JSON.stringify({
      name: 'starship', prep: ['localnet-up', 'balance:1000'],
    }));

    const { config, dappDir } = discoverDappConfig(tempDir);
    expect(config.name).toBe('starship');
    expect(config.network).toBe('undeployed'); // default
    expect(config.prep).toEqual(['localnet-up', 'balance:1000']);
    expect(dappDir).toBe(tempDir);
  });

  it('parses a full config with all fields', () => {
    writeFileSync(join(tempDir, 'dapp.test.json'), JSON.stringify({
      name: 'starship',
      network: 'preprod',
      port: 4173,
      buildCmd: 'npm run build',
      buildDir: 'game-ui',
      url: 'http://localhost:4173/',
      contractEntry: 'contract/src/index.ts',
      prep: ['cache-clear', 'localnet-up', 'balance:500', 'dust-register', 'dust-wait', 'mn-serve', 'build-and-serve'],
    }));

    const { config } = discoverDappConfig(tempDir);
    expect(config.name).toBe('starship');
    expect(config.network).toBe('preprod');
    expect(config.port).toBe(4173);
    expect(config.buildCmd).toBe('npm run build');
    expect(config.buildDir).toBe('game-ui');
    expect(config.url).toBe('http://localhost:4173/');
    expect(config.contractEntry).toBe('contract/src/index.ts');
    expect(config.prep).toHaveLength(7);
  });
});

describe('discoverTestSuites', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty array when tests/suites/ does not exist', () => {
    const suites = discoverTestSuites(tempDir);
    expect(suites).toEqual([]);
  });

  it('returns empty array when suites dir has no suite.json files', () => {
    mkdirSync(join(tempDir, 'tests', 'suites', 'empty'), { recursive: true });
    const suites = discoverTestSuites(tempDir);
    expect(suites).toEqual([]);
  });

  it('discovers a valid suite', () => {
    const suiteDir = join(tempDir, 'tests', 'suites', 'e2e');
    mkdirSync(suiteDir, { recursive: true });
    writeFileSync(join(suiteDir, 'suite.json'), JSON.stringify({
      name: 'e2e',
      description: 'End-to-end test',
      strategy: 'browser',
      timeout: 600,
    }));

    const suites = discoverTestSuites(tempDir);
    expect(suites).toHaveLength(1);
    expect(suites[0].suite.name).toBe('e2e');
    expect(suites[0].suite.strategy).toBe('browser');
    expect(suites[0].suite.timeout).toBe(600);
  });

  it('throws on invalid strategy', () => {
    const suiteDir = join(tempDir, 'tests', 'suites', 'bad');
    mkdirSync(suiteDir, { recursive: true });
    writeFileSync(join(suiteDir, 'suite.json'), JSON.stringify({
      name: 'bad', description: 'test', strategy: 'invalid',
    }));

    expect(() => discoverTestSuites(tempDir)).toThrow('"strategy" must be one of');
  });

  it('discovers multiple suites', () => {
    for (const name of ['e2e', 'contract-deploy', 'privacy']) {
      const suiteDir = join(tempDir, 'tests', 'suites', name);
      mkdirSync(suiteDir, { recursive: true });
      writeFileSync(join(suiteDir, 'suite.json'), JSON.stringify({
        name, description: `${name} test`, strategy: 'browser',
      }));
    }

    const suites = discoverTestSuites(tempDir);
    expect(suites).toHaveLength(3);
  });
});

describe('loadAssertions', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns null when assertions.json does not exist', () => {
    expect(loadAssertions(tempDir)).toBeNull();
  });

  it('throws on missing post array', () => {
    writeFileSync(join(tempDir, 'assertions.json'), JSON.stringify({}));
    expect(() => loadAssertions(tempDir)).toThrow('"post" is required');
  });

  it('throws when check is missing id', () => {
    writeFileSync(join(tempDir, 'assertions.json'), JSON.stringify({
      post: [{ type: 'balance-changed', expect: 'pass' }],
    }));
    expect(() => loadAssertions(tempDir)).toThrow('must have a string "id"');
  });

  it('parses valid assertions', () => {
    writeFileSync(join(tempDir, 'assertions.json'), JSON.stringify({
      post: [
        { id: 'balance', type: 'balance-changed', params: { direction: 'decreased' }, expect: 'pass' },
        { id: 'exit', type: 'process-exit-code', params: { code: 0 }, expect: 'pass' },
      ],
    }));

    const assertions = loadAssertions(tempDir);
    expect(assertions).not.toBeNull();
    expect(assertions!.post).toHaveLength(2);
    expect(assertions!.post[0].id).toBe('balance');
  });
});

describe('loadPrompt', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns null when prompt.md does not exist', () => {
    expect(loadPrompt(tempDir)).toBeNull();
  });

  it('reads prompt content', () => {
    writeFileSync(join(tempDir, 'prompt.md'), 'Open the game and play');
    expect(loadPrompt(tempDir)).toBe('Open the game and play');
  });
});
