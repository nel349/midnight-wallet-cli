import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Reset module state between tests by re-importing
let verbose: typeof import('../lib/verbose.ts');

beforeEach(async () => {
  // Fresh import to reset `enabled` state
  vi.resetModules();
  verbose = await import('../lib/verbose.ts');
});

describe('verbose', () => {
  it('is a no-op when not enabled', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    verbose.verbose('test', 'hello');
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it('writes to stderr when enabled', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    verbose.enableVerbose();
    verbose.verbose('sync', 'Starting facade...');

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const output = writeSpy.mock.calls[0]![0] as string;
    expect(output).toContain('sync');
    expect(output).toContain('Starting facade...');
    writeSpy.mockRestore();
  });

  it('includes timestamp in HH:mm:ss.SSS format', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    verbose.enableVerbose();
    verbose.verbose('phase', 'msg');

    const output = writeSpy.mock.calls[0]![0] as string;
    // Timestamp pattern: [HH:mm:ss.SSS]
    expect(output).toMatch(/\[\d{2}:\d{2}:\d{2}\.\d{3}\]/);
    writeSpy.mockRestore();
  });

  it('includes phase and message in output', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    verbose.enableVerbose();
    verbose.verbose('facade', 'Node: wss://example.com');

    const output = writeSpy.mock.calls[0]![0] as string;
    expect(output).toContain('facade: Node: wss://example.com');
    writeSpy.mockRestore();
  });

  it('ends with newline', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    verbose.enableVerbose();
    verbose.verbose('test', 'msg');

    const output = writeSpy.mock.calls[0]![0] as string;
    expect(output).toMatch(/\n$/);
    writeSpy.mockRestore();
  });
});
