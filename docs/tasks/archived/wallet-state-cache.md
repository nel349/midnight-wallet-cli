# Persistent Wallet State Cache

## Problem

Every CLI command that uses the WalletFacade (`transfer`, `dust`, `serve`) rebuilds the wallet from scratch — downloading and replaying ALL historical transactions from the indexer starting at transaction ID 0. On localnet this takes <5 seconds, but on preprod it takes **1-5+ minutes per invocation**, making one-off commands like `mn dust status` painfully slow.

## Solution

Cache serialized wallet state to disk after sync completes. On subsequent invocations, restore from cache and only sync new transactions since the last checkpoint.

**Target performance:** preprod commands go from 1-5 min → 5-30 seconds.

## Why This Works

The SDK already provides full serialization/restoration for all three wallet types. Each wallet tracks its sync progress (`appliedId` for unshielded, `offset`/`appliedIndex` for shielded and dust). A restored wallet resumes its indexer subscription from the checkpoint rather than replaying from ID 0.

## SDK Serialization API

*Verified against midnight-libraries source code.*

### Per-Wallet Serialization

All three wallet types follow the config-bound factory pattern. `WalletType(config)` returns a class with static methods including `restore()`:

```typescript
// Serialize — returns JSON string (all three)
const serialized = await wallet.serializeState();  // Promise<string>

// Restore — config is bound at factory time, restore only takes the serialized string
const restored = ShieldedWallet(config).restore(serialized);
const restored = UnshieldedWallet(config).restore(serialized);
const restored = DustWallet(config).restore(serialized);
```

Config contains `indexerClientConnection` (HTTP + WS URLs) and `networkId`. The config is bound when calling `ShieldedWallet(config)` — the returned class's `restore()` only needs the serialized state string.

### Serialized State Contents

**Unshielded** — JSON with:
- `publicKey` — `{ publicKey, addressHex, address }`
- `state` — `{ availableUtxos, pendingUtxos }` (each UTXO has value, owner, type, intentHash, outputNo + metadata)
- `appliedId` — last processed transaction ID, bigint (resume point for `UnshieldedTransactions` subscription)
- `protocolVersion` (bigint), `networkId` (string)

**Shielded** — JSON with:
- `publicKeys` — `{ coinPublicKey, encryptionPublicKey }`
- `state` — hex-encoded `ZswapLocalState` (Merkle tree, nullifiers, commitments)
- `offset` — last processed index, bigint (resume point for `ZswapEvents` subscription)
- `coinHashes` — map of nullifier→commitment pairs
- `protocolVersion` (bigint), `networkId` (string)

**Dust** — JSON with:
- `publicKey` — `{ publicKey }` (bigint)
- `state` — hex-encoded `DustLocalState`
- `offset` — last processed index, bigint (resume point for `DustLedgerEvents` subscription)
- `protocolVersion` (bigint), `networkId` (string)

### How Resume Works

Each wallet opens an indexer WebSocket subscription with its checkpoint as the starting position:

- **Unshielded**: `subscription UnshieldedTransactions($address, $transactionId: Int)` — passes `appliedId`
- **Shielded**: `subscription ZswapEvents($id: Int)` — passes `offset` (internally `appliedIndex`)
- **Dust**: `subscription DustLedgerEvents($id: Int)` — passes `offset` (internally `appliedIndex`)

A fresh wallet starts from ID 0, replaying ALL history. A restored wallet starts from its last checkpoint, skipping already-processed events.

### Serialization via Facade

The facade exposes individual wallets as public readonly properties. Serialization is called directly on them:

```typescript
// After sync completes, serialize all three in parallel:
const [shielded, unshielded, dust] = await Promise.all([
  facade.shielded.serializeState(),
  facade.unshielded.serializeState(),
  facade.dust.serializeState(),
]);
// Each returns a JSON string. Write to cache file.
```

This pattern is used in the SDK's own e2e tests (`packages/e2e-tests/src/tests/utils.ts`).

