import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  findContractInfo,
  formatCompactType,
  formatCircuitSignature,
  formatCircuitFlags,
  formatWitnessSignature,
  toJsonOutput,
  type CompactType,
  type CircuitInfo,
  type WitnessInfo,
} from '../lib/contract/inspect.ts';

// ── Type Formatting ──

describe('formatCompactType', () => {
  it('formats Uint as bigint', () => {
    expect(formatCompactType({ 'type-name': 'Uint', maxval: 255 })).toBe('bigint');
  });

  it('formats Bytes as Uint8Array', () => {
    expect(formatCompactType({ 'type-name': 'Bytes', length: 32 })).toBe('Uint8Array');
  });

  it('formats Opaque with tsType', () => {
    expect(formatCompactType({ 'type-name': 'Opaque', tsType: 'string' })).toBe('string');
  });

  it('formats Opaque without tsType as unknown', () => {
    expect(formatCompactType({ 'type-name': 'Opaque' })).toBe('unknown');
  });

  it('formats empty Tuple as void', () => {
    expect(formatCompactType({ 'type-name': 'Tuple', types: [] })).toBe('void');
  });

  it('formats non-empty Tuple', () => {
    expect(formatCompactType({
      'type-name': 'Tuple',
      types: [{ 'type-name': 'Uint' }, { 'type-name': 'Bytes', length: 32 }],
    })).toBe('[bigint, Uint8Array]');
  });

  it('formats Boolean', () => {
    expect(formatCompactType({ 'type-name': 'Boolean' })).toBe('boolean');
  });

  it('formats Vector', () => {
    expect(formatCompactType({
      'type-name': 'Vector',
      types: [{ 'type-name': 'Uint' }],
    })).toBe('bigint[]');
  });

  it('formats Map', () => {
    expect(formatCompactType({
      'type-name': 'Map',
      types: [{ 'type-name': 'Bytes', length: 32 }, { 'type-name': 'Uint' }],
    })).toBe('Map<Uint8Array, bigint>');
  });

  it('formats Set', () => {
    expect(formatCompactType({
      'type-name': 'Set',
      types: [{ 'type-name': 'Bytes', length: 32 }],
    })).toBe('Set<Uint8Array>');
  });

  it('formats Option', () => {
    expect(formatCompactType({
      'type-name': 'Option',
      types: [{ 'type-name': 'Uint' }],
    })).toBe('bigint | null');
  });

  it('formats String', () => {
    expect(formatCompactType({ 'type-name': 'String' })).toBe('string');
  });

  it('formats unknown types by name', () => {
    expect(formatCompactType({ 'type-name': 'CustomThing' })).toBe('CustomThing');
  });
});

// ── Circuit Formatting ──

describe('formatCircuitSignature', () => {
  it('formats circuit with arguments', () => {
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
    expect(formatCircuitSignature(circuit)).toBe('submit_score(score: bigint, alias: string)');
  });

  it('formats circuit with no arguments', () => {
    const circuit: CircuitInfo = {
      name: 'reveal_score',
      pure: false,
      proof: true,
      arguments: [],
      'result-type': { 'type-name': 'Tuple', types: [] },
    };
    expect(formatCircuitSignature(circuit)).toBe('reveal_score()');
  });
});

describe('formatCircuitFlags', () => {
  it('formats pure circuit', () => {
    expect(formatCircuitFlags({ name: 'x', pure: true, proof: false, arguments: [], 'result-type': { 'type-name': 'Uint' } })).toBe('pure');
  });

  it('formats impure circuit with proof', () => {
    expect(formatCircuitFlags({ name: 'x', pure: false, proof: true, arguments: [], 'result-type': { 'type-name': 'Uint' } })).toBe('impure, proof');
  });

  it('formats impure circuit without proof', () => {
    expect(formatCircuitFlags({ name: 'x', pure: false, proof: false, arguments: [], 'result-type': { 'type-name': 'Uint' } })).toBe('impure');
  });
});

// ── Witness Formatting ──

describe('formatWitnessSignature', () => {
  it('formats witness with return type', () => {
    const witness: WitnessInfo = {
      name: 'localSecretKey',
      arguments: [],
      'result type': { 'type-name': 'Bytes', length: 32 },
    };
    expect(formatWitnessSignature(witness)).toBe('localSecretKey() → Uint8Array');
  });

  it('formats witness with args and void return', () => {
    const witness: WitnessInfo = {
      name: 'storeScore',
      arguments: [{ name: 'score', type: { 'type-name': 'Uint', maxval: 255 } }],
      'result type': { 'type-name': 'Tuple', types: [] },
    };
    expect(formatWitnessSignature(witness)).toBe('storeScore(score: bigint)');
  });
});

// ── Discovery ──

