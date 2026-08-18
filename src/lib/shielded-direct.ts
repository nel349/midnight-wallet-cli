// Direct-from-indexer shielded (zswap) balance reader — the fast sync.
//
// Instead of replaying every zswap event (the SDK's default, minutes-to-hours on
// hosted networks), this registers the wallet's viewing key with the indexer and
// streams only the wallet's RELEVANT transactions interleaved with collapsed
// Merkle-tree deltas for the gaps. Two subscriptions off one session:
//   - shieldedTransactions: our outputs (coins) + `collapsedMerkleTree` fast-forward
//   - shieldedNullifierTransactions: spends that DON'T carry an output for us
//     (trial-decryption only sees outputs, so a spend-only tx would otherwise leave
//     a spent coin looking spendable).
//
// Produces a `ZswapLocalState` the caller can serialize/cache and read balances
// from. Mirrors the dust-direct reader's checkpoint/resume shape.

import WebSocket from 'ws';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { ShieldedEncryptionSecretKey } from '@midnight-ntwrk/wallet-sdk-address-format';
import { deserializeSealed } from './tx-serde.ts';
import { NetworkId } from '@midnight-ntwrk/wallet-sdk-abstractions';

const CONNECT_MUTATION = `mutation Connect($viewingKey: ViewingKey!) { connect(viewingKey: $viewingKey) }`;
const DISCONNECT_MUTATION = `mutation Disconnect($sessionId: HexEncoded!) { disconnect(sessionId: $sessionId) }`;

const SHIELDED_TX_SUBSCRIPTION = `subscription ShieldedTransactions($sessionId: HexEncoded!, $index: Int) {
  shieldedTransactions(sessionId: $sessionId, index: $index) {
    __typename
    ... on ShieldedTransactionsProgress { highestEndIndex highestCheckedEndIndex }
    ... on RelevantTransaction {
      transaction { raw startIndex endIndex }
      collapsedMerkleTree { startIndex endIndex update }
    }
  }
}`;

// Not exposed by the installed indexer-client types; the schema (indexer >=4.3.x)
// serves it. Delivers the transactions that spend our coins so we can drop them.
const NULLIFIER_SUBSCRIPTION = `subscription ShieldedNullifierTransactions($sessionId: HexEncoded!, $index: Int) {
  shieldedNullifierTransactions(sessionId: $sessionId, index: $index) {
    __typename
    ... on ShieldedTransactionsProgress { highestEndIndex highestCheckedEndIndex }
    ... on RelevantTransaction { transaction { raw } }
  }
}`;

export interface ShieldedDirectResult {
  /** Native (NIGHT) shielded balance in atomic units. */
  balance: bigint;
  /** Number of spendable shielded coins tracked. */
  availableCoins: number;
  /** Final ZswapLocalState — callers serialize this for caching. */
  state: ledger.ZswapLocalState;
  /** Highest relevant-transaction index applied (checkpoint cursor). -1 if none. */
  lastAppliedIndex: number;
  /** True if we stopped before catching up to the tip (timeout/abort) — resume from the checkpoint. */
  partial: boolean;
}

export interface ShieldedDirectOptions {
  /** Called with (relevantTxApplied, tipIndex) as progress advances. */
  onProgress?: (applied: number, tip: number) => void;
  /** Persist a checkpoint (state + cursor) after each chunk so a kill doesn't lose work. */
  onCheckpoint?: (state: ledger.ZswapLocalState, lastAppliedIndex: number) => void;
  /** Soft ceiling for the whole sync; on expiry resolves `partial: true`. Default 600s. */
  timeoutMs?: number;
  /** Treat the stream as caught up after this idle gap once we've seen the tip. Default 5s. */
  idleMs?: number;
  /** Abort mid-flight. */
  signal?: AbortSignal;
  /** Resume from this cached state instead of a fresh one. */
  initialState?: ledger.ZswapLocalState;
  /** Subscribe from this relevant-transaction index (inclusive). Default 0. */
  startFromIndex?: number;
}

