# Bug: CoreWallet.revertTransaction destroys dust UTXO instead of restoring it

**Package**: `@midnight-ntwrk/wallet-sdk-dust-wallet` 2.0.0-rc.5
**Also affects**: `@midnight-ntwrk/ledger-v7` 7.0.2 (DustLocalState.spend WASM behavior)

## Summary

After balancing a transaction with dust and then reverting it (e.g., user rejects the submit), the dust UTXO is permanently destroyed in local state. The wallet cannot balance any further write operations until new dust is generated on-chain — which takes 2+ minutes on preprod, effectively bricking the wallet for that period.

## Root Cause

Two issues combine to make dust revert destructive:

### 1. `DustLocalState.spend()` consumes the UTXO from `state.utxos`

When `CoreWallet.spendCoins()` calls `localState.spend(secretKey, coinToSpend, takeFee, currentTime)`, the WASM operation removes the UTXO from `state.utxos`. After balancing:

- `state.utxos.length` = 0 (coin consumed by WASM)
- `pendingDustTokens.length` = 1 (tracking the spent coin)
- `totalCoins` = 1 (0 available + 1 pending)

The coin is already gone from the ledger state before the transaction is even submitted.

### 2. `CoreWallet.applyFailed()` calls `processTtls()` instead of restoring state

```javascript
applyFailed(wallet, tx) {
    // ...
    const [updatedState, removedNullifiers] = pipe(relevantSpends,
        Arr.reduce([wallet.state, []], ([state, removed], { spend, pending }) => [
            state.processTtls(DateOps.addSeconds(pending.ctime, wallet.state.params.dustGracePeriodSeconds)),
            //    ^^^^^^^^^^^^^ This further damages the already-empty state
            Arr.append(removed, spend.oldNullifier),
        ]));
    return {
        ...wallet,
        state: updatedState,  // state with utxos=[] + processTtls damage
        pendingDustTokens: wallet.pendingDustTokens.filter(...),  // cleared
    };
}
```

After revert: `utxos=[]`, `pendingDustTokens=[]`, `totalCoins=0`. The coin is gone.

## Reproduction

1. Register a dust UTXO and wait for dust generation
2. Call `facade.balanceUnboundTransaction(tx, secrets, options)` — dust coin moves to pending
3. Call `facade.revert(recipe)` — simulating a rejected submit
4. Call `facade.balanceUnboundTransaction(tx, secrets, options)` again
5. **Result**: `TransactingError: No dust tokens found in the wallet state`
6. Dust does not recover until new dust is generated on-chain (2+ min on preprod)

Observed state transitions:
```
Before balance:  utxos=1, pending=0, total=1, available=1
After balance:   utxos=0, pending=1, total=1, available=0  ← UTXO consumed by WASM spend()
After revert:    utxos=0, pending=0, total=0, available=0  ← coin permanently lost
```

## Expected Behavior

After reverting a transaction that was never submitted to the chain, the dust wallet should return to its pre-balance state. The UTXO should be available for the next transaction immediately.

```
After revert:    utxos=1, pending=0, total=1, available=1  ← coin restored
```

## Suggested Fix

Snapshot the `DustLocalState` before `spendCoins` and restore it on revert, instead of calling `processTtls()`:

```javascript
// In spendCoins — save pre-spend state
const snapshot = wallet.state.serialize();  // Uint8Array

// In revertTransaction — restore instead of processTtls
const restoredState = DustLocalState.deserialize(snapshot);
return {
    ...wallet,
    state: restoredState,
    pendingDustTokens: wallet.pendingDustTokens.filter(
        (token) => !removedNullifiers.includes(token.nullifier)
    ),
};
```

This approach:
- Restores the UTXO to `state.utxos` (coin is back)
- Clears `pendingDustTokens` (no more pending filter)
- `availableCoins` immediately includes the restored coin
- No secret key material in the snapshot (`DustLocalState` contains only coin data and parameters)

We have implemented and shipped this as a runtime monkey-patch in [midnight-wallet-cli](https://github.com/nel349/midnight-wallet-cli) (`src/lib/dust-revert-patch.ts`) and confirmed it works on preprod — operators can reject and re-approve transactions repeatedly with zero interruption.

## Impact

This bug affects any application that:
- Uses `WalletFacade.balanceUnboundTransaction()` or similar balance methods
- Needs to handle transaction rejection/cancellation gracefully
- Runs on networks where dust generation is slow (preprod, mainnet)

For interactive wallet UIs and DApp connectors where users may reject transactions, this makes the wallet unusable after a single rejection without clearing the cache and restarting.
