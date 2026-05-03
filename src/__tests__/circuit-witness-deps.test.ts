import { describe, it, expect } from 'vitest';
import { analyzeWitnessDependencies } from '../lib/test/circuit-witness-deps.ts';

describe('analyzeWitnessDependencies', () => {
  it('returns empty when no witnesses are declared', () => {
    const source = `
      circuit deploy(): [] { return []; }
      circuit doStuff(amount: Uint<64>): [] { ledger.x = amount; return []; }
    `;
    const out = analyzeWitnessDependencies(source, []);
    expect(out.byCircuit.size).toBe(0);
  });

  it('returns empty when no circuits use any witness', () => {
    const source = `
      circuit register(pk: Bytes<32>): [] { ledger.providers = pk; return []; }
      circuit reset(): [] { ledger.x = 0; return []; }
    `;
    const out = analyzeWitnessDependencies(source, ['getSecret']);
    expect(out.byCircuit.size).toBe(0);
  });

  it('detects a direct witness call inside a circuit', () => {
    const source = `
      circuit requestLoan(amount: Uint<64>): [] {
        const attestation = getAttestedScoring();
        assert(attestation[0].creditScore > 600, "score too low");
        return [];
      }
    `;
    const out = analyzeWitnessDependencies(source, ['getAttestedScoring']);
    expect(out.byCircuit.get('requestLoan')).toEqual(['getAttestedScoring']);
  });

  it('detects multiple distinct witnesses on the same circuit', () => {
    const source = `
      circuit doThing(): [] {
        const a = witnessA();
        const b = witnessB();
        return [];
      }
    `;
    const out = analyzeWitnessDependencies(source, ['witnessA', 'witnessB']);
    expect(out.byCircuit.get('doThing')).toEqual(['witnessA', 'witnessB']);
  });

  it('does NOT report circuits that only call other circuits (not witnesses)', () => {
    const source = `
      circuit setup(): [] { return []; }
      circuit doIt(): [] { return []; }
    `;
    const out = analyzeWitnessDependencies(source, ['getSecret']);
    expect(out.byCircuit.size).toBe(0);
  });

  it('propagates witness dependency through a helper function', () => {
    const source = `
      function loadAttestation(): Bytes<32> {
        return getAttestedScoring();
      }
      circuit requestLoan(amount: Uint<64>): [] {
        const a = loadAttestation();
        return [];
      }
    `;
    const out = analyzeWitnessDependencies(source, ['getAttestedScoring']);
    expect(out.byCircuit.get('requestLoan')).toEqual(['getAttestedScoring']);
  });

  it('propagates through multi-hop helper chains', () => {
    const source = `
      function inner(): Bytes<32> { return secretWitness(); }
      function middle(): Bytes<32> { return inner(); }
      function outer(): Bytes<32> { return middle(); }
      circuit topCircuit(): [] { const x = outer(); return []; }
    `;
    const out = analyzeWitnessDependencies(source, ['secretWitness']);
    expect(out.byCircuit.get('topCircuit')).toEqual(['secretWitness']);
  });

  it('strips line comments so commented-out witness calls are not counted', () => {
    const source = `
      circuit safe(): [] {
        // const x = getSecret();
        return [];
      }
    `;
    const out = analyzeWitnessDependencies(source, ['getSecret']);
    expect(out.byCircuit.has('safe')).toBe(false);
  });

  it('strips block comments so commented-out witness calls are not counted', () => {
    const source = `
      circuit safe(): [] {
        /* const x = getSecret(); */
        return [];
      }
    `;
    const out = analyzeWitnessDependencies(source, ['getSecret']);
    expect(out.byCircuit.has('safe')).toBe(false);
  });

  it('does not report circuits whose param happens to share a witness name', () => {
    // If a circuit takes an argument literally named `getSecret`, that's a
    // user-supplied value — not a call to the global witness function.
    const source = `
      circuit useArg(getSecret: Bytes<32>): [] {
        ledger.s = getSecret;
        return [];
      }
    `;
    const out = analyzeWitnessDependencies(source, ['getSecret']);
    expect(out.byCircuit.has('useArg')).toBe(false);
  });

  it('skips control-flow keywords that look like calls', () => {
    const source = `
      circuit branchy(amount: Uint<64>): [] {
        if (amount > 0) {
          ledger.x = amount;
        }
        for (i in 0..3) { ledger.y = i; }
        return [];
      }
    `;
    const out = analyzeWitnessDependencies(source, ['someWitness']);
    expect(out.byCircuit.has('branchy')).toBe(false);
  });

  it('handles multi-line circuit signatures', () => {
    const source = `
      circuit complexSig(
        a: Bytes<32>,
        b: Uint<64>,
        c: Bytes<16>
      ): [] {
        const x = neededWitness();
        return [];
      }
    `;
    const out = analyzeWitnessDependencies(source, ['neededWitness']);
    expect(out.byCircuit.get('complexSig')).toEqual(['neededWitness']);
  });

  it('does not include helper functions in the result map (only circuits)', () => {
    const source = `
      function helper(): Bytes<32> { return secret(); }
      circuit safe(): [] { return []; }
    `;
    const out = analyzeWitnessDependencies(source, ['secret']);
    // helper() uses the witness, but only circuits are reported.
    expect(out.byCircuit.has('helper')).toBe(false);
    expect(out.byCircuit.has('safe')).toBe(false);
  });

  it('handles nested braces in circuit bodies (if blocks, for loops)', () => {
    const source = `
      circuit nested(amount: Uint<64>): [] {
        if (amount > 0) {
          if (amount > 100) {
            const x = innerWitness();
          }
        }
        return [];
      }
      circuit other(): [] { return []; }
    `;
    const out = analyzeWitnessDependencies(source, ['innerWitness']);
    expect(out.byCircuit.get('nested')).toEqual(['innerWitness']);
    expect(out.byCircuit.has('other')).toBe(false);
  });
});
