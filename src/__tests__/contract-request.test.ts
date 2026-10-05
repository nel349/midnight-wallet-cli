// A deploy or call is read from its arguments and the compiled contract on
// disk (contract-info.json, witnesses.js), with no wallet and no network.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveContractCallRequest, resolveContractDeployRequest } from '../lib/contract/request.ts';
import { parseArgs } from '../lib/argv.ts';
import { UsageError } from '../lib/errors.ts';

const UINT = { 'type-name': 'Uint', maxval: 255 };
const ADDRESS = 'cb5230e1ac98e07520d3b330016743a05fec38dd8fe894ae5b9ac3f71cac5190';
let dir: string;

/** A compiled contract as compactc lays it out: managed/<name>/compiler/contract-info.json. */
function compiledContract(name: string, witnesses: { name: string }[] = []): void {
  const compiler = join(dir, 'managed', name, 'compiler');
  mkdirSync(compiler, { recursive: true });
  writeFileSync(join(compiler, 'contract-info.json'), JSON.stringify({
    'compiler-version': '0.35.0', 'language-version': '0.27.0', 'runtime-version': '0.20.0',
    circuits: [
      { name: 'increment', pure: false, proof: true, arguments: [], 'result-type': { 'type-name': 'Tuple', types: [] } },
      { name: 'add', pure: false, proof: true, arguments: [{ name: 'x', type: UINT }, { name: 'y', type: UINT }], 'result-type': UINT },
    ],
    witnesses: witnesses.map((w) => ({ ...w, arguments: [], 'result-type': UINT })),
  }));
}

const call = (...flags: string[]) => resolveContractCallRequest(parseArgs(['contract', 'call', '--path', dir, ...flags]));
const deploy = (...flags: string[]) => resolveContractDeployRequest(parseArgs(['contract', 'deploy', '--path', dir, ...flags]));

beforeEach(() => {
  dir = join(tmpdir(), `mn-contract-request-${process.pid}-${Date.now()}`);
  compiledContract('counter');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('resolveContractCallRequest', () => {
  it('reads the address, circuit and arguments; an object\'s values are the arguments in order', () => {
    expect(call('--address', ADDRESS, '--circuit', 'add', '--args', '{"x":1,"y":2}'))
      .toMatchObject({ dappDir: dir, address: ADDRESS, circuit: 'add', callArgs: [1, 2], info: { name: 'counter' } });
    expect(call('--address', ADDRESS, '--circuit', 'increment').callArgs).toEqual([]);
  });

  it.each([
    [['--circuit', 'increment'], 'contract address'],
    [['--address', ADDRESS], 'circuit name'],
    [['--address', 'deadbeef', '--circuit', 'increment'], 'A contract address is 64 hex characters'],
    [['--address', ADDRESS, '--circuit', 'decrement'], 'counter has no circuit "decrement"'],
    [['--address', ADDRESS, '--circuit', 'add', '--args', '[1]'], 'add takes 2 arguments (x, y); --args gave 1.'],
    [['--address', ADDRESS, '--circuit', 'add', '--args', '[1,'], 'Invalid --args JSON'],
    [['--address', ADDRESS, '--circuit', 'add', '--args', '"12"'], 'Invalid --args JSON: expected an array or an object, got "12"'],
  ])('refuses %j', (flags, message) => {
    expect(() => call(...flags)).toThrow(message);
  });

  it('refuses a call where there is no compiled contract', () => {
    rmSync(join(dir, 'managed'), { recursive: true });
    expect(() => call('--address', ADDRESS, '--circuit', 'increment')).toThrow(`No compiled contract found in ${dir}`);
  });
});

describe('resolveContractDeployRequest', () => {
  it('reads the constructor arguments and the private-state key', () => {
    const key = 'ab'.repeat(32);
    expect(deploy('--args', '[7]', '--secret-key', key))
      .toMatchObject({ dappDir: dir, constructorArgs: [7], privateStateSecretKey: key, info: { name: 'counter' } });
  });

  it('refuses a secret key that is not 32 bytes of hex', () => {
    expect(() => deploy('--secret-key', 'abc')).toThrow(UsageError);
    expect(() => deploy('--secret-key', 'abc')).toThrow('--secret-key must be 32 bytes of hex (64 chars)');
  });

  it('refuses a contract that declares witnesses with no compiled witnesses.js, naming them', () => {
    rmSync(join(dir, 'managed'), { recursive: true });
    compiledContract('owned', [{ name: 'secret_key' }]);
    expect(() => deploy()).toThrow('secret_key');

    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'witnesses.js'), 'export const witnesses = {};\n');
    expect(deploy().info.name).toBe('owned');
  });
});
