# Spike: dust cold-sync bottleneck + can midnight-rs help?

## Problem
Cold dust sync on preprod replays ~1.44M `dustLedgerEvents` and takes ~22–24 min.
`mn` is instant only because it **resumes from a saved checkpoint** (dust-direct cache);
the anonboard dApp (SDK-internal wallet) syncs **cold every run** → never finishes in a
reasonable timeout on preprod (preview only worked because its dust ledger is small).

## Measurement (preprod, live — `.dust-spike/bottleneck.ts`)
Splits wall time into CPU (deserialize + `DustLocalState.replayEvents`) vs IO (waiting on
the indexer):

    events = 129,020 / 1,439,918     rate ~1,070/s   (=> full cold sync ~22 min)
    CPU (deser + replay) = 98.2%     [deserialize 2.3%, replayEvents 95.9%]
    IO (waiting on indexer) = 0.9%
    per-window rate: 1111, 1306, 1103, 989, 970 /s  (near-flat; ~13% decline over 125k)

**Conclusion: the cold sync is ~96% CPU inside `DustLocalState.replayEvents` (WASM).**
The indexer streams fine (1% wait). Per-event cost is near-constant (mild tree-depth growth),
so keeping the tree small during replay (our existing collapse) is NOT a speed lever — its
value stays storage. Client-side, you either replay faster or don't replay.

