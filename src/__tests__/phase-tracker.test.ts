import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPhaseTracker } from '../lib/phase-tracker.ts';

describe('createPhaseTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start + complete records timing', () => {
    const tracker = createPhaseTracker();
    tracker.start('signing');
    vi.advanceTimersByTime(100);
    tracker.complete();

    const timings = tracker.getTimings();
    expect(timings).toHaveLength(1);
    expect(timings[0]!.phase).toBe('signing');
    expect(timings[0]!.durationMs).toBe(100);
  });

  it('start auto-completes previous phase', () => {
    const tracker = createPhaseTracker();
    tracker.start('signing');
    vi.advanceTimersByTime(50);
    tracker.start('proving');
    vi.advanceTimersByTime(200);
    tracker.complete();

    const timings = tracker.getTimings();
    expect(timings).toHaveLength(2);
    expect(timings[0]!.phase).toBe('signing');
    expect(timings[0]!.durationMs).toBe(50);
    expect(timings[1]!.phase).toBe('proving');
    expect(timings[1]!.durationMs).toBe(200);
  });

  it('getTimings returns all completed phases', () => {
    const tracker = createPhaseTracker();
    tracker.start('approve');
    vi.advanceTimersByTime(10);
    tracker.start('building');
    vi.advanceTimersByTime(20);
    tracker.start('signing');
    vi.advanceTimersByTime(30);
    tracker.complete();

    const timings = tracker.getTimings();
    expect(timings).toHaveLength(3);
    expect(timings.map(t => t.phase)).toEqual(['approve', 'building', 'signing']);
  });

  it('callbacks fire on start and complete', () => {
    const onStart = vi.fn();
    const onComplete = vi.fn();
    const tracker = createPhaseTracker({ onStart, onComplete });

    tracker.start('proving');
    expect(onStart).toHaveBeenCalledWith('proving');

    vi.advanceTimersByTime(500);
    tracker.complete();
    expect(onComplete).toHaveBeenCalledWith('proving', 500);
  });

  it('works with no callbacks', () => {
    const tracker = createPhaseTracker();
    tracker.start('a');
    vi.advanceTimersByTime(1);
    tracker.start('b');
    vi.advanceTimersByTime(1);
    tracker.complete();

    expect(tracker.getTimings()).toHaveLength(2);
  });

  it('complete is a no-op when no phase is active', () => {
    const tracker = createPhaseTracker();
    tracker.complete(); // should not throw
    expect(tracker.getTimings()).toHaveLength(0);
  });

  it('getTimings returns a copy (not the internal array)', () => {
    const tracker = createPhaseTracker();
    tracker.start('a');
    vi.advanceTimersByTime(10);
    tracker.complete();

    const t1 = tracker.getTimings();
    const t2 = tracker.getTimings();
    expect(t1).toEqual(t2);
    expect(t1).not.toBe(t2); // different references
  });
});
