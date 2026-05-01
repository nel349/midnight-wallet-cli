// Tracks whether the animated `mn` intro has played in the current shell
// session. Used by the help command to play the cinematic logo materialize
// once per session and render the same layout statically on follow-up calls.
//
// "Session" key resolves in priority order:
//   1. TERM_SESSION_ID  (Apple Terminal sets this for every tab/window)
//   2. ITERM_SESSION_ID (iTerm2 specific)
//   3. parent shell PID (fallback when neither is set, e.g. plain SSH)
//
// Marker lives at $TMPDIR/mn-intro-<session-key>. Lifetime is the OS temp
// directory's lifetime (typically until reboot or system /tmp cleanup),
// which matches the user's expectation of "this session."

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function getSessionKey(): string {
  const raw =
    process.env.TERM_SESSION_ID ??
    process.env.ITERM_SESSION_ID ??
    `pid-${process.ppid}`;
  // Filesystem-safe + bounded length, in case TERM_SESSION_ID contains
  // characters like ':' or unusually long identifiers.
  return raw.replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 64);
}

function getMarkerPath(): string {
  return join(tmpdir(), `mn-intro-${getSessionKey()}`);
}

/** True iff the cinematic intro has already played in this shell session. */
export function hasShownIntroThisSession(): boolean {
  return existsSync(getMarkerPath());
}

/** Drop the marker. Best-effort: tmpfs full / permission errors are swallowed. */
export function markIntroShown(): void {
  try {
    writeFileSync(getMarkerPath(), String(Date.now()));
  } catch {
    /* best-effort, swallow */
  }
}
