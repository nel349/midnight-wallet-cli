import { describe, it, expect } from 'vitest';
import { LONG_DUST_SYNC_EVENTS, sayOnLongSync, slowDustReaderNotice, whyNativeReaderFailed } from '../lib/slow-dust-notice.ts';

describe('sayOnLongSync', () => {
  it('speaks once when the read has more than the threshold to cover', () => {
    let said = 0;
    const progress = sayOnLongSync(0, undefined, () => { said++; });
    progress(1000, LONG_DUST_SYNC_EVENTS);
    progress(2000, LONG_DUST_SYNC_EVENTS + 500);
    progress(3000, LONG_DUST_SYNC_EVENTS + 900);
    expect(said).toBe(1);
  });

  it('says nothing for a short read from the start', () => {
    let said = 0;
    const progress = sayOnLongSync(0, undefined, () => { said++; });
    progress(100, 200);
    progress(201, LONG_DUST_SYNC_EVENTS - 1);
    expect(said).toBe(0);
  });

  it('counts from where the read resumes, not from the first event', () => {
    let said = 0;
    const progress = sayOnLongSync(1_600_000, undefined, () => { said++; });
    progress(9, 1_600_008);
    expect(said).toBe(0);
  });

  it('speaks when a chain that looked short turns out long', () => {
    let said = 0;
    const progress = sayOnLongSync(0, undefined, () => { said++; });
    progress(100, 100);
    expect(said).toBe(0);
    progress(200, 1_500_000);
    expect(said).toBe(1);
  });

  it('passes every progress call on', () => {
    const seen: Array<[number, number]> = [];
    const progress = sayOnLongSync(0, (applied, max) => { seen.push([applied, max]); }, () => {});
    progress(1, 10);
    progress(5, 2_000_000);
    expect(seen).toEqual([[1, 10], [5, 2_000_000]]);
  });
});

describe('slowDustReaderNotice', () => {
  it('names the reason and where to read more', () => {
    const line = slowDustReaderNotice('not installed (@nel349/dust-sync-linux-arm64)');
    expect(line).toContain('Native Dust reader not installed (@nel349/dust-sync-linux-arm64)');
    expect(line).toContain('slower');
    expect(line).toContain('README');
  });
});

describe('whyNativeReaderFailed', () => {
  it('says the binary cannot start when the system refuses to run it', () => {
    const refused = Object.assign(new Error('spawn /x/node_modules/@nel349/dust-sync-linux-arm64/dust-sync ENOENT'), {
      code: 'ENOENT', syscall: 'spawn /x/node_modules/@nel349/dust-sync-linux-arm64/dust-sync',
    });
    expect(whyNativeReaderFailed(refused)).toBe("can't start on this system (ENOENT)");
  });

  it('gives the first line of the error for a run that started and failed', () => {
    expect(whyNativeReaderFailed(new Error('dust-sync exited 1: connect failed\nmore detail'))).toBe('failed (dust-sync exited 1: connect failed)');
  });

  it('keeps a long error short', () => {
    expect(whyNativeReaderFailed(new Error('x'.repeat(500))).length).toBeLessThan(140);
  });
});
