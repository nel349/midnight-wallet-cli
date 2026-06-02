import { describe, it, expect } from 'vitest';
import { computeHeapTargetMb } from '../lib/heap-guard.ts';
import {
  SYNC_HEAP_TARGET_MB,
  SYNC_HEAP_RAM_FRACTION,
  SYNC_HEAP_MIN_GAIN_MB,
} from '../lib/constants.ts';

describe('computeHeapTargetMb', () => {
  // The OOM repro: a 128 GB box with Node's default ~4.3 GB old-space cap.
  it('bumps to the desired target when RAM and current limit allow', () => {
    expect(computeHeapTargetMb({ totalMb: 131072, currentLimitMb: 4288 }))
      .toBe(SYNC_HEAP_TARGET_MB);
  });

  it('returns null when the current limit already has enough headroom', () => {
    // e.g. the user already raised the heap via NODE_OPTIONS — don't re-exec.
    expect(computeHeapTargetMb({ totalMb: 131072, currentLimitMb: 16384 })).toBeNull();
  });

  it('caps the target at the RAM fraction on small machines', () => {
    // 8 GB machine: 70% = 5734 MB, below the 12 GB desired.
    expect(computeHeapTargetMb({ totalMb: 8192, currentLimitMb: 4288 }))
      .toBe(Math.floor(8192 * SYNC_HEAP_RAM_FRACTION));
  });

  it('returns null when the RAM-capped target is not a worthwhile gain', () => {
    // 6 GB machine: 70% = 4300 MB, only ~12 MB over the current 4288 — below the
    // min-gain threshold, so re-exec isn't worth it.
    expect(computeHeapTargetMb({ totalMb: 6144, currentLimitMb: 4288 })).toBeNull();
  });

  it('respects the min-gain threshold exactly at the boundary', () => {
    const current = 4288;
    // target would be current + minGain exactly → not a *worthwhile* gain (<=).
    const totalMb = Math.ceil((current + SYNC_HEAP_MIN_GAIN_MB) / SYNC_HEAP_RAM_FRACTION);
    expect(computeHeapTargetMb({ totalMb, currentLimitMb: current })).toBeNull();
    // one MB more of RAM tips it over.
    expect(computeHeapTargetMb({ totalMb: totalMb + 2, currentLimitMb: current })).not.toBeNull();
  });

  it('honors an explicit desired override', () => {
    expect(computeHeapTargetMb({ totalMb: 131072, currentLimitMb: 4288, desiredMb: 8192 }))
      .toBe(8192);
  });

  it('rejects a non-positive or NaN desired override', () => {
    expect(computeHeapTargetMb({ totalMb: 131072, currentLimitMb: 4288, desiredMb: 0 })).toBeNull();
    expect(computeHeapTargetMb({ totalMb: 131072, currentLimitMb: 4288, desiredMb: NaN })).toBeNull();
  });

  it('returns null for bogus total memory', () => {
    expect(computeHeapTargetMb({ totalMb: 0, currentLimitMb: 4288 })).toBeNull();
    expect(computeHeapTargetMb({ totalMb: NaN, currentLimitMb: 4288 })).toBeNull();
  });
});
