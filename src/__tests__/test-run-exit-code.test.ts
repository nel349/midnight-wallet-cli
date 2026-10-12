import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// `mn test run` reports a failed suite through process.exitCode, and the CLI
// used to end every wallet command with exit(0): a failing suite passed in CI.
// These runs touch no chain: the suite has no prep and no actions, and its one
// assertion is whether a local port is listening.

const entryPoint = resolve(import.meta.dirname, '../wallet.ts');
// The run's cwd is a temp dApp, so the TypeScript loader is named by where it is.
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const SPAWN_TIMEOUT_MS = 30_000;

let root: string;
let closedPort: number;

/** A dApp directory with a compiled-contract stub and one CLI suite asserting on `closedPort`. */
function dappExpecting(expect: 'pass' | 'fail'): string {
  const dir = mkdtempSync(join(root, 'dapp-'));
  const compiler = join(dir, 'managed', 'counter', 'compiler');
  mkdirSync(compiler, { recursive: true });
  writeFileSync(join(compiler, 'contract-info.json'), JSON.stringify({
    'compiler-version': '0.31.0', 'language-version': '0.23.0', 'runtime-version': '0.16.0',
    circuits: [], witnesses: [], contracts: [], ledger: [],
  }));
  writeFileSync(join(dir, 'dapp.test.json'), JSON.stringify({ name: 'exit-code', network: 'undeployed', prep: [] }));
  const suite = join(dir, 'tests', 'suites', 'only');
  mkdirSync(suite, { recursive: true });
  writeFileSync(join(suite, 'suite.json'), JSON.stringify({ name: 'only', description: 'exit code', strategy: 'cli', timeout: 30 }));
  writeFileSync(join(suite, 'actions.json'), JSON.stringify({ actions: [] }));
  writeFileSync(join(suite, 'assertions.json'), JSON.stringify({
    post: [{ id: 'port', type: 'port-listening', params: { port: closedPort }, expect }],
  }));
  return dir;
}

function testRun(dappDir: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', tsxLoader, entryPoint, 'test', 'run', '--json'], {
    cwd: dappDir, encoding: 'utf-8', env: { ...process.env, HOME: join(root, 'home'), NO_COLOR: '1' },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mn-test-exit-'));
  mkdirSync(join(root, 'home'));
  const server = createServer();
  closedPort = await new Promise<number>((done) => server.listen(0, '127.0.0.1', () => done((server.address() as AddressInfo).port)));
  await new Promise((done) => server.close(done));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('mn test run exit code', () => {
  it('exits 1 when the suite fails', () => {
    const { status, stdout, stderr } = testRun(dappExpecting('pass'));
    expect(stdout, stderr).not.toBe('');
    expect(JSON.parse(stdout).status).toBe('fail');
    expect(status).toBe(1);
  }, SPAWN_TIMEOUT_MS);

  it('exits 0 when the suite passes', () => {
    const { status, stdout, stderr } = testRun(dappExpecting('fail'));
    expect(stdout, stderr).not.toBe('');
    expect(JSON.parse(stdout).status).toBe('pass');
    expect(status).toBe(0);
  }, SPAWN_TIMEOUT_MS);
});
