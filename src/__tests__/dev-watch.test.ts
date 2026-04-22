import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWatching } from '../lib/dev/watch.ts';

let TEST_DIR: string;

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'mn-dev-watch-'));
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('startWatching', () => {
  it('fires callback only for files matching the extension', async () => {
    // Pre-create the files so the watcher fires on content changes rather
    // than initial directory-entry creation (which FSEvents can coalesce).
    writeFileSync(join(TEST_DIR, 'a.compact'), 'v0');
    writeFileSync(join(TEST_DIR, 'b.txt'), 'v0');

    const seen: string[][] = [];
    const handle = startWatching({
      dirs: [TEST_DIR],
      extension: '.compact',
      debounceMs: 80,
      onChange: (paths) => { seen.push(paths); },
    });

    // Give the watcher a moment to bind before we write.
    await sleep(50);
    writeFileSync(join(TEST_DIR, 'a.compact'), 'v1');
    writeFileSync(join(TEST_DIR, 'b.txt'), 'v1');
    await sleep(400);

    handle.stop();
    const flat = seen.flat();
    expect(flat.some((p) => p.endsWith('a.compact'))).toBe(true);
    expect(flat.some((p) => p.endsWith('b.txt'))).toBe(false);
  });

  it('debounces rapid writes into a single callback', async () => {
    let callbackCount = 0;
    const handle = startWatching({
      dirs: [TEST_DIR],
      extension: '.compact',
      debounceMs: 80,
      onChange: () => { callbackCount += 1; },
    });

    // Five rapid writes within the debounce window
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(TEST_DIR, 'x.compact'), `v${i}`);
      await sleep(10);
    }
    await sleep(200);

    handle.stop();
    expect(callbackCount).toBe(1);
  });

  it('stop() prevents further callbacks', async () => {
    let callbackCount = 0;
    const handle = startWatching({
      dirs: [TEST_DIR],
      extension: '.compact',
      debounceMs: 50,
      onChange: () => { callbackCount += 1; },
    });

    handle.stop();
    writeFileSync(join(TEST_DIR, 'x.compact'), 'v1');
    await sleep(150);

    expect(callbackCount).toBe(0);
  });
});
