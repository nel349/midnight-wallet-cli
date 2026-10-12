// Keeps a Blockfrost project id out of the terminal. Endpoint URLs carry it,
// and URLs end up in error messages, progress lines, verbose logs and the
// logs of libraries mn doesn't control (the node client prints the URL it
// lost its connection to). People paste that output into bug reports.
//
// So the two output streams hide it, whoever writes. Each write is passed on
// with every argument it came with: only the text changes, and only when it
// holds a project id. (A wrapper that dropped writes or their callbacks once
// made libraries waiting on a write hang; this one drops nothing.)

import { mayHoldProjectId, redactProjectId } from './blockfrost.ts';

type Write = typeof process.stdout.write;

/** The chunk with any project id hidden; the same object when there is none. */
export function redactChunk<T extends string | Uint8Array>(chunk: T): T {
  if (typeof chunk === 'string') {
    return (mayHoldProjectId(chunk) ? redactProjectId(chunk) : chunk) as T;
  }
  const text = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('utf8');
  if (!mayHoldProjectId(text)) return chunk;
  const redacted = redactProjectId(text);
  return (redacted === text ? chunk : Buffer.from(redacted, 'utf8')) as T;
}

/** A `write` that hides project ids and otherwise is `write`: same arguments on, same return value back. */
export function redactingWrite(write: Write): Write {
  return function (this: unknown, chunk: string | Uint8Array, ...rest: unknown[]): boolean {
    return (write as (...args: unknown[]) => boolean).call(this, redactChunk(chunk), ...rest);
  } as Write;
}

let installed = false;

/** Hides project ids in everything this process writes to stdout and stderr. Safe to call twice. */
export function hideProjectIdsInOutput(): void {
  if (installed) return;
  installed = true;
  process.stdout.write = redactingWrite(process.stdout.write);
  process.stderr.write = redactingWrite(process.stderr.write);
}
