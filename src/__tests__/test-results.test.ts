import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { writeResult, readLatestResult, listResults } from '../lib/test/results.ts';
import type { TestRunResult } from '../lib/test/types.ts';

function makeTempDir(): string {
  const dir = join(tmpdir(), `mn-test-results-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeResult(overrides: Partial<TestRunResult> = {}): TestRunResult {
  return {
    id: 'test-1',
    dapp: 'starship',
    suite: 'e2e',
    timestamp: new Date().toISOString(),
    duration: 120,
    network: 'undeployed',
    strategy: 'browser',
    status: 'pass',
    prep: [{ step: 'localnet-up', status: 'pass', duration: 5000 }],
    assertions: [{ id: 'exit', status: 'pass' }],
    ...overrides,
  };
}

describe('writeResult', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('creates the results directory if it does not exist', () => {
    const result = makeResult();
    writeResult(result, tempDir);
    expect(existsSync(join(tempDir, 'tests', 'results'))).toBe(true);
  });

  it('writes a valid JSON file', () => {
    const result = makeResult();
    const path = writeResult(result, tempDir);
    const content = JSON.parse(readFileSync(path, 'utf-8'));
    expect(content.dapp).toBe('starship');
    expect(content.suite).toBe('e2e');
    expect(content.status).toBe('pass');
  });

  it('includes the suite name in the filename', () => {
    const result = makeResult({ suite: 'contract-deploy' });
    const path = writeResult(result, tempDir);
    expect(path).toContain('contract-deploy_');
  });
});

describe('readLatestResult', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('returns null when no results exist', () => {
    expect(readLatestResult(tempDir)).toBeNull();
  });

  it('returns the most recent result', () => {
    writeResult(makeResult({ timestamp: '2026-01-01T00:00:00Z', status: 'fail' }), tempDir);
    writeResult(makeResult({ timestamp: '2026-03-29T00:00:00Z', status: 'pass' }), tempDir);

    const latest = readLatestResult(tempDir);
    expect(latest).not.toBeNull();
    expect(latest!.timestamp).toBe('2026-03-29T00:00:00Z');
    expect(latest!.status).toBe('pass');
  });

  it('filters by suite name', () => {
    writeResult(makeResult({ suite: 'e2e', timestamp: '2026-03-29T00:00:00Z' }), tempDir);
    writeResult(makeResult({ suite: 'contract', timestamp: '2026-03-28T00:00:00Z' }), tempDir);

    const latest = readLatestResult(tempDir, 'contract');
    expect(latest).not.toBeNull();
    expect(latest!.suite).toBe('contract');
  });
});

describe('listResults', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('returns empty array when no results directory exists', () => {
    expect(listResults(tempDir)).toEqual([]);
  });

  it('returns all results sorted newest first', () => {
    writeResult(makeResult({ timestamp: '2026-01-01T00:00:00Z' }), tempDir);
    writeResult(makeResult({ timestamp: '2026-03-01T00:00:00Z' }), tempDir);
    writeResult(makeResult({ timestamp: '2026-02-01T00:00:00Z' }), tempDir);

    const results = listResults(tempDir);
    expect(results).toHaveLength(3);
    expect(results[0].timestamp).toBe('2026-03-01T00:00:00Z');
    expect(results[1].timestamp).toBe('2026-02-01T00:00:00Z');
    expect(results[2].timestamp).toBe('2026-01-01T00:00:00Z');
  });
});

describe('results beside other files in tests/results', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("is not thrown by the runner's contract cache, which is newer than the result", () => {
    const result = makeResult({ suite: 'cli-default', timestamp: '2026-10-12T05:54:52.675Z' });
    writeResult(result, tempDir);
    writeFileSync(
      join(tempDir, 'tests', 'results', '.contract-cache-cli-default.json'),
      JSON.stringify({ address: '7dcfe8f4a778e779', network: 'undeployed', timestamp: '2026-10-12T05:57:38.479Z' }),
    );
    expect(listResults(tempDir)).toEqual([result]);
    expect(readLatestResult(tempDir)).toEqual(result);
    expect(readLatestResult(tempDir, 'cli-default')).toEqual(result);
  });

  it('leaves out a JSON file that is not a result', () => {
    const result = makeResult();
    writeResult(result, tempDir);
    writeFileSync(join(tempDir, 'tests', 'results', 'notes.json'), JSON.stringify({ timestamp: '2999-01-01T00:00:00.000Z' }));
    expect(listResults(tempDir)).toEqual([result]);
  });
});
