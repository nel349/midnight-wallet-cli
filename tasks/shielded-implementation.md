# Shielded Transaction Support — Implementation Plan

## Status: Reviewed — Ready for Implementation

## Protocol Facts (verified)

1. No self-shielding — you cannot move your own NIGHT from unshielded → shielded
2. Shielded coins come from receiving transfers from another wallet that has shielded coins
3. Genesis wallet (seed 0x01) has 250M shielded NIGHT on localnet (tested, confirmed)
4. `transferTransaction` with `type: 'shielded'` draws from sender's **shielded** balance
5. Shielded address is derived from `ZswapSecretKeys` public keys at wallet init — available from first `facade.state()` emission, before sync completes
6. Shielded address prefix: `mn_shield-addr_<network>1...`
7. `initSwap` is for two-party DEX swaps, NOT for self-shielding (submission rejected on localnet)

## Commands

### 1. `mn airdrop <amount> --shielded` (localnet only)

Sends shielded NIGHT from genesis wallet to user's shielded address. Separate code path from unshielded airdrop — cannot reuse `executeTransfer` because the flow is fundamentally different (genesis uses shielded balance, not unshielded).

**Flow:**
1. Parse amount, load user wallet config
2. Build user facade, start, get first `facade.state()` emission → read `state.shielded.address`
3. Stop user facade immediately (no sync needed — address is from keys)
4. Build genesis facade (seed 0x01), sync (**full mode** — needs shielded balance, not just unshielded+dust)
5. Check `state.shielded.balances[nightToken] >= amount`
6. Ensure dust on genesis wallet via `ensureDust()`
7. Build transfer: `facade.transferTransaction([{ type: 'shielded', outputs: [{ type: nightToken, amount, receiverAddress: userShieldedAddress }] }], { shieldedSecretKeys, dustSecretKey }, { ttl })`
8. Sign via `facade.signRecipe(recipe, (payload) => keystore.signData(payload))`
9. Prove via `facade.finalizeRecipe(signed)`
10. Submit via `facade.submitTransaction(finalized)`
11. Stop genesis facade

**New function:** `executeShieldedAirdrop()` in `src/commands/airdrop.ts` — parallel to existing unshielded airdrop flow

**Output:**
- stdout: tx hash
- stderr: header, amount, shielded address
- `--json`: `{ txHash, amount, shieldedAddress, network }`

### 2. `mn transfer <addr> <amount> --shielded`

Sends shielded tokens from your wallet to another shielded address. New function — cannot reuse `executeTransfer` because:
- Address validation differs (ShieldedAddress vs UnshieldedAddress)
- Balance check reads from `state.shielded.balances` not `state.unshielded.balances`
- Transfer type is `'shielded'` not unshielded

**Flow:**
1. Parse recipient, validate as ShieldedAddress via `MidnightBech32m.parse(addr).decode(ShieldedAddress, networkId)`
2. Parse amount
3. Build facade, sync (**full mode** — needs shielded balance)
4. Check `state.shielded.balances[nightToken] >= amount`
5. Ensure dust via `ensureDust()`
6. Build transfer: same `transferTransaction` pattern as airdrop but with recipient's address
7. Sign, prove, submit

**New function:** `executeShieldedTransfer()` in `src/lib/transfer.ts`

**Output:**
- stdout: tx hash
- stderr: header "Shielded Transfer", from (shielded addr), to, amount
- `--json`: `{ txHash, amount, recipient, network }`

### 3. `mn balance --shielded` — DONE

Already implemented. Shows shielded address + balances via full facade sync.

## Decisions

1. **Dust on genesis for shielded airdrop:** Yes, use `ensureDust()` — same pattern as unshielded. Genesis needs dust for any transaction.
2. **Balance check for shielded transfer:** Use `state.shielded.balances[nightToken]` — this is the available shielded balance. `availableCoins` is an array of individual coins, not a sum.
3. **Shielded address in `mn wallet info`:** Defer to a follow-up. Requires facade start or caching. Not blocking for shielded transfers.
4. **JSON output shape:** Match existing patterns. Shielded airdrop adds `shieldedAddress` field. Shielded transfer same shape as unshielded but with shielded address.

## Cleanup (do first)

- Delete `src/commands/shield.ts`
- Delete `src/__tests__/shield-command.test.ts`
- Remove `shield` case from `src/wallet.ts` command router
- Remove `shield` from `FACADE_COMMANDS`

## Implementation Order

1. Cleanup shield command
2. `mn airdrop --shielded` (TDD: validation tests → implementation → live test)
3. `mn transfer --shielded` (TDD: validation tests → implementation → live test)
4. End-to-end: airdrop shielded → balance --shielded → transfer shielded → verify

## Test Plan

### Unit tests (no Docker)
- `mn airdrop --shielded` without amount → "Missing amount"
- `mn airdrop --shielded` on preprod → "only available on undeployed"
- `mn transfer --shielded` without recipient → "Missing recipient"
- `mn transfer --shielded` with unshielded address → "Invalid shielded address" (wrong prefix)
- `mn transfer --shielded` with garbage address → "Invalid shielded address"
- `mn transfer --shielded` without amount → "Missing amount"

### Integration tests (localnet, gated by HAS_INDEXER)
- `mn airdrop 10 --shielded` → outputs tx hash
- `mn balance --shielded` after airdrop → shows 10 NIGHT shielded
- `mn transfer <shielded-addr> 5 --shielded` → outputs tx hash
- `mn balance --shielded` after transfer → shows 5 NIGHT shielded

## Files to Modify

| File | Change |
|------|--------|
| `src/commands/shield.ts` | DELETE |
| `src/__tests__/shield-command.test.ts` | DELETE |
| `src/wallet.ts` | Remove `shield` case + FACADE_COMMANDS entry |
| `src/commands/airdrop.ts` | Add `--shielded` flag → `executeShieldedAirdrop()` |
| `src/commands/transfer.ts` | Add `--shielded` flag → route to shielded flow |
| `src/lib/transfer.ts` | Add `executeShieldedTransfer()` function |

## Risks

1. **Full sync for genesis shielded transfer:** Genesis wallet on localnet has lots of state. Full sync may be slow (~10-30s). Cached state helps on subsequent runs.
2. **Getting user's shielded address without full sync:** Relies on first `facade.state()` emission having the address. Verified in source (keys set at init) but not live-tested yet. Fallback: do a quick full sync of user wallet.
3. **Shielded address validation:** Need to verify `MidnightBech32m.parse()` works with `mn_shield-addr_` prefix. The dapp-connector already does this (line 254) so the pattern is proven.
4. **Genesis cache after shielded airdrop:** Genesis shielded state changes after each airdrop. Must save cache after successful submission to avoid stale UTXOs on next airdrop. Same pattern as existing unshielded airdrop.

## Current State

- 43 test files, 722 tests — all passing
- `mn balance --shielded` — working
- `src/lib/network-id.ts` — created, tested (5 tests)
- Shield command scaffold exists — needs removal before proceeding
