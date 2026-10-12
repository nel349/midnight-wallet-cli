import { describe, it, expect } from 'vitest';
import { scriptFailureMessage } from '../lib/contract/runner.ts';

const NODE_CRASH = [
  'Connecting to mn serve...',
  'Connected',
  'Deploying contract...',
  'file:///work/counter/.mn-contract-1791784016012.mjs:32',
  '          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));',
  '                                ^',
  '',
  'Error: Insufficient Funds: could not balance dust',
  '    at WebSocket.handler (file:///work/counter/.mn-contract-1791784016012.mjs:32:33)',
  '    at WebSocket.emit (node:events:519:28)',
  '',
  'Node.js v22.23.3',
].join('\n');

describe('scriptFailureMessage', () => {
  it('is the error Node printed, without the source excerpt, the stack or the progress lines', () => {
    expect(scriptFailureMessage(NODE_CRASH, 1)).toBe('Insufficient Funds: could not balance dust');
  });

  it('keeps the name of an error that is not a plain Error', () => {
    const stderr = 'Calling increment...\nTypeError: Cannot read properties of undefined (reading \'secret\')\n    at witness (file:///x.mjs:1:1)';
    expect(scriptFailureMessage(stderr, 1)).toBe("TypeError: Cannot read properties of undefined (reading 'secret')");
  });

  it('keeps the lines of a message that runs over several', () => {
    const stderr = 'Error: Contract not found at abc\n  Check the address and the network.\n    at find (file:///x.mjs:2:2)';
    expect(scriptFailureMessage(stderr, 1)).toBe('Contract not found at abc\n  Check the address and the network.');
  });

  it('leaves out the vacant witnesses warning the script prints for a contract without witnesses', () => {
    const stderr = 'Warning: No witnesses module found — using vacant witnesses. Searched:\n  - dist/witnesses.js\n' + NODE_CRASH;
    expect(scriptFailureMessage(stderr, 1)).toBe('Insufficient Funds: could not balance dust');
  });

  it('takes the last error when an earlier line also looks like one', () => {
    const stderr = 'Error: first attempt failed, retrying\nRetrying...\nError: gave up\n    at run (file:///x.mjs:3:3)';
    expect(scriptFailureMessage(stderr, 1)).toBe('gave up');
  });

  it('falls back to the whole stderr when there is no error line', () => {
    expect(scriptFailureMessage('  killed by the operating system\n', 137)).toBe('killed by the operating system');
  });

  it('names the exit code when the script said nothing', () => {
    expect(scriptFailureMessage('', 3)).toBe('Script exited with code 3');
  });
});
