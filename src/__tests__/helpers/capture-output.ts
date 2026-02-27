// Shared test helper — capture stdout/stderr writes
// Usage: const io = captureOutput(); ... io.stdout(); io.restore();

import { vi } from 'vitest';

export interface CapturedOutput {
  stdout(): string;
  stderr(): string;
  clearStdout(): void;
  clearStderr(): void;
  restore(): void;
}

export function captureOutput(): CapturedOutput {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const stdoutSpy = vi.spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(chunk.toString());
      return true;
    });

  const stderrSpy = vi.spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stderrChunks.push(chunk.toString());
      return true;
    });

  return {
    stdout: () => stdoutChunks.join(''),
    stderr: () => stderrChunks.join(''),
    clearStdout: () => { stdoutChunks.length = 0; },
    clearStderr: () => { stderrChunks.length = 0; },
    restore: () => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    },
  };
}
