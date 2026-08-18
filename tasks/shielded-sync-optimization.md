# Plan: make shielded (zswap) sync super fast (preview/preprod)

Target: next release. Goal: kill the slow shielded sync on hosted networks.

## Spike results (verified on real preprod — 2026-08-17)

Ran the collapsed path end-to-end against `indexer.preprod.midnight.network`
(`.shielded-spike/probe1-connect.ts`, `probe2-sync.ts`):

- **`connect` handshake works.** The `ViewingKey` scalar is the **bech32m** encryption
  secret key (`mn_shield-esk_preprod1…`, via `ShieldedEncryptionSecretKey.codec` + network
  id) → returns a `sessionId`. Raw hex is rejected.
- **Fresh/empty wallets sync in ~0.9 s.** bob, alice, test, test1, kuiraval — all reached
  the preprod tip (index **19,222**) in **~0.9 s** with **0 relevant transactions** (they
  have no shielded history). This is the exact case servicedesk#104 measured at **~2 hours**
  via full replay. **~1 s vs ~2 h.**
- **The path processes only relevant txs**, not the whole event log — the indexer streams
  progress + (for a wallet with coins) relevant transactions interleaved with
  `collapsedMerkleTree` deltas.
- **Cold index build is a one-time server-side cost.** The first `connect` for a never-seen
  viewing key triggers the indexer to scan history and build the wallet's relevance index
  (observed one first-connect exceed 120 s, then ~1 s once warm). It's server-side and
  cached — the *client* never replays everything either way. Verify this scan time at
  mainnet scale.
