// The owner's commands on the account, over the account package: what the
// account holds, its grants, and issuing and revoking them. Each gives a
// result (the JSON `--json` prints, its amounts as decimal text) and the lines
// a person reads, the same as mn has printed them since mn grant began.
//
// status and list read the account without a wallet; an issue shown but not
// confirmed reads only its link. Issuing and revoking run in an owner session
// whose fees the wallet pays.

import { randomBytes } from 'node:crypto';
import { NIGHT } from '@kuiralabs/midnight-account-chain/contract';
import {
  type GrantRequest,
  type OwnerView,
  type Session,
  exhaustedGrants,
  grantRequestFromLink,
  issueReadGrant,
  revokeEveryGrant,
  revokeReadGrant,
  sealedResponseLink,
  termsFor,
} from '@kuiralabs/midnight-account-chain/owner';
import { UsageError } from '../errors.ts';
import type { GrantLimits as RequestedLimits } from './request.ts';

/** What a command gives: its result, and the lines a person reads. */
export interface OwnerCommandOutput {
  result: Record<string, unknown>;
  lines: string[];
}

const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** The limits mn grants an agent unless told otherwise: Night, 0.3 per payment, 0.5 in all, coins of up to 2, for a day. */
export const DEFAULT_GRANT_LIMITS = { perCallCap: 300_000n, cap: 500_000n, maxCoinValue: 2_000_000n, expiresInSeconds: 24 * 60 * 60 } as const;

/** Section 4.2's recipient kinds, as a request names its payee. */
const ANY_COIN_KEY = 0;
const CONTRACT = 3;

const secondsOf = (date: Date): bigint => BigInt(Math.floor(date.getTime() / 1000));

/** The account as its owner reads it; `code` names this machine's device. */
export function statusOf(view: OwnerView, arm: string, code: string): OwnerCommandOutput {
  const { ledger } = view;
  const unspent = view.coins.filter((coin) => !coin.isSpent);
  const held = new Map<string, bigint>();
  for (const coin of unspent) held.set(hexOf(coin.color), (held.get(hexOf(coin.color)) ?? 0n) + coin.value);
  const useCounter = view.useCounter ?? 0n;
  const result = {
    account: view.address,
    device: { arm, code, useCounter: useCounter.toString() },
    devices: ledger.device_count.toString(),
    authNonce: ledger.auth_nonce.toString(),
    encKey: hexOf(ledger.enc_key),
    grants: ledger.grants.size().toString(),
    held: Object.fromEntries([...held].map(([color, value]) => [color, value.toString()])),
  };
  return {
    result,
    lines: [
      `account ${view.address}`,
      `device ${arm}, use counter ${useCounter}; ${ledger.device_count} device(s); auth_nonce ${ledger.auth_nonce}`,
      `this machine's device: ${code}`,
      `enc_key ${result.encKey}`,
      ...[...held].map(([color, value]) => `holds ${value} of color ${color} in ${unspent.filter((coin) => hexOf(coin.color) === color).length} coin(s)`),
      `${ledger.grants.size()} grant record(s)`,
    ],
  };
}

export function grantsOf(view: OwnerView, now: Date): OwnerCommandOutput {
  const { ledger, roster } = view;
  const exhausted = new Set(exhaustedGrants(ledger, roster, now).map((entry) => entry.grantId));
  const listed = new Map(roster.entries.map((entry) => [entry.grantId, entry] as const));
  const nowSeconds = secondsOf(now);
  const rows = [...ledger.grants].map(([id, record]) => {
    const grantId = hexOf(id);
    const entry = listed.get(grantId);
    return {
      grantId,
      slot: entry?.slot,
      roster: entry?.status ?? 'not in the roster',
      active: record.active,
      expired: record.scope.expires_at !== 0n && nowSeconds >= record.scope.expires_at,
      nonce: record.nonce.toString(),
      perCallCap: record.scope.per_call_cap.toString(),
      cap: record.scope.cap.toString(),
      expiresAt: record.scope.expires_at.toString(),
      read: record.scope.read,
      exhausted: exhausted.has(grantId),
    };
  });
  const lines = rows.map(
    (row) =>
      `${row.grantId} slot ${row.slot ?? '?'}: ${row.active ? (row.expired ? 'expired' : 'live') : 'revoked'} (${row.roster}), `
      + `${row.nonce} spend(s), per-call ${row.perCallCap}, cap ${row.cap}${row.read ? ', read' : ''}${row.exhausted ? ', spent to its cap' : ''}`,
  );
  if (exhausted.size > 0) {
    lines.push(`${exhausted.size} live grant(s) are spent to their cap: they can never pay again, yet every rotation re-seals to them.`);
  }
  return { result: { grants: rows }, lines };
}

