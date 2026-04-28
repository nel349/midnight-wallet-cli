// SDK workaround: patch CoreWallet to allow safe dust revert after rejection.
//
// SDK BUG (wallet-sdk-dust-wallet 2.0.0):
//   1. DustLocalState.spend() (WASM) consumes the UTXO from state.utxos during
//      balancing — the coin is removed from local state before the tx hits the chain.
//   2. CoreWallet.applyFailed() calls state.processTtls(ctime + gracePeriod) which
//      further damages the state instead of restoring it.
//   Combined effect: after rejecting a balanced transaction, dust is permanently
//   unavailable until new dust is generated on-chain (minutes on preprod).
//   The SDK's revert should snapshot and restore pre-spend state, not just clear
//   pending tracking. Filed as SDK issue — remove this patch when fixed upstream.
//
// Fix: We patch three CoreWallet methods:
//   1. spendCoins — saves a serialized snapshot of DustLocalState BEFORE the spend
//   2. revertTransaction — restores the pre-spend DustLocalState from the snapshot,
//      giving the UTXO back, and clears pendingDust. Coin is immediately available.
//   3. applyEvents — cleans up snapshots when coins are confirmed on-chain.
//
// ON SDK UPGRADE: verify that CoreWallet still exports spendCoins, revertTransaction,
// applyFailed, applyEvents, and pendingDustToMap with the same signatures.
// Test: reject a submitTransaction in `mn serve`, then immediately balance again.
// If dust recovers without this patch, the SDK bug is fixed and this file can be removed.
//
// This patch is applied once at import time and affects all facade operations.

import { DustLocalState } from '@midnight-ntwrk/ledger-v8';
import { CoreWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet/v1';

// Map from nullifier → serialized DustLocalState bytes (pre-spend snapshot).
// Cleaned up on revert (rejection) and on applyEvents (successful on-chain confirmation).
const preSpendSnapshots = new Map<any, Uint8Array>();

// ── Patch applyEventsWithChanges: clean up snapshots when coins are confirmed on-chain ──
//
// SDK 4.0.0 renamed `applyEvents` to `applyEventsWithChanges` and changed its
// return type from `CoreWallet` to `[CoreWallet, DustStateChanges[]]`.

const _originalApplyEventsWithChanges = CoreWallet.applyEventsWithChanges;

CoreWallet.applyEventsWithChanges = function patchedApplyEventsWithChanges(
  wallet: any, secretKey: any, events: any, currentTime: any,
): any {
  const result = _originalApplyEventsWithChanges.call(CoreWallet, wallet, secretKey, events, currentTime);

  // result is [updatedWallet, stateChanges[]] in v4
  const updatedWallet = Array.isArray(result) ? result[0] : result;

  // After applying events, pending entries for confirmed txs are filtered out.
  // Clean up any snapshots whose nullifiers are no longer in pendingDust.
  if (preSpendSnapshots.size > 0 && updatedWallet?.pendingDust) {
    const stillPending = new Set(updatedWallet.pendingDust.map((t: any) => t.nullifier));
    for (const nullifier of preSpendSnapshots.keys()) {
      if (!stillPending.has(nullifier)) {
        preSpendSnapshots.delete(nullifier);
      }
    }
  }

  return result;
};

// ── Patch spendCoins: save pre-spend state ──

const _originalSpendCoins = CoreWallet.spendCoins;

CoreWallet.spendCoins = function patchedSpendCoins(
  wallet: any, secretKey: any, coins: any, currentTime: any,
): any {
  // Snapshot the DustLocalState BEFORE the WASM spend() consumes the UTXO
  let snapshot: Uint8Array | null = null;
  try { snapshot = wallet.state.serialize(); } catch { /* best-effort */ }

  // Call original spendCoins
  const result = _originalSpendCoins.call(CoreWallet, wallet, secretKey, coins, currentTime);

  // result = [dustSpends[], updatedWallet]
  const updatedWallet = result[1] ?? result;
  if (snapshot && updatedWallet?.pendingDust) {
    // Save snapshot for each NEW pending entry (the ones just added)
    for (const pending of updatedWallet.pendingDust) {
      if (!preSpendSnapshots.has(pending.nullifier)) {
        preSpendSnapshots.set(pending.nullifier, snapshot);
      }
    }
  }

  return result;
};

// ── Patch revertTransaction: restore pre-spend state ──

const _originalRevert = CoreWallet.revertTransaction;

CoreWallet.revertTransaction = function safeRevertTransaction(wallet: any, tx: any): any {
  // Extract nullifiers of dust spends from the transaction
  const pendingSpendsMap = CoreWallet.pendingDustToMap(wallet.pendingDust);
  const removedNullifiers: any[] = [];

  const intents = tx.intents;
  if (intents) {
    for (const intent of intents.values()) {
      const spends = intent.dustActions?.spends;
      if (!spends) continue;
      for (const spend of spends) {
        if (pendingSpendsMap.has(spend.oldNullifier)) {
          removedNullifiers.push(spend.oldNullifier);
        }
      }
    }
  }

  // Restore pre-spend DustLocalState from snapshot
  let restoredState = wallet.state;
  for (const nullifier of removedNullifiers) {
    const snapshot = preSpendSnapshots.get(nullifier);
    if (snapshot) {
      try {
        restoredState = DustLocalState.deserialize(snapshot);
      } catch { /* fall back to current state */ }
      preSpendSnapshots.delete(nullifier);
    }
  }

  return {
    ...wallet,
    state: restoredState,
    pendingDust: wallet.pendingDust.filter(
      (token: any) => !removedNullifiers.includes(token.nullifier),
    ),
  };
};

// Also patch applyFailed since revertTransaction is just an alias for it
CoreWallet.applyFailed = CoreWallet.revertTransaction;

export { _originalRevert as originalRevertTransaction };
