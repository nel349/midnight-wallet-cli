// Waiting for Dust to cover a fee. The Dust wallet's balance is a function of
// time (registered NIGHT keeps generating), so the wait can be found by
// looking ahead: right after registering 1000 NIGHT a wallet holds ~0.66 DUST
// and a ledger-9 transfer costs ~0.85, a gap 1000 NIGHT closes in ~20 seconds.

import { formatWait } from './dust-registration-plan.ts';
import { DUST_RETRY_DELAY_MS } from './constants.ts';
import { dustShortfallOf } from './sdk-errors.ts';
import { roughDust, toDust } from '../ui/format.ts';

/** What the check reads from the SDK's Dust state. */
export interface DustBalanceSource {
  balance(at: Date): bigint;
}

/** Waits up to this long rather than refusing. */
export const DUST_SHORT_WAIT_MS = 2 * 60_000;
/**
 * How long a serve that mn starts for one of its own commands waits (contract
 * deploy and call, a test suite, grant): the person who ran the command sees
 * the wait and can stop it, and five minutes covers a 1000 NIGHT wallet's
 * next fee after it paid one (a deploy takes about 1.65 DUST on a local
 * ledger-9 chain, generated in a little over three minutes).
 */
export const OWN_COMMAND_DUST_WAIT_MS = 5 * 60_000;
/** How far ahead a wait is looked for: past it, the wallet's NIGHT won't generate the Dust in useful time. */
export const LOOK_AHEAD_MS = 24 * 3_600_000;

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
  await sleep(waitMs, signal);
}

/** A fee the wallet's Dust doesn't cover yet: what it has, what the fee takes, and how long its NIGHT needs for the rest (null: not within a day). */
export interface DustWaitPlan {
  have: bigint;
  needed: bigint;
  waitMs: number | null;
}

/**
 * The wait for a Dust shortage that says what the wallet is short by (mn's
 * fee planner marks its shortages so): how long the balance takes to grow by
 * that much. The shortfall is measured on the wallet's clock for the chain,
 * which needn't be this machine's, so it is the growth that is timed, not a
 * balance to reach. Undefined when the error carries no shortfall.
 */
export function planDustWait(err: unknown, dust: DustBalanceSource, now: Date): DustWaitPlan | undefined {
  const shortfall = dustShortfallOf(err);
  if (!shortfall || shortfall.available >= shortfall.needed) return undefined;
  const { needed, available: have } = shortfall;
  // A little over the shortfall, and never a wait too short to matter: the
  // fee is worked out again at the next attempt and moves by a few parts in
  // a thousand, which would otherwise be a string of one-second waits.
  const target = dust.balance(now) + (needed - have) * 102n / 100n;
  const waitMs = msUntilDust(dust, target, now, LOOK_AHEAD_MS);
  return { have, needed, waitMs: waitMs === null ? null : Math.max(waitMs, DUST_RETRY_DELAY_MS) };
}

/**
 * Run `pay`, a wallet call that pays a fee. When it fails because the Dust
 * doesn't cover the fee yet, wait for the wallet's NIGHT to generate the rest
 * and run it again: for as long as the waits fit in `maxWaitMs`, reporting
 * each; past that, dustShortError with the time. Any other failure is thrown
 * as it is.
 */
export async function payWhenDustCovers<T>(
  pay: () => Promise<T>,
  dust: DustBalanceSource,
  options: { maxWaitMs: number; onStatus?: (status: string) => void; signal?: AbortSignal },
): Promise<T> {
  let waitedMs = 0;
  for (;;) {
    try {
      return await pay();
    } catch (err) {
      const plan = planDustWait(err, dust, new Date());
      if (!plan) throw err;
      if (plan.waitMs === null || waitedMs + plan.waitMs > options.maxWaitMs) throw dustShortError(plan.have, plan.needed, plan.waitMs);
      options.onStatus?.(`Waiting ${formatWait(plan.waitMs)} for Dust to cover the fee (${roughDust(plan.have)} of ${roughDust(plan.needed, true)} DUST)...`);
      await sleep(plan.waitMs, options.signal);
      waitedMs += plan.waitMs;
    }
  }
}

/** Wait `ms`; reject with "Operation cancelled" if `signal` aborts first (or already has). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('Operation cancelled'));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new Error('Operation cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
