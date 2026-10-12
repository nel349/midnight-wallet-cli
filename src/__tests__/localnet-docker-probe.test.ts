import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// On a machine without Docker, `mn localnet status` printed the shell's own
// "docker: not found" twice beside mn's message: the two probes ran with
// their stderr on the terminal. A child process's stderr never passes through
// this process's, so the check runs in a process of its own, with a PATH that
// has no docker in it.

const localnet = pathToFileURL(resolve(import.meta.dirname, '../lib/localnet.ts')).href;
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

describe('checkDockerAvailable on a machine without Docker', () => {
  it('says Docker is required, and lets none of the shell\'s own words through', () => {
    const emptyPath = mkdtempSync(join(tmpdir(), 'mn-no-docker-'));
    try {
      const run = spawnSync(
        process.execPath,
        ['--import', tsxLoader, '--input-type=module', '-e',
          `const { checkDockerAvailable } = await import(${JSON.stringify(localnet)}); try { checkDockerAvailable(); } catch (error) { console.log(error.message); }`],
        { env: { ...process.env, PATH: emptyPath }, encoding: 'utf-8', timeout: 30_000 },
      );
      expect(run.stdout.trim()).toBe('Docker is required but was not found.\nInstall Docker from https://docs.docker.com/get-docker/');
      expect(run.stderr).toBe('');
    } finally {
      rmSync(emptyPath, { recursive: true, force: true });
    }
  }, 40_000);
});
