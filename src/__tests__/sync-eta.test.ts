import { describe, it, expect } from 'vitest';
import { createEtaEstimator, formatSyncStatus } from '../lib/sync-eta.ts';

describe('createEtaEstimator', () => {
  it('returns null rate + ETA on the first sample', () => {
    const eta = createEtaEstimator();
    const snap = eta.sample({ applied: 0, highest: 1000, t: 0 });
    expect(snap.applied).toBe(0);
    expect(snap.highest).toBe(1000);
    expect(snap.ratePerSec).toBeNull();
    expect(snap.etaSec).toBeNull();
    expect(snap.percent).toBe(0);
  });

  it('computes rate + ETA once two samples span ≥ 1 second', () => {
    const eta = createEtaEstimator();
    eta.sample({ applied: 0, highest: 1000, t: 0 });
    const snap = eta.sample({ applied: 100, highest: 1000, t: 1_000 }); // 100 events / 1s
    expect(snap.ratePerSec).toBe(100);
    expect(snap.etaSec).toBe(9); // 900 remaining / 100 per sec
    expect(snap.percent).toBe(10);
  });

  it('reports etaSec=0 when applied==highest', () => {
    const eta = createEtaEstimator();
    eta.sample({ applied: 0, highest: 1000, t: 0 });
    const snap = eta.sample({ applied: 1000, highest: 1000, t: 1_000 });
    expect(snap.percent).toBe(100);
    expect(snap.etaSec).toBe(0);
  });

  it('percent is null when highest=0 (sync not yet reporting head)', () => {
    const eta = createEtaEstimator();
    const snap = eta.sample({ applied: 42, highest: 0, t: 0 });
    expect(snap.percent).toBeNull();
  });

  it('drops samples older than the window when computing rate', () => {
    const eta = createEtaEstimator({ windowMs: 5_000 });
    eta.sample({ applied: 0, highest: 10_000, t: 0 });
    // 6s later, sync has slowed dramatically — old fast samples should be ignored
    eta.sample({ applied: 5_000, highest: 10_000, t: 6_000 });
    const snap = eta.sample({ applied: 5_100, highest: 10_000, t: 7_000 });
    // Rolling window drops the t=0 sample; rate computed only from recent slow samples
    expect(snap.ratePerSec).toBe(100); // (5100 - 5000) / 1s
  });

  it('reset() clears rate history', () => {
    const eta = createEtaEstimator();
    eta.sample({ applied: 0, highest: 1000, t: 0 });
    eta.sample({ applied: 100, highest: 1000, t: 1_000 });
    eta.reset();
    const snap = eta.sample({ applied: 200, highest: 1000, t: 2_000 });
    expect(snap.ratePerSec).toBeNull();
    expect(snap.etaSec).toBeNull();
  });
});

describe('formatSyncStatus', () => {
  it('omits ETA and rate when not yet computable', () => {
    const s = formatSyncStatus({ applied: 0, highest: 1000, percent: 0, ratePerSec: null, etaSec: null });
    expect(s).toBe('Syncing · 0%');
  });

  it('includes ETA + rate when both are known', () => {
    const s = formatSyncStatus({ applied: 500, highest: 1000, percent: 50, ratePerSec: 100, etaSec: 5 });
    expect(s).toContain('50%');
    expect(s).toContain('ETA 5s');
    expect(s).toContain('100 evt/s');
  });

  it('formats minutes + seconds when ETA > 60s', () => {
    const s = formatSyncStatus({ applied: 0, highest: 100_000, percent: 0, ratePerSec: 50, etaSec: 125 });
    expect(s).toContain('ETA 2m 5s');
  });

  it('formats hours + minutes when ETA > 3600s', () => {
    const s = formatSyncStatus({ applied: 0, highest: 1_000_000, percent: 0, ratePerSec: 50, etaSec: 7_200 });
    expect(s).toContain('ETA 2h');
  });

  it('uses event count when highest=0', () => {
    const s = formatSyncStatus({ applied: 42, highest: 0, percent: null, ratePerSec: null, etaSec: null });
    expect(s).toContain('42 events');
  });

  it('respects the label override', () => {
    const s = formatSyncStatus(
      { applied: 500, highest: 1000, percent: 50, ratePerSec: null, etaSec: null },
      'Syncing shielded',
    );
    expect(s.startsWith('Syncing shielded ·')).toBe(true);
  });
});
