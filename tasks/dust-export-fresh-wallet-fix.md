# Fix: `mn dust export` on a brand-new wallet

## Two different "cold starts"

The design anonboard established is right, and this fix does not change it:

> **`mn` absorbs the cold start** — it builds the dust state from genesis once and
> persists it — **and then hands the SDK wallet a warm prime**, so the SDK wallet
> never cold-syncs at all.

But that sentence contains two separate cold starts, and they fail independently:

1. **The SDK wallet is cold** — the dApp process has no dust state. This is the one
   anonboard was built to solve, and it solves it: `DustWallet.restore(snapshot)`
   means the SDK never replays anything.
2. **`mn`'s own cache is cold** — `~/.midnight/cache/<network>/dust-<pubkey>.json`
   does not exist, so `mn` itself must replay from event 0.

0.5.0 handles (1) correctly. It is (2) that was broken — and anonboard never
exercised it. Verified: anonboard's preprod wallet derives to dust public key
`1849040121abe21c3bcb…`, and a cache file for exactly that key already existed on
the machine (it is the same wallet as `mn`'s `alice`). So every `mn dust export`
anonboard ever ran was a **delta** against a cache someone had already built by
using `mn` normally. Hence the "~5–9 s" in its docs. That number is real, and it is
the warm path.

A developer scaffolding a starter app has no `~/.midnight/cache` at all. They land
on (2) — `mn`'s first-ever replay of 1.45M preprod events — which is exactly where
0.5.0 broke, in two independent ways, both from the same root cause: `dust export`
reimplemented the sync instead of using the repository seam the rest of the CLI
goes through.

## Measured, on preprod (1,450,904 dust events at time of writing)

| | before | after |
|---|---|---|
| offset reached | 686,503 | **1,450,929 (tip)** |
| `partial` reported | *field did not exist* | **false** |
| exit code | 0 | 0 |
| wall time | 600 s (soft timeout) | **310 s** |

A fresh-seed run before the fix, verbatim:

```json
{ "offset": 686503, "eventCount": 673996, "fromCache": false }
```

Exit 0. No indication anything was missing.

## Defect 1 — the export never reached the native sidecar

The call chain was:

    dust export → exportDustSnapshot → primeDustCache → readDustBalanceDirect

`readDustBalanceDirect` is the WASM reader. The native Rust sidecar (~5× faster,
see `dust-native-sidecar-plan.md`) is wired into `WalletDataRepository`'s
`fetchDust` seam via `nativeOrWasmDustFetcher` — which `dust export` bypassed
entirely.

Measured replay rates on preprod: WASM ~1,050 events/s, native ~5,100 events/s.
Over 1.45M events that is ~22 min versus ~5 min. So the one command a dApp
integrates for a fast cold prime was the one command that could not use the
accelerator.

## Defect 2 — the export truncated silently at 600 s

`readDustBalanceDirect` has a soft `timeoutMs` (default 600 s). By design it does
not throw on expiry: it resolves with `partial: true` and whatever state it has,
so the caller can persist the checkpoint and resume. That contract was never
honoured here:

- `primeDustCache` ignored `result.partial`.
- `DustExportResult` had no `partial` field, so `dust export` could not report it.
- The `--json` payload had no `partial` key, so a programmatic consumer could not
  read it either.

The consequence is the worst kind: a fresh wallet's export exits 0 with a
structurally valid snapshot that is **half the chain behind**. A consumer —
anonboard's `primeDustSnapshotViaMn`, or a scaffolded app — restores it, the
wallet looks warm, and the SDK then quietly cold-syncs the remaining ~764k events.
That is precisely the failure this command exists to prevent, dressed as success.

The retry loop that fixes this already existed. `WalletDataRepository.dust()` runs
a bounded partial-resume loop (`DUST_PARTIAL_RETRIES = 6`), each iteration
resuming from the persisted checkpoint. `dust export` bypassed that too.

## The fix

Route `exportDustSnapshot` through `WalletDataRepository.dust()` instead of
calling the reader directly. That single change picks up, for free:

- the native sidecar (via `nativeOrWasmDustFetcher`),
- the partial-resume loop,
- the chain-reset (genesis-hash) cache guard,
- per-chunk checkpoint persistence.

It removes duplicated logic rather than adding any: `dust-export.ts` got smaller
in behaviour-carrying code.

Then surface what the repository knew and was discarding:

- `DustView` gains `partial` and `lastAppliedEventId`. `dust()` computed both and
  threw them away; `lastAppliedEventId` in particular lived nowhere else, which is
  why the old export had to re-read the cache file to find the snapshot offset.
- `DustExportResult.partial` is set from it, `--json` carries it, and the human
  output prints a loud warning plus an "incomplete" spinner label.

`exportDustSnapshot` now reads state and offset off the returned view instead of
re-reading the cache file from disk, so it no longer assumes the repository's
cache directory matches its own.

## Two consequential fixes found on the way

**`ReadOptions.onProgress` was documented for dust but never called.** Its doc
comment says "for dust this fires per-chunk (events applied vs max event id)";
`dust()` only ever called `onStatus`. Nothing noticed because no caller used it —
until `dust export` did, and showed a motionless spinner for a five-minute sync.
`dust()` now forwards it as documented.

**A completed sync could be discarded by a 3 s RPC timeout.** Both `dust()` and
`unshielded()` ended with a bare `await this.getTip(...)` to stamp the memo entry.
If the node was unreachable, that threw — *after* a 5–22 minute sync that had
already been written to disk. `tryMemo` already took the opposite stance ("network
down on the tip-check → serve cache"), so this was an inconsistency, not a
deliberate choice. Both paths now go through a `memoize()` helper that treats a
tip failure as "skip the memo", never as an error.

## What this does not fix

The shielded sub-wallet. `waitForSyncedState()` waits on shielded, unshielded and
dust; this work only removes dust from the critical path. `shielded-direct.ts`
already has a bounded-memory reader (~155 MB on preview versus the SDK's 16 GB
OOM), but there is no `mn shielded export` and no facade-snapshot overlay for it.
That is the next gap, and it needs its own investigation.

Nor does it change the underlying economics: a first sync is still O(1.45M events).
The real fix is upstream — collapsed dust updates from the indexer, or the
viewing-key subscription sync tracked in ledger#276 / midnight-wallet#285 / #288.
This makes the one-time cost survivable (~5 min, bounded memory, resumable)
instead of unbounded.

## Packaging caveat

The native sidecar is **not published**. `package.json`'s `files` is
`["dist", "docs/SKILL.md", "NOTICE"]`, and `@midnight-wallet-cli/dust-sync-<os>-<arch>`
404s on npm. So an npm-installed `mn` resolves no binary and falls back to WASM:
~22 min rather than ~5 min for a fresh preprod wallet. Both are finite and
resumable, which the SDK's own cold sync is not — but the headline number needs
the optional platform packages from `dust-native-sidecar-plan.md` to actually ship.

Until then a developer can point at a local build:

```sh
export MN_DUST_SYNC_BIN=/path/to/midnight-wallet-cli/sidecar/dust-sync/target/release/dust-sync
```

## Files touched

    src/lib/dust-export.ts             — route through the repository; expose `partial`
    src/lib/wallet-data-repository.ts  — DustView.partial + .lastAppliedEventId;
                                         forward onProgress; non-fatal memo writes
    src/commands/dust.ts               — surface `partial` in --json and human output;
                                         live progress counter
    src/lib/facade.ts                  — narrow overlayDustDirectSnapshot's parameter
                                         to what it actually reads
    src/__tests__/wallet-data-repository.test.ts — 4 new tests