## Can midnight-rs help? (Moonsong-Labs/midnight-rs)
- It's a **Rust-native SDK** built on the **same official ledger crates**
  (`midnight-node-ledger-helpers`, `midnight-crypto`) that `@midnight-ntwrk/ledger-v8`
  (WASM) is compiled from. So the win is **WASM→native of the same code**, realistically
  ~2–3× on V8/Node (the larger mobile gains were likely vs a JS engine, not V8's WASM),
  NOT 10×. → ~22 min cold sync becomes ~8–12 min, still O(1.44M events).
- **No Node/napi/WASM bindings** (mobile-oriented). Using it from our Node CLI means either
  napi-rs bindings (a native addon) or a Rust **sidecar binary** — a native build +
  cross-platform distribution + a new heavyweight dependency (needs authorization).

## Levers, ranked
1. **Checkpoint persistence (proven, cheap) — the real fix.** `mn`'s dust-direct cache +
   facade bridge make every run after the first instant. The anonboard dApp should adopt the
   same pattern (the SDK supports `dustSerializedState` / `DustWallet.restore`, which `mn`
   already uses via `maybeBridgeDustCache`). First cold sync stays ~22 min ONCE; deploy then
   records its block and is skipped forever, and the operator resumes like `mn`.
2. **Native replay engine (midnight-rs).** Directly attacks the 96%-CPU bottleneck, but ~2–3×
   only, and costs a native dependency + bindings. Worth it ONLY if the one-time first cold
   sync itself must be cut. Composes with (1): native for the unavoidable first sync, checkpoint
   for the rest.
3. **WASM SIMD rebuild of ledger-v8 (upstream ask).** Rebuilding the published WASM with
   `simd128` could capture a chunk of native's advantage with no napi — but we don't own that
   build. Upstream request, lighter than bindings.
4. **Collapsed-dust support (upstream, transformative).** If the indexer served collapsed dust
   updates the way it does for zswap, cold sync would drop from O(1.44M events) to near-constant
   — the real fix. Not client-side; worth pushing to the Midnight team.

## Recommendation
For the anonboard blocker specifically: **do (1) — port `mn`'s dust checkpoint/bridge into the
dApp.** It solves the repeated-sync problem (operator + post-deploy) with code we already have
and have proven. The one-time ~22-min first cold sync is tolerable for a deploy (run once).
Only reach for **midnight-rs (2)** if that one-time first sync must also be cut and a native
Rust dependency is acceptable — and even then, pair it with (1), don't replace it. Push (4)
upstream as the durable fix.

## CORRECTION + breakthrough (verified live on preprod)
The claim above that "the indexer serves no collapsed dust updates" is WRONG. Introspection
shows the indexer DOES serve them:
- `dustGenerationMerkleTreeUpdate(startIndex, endIndex)` -> collapsed generation-tree update
- `dustCommitmentMerkleTreeUpdate(startIndex, endIndex)` -> collapsed UTXO-tree update
- `dustGenerations(dustAddress, startIndex, endIndex)` -> our generations, indexer-filtered
And the ledger applies them: `DustLocalState.applyGenerationCollapsedUpdate` /
`applyCommitmentCollapsedUpdate` (ledger-v8 ~1595-1600).

Proven end-to-end (`.dust-spike/collapsed-probe.ts`): fetched `dustGenerationMerkleTreeUpdate(0,100000)`
from preprod = ~278 bytes, `DustStateMerkleTreeCollapsedUpdate.deserialize` + `applyGenerationCollapsedUpdate`
in ~9ms, correct root. The generation tree frontier is ~393k leaves (the 1.44M was EVENTS),
coverable in a handful of aligned collapsed-update queries (~seconds total).

### => The real fix: a collapsed DUST fast-sync (mirrors the shielded fast-sync)
1. Fast-forward the generation + commitment trees over foreign ranges via the two
   `*MerkleTreeUpdate` queries + `applyGeneration/CommitmentCollapsedUpdate` (seconds).
2. Apply only OUR dust events (indexer-filtered via `dustGenerations(dustAddress)`).
3. Result: O(1.44M events / 22 min) -> O(our events / seconds). Client-side, NO native dependency.

This obviates midnight-rs for the cold-start problem. Native replay stays a back-pocket
2-3x on residual own-event replay, not needed once collapsed fast-sync lands.

Needs a spike to verify correctness (collapsed-synced dust balance == full-replay ground
truth, mirroring the shielded validation) + handle subtree alignment + the commitment tree.

## PROVEN: dust BALANCE fast path — 22 min → seconds (2026-08-18)
Definitive test on preprod: fxrecv (seed 0x02) full-replay ground truth
`walletBalance = 500000000000000000`; fast path via `dustGenerations` + formula =
`500000000000000000` — **exact match at the same instant**.

Recipe (READ path — `mn balance --dust`, `mn dust status`): NO tree reconstruction needed.
1. Subscribe `dustGenerations(dustAddress, 0, genTip)` — indexer-filtered to OUR generations
   (~1 item for alice/fxrecv vs 1.44M events; ~1–2s). `dustAddress` = bech32m via
   `DustAddress.encodePublicKey(networkId, dustSecretKey.publicKey)`. Capture
   `DustGenerationsItem`s + `DustGenerationDtimeUpdateItem`s.
2. balance = Σ over items of `ledger.updatedValue(new Date(item.ctime*1000),
   BigInt(item.initialValue), { value: BigInt(item.value), owner: dustSk.publicKey,
   nonce: item.backingNight, dtime: dtimeFor(item) }, now, params)`.
3. `params` = `new DustParameters(nightDustRatio, generationDecayRate, dustGracePeriodSeconds)`
   — portable/stable (read once from any synced state or the initial values 5e9/8267/10800).
Formula verified exact against real synced states (6 utxos incl. dtime-expired → 0).

### Completeness items before shipping (verify in the impl spike)
- `endIndex` must be the current generation tip, else the subscription follows the tip and
  hangs (overshoot). Get the tip from `DustGenerationsProgress.highestIndex` or a bounded probe.
- Capture `DustGenerationDtimeUpdateItem` and apply `dtime` (backing NIGHT spent → accrual stops).
- Verify a wallet that has SPENT dust (paid fees), not just dtime-expired — confirm the item
  set reflects remaining balance (may need commitment/spend handling).
- This is the READ path. SPENDS (transfer) still need the full DustLocalState (commitment tree
  + spend proofs) — use the existing checkpoint cache for the write path.

=> Obviates midnight-rs for the cold-start read problem entirely (seconds, no native dep).

## NEGATIVE RESULT (2026-08-18): generation-only fast path is WRONG for spenders
Built `src/lib/dust-balance-direct.ts` (dustGenerations items + Σ updatedValue) and verified:
- Correct for simple RECEIVERS: fxrecv 5e17==5e17, alice matched. These have 1 generation = 1
  UTXO, never spent.
- WRONG for SPENDERS: reprogen (1a4773, seq=61, paid dust fees) ground-truth walletBalance
  8.7256e18 vs generation-path 5e17 (filtered) / 2.5e19 (all) — no match.

Root cause: `walletBalance` sums the wallet's actual dust **UTXOs** (state.utxos), whose
`ctime`/`initialValue`/`seq` are those of post-SPEND SUCCESSOR UTXOs (spending dust to pay
fees creates a successor via `successorUtxo`, incrementing seq, resetting initialValue).
`dustGenerations` returns the original GENERATIONS, which diverge from the current UTXO set
after any spend. So generation-based accrual != net balance for any wallet that has spent dust.

=> The generation-only shortcut is NOT a general fast balance. NOT wired into the CLI.
A correct fast dust balance needs the UTXO/commitment side (post-spend successors + spend
tracking): the collapsed COMMITMENT reconstruction (`dustCommitmentMerkleTreeUpdate` +
`applyCommitmentCollapsedUpdate` + our dust UTXO/spend events), which is a larger spike.
Meanwhile the checkpoint cache remains the practical fix for repeated syncs; the one-time
first cold sync (~22 min) is unsolved client-side without that larger reconstruction.

## MEASURED: native (midnight-rs) is ~5x faster — CORRECTS the earlier ~2-3x estimate (2026-08-18)
Built a real benchmark: midnight-rs uses `midnight-ledger = "=8.1.0"` — the exact Rust crate
our WASM `@midnight-ntwrk/ledger-v8` 8.1.0 is compiled from. Ran `DustWallet::replay_events`
(same path midnight-rs uses) over 49,880 real preprod dust events; compared to WASM
`DustLocalState.replayEvents` over the identical events.

| batch | WASM /s | Native /s |
|-------|---------|-----------|
| 1     | (n/a)   | 637       |
| 500   | ~1,300  | 6,467     |
| 2000  | ~1,326  | —         |
| all   | crash*  | 6,564     |
*WASM crashes on large batches ("array contains a value of the wrong type" / memory); it
plateaus at ~1,300/s and cannot batch bigger. Native plateaus at ~6,500/s.

=> Native ~5x faster. Cold 1.44M-event dust sync: native **~3.7 min** vs WASM ~18-22 min.
Native CROSSES the <5-min target; WASM cannot. The earlier "~2-3x, not worth it" was WRONG.

### Integration path (if pursued)
- Rust **sidecar binary** (simpler for a CLI than napi): streams `dustLedgerEvents`, replays
  natively, emits `DustLocalState.serialize()` → the Node CLI reads it into its dust cache.
  Same ledger 8.1.0 => serialization format should be byte-compatible between native and WASM
  (VERIFY: native serialize -> WASM deserialize round-trip). Cost: a per-platform native binary
  bundled/downloaded with the npm package.
- Combine with the checkpoint cache (first sync ~3.7 min native, then incremental/instant).
- KEY OPEN ITEM before committing: confirm native `DustLocalState.serialize()` deserializes in
  WASM ledger-v8 8.1.0 (and matches `walletBalance`). That makes the sidecar drop-in.

## Sidecar viability PROVEN (2026-08-18): native serialize <-> WASM deserialize round-trips
Native `tagged_serialize(DustLocalState)` (49,880 events, 24,810 bytes) deserializes cleanly
in WASM ledger-v8 8.1.0: `DustLocalState.deserialize()` OK, consistent balance + valid
generatingTreeRoot. WASM's own `.serialize()` uses the SAME `midnight:dust-local-state` tag
(tagged_serialize) => byte-compatible, same ledger version. So a Rust sidecar is DROP-IN:
  native replays dustLedgerEvents @ ~6,500/s -> tagged_serialize state -> Node CLI reads it
  into the dust cache (DustLocalState.deserialize) -> normal WASM balance/transfer flow.

### FINAL VERDICT on midnight-rs (corrects the earlier dismissal)
- ~5x faster (6,489/s vs WASM ~1,300/s), cold dust sync ~3.7 min < the 5-min target (WASM can't).
- Drop-in via serialized-state handoff (proven), no reimplementation, same ledger 8.1.0.
- Cost: bundle/download a per-platform native binary with the npm CLI.
Recommended if the ~22-min first cold sync must be cut. Bench crate: midnight-rs clone
`crates/dust-bench` (scratchpad). Events fixture: `.dust-spike/dust-events-preprod.jsonl`.
