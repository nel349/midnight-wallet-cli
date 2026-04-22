// Raw-mode keystroke dispatcher tests.
// We monkey-patch process.stdin's TTY surface because vitest runs non-TTY
// by default; without this the dispatcher correctly no-ops and nothing fires.

import { describe, it, expect, afterEach, vi } from 'vitest';

describe('startKeyDispatcher', () => {
  const original = {
    isTTY: process.stdin.isTTY,
    isRaw: process.stdin.isRaw,
    setRawMode: process.stdin.setRawMode,
    resume: process.stdin.resume,
    setEncoding: process.stdin.setEncoding,
  };

  afterEach(() => {
    // Restore everything we fiddled with.
    (process.stdin as any).isTTY = original.isTTY;
    process.stdin.setRawMode = original.setRawMode;
    process.stdin.resume = original.resume;
    process.stdin.setEncoding = original.setEncoding;
    process.stdin.removeAllListeners('data');
    vi.resetModules();
  });

  async function loadWithRawSupport() {
    (process.stdin as any).isTTY = true;
    process.stdin.setRawMode = vi.fn(() => process.stdin) as any;
    process.stdin.resume = vi.fn(() => process.stdin) as any;
    process.stdin.setEncoding = vi.fn(() => process.stdin) as any;
    return await import('../lib/dev/keys.ts');
  }

  it('returns a no-op dispatcher when stdin is not a TTY', async () => {
    (process.stdin as any).isTTY = false;
    const { startKeyDispatcher } = await import('../lib/dev/keys.ts');
    const d = startKeyDispatcher({ actions: { d: () => {} }, onInterrupt: () => {} });
    expect(typeof d.stop).toBe('function');
    d.stop(); // must not throw
  });

  it('routes keystrokes to the matching action (case-insensitive)', async () => {
    const { startKeyDispatcher } = await loadWithRawSupport();
    const dAction = vi.fn();
    const d = startKeyDispatcher({
      actions: { d: dAction },
      onInterrupt: vi.fn(),
    });
    process.stdin.emit('data', 'D');
    await Promise.resolve();
    expect(dAction).toHaveBeenCalledTimes(1);
    d.stop();
  });

  it('calls onInterrupt on Ctrl+C', async () => {
    const { startKeyDispatcher } = await loadWithRawSupport();
    const onInterrupt = vi.fn();
    const d = startKeyDispatcher({ actions: {}, onInterrupt });
    process.stdin.emit('data', '\u0003');
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    d.stop();
  });

  it('invokes onUnknown for unbound keys', async () => {
    const { startKeyDispatcher } = await loadWithRawSupport();
    const onUnknown = vi.fn();
    const d = startKeyDispatcher({ actions: { d: () => {} }, onInterrupt: () => {}, onUnknown });
    process.stdin.emit('data', 'x');
    expect(onUnknown).toHaveBeenCalledWith('x');
    d.stop();
  });

  it('surfaces handler errors via onError', async () => {
    const { startKeyDispatcher } = await loadWithRawSupport();
    const onError = vi.fn();
    const d = startKeyDispatcher({
      actions: { d: async () => { throw new Error('boom'); } },
      onInterrupt: () => {},
      onError,
    });
    process.stdin.emit('data', 'd');
    // Wait for the microtask queue to drain so the promise catch fires.
    await new Promise((r) => setTimeout(r, 10));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe('d');
    expect((onError.mock.calls[0][1] as Error).message).toBe('boom');
    d.stop();
  });

  it('stop() is idempotent', async () => {
    const { startKeyDispatcher } = await loadWithRawSupport();
    const d = startKeyDispatcher({ actions: {}, onInterrupt: () => {} });
    d.stop();
    d.stop(); // should not throw
  });
});
