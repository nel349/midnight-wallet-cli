import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { placeholderArg, placeholderArgsFor, buildScaffold } from '../lib/test/create.ts';
import { writeScaffold } from '../lib/test/create-writer.ts';
import type { CircuitInfo, CompactType } from '../lib/contract/inspect.ts';

const tmpBase = join(tmpdir(), 'mn-test-create-' + Date.now());

afterAll(() => {
  try { rmSync(tmpBase, { recursive: true }); } catch {}
});

// ── placeholderArg ──

describe('placeholderArg', () => {
  const cases: [CompactType, unknown][] = [
    [{ 'type-name': 'Uint', maxval: 255 }, 0],
    [{ 'type-name': 'Boolean' }, false],
    [{ 'type-name': 'String' }, 'test'],
    [{ 'type-name': 'Opaque', tsType: 'string' }, 'test'],
    [{ 'type-name': 'Opaque', tsType: 'CustomThing' }, null],
    [{ 'type-name': 'Vector', types: [{ 'type-name': 'Uint' }] }, []],
    [{ 'type-name': 'Map', types: [{ 'type-name': 'Bytes', length: 32 }, { 'type-name': 'Uint' }] }, {}],
    [{ 'type-name': 'Set', types: [{ 'type-name': 'Uint' }] }, []],
    [{ 'type-name': 'Option', types: [{ 'type-name': 'Uint' }] }, null],
  ];
  for (const [type, expected] of cases) {
    it(`returns ${JSON.stringify(expected)} for ${type['type-name']}`, () => {
      expect(placeholderArg(type)).toEqual(expected);
    });
  }

  it('returns a zero-filled array of the declared length for Bytes', () => {
    const out = placeholderArg({ 'type-name': 'Bytes', length: 32 }) as number[];
    expect(out).toHaveLength(32);
    expect(out.every((b) => b === 0)).toBe(true);
  });

  it('defaults Bytes to 32 bytes when length is missing', () => {
    expect((placeholderArg({ 'type-name': 'Bytes' }) as number[])).toHaveLength(32);
  });

  it('recurses into Tuple element types', () => {
    const out = placeholderArg({
      'type-name': 'Tuple',
      types: [{ 'type-name': 'Uint' }, { 'type-name': 'String' }],
    });
    expect(out).toEqual([0, 'test']);
  });
});

describe('placeholderArgsFor', () => {
  it('builds an arg map matching the circuit signature', () => {
    const circuit: CircuitInfo = {
      name: 'submit_score',
      pure: false,
      proof: true,
      arguments: [
        { name: 'score', type: { 'type-name': 'Uint', maxval: 255 } },
        { name: 'alias', type: { 'type-name': 'Opaque', tsType: 'string' } },
      ],
      'result-type': { 'type-name': 'Tuple', types: [] },
    };
    expect(placeholderArgsFor(circuit)).toEqual({ score: 0, alias: 'test' });
  });

  it('returns an empty object when the circuit takes no args', () => {
    const circuit: CircuitInfo = {
      name: 'reveal',
      pure: false,
      proof: true,
      arguments: [],
      'result-type': { 'type-name': 'Tuple', types: [] },
    };
    expect(placeholderArgsFor(circuit)).toEqual({});
  });
});

// ── buildScaffold ──

describe('buildScaffold', () => {
  const circuits: CircuitInfo[] = [
    {
      name: 'submit_score',
      pure: false,
      proof: true,
      arguments: [{ name: 'score', type: { 'type-name': 'Uint' } }],
      'result-type': { 'type-name': 'Tuple', types: [] },
    },
    {
      name: 'reveal',
      pure: false,
      proof: true,
      arguments: [],
      'result-type': { 'type-name': 'Tuple', types: [] },
    },
    {
      name: 'pure_helper',
      pure: true,
      proof: false,
      arguments: [{ name: 'x', type: { 'type-name': 'Uint' } }],
      'result-type': { 'type-name': 'Uint' },
    },
  ];

  it('uses contract name in dapp config', () => {
    const out = buildScaffold(circuits, { contractName: 'starship' });
    expect(out.dappConfig.name).toBe('starship');
  });

  it('defaults to undeployed network and the standard CLI prep chain', () => {
    const out = buildScaffold(circuits, { contractName: 'starship' });
    expect(out.dappConfig.network).toBe('undeployed');
    expect(out.dappConfig.prep).toEqual(['cache-clear', 'localnet-up', 'balance:1000', 'dust', 'mn-serve']);
  });

  it('honors network and suite-name overrides', () => {
    const out = buildScaffold(circuits, { contractName: 'x', network: 'preprod', suiteName: 'smoke' });
    expect(out.dappConfig.network).toBe('preprod');
    expect(out.suiteName).toBe('smoke');
    expect(out.suite.name).toBe('smoke');
  });

  it('emits cli-strategy suite with sensible defaults', () => {
    const out = buildScaffold(circuits, { contractName: 'x' });
    expect(out.suite.strategy).toBe('cli');
    expect(out.suite.timeout).toBe(300);
  });

  it('action sequence: deploy, state, one call per impure circuit, final state', () => {
    const out = buildScaffold(circuits, { contractName: 'x' });
    const ids = out.actions!.actions.map((a) => a.id);
    expect(ids).toEqual(['deploy', 'check-initial', 'call-submit_score', 'call-reveal', 'check-final']);
  });

  it('skips pure circuits in the action sequence', () => {
    const out = buildScaffold(circuits, { contractName: 'x' });
    const calls = out.actions!.actions.filter((a) => a.type === 'contract-call').map((a) => a.circuit);
    expect(calls).not.toContain('pure_helper');
  });

  it('includes args object only for circuits that take parameters', () => {
    const out = buildScaffold(circuits, { contractName: 'x' });
    const submit = out.actions!.actions.find((a) => a.circuit === 'submit_score');
    const reveal = out.actions!.actions.find((a) => a.circuit === 'reveal');
    expect(submit?.args).toEqual({ score: 0 });
    expect(reveal?.args).toBeUndefined();
  });

  it('attaches a port-listening assertion targeting the serve port', () => {
    const out = buildScaffold(circuits, { contractName: 'x', servePort: 4242 });
    expect(out.assertions.post[0]).toMatchObject({
      type: 'port-listening',
      params: { port: 4242 },
      expect: 'pass',
    });
  });

  it('cli scaffold has actions and no prompt', () => {
    const out = buildScaffold(circuits, { contractName: 'x' });
    expect(out.actions).not.toBeNull();
    expect(out.prompt).toBeNull();
  });
});

