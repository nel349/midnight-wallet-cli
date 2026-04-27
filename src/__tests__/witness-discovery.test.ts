import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WITNESS_FILE_CANDIDATES,
  findWitnessFile,
  findWitnessSource,
  buildMissingWitnessError,
} from '../lib/contract/witness-discovery.ts';

let DIR: string;

beforeEach(() => { DIR = mkdtempSync(join(tmpdir(), 'mn-witness-')); });
afterEach(() => { rmSync(DIR, { recursive: true, force: true }); });

function touch(rel: string): void {
  const full = join(DIR, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, '');
}

describe('findWitnessFile', () => {
  it('returns null when nothing exists', () => {
    expect(findWitnessFile(DIR)).toBeNull();
  });

  it('finds dist/witnesses.js (preferred)', () => {
    touch('dist/witnesses.js');
    expect(findWitnessFile(DIR)).toBe(join(DIR, 'dist/witnesses.js'));
  });

  it('falls back to src/witnesses.js when dist is missing', () => {
    touch('src/witnesses.js');
    expect(findWitnessFile(DIR)).toBe(join(DIR, 'src/witnesses.js'));
  });

  it('finds nested contract/dist/witnesses.js', () => {
    touch('contract/dist/witnesses.js');
    expect(findWitnessFile(DIR)).toBe(join(DIR, 'contract/dist/witnesses.js'));
  });

  it('prefers dist over src when both exist', () => {
    touch('src/witnesses.js');
    touch('dist/witnesses.js');
    expect(findWitnessFile(DIR)).toBe(join(DIR, 'dist/witnesses.js'));
  });
});

describe('findWitnessSource', () => {
  it('finds src/witnesses.ts', () => {
    touch('src/witnesses.ts');
    expect(findWitnessSource(DIR)).toBe(join(DIR, 'src/witnesses.ts'));
  });

  it('returns null when no .ts source exists', () => {
    expect(findWitnessSource(DIR)).toBeNull();
  });
});

describe('buildMissingWitnessError', () => {
  it('lists declared names and every searched path', () => {
    const msg = buildMissingWitnessError({
      projectRoot: DIR,
      witnessNames: ['secretSeed', 'localSecret'],
    });
    expect(msg).toContain('2 witness(es): secretSeed, localSecret');
    for (const p of WITNESS_FILE_CANDIDATES) expect(msg).toContain(p);
    expect(msg).toContain(DIR);
  });

  it('names the .ts source and suggests building when one exists', () => {
    touch('src/witnesses.ts');
    const msg = buildMissingWitnessError({
      projectRoot: DIR,
      witnessNames: ['x'],
    });
    expect(msg).toContain('src/witnesses.ts');
    expect(msg).toMatch(/build|compile/i);
  });

  it('falls back to a generic add-the-module hint when no .ts source exists', () => {
    const msg = buildMissingWitnessError({
      projectRoot: DIR,
      witnessNames: ['x'],
    });
    expect(msg).toMatch(/witnesses module|witnesses object/i);
    expect(msg).not.toMatch(/looks like it isn't compiled/);
  });
});
