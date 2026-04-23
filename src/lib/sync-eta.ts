// Rolling-window ETA estimator for wallet sync.
// Takes a series of (applied, highest, t) samples and reports current rate +
// estimated time remaining. Pure module — callers own the timestamps and
// call .sample() on each progress callback.

export interface EtaSample {
  applied: number;
  highest: number;
  /** Monotonic-ish timestamp in ms (e.g. Date.now()). */
  t: number;
}

export interface EtaSnapshot {
  /** Current applied-events count (mirrors the latest sample). */
  applied: number;
  /** Current highest index (mirrors the latest sample). */
  highest: number;
  /** 0–100 or null if highest is 0. */
  percent: number | null;
  /** Events per second over the rolling window, or null if insufficient samples. */
  ratePerSec: number | null;
  /** Estimated seconds remaining, or null if no rate / no remaining work. */
  etaSec: number | null;
}

/** Default rolling window — longer smooths noise, shorter responds faster to slowdowns. */
const DEFAULT_WINDOW_MS = 15_000;
/** Ignore samples older than this when computing rate. */
const MAX_WINDOW_MS = 60_000;

export interface EtaEstimatorOptions {
  /** Samples older than this are dropped from the rate calculation. */
  windowMs?: number;
}

export interface EtaEstimator {
  sample(s: EtaSample): EtaSnapshot;
  snapshot(): EtaSnapshot | null;
  /** Reset state — useful when a new sync phase starts. */
  reset(): void;
}

export function createEtaEstimator(opts: EtaEstimatorOptions = {}): EtaEstimator {
  const windowMs = Math.min(Math.max(opts.windowMs ?? DEFAULT_WINDOW_MS, 1_000), MAX_WINDOW_MS);
  const samples: EtaSample[] = [];
  let latest: EtaSnapshot | null = null;

  const trim = (now: number) => {
    const cutoff = now - windowMs;
    while (samples.length > 0 && samples[0].t < cutoff) samples.shift();
  };

  const compute = (): EtaSnapshot => {
    const last = samples[samples.length - 1];
    const first = samples[0];
    const percent = last.highest > 0 ? Math.min(100, Math.round((last.applied / last.highest) * 100)) : null;

    // Need at least 2 samples spanning ≥ 1s to estimate a rate.
    let ratePerSec: number | null = null;
    let etaSec: number | null = null;
    if (samples.length >= 2) {
      const deltaEvents = last.applied - first.applied;
      const deltaMs = last.t - first.t;
      if (deltaMs >= 1_000 && deltaEvents > 0) {
        ratePerSec = deltaEvents / (deltaMs / 1_000);
        const remaining = Math.max(0, last.highest - last.applied);
        etaSec = remaining > 0 ? remaining / ratePerSec : 0;
      }
    }

    return { applied: last.applied, highest: last.highest, percent, ratePerSec, etaSec };
  };

  return {
    sample(s) {
      samples.push(s);
      trim(s.t);
      latest = compute();
      return latest;
    },
    snapshot() {
      return latest;
    },
    reset() {
      samples.length = 0;
      latest = null;
    },
  };
}

/**
 * Format a snapshot into a one-line status string for display.
 * Omits rate/ETA if not yet known; omits percent if highest=0.
 */
export function formatSyncStatus(snap: EtaSnapshot, label = 'Syncing'): string {
  const parts: string[] = [label];
  if (snap.percent !== null) {
    parts.push(`${snap.percent}%`);
  } else if (snap.highest === 0) {
    parts.push(`${snap.applied} events`);
  }
  if (snap.etaSec !== null && snap.etaSec > 0) {
    parts.push(`ETA ${formatDuration(snap.etaSec)}`);
  }
  if (snap.ratePerSec !== null && snap.ratePerSec > 0) {
    parts.push(`${Math.round(snap.ratePerSec)} evt/s`);
  }
  return parts.join(' · ');
}

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '?';
  if (sec < 60) return `${Math.ceil(sec)}s`;
  const minutes = Math.floor(sec / 60);
  const seconds = Math.round(sec - minutes * 60);
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes - hours * 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}