### Restored Wallet Lifecycle

The factory functions in `WalletFacade.init()` currently call `.startWithSecretKeys()` / `.startWithPublicKey()` / `.startWithSecretKey()` to create fresh wallets. For cached wallets, `.restore()` replaces these:

```typescript
// Current (fresh build):
shielded: (cfg) => ShieldedWallet(cfg).startWithSecretKeys(zswapSecretKeys),
unshielded: (cfg) => UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(keystore)),
dust: (cfg) => DustWallet(cfg).startWithSecretKey(dustSecretKey, dustParams),

// With cache (restore replaces startWith*):
shielded: (cfg) => ShieldedWallet(cfg).restore(cachedShielded),
unshielded: (cfg) => UnshieldedWallet(cfg).restore(cachedUnshielded),
dust: (cfg) => DustWallet(cfg).restore(cachedDust),
```

After `init()`, the lifecycle is unchanged:

```typescript
// Start — wallets connect to indexer and resume from checkpoint
await facade.start(zswapSecretKeys, dustSecretKey);
// Internally: Promise.all([shielded.start(keys), unshielded.start(), dust.start(dustKey)])

// Wait for sync — now only downloads NEW transactions since checkpoint
await waitForSync(facade);
```

### What WalletFacade Does NOT Do

- No `WalletFacade.restore()` method — it only orchestrates already-instantiated wallets
- No facade-level serialization — must serialize the three wallets independently via `facade.shielded`, `facade.unshielded`, `facade.dust`
- No way to skip wallet types — `init()` requires all three factories
- `InMemoryTransactionHistoryStorage` is not automatically persisted (tx history is separate from wallet state)

## Architecture

### Cache File Location

```
~/.midnight/cache/<network>/<address-prefix>.json
```

Example: `~/.midnight/cache/preprod/mp06mtx.json`

Using the first 7 chars of the address (after the network prefix) as filename — unique enough, avoids 60-char filenames.

### Cache File Format

```json
{
  "version": 1,
  "network": "preprod",
  "address": "mn_addr_preprod1mp06mtx...",
  "timestamp": "2026-03-11T01:30:00.000Z",
  "wallets": {
    "shielded": "<serialized string>",
    "unshielded": "<serialized string>",
    "dust": "<serialized string>"
  }
}
```

### Lifecycle

**Build with cache (modified `buildFacade`):**

