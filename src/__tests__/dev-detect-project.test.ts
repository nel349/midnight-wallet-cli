import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectProject } from '../lib/dev/detect-project.ts';

let TEST_DIR: string;

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'mn-dev-detect-'));
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('detectProject', () => {
  it('finds .compact files at the project root', () => {
    writeFileSync(join(TEST_DIR, 'counter.compact'), 'pragma language_version >= 0.15;\n');
    const info = detectProject(TEST_DIR);
    expect(info.sourceFiles).toHaveLength(1);
    expect(info.sourceFiles[0]).toBe(join(TEST_DIR, 'counter.compact'));
    expect(info.sourceDirs).toContain(TEST_DIR);
  });

  it('finds .compact files in common subdirs (src, contract/src)', () => {
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true });
    mkdirSync(join(TEST_DIR, 'contract', 'src'), { recursive: true });
    writeFileSync(join(TEST_DIR, 'src', 'a.compact'), '');
    writeFileSync(join(TEST_DIR, 'contract', 'src', 'b.compact'), '');
    const info = detectProject(TEST_DIR);
    expect(info.sourceFiles).toHaveLength(2);
  });

  it('ignores node_modules, .git, dist, build, managed', () => {
    for (const junk of ['node_modules', '.git', 'dist', 'build', 'managed']) {
      mkdirSync(join(TEST_DIR, junk), { recursive: true });
      writeFileSync(join(TEST_DIR, junk, 'x.compact'), '');
    }
    writeFileSync(join(TEST_DIR, 'real.compact'), '');
    const info = detectProject(TEST_DIR);
    expect(info.sourceFiles).toHaveLength(1);
    expect(info.sourceFiles[0]).toBe(join(TEST_DIR, 'real.compact'));
  });

  it('throws a clear error when no .compact files are found', () => {
    writeFileSync(join(TEST_DIR, 'package.json'), '{}');
    expect(() => detectProject(TEST_DIR)).toThrow(/No .compact source files found/);
  });

  it('detects an npm "compact" script (Midnight-starship / create-mn-app convention)', () => {
    writeFileSync(join(TEST_DIR, 'x.compact'), '');
    writeFileSync(
      join(TEST_DIR, 'package.json'),
      JSON.stringify({ name: 'p', scripts: { compact: 'compact compile src/x.compact src/managed/x' } }),
    );
    const info = detectProject(TEST_DIR);
    expect(info.compileScript).toBe('compact');
    expect(info.hasNpmCompileScript).toBe(true);
  });

  it('detects an npm "compile" script as fallback', () => {
    writeFileSync(join(TEST_DIR, 'x.compact'), '');
    writeFileSync(
      join(TEST_DIR, 'package.json'),
      JSON.stringify({ name: 'p', scripts: { compile: 'compact compile src/x.compact src/managed/x' } }),
    );
    const info = detectProject(TEST_DIR);
    expect(info.compileScript).toBe('compile');
    expect(info.hasNpmCompileScript).toBe(true);
  });

  it('prefers "compact" over "compile" when both are defined', () => {
    writeFileSync(join(TEST_DIR, 'x.compact'), '');
    writeFileSync(
      join(TEST_DIR, 'package.json'),
      JSON.stringify({ name: 'p', scripts: { compact: 'a', compile: 'b' } }),
    );
    expect(detectProject(TEST_DIR).compileScript).toBe('compact');
  });

  it('returns compileScript=null when no recognised script is defined', () => {
    writeFileSync(join(TEST_DIR, 'x.compact'), '');
    writeFileSync(
      join(TEST_DIR, 'package.json'),
      JSON.stringify({ name: 'p', scripts: { test: 'vitest' } }),
    );
    const info = detectProject(TEST_DIR);
    expect(info.compileScript).toBeNull();
    expect(info.hasNpmCompileScript).toBe(false);
  });

  it('gracefully handles missing package.json', () => {
    writeFileSync(join(TEST_DIR, 'x.compact'), '');
    const info = detectProject(TEST_DIR);
    expect(info.packageJson).toBeNull();
    expect(info.hasNpmCompileScript).toBe(false);
  });
});