describe('findContractInfo', () => {
  const tmpBase = join(tmpdir(), 'mn-contract-test-' + Date.now());

  function createContractInfo(dir: string, name: string, circuits: unknown[] = [], witnesses: unknown[] = []): void {
    const managedDir = join(dir, 'managed', name, 'compiler');
    mkdirSync(managedDir, { recursive: true });
    writeFileSync(join(managedDir, 'contract-info.json'), JSON.stringify({
      'compiler-version': '0.30.0',
      'language-version': '0.22.0',
      'runtime-version': '0.15.0',
      circuits,
      witnesses,
    }));
  }

  it('discovers contract in managed/ subdirectory', () => {
    const dir = join(tmpBase, 'test1');
    createContractInfo(dir, 'mycontract');
    const { info } = findContractInfo(dir);
    expect(info.name).toBe('mycontract');
    expect(info.compilerVersion).toBe('0.30.0');
    expect(info.siblings).toEqual([]);
  });

  it('discovers contract in contract/src/managed/', () => {
    const dir = join(tmpBase, 'test2');
    createContractInfo(join(dir, 'contract', 'src'), 'deepcontract');
    const { info } = findContractInfo(dir);
    expect(info.name).toBe('deepcontract');
  });

  it('discovers contract in contracts/ (plural) — create-mn-app layout', () => {
    const dir = join(tmpBase, 'test-plural');
    createContractInfo(join(dir, 'contracts'), 'helloworld');
    const { info } = findContractInfo(dir);
    expect(info.name).toBe('helloworld');
  });

  it('discovers contract in contracts/src/managed/', () => {
    const dir = join(tmpBase, 'test-plural-src');
    createContractInfo(join(dir, 'contracts', 'src'), 'pluralsrc');
    const { info } = findContractInfo(dir);
    expect(info.name).toBe('pluralsrc');
  });

  it('discovers contract via --managed (compiler/ parent)', () => {
    const dir = join(tmpBase, 'test3');
    createContractInfo(dir, 'direct');
    const { info } = findContractInfo(join(dir, 'managed', 'direct'));
    expect(info.name).toBe('direct');
  });

  it('returns first contract alphabetically and lists siblings when project has multiple', () => {
    const dir = join(tmpBase, 'test-multi');
    createContractInfo(dir, 'zeta');
    createContractInfo(dir, 'alpha');
    createContractInfo(dir, 'beta');
    const { info } = findContractInfo(dir);
    expect(info.name).toBe('alpha');
    expect(info.siblings).toEqual(['beta', 'zeta']);
  });

  it('selects a specific contract by name when provided', () => {
    const dir = join(tmpBase, 'test-multi-named');
    createContractInfo(dir, 'access-control');
    createContractInfo(dir, 'counter');
    createContractInfo(dir, 'discovery-core');
    const { info } = findContractInfo(dir, 'counter');
    expect(info.name).toBe('counter');
    expect(info.siblings).toEqual(['access-control', 'discovery-core']);
  });

  it('errors with available list when named contract is not present', () => {
    const dir = join(tmpBase, 'test-bad-name');
    createContractInfo(dir, 'foo');
    createContractInfo(dir, 'bar');
    expect(() => findContractInfo(dir, 'baz')).toThrow(/Contract "baz" not found.*Available: bar, foo/s);
  });

  it('parses pre-0.30 contract-info.json without compiler-version', () => {
    const dir = join(tmpBase, 'test-old-format');
    const managedDir = join(dir, 'managed', 'oldcontract', 'compiler');
    mkdirSync(managedDir, { recursive: true });
    // Older Compact emitted contract-info.json without the version trio.
    writeFileSync(join(managedDir, 'contract-info.json'), JSON.stringify({
      circuits: [{ name: 'tick', pure: true, proof: false, arguments: [], 'result-type': { 'type-name': 'Uint' } }],
      witnesses: [],
    }));
    const { info } = findContractInfo(dir);
    expect(info.name).toBe('oldcontract');
    expect(info.compilerVersion).toBe('unknown');
    expect(info.languageVersion).toBe('unknown');
    expect(info.runtimeVersion).toBe('unknown');
    expect(info.circuits).toHaveLength(1);
  });

  it('throws when no contract found', () => {
    const dir = join(tmpBase, 'empty');
    mkdirSync(dir, { recursive: true });
    expect(() => findContractInfo(dir)).toThrow('No compiled contract found');
  });

  it('parses circuits and witnesses', () => {
    const dir = join(tmpBase, 'test4');
    createContractInfo(dir, 'withcircuits', [
      { name: 'foo', pure: true, proof: false, arguments: [], 'result-type': { 'type-name': 'Uint' } },
    ], [
      { name: 'bar', arguments: [], 'result type': { 'type-name': 'Bytes', length: 32 } },
    ]);
    const { info } = findContractInfo(dir);
    expect(info.circuits).toHaveLength(1);
    expect(info.circuits[0].name).toBe('foo');
    expect(info.witnesses).toHaveLength(1);
    expect(info.witnesses[0].name).toBe('bar');
  });

  // Cleanup
  afterAll(() => {
    try { rmSync(tmpBase, { recursive: true }); } catch {}
  });
});

// ── JSON Output ──

describe('toJsonOutput', () => {
  it('formats contract info as JSON-friendly object', () => {
    const json = toJsonOutput({
      name: 'test',
      managedDir: '/tmp/test',
      compilerVersion: '1.0.0',
      languageVersion: '1.0.0',
      runtimeVersion: '1.0.0',
      siblings: [],
      circuits: [{
        name: 'call_me',
        pure: false,
        proof: true,
        arguments: [{ name: 'x', type: { 'type-name': 'Uint', maxval: 255 } }],
        'result-type': { 'type-name': 'Tuple', types: [] },
      }],
      witnesses: [{
        name: 'get_key',
        arguments: [],
        'result type': { 'type-name': 'Bytes', length: 32 },
      }],
    });

    expect(json.name).toBe('test');
    expect((json.circuits as any[])[0].arguments[0].type).toBe('bigint');
    expect((json.circuits as any[])[0].returnType).toBe('void');
    expect((json.witnesses as any[])[0].returnType).toBe('Uint8Array');
  });
});
