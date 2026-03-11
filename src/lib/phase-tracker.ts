// Phase tracker — pure logic module for timing multi-step operations
// No console, no spinner, no notifications — callbacks let callers wire in side effects

export interface PhaseTiming {
  phase: string;
  durationMs: number;
}

export interface PhaseTracker {
  /** Begin a new phase. Auto-completes the previous phase if one is active. */
  start(phase: string): void;
  /** Complete the current phase. */
  complete(): void;
  /** Return all completed phase timings. */
  getTimings(): PhaseTiming[];
}

export interface PhaseCallbacks {
  onStart?: (phase: string) => void;
  onComplete?: (phase: string, durationMs: number) => void;
}

export function createPhaseTracker(callbacks?: PhaseCallbacks): PhaseTracker {
  const timings: PhaseTiming[] = [];
  let currentPhase: string | undefined;
  let phaseStart: number | undefined;

  function complete(): void {
    if (currentPhase !== undefined && phaseStart !== undefined) {
      const durationMs = Date.now() - phaseStart;
      timings.push({ phase: currentPhase, durationMs });
      callbacks?.onComplete?.(currentPhase, durationMs);
      currentPhase = undefined;
      phaseStart = undefined;
    }
  }

  function start(phase: string): void {
    // Auto-complete previous phase
    complete();
    currentPhase = phase;
    phaseStart = Date.now();
    callbacks?.onStart?.(phase);
  }

  function getTimings(): PhaseTiming[] {
    return [...timings];
  }

  return { start, complete, getTimings };
}
