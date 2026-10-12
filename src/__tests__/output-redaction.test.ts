// The two output streams hide a Blockfrost project id whoever writes it, and
// are otherwise untouched: every argument of a write is passed on, and its
// return value comes back.

import { describe, expect, it } from 'vitest';
import { redactChunk, redactingWrite } from '../lib/output-redaction.ts';

const ID = 'nightpreprodAbCdEfGhIjKlMnOpQrStUv0123';
const URL_WITH_ID = `wss://rpc.midnight-preprod.blockfrost.io?project_id=${ID}`;

describe('redactChunk', () => {
  it('hides a project id in text', () => {
    expect(redactChunk(`API-WS: disconnected from ${URL_WITH_ID}: 1006\n`)).toBe('API-WS: disconnected from wss://rpc.midnight-preprod.blockfrost.io?project_id=***: 1006\n');
  });

  it('hides one in bytes, and gives bytes back', () => {
    const redacted = redactChunk(Buffer.from(`{"message":"${URL_WITH_ID}"}\n`));
    expect(Buffer.isBuffer(redacted)).toBe(true);
    expect(Buffer.from(redacted).toString()).toBe('{"message":"wss://rpc.midnight-preprod.blockfrost.io?project_id=***"}\n');
  });

  it('reads a view over part of a buffer as that part only', () => {
    const whole = Buffer.from(`xxxx${URL_WITH_ID}yyyy`);
    const view = new Uint8Array(whole.buffer, whole.byteOffset + 4, whole.byteLength - 8);
    expect(Buffer.from(redactChunk(view)).toString()).toBe('wss://rpc.midnight-preprod.blockfrost.io?project_id=***');
  });

  it('gives back the very same chunk when there is nothing to hide', () => {
    const bytes = Buffer.from('Balance: 5 NIGHT\n');
    expect(redactChunk(bytes)).toBe(bytes);
    expect(redactChunk('nightpreprod…0123 (preprod)\n')).toBe('nightpreprod…0123 (preprod)\n');
  });
});

describe('redactingWrite', () => {
  function recording() {
    const calls: unknown[][] = [];
    const stream = {
      answer: true,
      write(this: { answer: boolean }, ...args: unknown[]): boolean {
        calls.push([this, ...args]);
        return this.answer;
      },
    };
    return { calls, stream };
  }

  /** The wrapped write, callable with whatever arguments a caller of a stream's write may give. */
  const wrapped = (stream: { write: (...args: unknown[]) => boolean }) =>
    redactingWrite(stream.write as typeof process.stdout.write) as unknown as (this: unknown, ...args: unknown[]) => boolean;

  it('passes the text on with the project id hidden', () => {
    const { calls, stream } = recording();
    wrapped(stream).call(stream, `Indexer: ${URL_WITH_ID}\n`);
    expect(calls[0]![1]).toBe('Indexer: wss://rpc.midnight-preprod.blockfrost.io?project_id=***\n');
  });

  it('passes on the encoding and the callback, and the stream it was called on', () => {
    const { calls, stream } = recording();
    const write = wrapped(stream);
    const done = () => {};
    write.call(stream, 'plain\n', 'utf8', done);
    write.call(stream, 'plain\n', done);
    expect(calls[0]).toEqual([stream, 'plain\n', 'utf8', done]);
    expect(calls[1]).toEqual([stream, 'plain\n', done]);
  });

  it('gives back what the stream answered: a full buffer is still reported', () => {
    const { stream } = recording();
    const write = wrapped(stream);
    expect(write.call(stream, 'x')).toBe(true);
    stream.answer = false;
    expect(write.call(stream, 'x')).toBe(false);
  });
});
