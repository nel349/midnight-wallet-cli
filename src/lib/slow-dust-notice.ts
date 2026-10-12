// A Dust sync that can't run through the native sidecar runs through the WASM
// reader, several times slower. On a long sync that is minutes the user would
// otherwise spend guessing, so it is worth one line; a short one (a resume near
// the tip, a local chain) says nothing.

/** Events to read above which the reader in use is worth a line: about a minute of WASM reading. */
export const LONG_DUST_SYNC_EVENTS = 50_000;

/**
 * Why a run of the native reader ended in an error, to read after "Native Dust
 * reader". A binary the system can't start (on Linux it needs glibc, so not on
 * Alpine) is told apart from a run that started and failed.
 */
export function whyNativeReaderFailed(error: unknown): string {
  const { code, syscall } = error as NodeJS.ErrnoException;
  if (code !== undefined && String(syscall ?? '').startsWith('spawn')) return `can't start on this system (${code})`;
  const message = error instanceof Error ? error.message : String(error);
  return `failed (${message.split('\n')[0].slice(0, 120)})`;
}

/** The line itself. `why` reads after "Native Dust reader": "not installed (...)", "failed (...)". */
export function slowDustReaderNotice(why: string): string {
  return `Native Dust reader ${why}: reading with the built-in one, several times slower on a long sync. See "Native dust acceleration" in the README.`;
}

/**
 * A progress callback that passes every call on, and calls `say` once: the
 * first time the events this read has to cover exceed `LONG_DUST_SYNC_EVENTS`.
 */
export function sayOnLongSync(
  startFromId: number,
  onProgress: ((applied: number, max: number) => void) | undefined,
  say: () => void,
): (applied: number, max: number) => void {
  let said = false;
  return (applied, max) => {
    if (!said && max + 1 - startFromId > LONG_DUST_SYNC_EVENTS) {
      said = true;
      say();
    }
    onProgress?.(applied, max);
  };
}
