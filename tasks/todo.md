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

### 2. DUST first-sync speedup — investigation
Goal: cut the dust cold first-sync (the remaining slow path — ~1.3M events on preprod).
- `dustLedgerEvents` is single-cursor (not range) per schema introspection, so it isn't
  directly parallelizable. Range-based primitives that do exist: `dustGenerations`
  (start/end index) and the collapsed dust-merkle update. Explore whether they reconstruct
  the balance faster than full event replay, or whether the real win is upstream
  (collapsed-dust support, the way zswap has collapsed updates).

### 3. Mainnet support (RCs) — separate plan
First-class mainnet network for donBenito's agent wallets: RC1 read-only mainnet, RC2
safeguarded transfers (enablement gate, confirmation, spend caps, allowlist) after a
security review. See the mainnet plan doc.