1. Check if cache file exists for this address + network
2. If yes → restore wallets from cache, pass to `WalletFacade.init()`
3. If no → create fresh wallets (current behavior)
4. Return `FacadeBundle` as before (caller doesn't know about cache)

**Save cache (new function):**

1. Serialize all three wallets via `facade.shielded/unshielded/dust.serializeState()`
2. Write cache file atomically (temp file + rename)
3. When to save depends on the command:
   - **Read-only commands** (`dust status`): save immediately after sync
   - **Transaction commands** (`transfer`, `dust register`): save after transaction is submitted and a quick re-sync confirms the new state
   - **Long-running commands** (`serve`): save on graceful shutdown (SIGINT/SIGTERM)

**Invalidation:**

- Cache is automatically stale-tolerant: restored wallets catch up from checkpoint
- Delete cache on network mismatch (address prefix check)
- Delete cache if deserialization fails (corrupted/incompatible)
- No time-based eviction needed — stale cache is always better than no cache
- `--no-cache` flag to force fresh sync if needed

### Concurrency

- Atomic writes: write to `<file>.tmp`, then `fs.renameSync()` (atomic on POSIX)
- Read-then-write is safe: worst case, two commands overwrite each other — both produce valid state
- No file locking needed for this use case

## Key Files

| File | Changes |
|---|---|
| `src/lib/facade.ts` | Modify `buildFacade()` to check cache and restore; add `saveFacadeCache()` |
| `src/lib/wallet-cache.ts` | New file: cache read/write/invalidation logic |
| `src/commands/transfer.ts` | Call `saveFacadeCache()` after sync |
| `src/commands/dust.ts` | Call `saveFacadeCache()` after sync |
| `src/commands/serve.ts` | Call `saveFacadeCache()` after sync |
| `src/lib/constants.ts` | Add `CACHE_DIR_NAME`, `CACHE_VERSION` |

## Implementation Checklist

### Core cache layer
- [ ] Create `src/lib/wallet-cache.ts` with:
  - `loadWalletCache(address, network)` — read + parse + validate cache file
  - `saveWalletCache(address, network, facade)` — serialize all three wallets, atomic write
  - `clearWalletCache(address?, network?)` — delete cache files
  - `getCachePath(address, network)` — derive file path
- [ ] Add cache version constant to `src/lib/constants.ts`

### Facade integration
- [ ] Modify `buildFacade()` to accept optional `cacheDir` parameter
- [ ] On build: check cache → if valid, restore wallets from cache instead of creating fresh
- [ ] Add `saveFacadeCache(bundle, address, network)` function
- [ ] Handle deserialization failures gracefully (log warning, fall back to fresh build)

### Command integration
- [ ] `dust.ts` (status subcommand) — save cache after sync (read-only, safe to save immediately)
- [ ] `dust.ts` (register subcommand) — save cache after `ensureDust()` completes and a quick re-sync
- [ ] `transfer.ts` — save cache after `submitTransaction()` returns and a quick re-sync
- [ ] `serve.ts` — save cache on graceful shutdown (SIGINT handler)
- [ ] All commands: add `--no-cache` flag to force fresh sync
- [ ] Thread `--no-cache` flag through to `buildFacade()` to skip cache load

### CLI support
- [ ] Add `midnight cache clear` command (or subcommand) to manually clear cache
- [ ] Add `--no-cache` flag to help text for transfer, dust, serve
- [ ] Show "Restoring from cache..." vs "Syncing from scratch..." in spinner

### Testing
- [ ] Unit test: `saveWalletCache` → `loadWalletCache` round-trip
- [ ] Unit test: corrupted cache file → falls back to fresh build
- [ ] Unit test: cache version mismatch → falls back to fresh build
- [ ] Unit test: `--no-cache` flag bypasses cache
- [ ] Integration test: build → sync → save → restore → sync (verify faster)
- [ ] Integration test: cache survives across CLI invocations

## Sync Performance Analysis

### Where Time Is Spent

All three wallets sync in parallel via `Promise.all()` in `facade.start()`. The bottleneck is the **slowest wallet** (not the sum). On preprod:

| Wallet | What it processes | Speed | Bottleneck? |
|---|---|---|---|
| Unshielded | UTXO transactions for this address | Fast — simple state updates | Rarely |
| Dust | DustLedgerEvents (all addresses) | Medium — batched (10 events/1ms) | Sometimes |
| **Shielded** | **ZswapEvents (all addresses)** | **Slow — cryptographic processing per event** | **Usually** |

Shielded wallet decrypts and validates every ZswapEvent using ledger crypto. On preprod with months of history, this is the dominant cost.

### Why Cache Is the Right Fix

With cache, ALL three wallets resume from their checkpoint. Even the slow shielded wallet only needs to process new events since last cache. On an idle wallet:
- Without cache: replay thousands of shielded events → minutes
- With cache: zero new events to process → seconds (just connection setup + sync check)

### Future Optimization: Skip Shielded for Unshielded-Only Commands

`WalletFacade.init()` requires all three wallet factories — no way to skip shielded. But some commands don't need it:

| Command | Needs shielded? | Notes |
|---|---|---|
| `dust status` | No | Only reads unshielded balance + dust state |
| `dust register` | No | Only uses unshielded UTXOs + dust wallet |
| `transfer` | No | Unshielded transfer only (no shielded sends) |
| `serve` | Yes | Exposes full facade to dApps |

A future optimization could build a lightweight facade (or use wallets directly) to skip shielded entirely for unshielded-only commands. This would be 5-10x faster on first run (no cache). However, **cache makes this less urgent** — a cached shielded wallet resumes near-instantly on subsequent runs.

## Background Caching Analysis

**Can we start caching at CLI startup in the background?**

No — the two phases have different timing constraints:

**Restore (at startup):** Near-instant. Loading cached state from disk and passing restored wallets to `WalletFacade.init()` is synchronous. This is where the performance win comes from — the restored wallet resumes from checkpoint rather than ID 0.

**Save (after sync):** `serializeState()` requires the wallet to be fully synced with valid state. We can't serialize before sync completes — the state would be incomplete. However, the disk write itself can be fire-and-forget (non-blocking) since the command's work is already done by then.

**The real bottleneck** is the sync window itself. Cache shrinks it dramatically (checkpoint → current vs 0 → current) but can't eliminate it.

**When to save cache for transaction commands:** Save AFTER the transaction is confirmed, not before submission. This ensures the cache reflects the post-transaction UTXO state (spent inputs removed, change outputs added). Otherwise the next invocation would restore stale UTXOs and need to resync them.

## Prior Art: Kuira Android Wallet

The Kuira mobile wallet already implements persistent wallet state caching. Key patterns validated by their production experience:

**Indexer is source of truth** — Cache is purely an optimization layer. On any corruption or version mismatch, clear cache and rebuild from indexer.

**Throttled progress saves** — The mobile wallet saves sync progress every 5 seconds, not per transaction. For the CLI (short-lived process), saving once at the end is sufficient.

**Self-healing UTXO state** — When a local transaction succeeds on the node but the indexer hasn't replayed it yet, the mobile wallet marks UTXOs as `spent_by_local_tx` to prevent race conditions. For CLI: save cache AFTER transaction confirmation to avoid stale UTXO state.

**Database migrations clear sync state** — When storage format changes, force full resync. Our `version` field handles this same concern.

**Dust state serialization** — The mobile wallet uses binary SCALE encoding (Rust FFI). The JS SDK uses JSON via `serializeState()`, which is simpler for our use case but produces the same result.

## What Cannot Be Cached

- **Pending transaction service state** — in-memory only, not serializable
- **Transaction history** (`InMemoryTransactionHistoryStorage`) — separate from wallet state, not currently persisted
- **RPC/indexer connections** — must be re-established each invocation
- **Proof server connection** — must be re-established

Transaction history is a separate concern — caching wallet state alone gives us the big win (avoiding full replay). History caching could be added later if needed.

## Risk Assessment

**Low risk:**
- SDK serialization is a supported, tested API (integration tests exist in SDK repo)
- Cache is purely an optimization — if it fails, we fall back to fresh sync
- Atomic file writes prevent corruption from concurrent access
- Mobile wallet has proven this pattern works in production

**Medium risk:**
- SDK version upgrades may change serialization format. The `version` field in the cache file handles this — on version mismatch, discard and rebuild.
- Shielded state can grow large for wallets with many transactions (Merkle tree + coinHashes map). May need to monitor cache file sizes.
- Restoring stale UTXO state after a transaction could cause temporary inconsistency. Mitigated by saving cache AFTER transaction confirmation, and by the SDK's own sync-from-checkpoint behavior which will correct any drift.

## Expected Impact

| Scenario | Without cache | With cache |
|---|---|---|
| First run (no cache) | 1-5 min | 1-5 min (same) |
| Subsequent run, wallet idle | 1-5 min | ~5-15 sec (connection setup + sync check) |
| Subsequent run, few new txs | 1-5 min | ~5-20 sec |
| Subsequent run, many new txs | 1-5 min | ~15-40 sec (proportional to new events only) |

The bottleneck on preprod is **shielded wallet replaying all ZswapEvents from genesis**. Cache eliminates this entirely for subsequent runs — restored shielded wallet only processes events since its last checkpoint.

On an idle wallet, the sync check is near-instant (connect to indexer, verify no new events, done). The 5-15 second floor is connection setup (3 WebSocket connections to indexer + RPC/node handshake).
