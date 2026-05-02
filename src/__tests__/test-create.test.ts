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
    const ids = out.actions.actions.map((a) => a.id);
    expect(ids).toEqual(['deploy', 'check-initial', 'call-submit_score', 'call-reveal', 'check-final']);
  });

  it('skips pure circuits in the action sequence', () => {
    const out = buildScaffold(circuits, { contractName: 'x' });
    const calls = out.actions.actions.filter((a) => a.type === 'contract-call').map((a) => a.circuit);
    expect(calls).not.toContain('pure_helper');
  });

  it('includes args object only for circuits that take parameters', () => {
    const out = buildScaffold(circuits, { contractName: 'x' });
    const submit = out.actions.actions.find((a) => a.circuit === 'submit_score');
    const reveal = out.actions.actions.find((a) => a.circuit === 'reveal');
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

    expect(result.written.map((p) => p.replace(dir + '/', ''))).toEqual([
      'dapp.test.json',
      'tests/suites/cli-default/suite.json',
      'tests/suites/cli-default/actions.json',
      'tests/suites/cli-default/assertions.json',
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

  it('refuses to overwrite an existing file without --force', () => {
    const dir = freshDir('existing');
    writeFileSync(join(dir, 'dapp.test.json'), '{"existing":true}');
    expect(() => writeScaffold(basicScaffold(), { dappDir: dir })).toThrow(/Refusing to overwrite/);
    // The existing file is left untouched
    expect(JSON.parse(readFileSync(join(dir, 'dapp.test.json'), 'utf-8'))).toEqual({ existing: true });
    // No partial scaffold leaked into the suite dir
    expect(existsSync(join(dir, 'tests', 'suites', 'cli-default'))).toBe(false);
  });

  it('overwrites existing files when --force is set', () => {
    const dir = freshDir('forced');
    writeFileSync(join(dir, 'dapp.test.json'), '{"existing":true}');
    writeScaffold(basicScaffold(), { dappDir: dir, force: true });
    expect(JSON.parse(readFileSync(join(dir, 'dapp.test.json'), 'utf-8')).name).toBe('demo');
  });
});