/** Derive the HTTP GraphQL endpoint (for mutations) from the WS endpoint. */
function httpFromWs(indexerWs: string): string {
  return indexerWs.replace(/^ws/, 'http').replace(/\/ws$/, '');
}

function viewingKeyOf(secretKeys: ledger.ZswapSecretKeys, networkId: NetworkId.NetworkId): string {
  return ShieldedEncryptionSecretKey.codec
    .encode(networkId, new ShieldedEncryptionSecretKey(secretKeys.encryptionSecretKey))
    .asString();
}

/** Sum spendable native-token coins in a state. */
function nativeBalance(state: ledger.ZswapLocalState): { balance: bigint; count: number } {
  const native = ledger.unshieldedToken().raw; // shielded NIGHT keys off the unshielded raw (matches balance.ts / facade)
  let balance = 0n;
  let count = 0;
  for (const coin of state.coins) {
    count++;
    if (coin.type === native) balance += coin.value;
  }
  return { balance, count };
}

/**
 * Register the viewing key and stream the wallet's relevant shielded activity,
 * applying collapsed Merkle updates + our coins (and removing spent coins), into
 * a ZswapLocalState. Resolves with the balance + state + resume cursor.
 */
export function readShieldedBalanceDirect(
  secretKeys: ledger.ZswapSecretKeys,
  indexerWs: string,
  networkId: NetworkId.NetworkId,
  options: ShieldedDirectOptions = {},
): Promise<ShieldedDirectResult> {
  const {
    onProgress,
    onCheckpoint,
    timeoutMs = 600_000,
    idleMs = 5_000,
    signal,
    initialState,
    startFromIndex = 0,
  } = options;

  const http = httpFromWs(indexerWs);
  const viewingKey = viewingKeyOf(secretKeys, networkId);

  async function graphqlMutation(query: string, variables: Record<string, unknown>): Promise<any> {
    const res = await fetch(http, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    return res.json();
  }

  return new Promise<ShieldedDirectResult>((resolve, reject) => {
    let state = initialState ?? new ledger.ZswapLocalState();
    let sessionId = '';
    let relevantApplied = 0;
    let lastAppliedIndex = startFromIndex - 1;
    let txTip = 0, txChecked = 0;
    let nullTip = 0, nullChecked = 0;
    let sawTx = false, sawNull = false;
    let settled = false;
    let ws: WebSocket | undefined;
    let timeoutId: ReturnType<typeof setTimeout>;
    let idleId: ReturnType<typeof setTimeout> | undefined;

    const caughtUp = () =>
      sawTx && txTip > 0 && txChecked >= txTip &&
      // nullifier stream may legitimately be empty for a receive-only wallet
      (!sawNull || (nullTip > 0 ? nullChecked >= nullTip : true));

    const cleanup = () => {
      clearTimeout(timeoutId);
      if (idleId) clearTimeout(idleId);
      try { ws?.close(); } catch { /* best-effort */ }
      signal?.removeEventListener('abort', onAbort);
      if (sessionId) void graphqlMutation(DISCONNECT_MUTATION, { sessionId }).catch(() => {});
    };

    const finish = (partial = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      const { balance, count } = nativeBalance(state);
      resolve({ balance, availableCoins: count, state, lastAppliedIndex, partial });
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onAbort = () => fail(new Error('Operation cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });

    // Apply one relevant transaction: fast-forward the tree over the foreign gap,
    // then apply our coins from its offers and remove any of our coins it spends.
    const applyRelevant = (rawHex: string, updateHex?: string) => {
      if (updateHex) {
        state = state.applyCollapsedUpdate(ledger.MerkleTreeCollapsedUpdate.deserialize(new Uint8Array(Buffer.from(updateHex, 'hex'))));
      }
      const tx = deserializeSealed(rawHex);
      const offers: ledger.ZswapOffer<ledger.Proof>[] = [];
      if (tx.guaranteedOffer) offers.push(tx.guaranteedOffer);
      if (tx.fallibleOffer) for (const o of tx.fallibleOffer.values()) offers.push(o);
      for (const offer of offers) {
        state = state.apply(secretKeys, offer);
        for (const input of offer.inputs) {
          try { state = state.removeCoinByNullifier(input.nullifier); } catch { /* not our coin */ }
        }
      }
    };

    // A spend-only tx (no output for us): drop the coins it nullifies.
    const applyNullifierTx = (rawHex: string) => {
      const tx = deserializeSealed(rawHex);
      const offers: ledger.ZswapOffer<ledger.Proof>[] = [];
      if (tx.guaranteedOffer) offers.push(tx.guaranteedOffer);
      if (tx.fallibleOffer) for (const o of tx.fallibleOffer.values()) offers.push(o);
      for (const offer of offers) {
        for (const input of offer.inputs) {
          try { state = state.removeCoinByNullifier(input.nullifier); } catch { /* not our coin */ }
        }
      }
    };

    const armIdle = () => {
      if (idleId) clearTimeout(idleId);
      idleId = setTimeout(() => { if (caughtUp()) finish(); }, idleMs);
    };

    (async () => {
      try {
        const conn = await graphqlMutation(CONNECT_MUTATION, { viewingKey });
        if (!conn?.data?.connect) throw new Error(`connect failed: ${JSON.stringify(conn?.errors)?.slice(0, 200)}`);
        sessionId = conn.data.connect;
      } catch (err) {
        fail(err as Error);
        return;
      }

      ws = new WebSocket(indexerWs, ['graphql-transport-ws']);
      ws.on('open', () => ws!.send(JSON.stringify({ type: 'connection_init' })));
      ws.on('error', (e: Error) => fail(new Error(`WebSocket error: ${e.message}`)));
      ws.on('close', () => { if (!settled) finish(sawTx && !caughtUp()); });
      ws.on('message', (data: WebSocket.Data) => {
        let msg: any;
        try { msg = JSON.parse(data.toString()); } catch { return; }

        if (msg.type === 'connection_ack') {
          ws!.send(JSON.stringify({ id: 'tx', type: 'subscribe', payload: { query: SHIELDED_TX_SUBSCRIPTION, variables: { sessionId, index: startFromIndex } } }));
          ws!.send(JSON.stringify({ id: 'null', type: 'subscribe', payload: { query: NULLIFIER_SUBSCRIPTION, variables: { sessionId, index: startFromIndex } } }));
          return;
        }
        if (msg.type === 'error') { fail(new Error(`GraphQL subscription error: ${JSON.stringify(msg.payload)?.slice(0, 200)}`)); return; }
        if (msg.type !== 'next') return;

        try {
          if (msg.id === 'tx') {
            const p = msg.payload?.data?.shieldedTransactions;
            if (!p) return;
            sawTx = true;
            if (p.__typename === 'ShieldedTransactionsProgress') {
              txTip = Number(p.highestEndIndex); txChecked = Number(p.highestCheckedEndIndex);
            } else if (p.__typename === 'RelevantTransaction') {
              applyRelevant(p.transaction.raw, p.collapsedMerkleTree?.update);
              relevantApplied++;
              lastAppliedIndex = Number(p.transaction.endIndex);
              if (onCheckpoint) { try { onCheckpoint(state, lastAppliedIndex); } catch { /* best-effort */ } }
            }
            onProgress?.(relevantApplied, txTip);
          } else if (msg.id === 'null') {
            const p = msg.payload?.data?.shieldedNullifierTransactions;
            if (!p) return;
            sawNull = true;
            if (p.__typename === 'ShieldedTransactionsProgress') {
              nullTip = Number(p.highestEndIndex); nullChecked = Number(p.highestCheckedEndIndex);
            } else if (p.__typename === 'RelevantTransaction') {
              applyNullifierTx(p.transaction.raw);
            }
          }
        } catch (err) {
          fail(new Error(`Failed applying shielded update: ${(err as Error).message}`));
          return;
        }

        if (caughtUp()) { finish(); return; }
        armIdle();
      });
    })();

    timeoutId = setTimeout(() => finish(true), timeoutMs);
  });
}