- **Feasibility confirmed.** `ledger-v8` 8.1.0 has every API needed: `applyCollapsedUpdate`,
  `apply(secretKeys, offer)` (coins from `transaction.guaranteedOffer`/`fallibleOffer`),
  `removeCoinByNullifier`, `merkleTreeRoot`, `serialize/deserialize`. (ledger#276's
  `applyTransactionWithChanges` is just a convenience wrapper we don't need.)

**Coin-apply verified end-to-end (localnet, `probe3-correctness.ts`):** connect →
subscribe → `deserializeSealed(tx.raw)` → `apply(secretKeys, guaranteedOffer/fallibleOffer)`
→ `applyCollapsedUpdate(gap)`. Against a shielded-holding wallet it tracked the **exact coin
count (7 ✅)** — the mechanism works.

**One correctness caveat, reproduced and diagnosed (the #994 requirement):** balance came out
**350M vs the full-sync 250M** because `shieldedTransactions` delivers **outputs only** — it
never removes **spent** coins. Fix, in two parts:
1. For a spend that rides in a tx which also has an output for us (has a `collapsedMerkleTree`
   / is "relevant"), remove it from the tx's own offer: iterate `offer.inputs[].nullifier` →
   `state.removeCoinByNullifier(...)`. (Added to the probe.)
2. For a **spend-only** tx (no output for us, so `shieldedTransactions` never sends it), we
   need the separate **`shieldedNullifierTransactions`** subscription (#994) →
   `removeCoinByNullifier`. The installed `wallet-sdk-indexer-client` predates #994 (no typed
   subscription), and the localnet indexer has introspection disabled — so we must pull the
   exact query shape from the indexer schema/source when building.

**Final balance-exact check was blocked by environment, not the approach:** the localnet
shielded sync (needed to fund a clean receive-only test wallet) repeatedly `SYNC_TIMEOUT`'d —
the very slowness this work fixes — and the localnet indexer then crashed (the SPO restart
race). To finish: on a healthy localnet, fund a **receive-only** wallet (no spends) and assert
collapsed-sync balance + `merkleTreeRoot` == full-sync — that isolates output-tracking from the
spend/nullifier piece and should match exactly.

**Verdict: green-light.** The dominant cost — first sync of a new wallet — drops from ~2 h to
~1 s, exactly as the maintainers' roadmap (wallet#285) predicts.

## Where the time actually goes

- **Restart is already incremental.** The CLI persists the shielded snapshot with
  `offset = progress.appliedIndex` and, on restore, resumes `ZswapEvents.run({ id:
  appliedIndex })` — it does **not** re-scan from genesis when the cache is warm
  (`wallet-sdk-shielded/dist/v1/Serialization.js:64,71`, `Sync.js:96-100,118,130`).
- **The first / cold sync is the killer.** With no cache the SDK subscribes to
  `zswapLedgerEvents` from index 0 and replays **every** zswap event on chain via
  `replayEventsWithChanges` (`Sync.js:100,127`). On preview/preprod that's the whole
  global commitment log — minutes of download + WASM replay, and the memory spike that
  currently forces `heap-guard.ts` to re-exec with 16 GB.

So "sync is slow" ≈ "first sync replays the entire zswap event log." Restart is fine.

## Why Kuira doesn't already solve it (studied the Android wallet)

Kuira (`kuira-android-wallet`) does the **same** full-event replay of `zswapLedgerEvents`.
Its wins are all on the *restart* path, which we already have:
- checkpoint = {serialized state + last-applied event id}, atomic write, tip-vs-cursor
  routing (AT_TIP → skip network, DELTA → replay only new, FULL → genesis).
- the ledger SDK already **collapses non-wallet commitments during replay**
  (`merkle_tree.collapse(mt_index, mt_index)` per foreign output), so the persisted tree
  stays small and deserialize doesn't rehash from genesis.
- streams events to a temp file + replays in 500-event chunks to avoid one giant buffer
  and GC stalls.

Kuira's **first sync is still a genesis replay** — it has no faster path. So Kuira is a
good reference for restart robustness and for the memory/streaming technique, but it is
**not** the answer to fast first sync.

## The lever: the indexer's collapsed shielded path (exists, unused)

The indexer already offers a server-side-collapsed sync for zswap — and neither the SDK's
default sync nor Kuira uses it:

- Subscription `shieldedTransactions(sessionId, index)`
  (`wallet-sdk-indexer-client/.../ShieldedTransactions.js`) returns, per step:
  - `RelevantTransaction` — a transaction that actually touches **our** wallet
    (`transaction { raw, startIndex, endIndex, … }`), plus
  - `collapsedMerkleTree { startIndex, endIndex, update }` — a **collapsed Merkle delta
    for the gap** of foreign commitments we skipped.
  - `ShieldedTransactionsProgress` — `highestEndIndex` / `…CheckedEndIndex` /
    `…RelevantEndIndex` to know when caught up.
- The wallet registers its viewing key once via the `connect(viewingKey) → sessionId`
  mutation (`indexer-client/.../queries/Connect.js`); the indexer then scans on our behalf.
- `ledger-v8` `ZswapLocalState` has exactly the apply APIs: `applyCollapsedUpdate(update)`,
  `replayEvents(secretKeys, events)`, `watchFor`, `serialize/deserialize`, `firstFree`,
  `merkleTreeRoot`. `MerkleTreeCollapsedUpdate.deserialize(bytes)` builds the update.
- `CoreWallet.applyCollapsedUpdate` is defined in the shielded SDK but has **no caller**
  — the fast path is shipped and wired to nothing.

**Why this is the win:** instead of downloading and replaying *every* commitment, the
wallet receives only its own relevant transactions plus one collapsed hash per foreign
gap. On a busy chain that is orders of magnitude less data and WASM work — fast first
sync **and** small persisted state — and it removes the memory spike that heap-guard
currently brute-forces.

This is the exact shape of the win we already shipped for **dust** (`dust-direct.ts`
bypasses the SDK's dust sync and manages the state ourselves), except here the indexer
does the collapsing for us, so it's less client-side work than dust was.

## Plan

Mirror the dust-direct pattern for shielded: a direct reader that consumes the collapsed
subscription and produces a `ZswapLocalState`, bridged into the facade's shielded snapshot.

- **Phase 1 — shielded-direct reader.** New lib that: `connect(viewingKey) → sessionId`;
  subscribes `shieldedTransactions(sessionId, index)`; for each `RelevantTransaction`,
  `applyCollapsedUpdate` over the gap then apply our coins from the relevant tx; tracks
  progress; checkpoints {serialized `ZswapLocalState` + index} atomically (same shape as
  the dust cache). Resume from the saved index. Own coins preserved; foreign ranges are
  collapsed hashes.
- **Phase 2 — bridge into the facade.** Overlay the direct-built `ZswapLocalState` into
  the facade's shielded snapshot before restore (mirror `maybeBridgeDustCache`), so
  `balance`/`transfer` get the fast-synced state with no change to the facade API.
- **Phase 3 — verify + fall back.** Prove the collapsed-synced state matches a full-replay
  state (balance, coin set, `merkleTreeRoot`) on localnet + preprod; keep the SDK full
  replay as an automatic fallback if the collapsed path errors or the indexer lacks it.
- **Secondary (Kuira-inspired, cheap):** apply in bounded chunks and avoid one giant event
  buffer; the collapsed path already downloads far less, so this mainly hardens memory and
  lets us drop / relax the 16 GB heap-guard re-exec for shielded.

## Risks / open questions

- **Session lifecycle.** `connect` returns a session the indexer maintains; need
  `disconnect` on teardown and to handle session expiry / reconnect mid-sync.
- **Protocol version.** `collapsedMerkleTree.update` and `transaction.raw` carry a
  `protocolVersion`; confirm it matches our `ledger-v8` (8.1.0) wire format before trusting
  `applyCollapsedUpdate`. (Kuira pins 8.0.3 / event v9 — verify ours.)
- **Applying own coins from a RelevantTransaction.** Confirm the exact call to turn a
  relevant `transaction.raw` into the coins our `ZswapLocalState` should track (deserialize
  → `replayEvents` with secret keys vs `watchFor`), and that it composes with the collapsed
  gap ordering (indices must stay linear, like dust's frontier rule).
- **Indexer support on all targets.** Confirm preview + preprod indexers serve
  `shieldedTransactions` (localnet indexer 4.3.3 does); fall back to full replay if not.
- **Correctness guard.** As with dust, verify (balance + `merkleTreeRoot`) after building
  the collapsed state and fall back to full replay on mismatch — never ship a wrong balance.

## Not this (noted, unrelated)

The Discord `partitionTranscripts` / `LedgerParameters` byte-patch Max shared is about
forcing contract-call batches into the fallible stage (transaction partitioning), not
shielded sync. Out of scope here.

## GitHub issues (midnightntwrk) — deep dive

**This plan IS the maintainers' roadmapped direction.** The collapsed viewing-key sync is
specced and the indexer half is already merged; only the ledger-WASM and SDK-consumer
halves are still open — which is why we'd build the consumer ourselves for next release.

- **servicedesk#104** (closed) — fresh Preprod wallet "sync from genesis and full history
  regardless of having no prior transactions… no tip-start or snapshot path available." The
  OOM was fixed in wallet-sdk **1.2.0** (peak RSS 430 MB), but the confirming re-test still
  took **125 minutes** to reach `appliedIndex=1,298,060`. This is our exact problem, documented.
- **servicedesk#145** (closed), **midnight-wallet#648** (open), **#405** (open) — more
  shielded first-sync OOM / hang / RPC-stall reports on preprod/preview. #648: sync can
  never complete once a real tx is pending (`pickAllCoins→replayEvents` retry loop).
- **midnight-wallet#285** (OPEN) — "Subscription-based sync for shielded wallet": the full
  design. `connect` → session → `shieldedTransactions` (`replayEventsWithChanges` for txs +
  **`applyCollapsedUpdate`** for the gaps) → **`shieldedNullifierTransactions`** to catch
  spends → fetch a fresh collapsed update before spending. Fresh wallets: "fetch collapsed
  Merkle tree update from 0 to `endIndex`" instead of replaying all history. **SDK consumer
  still unbuilt.**
- **midnight-ledger#276** (OPEN) — the WASM APIs the SDK path needs; names the trade-off:
  "significantly more efficient synchronisation **at a cost of encryption secret key exposure
  to the indexer**… fast-track synchronisation of newly created wallets."
- **Indexer support MERGED:** #973 (collapsed-update query), #984 (`startIndex` on `connect`
  to skip known-irrelevant history), #994 (`shieldedNullifierTransactions` for spends), #314
  (progress fields), **#1265 (rehash the tree before building collapsed updates — without it a
  wallet rebuilding from collapsed updates gets a root that diverges at the newest leaf)**.
- **No shielded twin of dust #639 exists.** The leaf-by-leaf rebuild+rehash deserialize cost
  (#639) applies to the zswap tree too, but nobody has filed it — because the SDK already
  collapses foreign commitments during replay, so the *local* zswap tree stays small (own
  coins only). Worth raising upstream, but likely a non-issue for us.
- **Correctness anchor:** wallet#584/#658 — verify the commitment-tree root against the node's
  `midnight_zswapStateRoot` at checkpoints. Use this as our guard.
- **Right-now baseline:** upgrade to the **wallet-sdk 1.2.0 barrel** (official OOM fix per
  servicedesk#104/#145) — makes sync *complete*, not *fast*. Check what we're on.

### What this changes in the plan
1. Add the **`shieldedNullifierTransactions`** subscription (#994) — mandatory, or spent
   coins stay "spendable" (trial-decrypt only sees outputs).
2. Fresh-wallet **fast-track**: one collapsed update `0 → endIndex`, not a full replay (#285).
3. Fetch a **fresh collapsed update before spending** so the proof uses the latest tree.
4. **Privacy gate:** the viewing-key path exposes the encryption secret key to the indexer.
   Fine for dev/testnet; make it explicit/opt-in and think hard before defaulting it on for
   mainnet / agent wallets holding real funds.
5. **Indexer version check:** require the #1265 fix (rehash-before-collapse) on the target
   indexer, else reconstructed roots diverge; guard by comparing against `midnight_zswapStateRoot`.
