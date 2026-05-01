import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hasShownIntroThisSession, markIntroShown } from '../lib/intro-marker.ts';

function currentMarkerPath(): string {
  const raw =
    process.env.TERM_SESSION_ID ??
    process.env.ITERM_SESSION_ID ??
    `pid-${process.ppid}`;
  const safe = raw.replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 64);
  return join(tmpdir(), `mn-intro-${safe}`);
}

describe('intro-marker', () => {
  beforeEach(() => {
    try { unlinkSync(currentMarkerPath()); } catch { /* missing is fine */ }
  });

  afterEach(() => {
    try { unlinkSync(currentMarkerPath()); } catch { /* missing is fine */ }
  });

  it('reports false when no marker file exists', () => {
    expect(hasShownIntroThisSession()).toBe(false);
  });

  it('reports true after markIntroShown', () => {
    markIntroShown();
    expect(hasShownIntroThisSession()).toBe(true);
  });

  it('writes the marker to a session-keyed path under tmpdir', () => {
    markIntroShown();
    expect(existsSync(currentMarkerPath())).toBe(true);
  });

  it('survives a missing tmpdir write gracefully', () => {
    // Force a failure by setting TMPDIR to a non-writable path before calling.
    // markIntroShown is best-effort; it should NOT throw.
    const originalTmp = process.env.TMPDIR;
    process.env.TMPDIR = '/this/path/does/not/exist';
    try {
      expect(() => markIntroShown()).not.toThrow();
    } finally {
      if (originalTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmp;
    }
  });
});