/** A grant request read from its link; a link that isn't one is a usage error. */
export function grantRequestOf(link: string): GrantRequest {
  try {
    return grantRequestFromLink(link);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

/** The limits an issue sets: those given, mn's defaults for the rest. */
function limitsOf(requested: RequestedLimits) {
  return {
    color: NIGHT,
    perCallCap: requested.perCall === undefined ? DEFAULT_GRANT_LIMITS.perCallCap : BigInt(requested.perCall),
    cap: requested.cap === undefined ? DEFAULT_GRANT_LIMITS.cap : BigInt(requested.cap),
    maxCoinValue: requested.maxCoin === undefined ? DEFAULT_GRANT_LIMITS.maxCoinValue : BigInt(requested.maxCoin),
    expiresInSeconds: requested.expiresIn === undefined ? DEFAULT_GRANT_LIMITS.expiresInSeconds : Number(requested.expiresIn),
  };
}

/**
 * The caller pin as the grants draft has it confirmed (section 9): the full
 * contract address and what pinning it means, or that any caller may spend.
 */
function callerTerm(caller: Uint8Array | undefined): string {
  if (caller === undefined) return 'via any caller';
  return `via contract ${hexOf(caller)} only: the agent spends only when that contract calls the account, and that call is public on chain`;
}

/** What an issue would grant, before anything is signed: the terms a person confirms. */
export function issueTerms(request: GrantRequest, requested: RequestedLimits, now: Date) {
  const terms = termsFor(request, limitsOf(requested), now);
  const asked = {
    account: request.account,
    clientId: request.clientId,
    slot: request.slot,
    grantee: request.granteeKey.arm,
    payee: request.payToKind === ANY_COIN_KEY ? 'any shielded coin key' : `${request.payToKind === CONTRACT ? 'contract' : 'coin key'} ${hexOf(request.payTo)}`,
    caller: callerTerm(request.caller),
    perCallCap: terms.perCallCap.toString(),
    cap: terms.cap.toString(),
    maxCoinValue: terms.object.maxCoinValue.toString(),
    expires: new Date(Number(terms.expiresAt) * 1000).toISOString(),
  };
  return { terms, asked, askedLines: Object.entries(asked).map(([name, value]) => `  ${name}: ${value}`) };
}

export function issuePreview(request: GrantRequest, requested: RequestedLimits, now: Date): OwnerCommandOutput {
  const { asked, askedLines } = issueTerms(request, requested, now);
  return { result: { confirmed: false, request: asked }, lines: ['the request asks for:', ...askedLines, 're-run with --yes to issue it'] };
}

export async function issue(session: Session, request: GrantRequest, requested: RequestedLimits, now: Date): Promise<OwnerCommandOutput> {
  const { terms, asked } = issueTerms(request, requested, now);
  const issued = await issueReadGrant(session, request, terms, new Uint8Array(randomBytes(32)));
  const fallbackLink = sealedResponseLink(issued);
  // A grant an interrupted run had issued keeps that run's terms: say those, not the ones asked for now.
  const granted = issued.resumed
    ? { ...asked, perCallCap: issued.scope.perCallCap.toString(), cap: issued.scope.cap.toString(), maxCoinValue: issued.scope.object.maxCoinValue.toString(), expires: new Date(Number(issued.scope.expiresAt) * 1000).toISOString() }
    : asked;
  const grantedLines = Object.entries(granted).map(([name, value]) => `  ${name}: ${value}`);
  return {
    result: { confirmed: true, grantId: hexOf(issued.grantId), request: granted, fallbackLink, ...(issued.resumed ? { resumed: true } : {}) },
    lines: [
      issued.resumed ? `issued ${hexOf(issued.grantId)} in an earlier run that was interrupted, with these terms:` : `issued ${hexOf(issued.grantId)}:`,
      ...grantedLines,
      "the response is in the grant mailbox; if the agent cannot read the chain, give it this link (midnight-mandate's receive_grant takes it):",
      fallbackLink,
    ],
  };
}

export async function revoke(session: Session, target: string): Promise<OwnerCommandOutput> {
  const { revoked, alreadyRevoked } = await revokeReadGrant(session, target);
  const [grantId] = revoked;
  if (grantId !== undefined) return { result: { revoked: hexOf(grantId) }, lines: [`revoked ${hexOf(grantId)}`] };
  // Already revoked, by an earlier run (one interrupted after its revocation
  // landed is finished first, rotation included): nothing is left to do.
  return { result: { alreadyRevoked }, lines: alreadyRevoked.map((id) => `already revoked: ${id}`) };
}

export async function revokeAll(session: Session): Promise<OwnerCommandOutput> {
  await revokeEveryGrant(session);
  return { result: { revokedAll: true, generation: (await session.readLedger()).grant_generation.toString() }, lines: ['revoked every grant'] };
}
