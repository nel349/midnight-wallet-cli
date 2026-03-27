# DUST Sponsorship: Exercise + Wallet CLI Feature Plan

## Background

bochaco (Midnight dev) confirmed a working DUST sponsorship flow:
1. App wallet generates UnboundTransaction (runs circuit, generates ZK proof)
2. Sponsor wallet receives it, calls `balanceUnboundTransaction` with `tokenKindsToBalance: ["dust"]`
3. Sponsor wallet finalizes with `finalizeRecipe`
4. App wallet submits to network
5. `ownPublicKey()` returns the app wallet's key (ownership checks pass)

This confirms `ownPublicKey()` is determined at proof generation time, not at dust balancing or submission time. The sponsor only touches the dust segment.

## Part 1: Exercise (midnight-starship)

**Goal:** Verify bochaco's claim with a minimal reproducible test.

**Location:** `/Users/norman/Development/tech-moderator/midnight-starship/exercises/dust-sponsorship/`

### Contract

A trivial Compact contract that records `ownPublicKey()` on-chain:

```
export ledger recorded_caller: ZswapCoinPublicKey;
export circuit record_caller(): [] {
  recorded_caller = ownPublicKey();
}
```

### Test flow

1. Spin up local devnet (`docker compose up` or use midnight-wallet-cli localnet)
2. Create wallet A (the "app") and wallet B (the "sponsor")
3. Fund both wallets via genesis mint
4. Wallet A builds an UnboundTransaction calling `record_caller`
5. Wallet B balances the tx with `tokenKindsToBalance: ["dust"]` only
6. Wallet B finalizes the recipe
7. Wallet A submits the finalized tx
8. Read `recorded_caller` from ledger state
9. Assert it matches wallet A's coin public key, NOT wallet B's

### Files to create

- `exercises/dust-sponsorship/contract/src/ownership-test.compact` — the contract
- `exercises/dust-sponsorship/contract/src/witnesses.ts` — empty witnesses (no private state needed)
- `exercises/dust-sponsorship/contract/package.json` — with `compact compile` script
- `exercises/dust-sponsorship/test/sponsorship.test.ts` — the integration test
- `exercises/dust-sponsorship/test/helpers.ts` — wallet setup, provider wiring, devnet utilities

### Dependencies

Already in midnight-starship root `package.json`:
- midnight-js-contracts 4.0.2
- midnight-js providers 4.0.2
- wallet-sdk packages (need to add: wallet-sdk-facade, wallet-sdk-shielded, wallet-sdk-unshielded-wallet, wallet-sdk-dust-wallet, wallet-sdk-hd)
- compact-runtime 0.15.0

Needs:
- Add wallet SDK packages to root deps
- Add `exercises/dust-sponsorship` to workspaces
- vitest for test runner

### Key references

- bboard CLI wallet setup: `/Users/norman/Development/midnight/midnight-libraries/example-bboard/bboard-cli/src/index.ts`
- midnight-wallet-cli facade builder: `/Users/norman/Development/tech-moderator/midnight-wallet-cli/src/lib/facade.ts`
- Wallet SDK `balanceUnboundTransaction` signature: accepts `UnboundTransaction`, secrets, options (including `tokenKindsToBalance`)
- midnight-starship existing API: `/Users/norman/Development/tech-moderator/midnight-starship/api/src/`


## Part 2: Wallet CLI Feature (midnight-wallet-cli)

**Goal:** Add a `dust sponsor` command that lets the CLI wallet act as a DUST sponsor for dApps.

**Location:** `/Users/norman/Development/tech-moderator/midnight-wallet-cli/`

### User flow

**Scenario A: CLI as sponsor (command line)**
```
# App sends an UnboundTransaction (hex encoded) to the sponsor
# Sponsor wallet balances with dust only, finalizes, returns for submission

mn dust sponsor --tx <hex> [--wallet <path>] [--network <name>]

# Output: finalized transaction hex, ready for the app to submit
```

**Scenario B: CLI as sponsor (via dapp-connector / mn serve)**
The dapp-connector already has `balanceUnsealedTransaction`. The sponsorship flow would be:
1. DApp connects to wallet A's `mn serve` — generates the UnboundTransaction
2. DApp connects to wallet B's `mn serve` — passes the tx for dust-only balancing
3. DApp receives finalized tx from wallet B
4. DApp submits via wallet A

This may need a new RPC method or an option on the existing `balanceUnsealedTransaction` to restrict to dust-only balancing.

### Implementation plan

1. **New subcommand: `mn dust sponsor`**
   - Parse `--tx <hex>` flag (required) — the serialized UnboundTransaction
   - Load wallet, build facade (same pattern as other commands)
   - Call `facade.balanceUnboundTransaction(tx, secrets, { tokenKindsToBalance: ["dust"] })`
   - Finalize with `facade.finalizeRecipe(recipe)`
   - Serialize and output the finalized transaction hex
   - Support `--json` output for programmatic use

2. **Extend existing `src/commands/dust.ts`**
   - Add `sponsor` as a new subcommand alongside `register` and `status`
   - Reuse existing wallet loading, network resolution, facade building from dust.ts

3. **Lib module: `src/lib/sponsor.ts`**
   - Pure function: accepts facade + secrets + serialized tx, returns finalized tx hex
   - Handles deserialization of the UnboundTransaction
   - Validates the tx before balancing

4. **Dapp-connector extension (optional, future)**
   - Add `tokenKindsToBalance` option to existing `balanceUnsealedTransaction` RPC method
   - Or add a new `sponsorDust` RPC method
   - Allows `mn serve` to act as a dust sponsorship backend

### Key files to modify

- `src/commands/dust.ts` — add `sponsor` subcommand routing
- `src/lib/sponsor.ts` — new module for sponsorship logic
- `src/commands/help.ts` — add help text for `dust sponsor`

### Key files to reference

- `src/lib/facade.ts` — FacadeBundle, buildFacade, startAndSyncFacade
- `src/lib/transfer.ts` — existing `ensureDust`, signing patterns
- `src/lib/dapp-connector.ts:512-532` — existing balanceUnsealedTransaction implementation
- `src/lib/constants.ts` — TTL defaults, dust cost parameters

### Open questions

1. How should the UnboundTransaction be passed? Hex string via `--tx` flag? Stdin? File path?
2. Should the output include metadata (dust cost, TTL, etc.) or just the finalized tx hex?
3. For the dapp-connector path, should we add `tokenKindsToBalance` as an option to the existing `balanceUnsealedTransaction` method, or create a dedicated `sponsorDust` method?
4. Security: should there be approval/confirmation before sponsoring dust for an unknown transaction?


## Discovery notes

- Wallet SDK v2.0.0 release notes (private repo): `midnight-wallet/release-notes/v2.0.0.md`
- `balanceUnboundTransaction` accepts options object with `tokenKindsToBalance` (array of token kinds to balance, e.g., `["dust"]`)
- The dapp-connector already calls `balanceUnboundTransaction` without `tokenKindsToBalance` restriction — it balances everything
- Developer guide (page 50-51): contract action + ZK proof lives in one segment, dust fee in a separate segment, merged but distinct
- `ownPublicKey()` resolves to the prover's `ZswapCoinPublicKey` at proof generation time
- midnight-ledger spec (dust.md): "Dust may be spent multiple times, and a new UTXO is always created, even if its value is zero"