describe('buildScaffold (browser strategy)', () => {
  const noCircuits: CircuitInfo[] = [];

  it('throws when browser options are missing', () => {
    expect(() => buildScaffold(noCircuits, { contractName: 'x', strategy: 'browser' }))
      .toThrow(/browser options/i);
  });

  it('emits prompt.md and no actions.json', () => {
    const out = buildScaffold(noCircuits, {
      contractName: 'starship',
      strategy: 'browser',
      browser: { port: 4173, buildCmd: 'npm run dev' },
    });
    expect(out.prompt).toBeTruthy();
    expect(out.prompt).toContain('starship');
    expect(out.prompt).toContain('http://localhost:4173/');
    expect(out.actions).toBeNull();
  });

  it('defaults the suite name to ui-default and timeout to 600', () => {
    const out = buildScaffold(noCircuits, {
      contractName: 'x',
      strategy: 'browser',
      browser: { port: 4173, buildCmd: 'npm run dev' },
    });
    expect(out.suiteName).toBe('ui-default');
    expect(out.suite.timeout).toBe(600);
    expect(out.suite.strategy).toBe('browser');
  });

  it('appends build-and-serve to prep and propagates UI fields to dapp config', () => {
    const out = buildScaffold(noCircuits, {
      contractName: 'x',
      strategy: 'browser',
      browser: { port: 3000, buildCmd: 'pnpm dev', buildDir: 'web', url: 'http://example.test:3000/' },
    });
    expect(out.dappConfig.prep).toEqual([
      'cache-clear', 'localnet-up', 'balance:1000', 'dust', 'mn-serve', 'build-and-serve',
    ]);
    expect(out.dappConfig.port).toBe(3000);
    expect(out.dappConfig.buildCmd).toBe('pnpm dev');
    expect(out.dappConfig.buildDir).toBe('web');
    expect(out.dappConfig.url).toBe('http://example.test:3000/');
  });

  it('omits buildDir from dapp config when not given', () => {
    const out = buildScaffold(noCircuits, {
      contractName: 'x',
      strategy: 'browser',
      browser: { port: 4173, buildCmd: 'npm run dev' },
    });
    expect(out.dappConfig.buildDir).toBeUndefined();
  });

  it('defaults url to http://localhost:<port>/ when not given', () => {
    const out = buildScaffold(noCircuits, {
      contractName: 'x',
      strategy: 'browser',
      browser: { port: 5173, buildCmd: 'npm run dev' },
    });
    expect(out.dappConfig.url).toBe('http://localhost:5173/');
  });

  it('includes both claude-exit-ok and serve-port-listening assertions', () => {
    const out = buildScaffold(noCircuits, {
      contractName: 'x',
      strategy: 'browser',
      browser: { port: 4173, buildCmd: 'npm run dev' },
    });
    const ids = out.assertions.post.map((a) => a.id);
    expect(ids).toContain('claude-exit-ok');
    expect(ids).toContain('serve-port-listening');
  });
});

// ── writeScaffold ──

