import { describe, it, expect } from 'vitest';
import { claudeLaunchFailure } from '../lib/test/browser-test.ts';

describe('claudeLaunchFailure', () => {
  it('says what the browser strategy needs when there is no claude command', () => {
    const missing = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    const message = claudeLaunchFailure(missing);
    expect(message).toContain('no "claude" command was found on PATH');
    expect(message).toContain('mn test create --strategy cli');
  });

  it('passes any other launch error on', () => {
    expect(claudeLaunchFailure(new Error('spawn claude EACCES'))).toBe('Claude process error: spawn claude EACCES');
  });
});
