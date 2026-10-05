// Contract request checks made from the compiled contract alone, before any
// wallet or network work. The contract below has the shape of a compiled
// counter (one circuit, no arguments) plus a circuit that takes arguments.

import { describe, expect, it } from 'vitest';
import { validateCallRequest, validateContractAddress } from '../lib/contract/validate.ts';
import { UsageError } from '../lib/errors.ts';
import type { ContractInfo } from '../lib/contract/inspect.ts';

const UINT = { 'type-name': 'Uint', maxval: 255 } as never;
const COUNTER: ContractInfo = {
  name: 'counter', managedDir: '/m', compilerVersion: '0.35.0', languageVersion: '0.27.0', runtimeVersion: '0.20.0',
  circuits: [
    { name: 'increment', pure: false, proof: true, arguments: [], 'result-type': { 'type-name': 'Tuple', types: [] } as never },
    { name: 'add', pure: false, proof: true, arguments: [{ name: 'x', type: UINT }, { name: 'y', type: UINT }], 'result-type': UINT },
  ],
  witnesses: [], siblings: [],
} as ContractInfo;

describe('validateCallRequest', () => {
  it('names the circuits there are when the circuit is unknown', () => {
    expect(() => validateCallRequest(COUNTER, 'no_such_circuit', [])).toThrow(UsageError);
    expect(() => validateCallRequest(COUNTER, 'no_such_circuit', [])).toThrow('counter has no circuit "no_such_circuit". Its circuits: increment, add.');
  });

  it('says how many arguments a circuit takes, counting only the caller\'s', () => {
    expect(() => validateCallRequest(COUNTER, 'increment', [1, 2, 3])).toThrow('increment takes 0 arguments; --args gave 3.');
    expect(() => validateCallRequest(COUNTER, 'add', [1])).toThrow('add takes 2 arguments (x, y); --args gave 1.');
  });

  it('accepts a known circuit with the right number of arguments', () => {
    expect(() => validateCallRequest(COUNTER, 'increment', [])).not.toThrow();
    expect(() => validateCallRequest(COUNTER, 'add', [1, 2])).not.toThrow();
  });
});

describe('validateContractAddress', () => {
  it('accepts 64 hex characters, as a deployed address on a ledger-9 chain', () => {
    expect(() => validateContractAddress('cb5230e1ac98e07520d3b330016743a05fec38dd8fe894ae5b9ac3f71cac5190')).not.toThrow();
  });

  it.each(['deadbeef', '', 'zz'.repeat(32), 'ab'.repeat(33)])('refuses %j, saying what an address is', (address) => {
    expect(() => validateContractAddress(address)).toThrow(UsageError);
    expect(() => validateContractAddress(address)).toThrow('A contract address is 64 hex characters (32 bytes)');
  });
});
