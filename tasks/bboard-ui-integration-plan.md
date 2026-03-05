# BBoard UI Integration with midnight-wallet-connector

## Context

The bboard example UI (`midnight-libraries/example-bboard/bboard-ui`) currently polls `window.midnight.mnLace` for the Lace browser extension wallet. We need to swap this to use our `midnight-wallet-connector` library, which connects directly to `midnight serve` over WebSocket.

The key UX challenge: write methods (`balanceUnsealedTransaction`, `submitTransaction`) block while the user approves in the terminal. The DApp needs to show "Waiting for wallet approval..." rather than just spinning. This requires server-side notifications.

## Scope

Three layers of changes:

1. **Server** (`midnight-wallet-cli`) — Add JSON-RPC notifications for approval state
2. **Connector client** (`packages/connector`) — Listen for notifications, expose via callbacks
3. **BBoard UI** (`/Users/norman/Development/midnight/midnight-libraries/example-bboard/bboard-ui`) — Replace Lace connection with `createWalletClient`, show approval state

---

## Part 1: Server — Approval Notifications

### What changes

Add JSON-RPC notifications (messages without `id`) that the server pushes when approval state changes. This is spec-compliant and doesn't break existing request/response protocol.

### Files to modify

**`src/lib/ws-rpc.ts`**

Add types:
- `JsonRpcNotification` interface (jsonrpc, method, params — no id)
- `RpcHandlerContext` interface with a `notify(method, params?)` function
- Update `RpcHandler` type: `(params, context: RpcHandlerContext) => Promise<unknown>`

Add `notify()` method on `RpcConnection`:
- Sends a `JsonRpcNotification` over the connection's WebSocket
- Guards against closed sockets (check readyState)

Wire context into handler dispatch:
- When invoking a handler, construct an `RpcHandlerContext` from the connection's `notify`
- Pass it as the second argument: `handler(request.params ?? {}, context)`

**`src/lib/dapp-connector.ts`**

Thread `notify` through the approval path:
- `requireApproval()` currently takes `(method, details?)` — add optional `notify` parameter
- Before calling `promptApproval()`, call `notify('approval:pending', { method })`
- After `promptApproval()` returns, call `notify('approval:resolved', { method, result })` where result is `'approved'` or `'rejected'`
- All write-method handlers already call `requireApproval()` — update each call to pass `context.notify`
- The `RpcHandler` type change means every handler now receives `(params, context)` — read-only handlers can ignore the second arg

**`src/lib/approval.ts`** — No changes needed (already returns 'approve'|'reject')

### Notification format

```json
{ "jsonrpc": "2.0", "method": "approval:pending", "params": { "method": "balanceUnsealedTransaction" } }
{ "jsonrpc": "2.0", "method": "approval:resolved", "params": { "method": "balanceUnsealedTransaction", "result": "approved" } }
```

---

## Part 2: Connector Client — Notification Callbacks

### What changes

The transport already receives all WebSocket messages. Add handling for messages without `id` (notifications) and expose them via callbacks.

### Files to modify

**`packages/connector/src/transport.ts`**

In the message handler (line ~93-114):
- After parsing the message, check: if there's no `id` but there IS a `method`, it's a notification
- Call `onNotification(method, params)` if the callback is registered
- Add `onNotification?: (method: string, params: any) => void` to `TransportOptions`
- This check must come BEFORE the existing `pending.get(id)` lookup

**`packages/connector/src/client.ts`**

Add callbacks to `WalletClientOptions`:
- `onApprovalPending?: (method: string) => void`
- `onApprovalResolved?: (method: string, result: 'approved' | 'rejected') => void`

Wire these to the transport:
- Pass `onNotification` to `createTransport()`
- In the `onNotification` handler, filter by method name:
  - `approval:pending` → call `onApprovalPending(params.method)`
  - `approval:resolved` → call `onApprovalResolved(params.method, params.result)`

