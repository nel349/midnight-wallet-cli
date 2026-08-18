# Pending tasks — feat/dust-collapse

## Shipped on this branch (context)
- **Shielded fast balance sync** — indexer-direct `zswapLedgerEvents` reader + cache
  (read path: `mn balance --shielded`). Replaces the facade cold sync: hours → ~1 min,
  memory-bounded (~155 MB, kills the old 16 GB OOM), incremental after first sync.
  See `tasks/shielded-sync-optimization.md` for the full spike + decision.
- Dust generation-tree collapse; shielded-skip policy on faucet-less nets; per-network
  endpoint-override scoping; localnet Preview/Preprod matrix bump.

## Pending

### 1. Shielded write-path fast state (facade bridge) — deferred to a stable-env session
Goal: let shielded WRITE ops (`mn transfer --shielded`, and other facade commands) reuse
the indexer-direct shielded state instead of paying the facade's cold sync — mirroring the
existing dust bridge (`maybeBridgeDustCache`).
- Feasibility confirmed (SDK research + ledger APIs): overlay our `ZswapLocalState` + the
  matching `zswapLedgerEvents` offset into the facade's shielded snapshot. Two differences
  from the dust bridge: the snapshot key is `publicKeys` (coin + encryption), and a
  `coinHashes` map (nullifier + commitment per coin nonce) must be recomputed from the
  secret keys or `restore()` rejects the snapshot.
- **Must be verified with a real `mn transfer --shielded`** (ZK proof generation) from a
  bridged state: a wrong `coinHashes` passes `restore()` but yields an invalid spend proof,
  and only a live transfer surfaces it. Needs a stable localnet + proof server.

### 2. DUST collapsed fast-sync — the cold-start fix (mechanism PROVEN)
Goal: cut the dust cold first-sync (~1.44M events / ~22 min on preprod → seconds).
Bottleneck measured at ~96% CPU in `DustLocalState.replayEvents` (WASM). The indexer DOES
serve collapsed dust merkle updates (verified live): `dustGenerationMerkleTreeUpdate` /
`dustCommitmentMerkleTreeUpdate` (range queries) + `dustGenerations(dustAddress)` (our
generations), and the ledger applies them via `applyGeneration/CommitmentCollapsedUpdate`.
Approach (mirrors the shielded fast-sync): fast-forward the foreign gen+commitment trees via
a few collapsed-update range queries, then apply only OUR dust events →
O(1.44M events) → O(our events), client-side, no native dependency. Obviates midnight-rs for
the cold start. Needs a spike to verify reconstructed `walletBalance` == full-replay ground
truth + subtree-boundary alignment on the range queries. See
`tasks/dust-cold-sync-native-spike.md`.

**Chosen direction — native sidecar (measured ~5x, cold sync ~3.7min, crosses <5min):**
Full scoped plan + implementation checklist in `tasks/dust-native-sidecar-plan.md`. The
collapsed/generation client-side shortcuts are correct only for receivers; the native
sidecar (crates.io midnight-ledger 8.1.0, serialized-state handoff into the existing cache,
proven round-trip) is correct for spenders too and is the recommended path.

### 3. Mainnet support (RCs) — separate plan
First-class mainnet network for donBenito's agent wallets: RC1 read-only mainnet, RC2
safeguarded transfers (enablement gate, confirmation, spend caps, allowlist) after a
security review. See the mainnet plan doc.