describe('writeScaffold', () => {
  function freshDir(label: string): string {
    const dir = join(tmpBase, label + '-' + Math.random().toString(36).slice(2, 8));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function basicScaffold(suiteName = 'cli-default') {
    return buildScaffold([
      {
        name: 'tick',
        pure: false,
        proof: true,
        arguments: [],
        'result-type': { 'type-name': 'Tuple', types: [] },
      },
    ], { contractName: 'demo', suiteName });
  }

  it('creates all four files in the expected layout', () => {
    const dir = freshDir('basic');
    const result = writeScaffold(basicScaffold(), { dappDir: dir });

    const rel = result.written.map((p) => p.replace(dir + '/', '')).sort();
    expect(rel).toEqual([
      'dapp.test.json',
      'tests/suites/cli-default/actions.json',
      'tests/suites/cli-default/assertions.json',
      'tests/suites/cli-default/suite.json',
    ]);

    for (const path of result.written) {
      expect(existsSync(path)).toBe(true);
      // Each file is valid JSON
      expect(() => JSON.parse(readFileSync(path, 'utf-8'))).not.toThrow();
    }
  });

  it('uses the configured suite name in the suite directory path', () => {
    const dir = freshDir('named');
    writeScaffold(basicScaffold('smoke'), { dappDir: dir });
    expect(existsSync(join(dir, 'tests', 'suites', 'smoke', 'suite.json'))).toBe(true);
  });

  it('preserves an existing dapp.test.json with the same contract name (additive — adding a new suite)', () => {
    const dir = freshDir('additive');
    const userConfig = { name: 'demo', network: 'preprod', prep: ['cache-clear', 'localnet-up'], buildCmd: 'custom' };
    writeFileSync(join(dir, 'dapp.test.json'), JSON.stringify(userConfig));

    const result = writeScaffold(basicScaffold(), { dappDir: dir });

    // dapp.test.json untouched — user's customization preserved
    expect(JSON.parse(readFileSync(join(dir, 'dapp.test.json'), 'utf-8'))).toEqual(userConfig);
    expect(result.preserved).toContain(join(dir, 'dapp.test.json'));
    expect(result.written).not.toContain(join(dir, 'dapp.test.json'));

    // Suite files still written
    expect(existsSync(join(dir, 'tests', 'suites', 'cli-default', 'suite.json'))).toBe(true);
  });

  it('rejects an existing dapp.test.json for a different contract', () => {
    const dir = freshDir('different');
    writeFileSync(join(dir, 'dapp.test.json'), JSON.stringify({ name: 'someotherproject', network: 'undeployed', prep: [] }));
    expect(() => writeScaffold(basicScaffold(), { dappDir: dir }))
      .toThrow(/exists with name "someotherproject" but this scaffold targets "demo"/);
  });

  it('rejects an existing dapp.test.json that is not valid JSON, including the parse cause', () => {
    const dir = freshDir('corrupt');
    writeFileSync(join(dir, 'dapp.test.json'), 'this is not json');
    expect(() => writeScaffold(basicScaffold(), { dappDir: dir }))
      .toThrow(/not valid JSON:.*Unexpected/s);
  });

  it('refuses to overwrite an existing suite dir without --force, suggests --suite', () => {
    const dir = freshDir('suite-clash');
    // First write succeeds and creates the suite dir
    writeScaffold(basicScaffold(), { dappDir: dir });
    // Second write to the same suite name fails with a pointed message.
    // The `s` flag lets `.` match the newline between the two phrases.
    expect(() => writeScaffold(basicScaffold(), { dappDir: dir }))
      .toThrow(/already exists.*Pick a different suite name \(--suite/s);
  });

  it('overwrites suite dir when --force is set', () => {
    const dir = freshDir('forced-suite');
    writeScaffold(basicScaffold(), { dappDir: dir });
    expect(() => writeScaffold(basicScaffold(), { dappDir: dir, force: true })).not.toThrow();
  });

  it('overwrites a different-named dapp.test.json when --force is set', () => {
    const dir = freshDir('forced-dapp');
    writeFileSync(join(dir, 'dapp.test.json'), JSON.stringify({ name: 'someotherproject' }));
    writeScaffold(basicScaffold(), { dappDir: dir, force: true });
    expect(JSON.parse(readFileSync(join(dir, 'dapp.test.json'), 'utf-8')).name).toBe('demo');
  });

  it('writes prompt.md instead of actions.json for browser scaffolds', () => {
    const dir = freshDir('browser');
    const browserScaffold = buildScaffold([], {
      contractName: 'demo',
      strategy: 'browser',
      browser: { port: 4173, buildCmd: 'npm run dev' },
    });
    const result = writeScaffold(browserScaffold, { dappDir: dir });
    const rel = result.written.map((p) => p.replace(dir + '/', ''));
    expect(rel).toContain('tests/suites/ui-default/prompt.md');
    expect(rel).toContain('tests/suites/ui-default/suite.json');
    expect(rel).toContain('tests/suites/ui-default/assertions.json');
    expect(rel).not.toContain('tests/suites/ui-default/actions.json');
    expect(existsSync(join(dir, 'tests', 'suites', 'ui-default', 'actions.json'))).toBe(false);
    // prompt.md is plain markdown, not JSON
    const promptBody = readFileSync(join(dir, 'tests', 'suites', 'ui-default', 'prompt.md'), 'utf-8');
    expect(promptBody).toContain('demo');
  });
});
