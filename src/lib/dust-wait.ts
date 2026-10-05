// Waiting for Dust to cover a fee. The Dust wallet's balance is a function of
// time (registered NIGHT keeps generating), so the wait can be found by
// looking ahead: right after registering 1000 NIGHT a wallet holds ~0.66 DUST
// and a ledger-9 transfer costs ~0.85, a gap 1000 NIGHT closes in ~20 seconds.

import { formatWait } from './dust-registration-plan.ts';
import { toDust } from '../ui/format.ts';

/** What the check reads from the SDK's Dust state. */
export interface DustBalanceSource {
  balance(at: Date): bigint;
}

/** Waits up to this long rather than refusing. */
export const DUST_SHORT_WAIT_MS = 2 * 60_000;
const LOOK_AHEAD_MS = 24 * 3_600_000;

/** Milliseconds until the balance reaches `needed`, in whole seconds: 0 if it already has, null if not within `horizonMs`. */
export function msUntilDust(dust: DustBalanceSource, needed: bigint, now: Date, horizonMs: number): number | null {
  const at = (seconds: number) => dust.balance(new Date(now.getTime() + seconds * 1000));
  if (at(0) >= needed) return 0;
  let high = Math.ceil(horizonMs / 1000);
  if (at(high) < needed) return null;
  let low = 0;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (at(mid) >= needed) high = mid; else low = mid;
  }
  return high * 1000;
}

/** Not enough Dust for the fee, with how long until there is. */
export function dustShortError(have: bigint, needed: bigint, waitMs: number | null): Error {
  const when = waitMs === null
    ? "This wallet's registered NIGHT won't generate that within a day: register more NIGHT (midnight dust register)."
    : `This wallet's NIGHT generates that in ${formatWait(waitMs)}; retry then.`;
  return new Error(`Insufficient dust for transaction fees.\nAvailable: ${toDust(have)} DUST, need ≥${toDust(needed)} DUST.\n${when}`);
}

/**
 * Make sure the Dust balance covers `needed`: return at once when it does,
 * wait when it will within DUST_SHORT_WAIT_MS (reporting how long), and throw
 * dustShortError otherwise. A wallet with no Dust at all is left to the
 * registration path (returns at once).
 */
export async function awaitDustForFee(
  dust: DustBalanceSource,
  needed: bigint,
  onStatus?: (status: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const now = new Date();
  const have = dust.balance(now);
  if (have === 0n || have >= needed) return;
  const waitMs = msUntilDust(dust, needed, now, LOOK_AHEAD_MS);
  if (waitMs === null || waitMs > DUST_SHORT_WAIT_MS) throw dustShortError(have, needed, waitMs);
  onStatus?.(`Waiting ${formatWait(waitMs)} for Dust to cover the fee (${toDust(have)} of ${toDust(needed)} DUST)...`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, waitMs);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Operation cancelled')); }, { once: true });
  });
}