**`packages/connector/src/index.ts`** — No new exports needed (callbacks are part of existing option types)

### Tests to add

**`packages/connector/src/__tests__/transport.test.ts`**
- Test: server sends notification (no id, has method), `onNotification` callback fires with correct method and params

**`packages/connector/src/__tests__/client.test.ts`**
- Test: mock server sends `approval:pending` notification, `onApprovalPending` fires with method name
- Test: mock server sends `approval:resolved` notification, `onApprovalResolved` fires with method and result

---

## Part 3: BBoard UI Integration

### Location

All files in `/Users/norman/Development/midnight/midnight-libraries/example-bboard/bboard-ui/`

### What changes

Replace the `connectToWallet()` function that polls `window.midnight.mnLace` with a direct `createWalletClient()` call. The returned `WalletClient` is structurally compatible with `ConnectedAPI` — same method signatures.

### Files to modify

**`src/contexts/BrowserDeployedBoardManager.ts`**

Replace `connectToWallet()` function (lines 271-337):
- Delete the entire RxJS polling chain (interval, filter, concatMap, semver check, timeout)
- Replace with: `createWalletClient({ url, networkId, onApprovalPending, onApprovalResolved })`
- The `url` comes from env var `VITE_WALLET_URL` (default: `ws://localhost:9932`)
- The approval callbacks update a shared `BehaviorSubject<ApprovalState>`

Replace `initializeProviders()` (lines 221-268):
- The function stays mostly the same — it calls `connectToWallet()` then builds providers
- The `connectedAPI` return from `createWalletClient` has the same interface
- Remove `semver` import and version checking (not relevant for WebSocket connector)
- Remove `ConnectedAPI` and `InitialAPI` imports from `@midnight-ntwrk/dapp-connector-api`
- Add `createWalletClient` and `WalletClient` imports from `midnight-wallet-connector`

Expose approval state:
- Add an `approvalState$` BehaviorSubject property to `BrowserDeployedBoardManager`
- Type: `BehaviorSubject<{ status: 'idle' } | { status: 'pending'; method: string } | { status: 'resolved'; method: string; result: string }>`
- The `onApprovalPending`/`onApprovalResolved` callbacks (passed to `createWalletClient`) update this subject
- Expose as a public readonly observable on the class

**`src/contexts/DeployedBoardContext.tsx`**
- Pass `approvalState$` through context so Board.tsx can access it
- Add a second context or extend the existing context value to include the observable

**`src/components/Board.tsx`**
- Subscribe to `approvalState$`
- When `pending`, show a Backdrop with message "Approve in terminal..." instead of the generic CircularProgress
- When `resolved`, hide the approval overlay

**`package.json`**
- Add `midnight-wallet-connector` dependency (file: reference to `../../midnight-wallet-cli/packages/connector`)

**`.env.undeployed`**
- Add `VITE_WALLET_URL=ws://localhost:9932`

### Import changes

```typescript
// Before (remove these)
import { ConnectedAPI, type InitialAPI } from '@midnight-ntwrk/dapp-connector-api';
import semver from 'semver';

// After (add these)
import { createWalletClient, type WalletClient } from 'midnight-wallet-connector';
```

---

## Implementation Order

1. Server notifications (ws-rpc.ts + dapp-connector.ts)
2. Connector notification support (transport.ts + client.ts + tests)
3. BBoard UI integration (BrowserDeployedBoardManager.ts + Board.tsx)
4. End-to-end test: `mn serve` + bboard-ui — deploy board, post message, verify approval UX

## Verification

- `mn serve --approve-all` + bboard-ui: all operations work (no approval modal since auto-approved)
- `mn serve` (no flags) + bboard-ui: write operations show "Approve in terminal..." overlay, user approves in terminal, operation completes
- `mn serve` + reject in terminal: bboard-ui shows rejection error
- All existing connector tests pass
- All existing CLI tests pass
