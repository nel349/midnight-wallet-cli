# midnight-wallet-connector

![midnight-wallet-connector demo](https://raw.githubusercontent.com/nel349/midnight-wallet-cli-hub/main/docs/demo-github-connector.gif)

[![npm version](https://badge.fury.io/js/midnight-wallet-connector.svg)](https://www.npmjs.com/package/midnight-wallet-connector)
[![npm downloads](https://img.shields.io/npm/dm/midnight-wallet-connector)](https://npm-stat.com/charts.html?package=midnight-wallet-connector)
[![License](https://img.shields.io/npm/l/midnight-wallet-connector)](https://www.apache.org/licenses/LICENSE-2.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript)](https://www.typescriptlang.org/)


A TypeScript client for connecting dApps to the Midnight CLI wallet (`mn serve`) over WebSocket JSON-RPC. Implements the same `ConnectedAPI` interface as the Lace browser extension, so your app can switch between them without code changes.

## Install

```bash
npm install midnight-wallet-connector
# or
yarn add midnight-wallet-connector
# or
pnpm add midnight-wallet-connector
```

> `ws` is an optional peer dependency — only needed in Node.js. Browsers use native `WebSocket`.

## Quick Start

```typescript
import { createWalletClient } from 'midnight-wallet-connector';

const wallet = await createWalletClient({
  url: 'ws://localhost:9932',
  networkId: 'Undeployed',
});

const balances = await wallet.getUnshieldedBalances();
console.log('Balances:', balances);

wallet.disconnect();
```

Start the wallet server first:

```bash
mn serve                # interactive terminal approval
mn serve --approve-all  # auto-approve all requests (dev only)
```

## API Reference

### `createWalletClient(options): Promise<WalletClient>`

Connects to `mn serve` over WebSocket and performs a network handshake. Throws an `APIError` with code `InvalidRequest` if the wallet's network doesn't match `networkId`.

### WalletClientOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `url` | `string` | — | WebSocket URL, e.g. `ws://localhost:9932` |
| `networkId` | `string` | — | `'Undeployed'`, `'PreProd'`, or `'Preview'` |
| `timeout` | `number` | `300000` | Per-call timeout in ms (5 min default, sized for proof-heavy ops) |
| `onApprovalPending` | `(method: string) => void` | — | Called when the server begins waiting for terminal approval |
| `onApprovalResolved` | `(method: string, result: 'approved' \| 'rejected') => void` | — | Called when terminal approval completes |

### WalletClient Methods

**Balance**

```typescript
getUnshieldedBalances(): Promise<Record<TokenType, bigint>>
getShieldedBalances(): Promise<Record<TokenType, bigint>>
getDustBalance(): Promise<{ cap: bigint; balance: bigint }>
```

**Addresses**

```typescript
getUnshieldedAddress(): Promise<{ unshieldedAddress: string }>
getShieldedAddresses(): Promise<{
  shieldedAddress: string;
  shieldedCoinPublicKey: string;
  shieldedEncryptionPublicKey: string;
}>
getDustAddress(): Promise<{ dustAddress: string }>
```

**Transactions**

```typescript
balanceUnsealedTransaction(tx: string, options?: { payFees?: boolean }): Promise<{ tx: string }>
balanceSealedTransaction(tx: string, options?: { payFees?: boolean }): Promise<{ tx: string }>
makeTransfer(desiredOutputs: DesiredOutput[], options?: { payFees?: boolean }): Promise<{ tx: string }>
makeIntent(
  desiredInputs: DesiredInput[],
  desiredOutputs: DesiredOutput[],
  options: { intentId: number | 'random'; payFees: boolean },
): Promise<{ tx: string }>
submitTransaction(tx: string): Promise<void>
```

**History**

```typescript
getTxHistory(pageNumber: number, pageSize: number): Promise<HistoryEntry[]>
```

**Signing**

```typescript
signData(data: string, options: SignDataOptions): Promise<Signature>
```

**Proving**

```typescript
getProvingProvider(keyMaterialProvider: KeyMaterialProvider): Promise<WalletProvingProvider>
```

> **Note:** `.check()` and `.prove()` on the returned provider throw "not yet supported". Use `.proverServerUri` directly until bidirectional WebSocket proving is implemented.

**Configuration & Status**

```typescript
getConfiguration(): Promise<Configuration>
getConnectionStatus(): Promise<ConnectionStatus>
```

**Hints**

```typescript
hintUsage(methodNames: Array<keyof WalletConnectedAPI>): Promise<void>
```

**Lifecycle** (client-only, not part of `ConnectedAPI`)

```typescript
disconnect(): void
onDisconnect(handler: () => void): void
```

## Framework Integration

The connector just needs a WebSocket URL. Pass it through your framework's environment variable pattern:

### Vite

```bash
# .env.local
VITE_WALLET_URL=ws://localhost:9932
```

```typescript
const walletUrl = import.meta.env.VITE_WALLET_URL;
```

### Next.js

```bash
# .env.local
NEXT_PUBLIC_WALLET_URL=ws://localhost:9932
```

```typescript
const walletUrl = process.env.NEXT_PUBLIC_WALLET_URL;
```

### Create React App

```bash
# .env.local
REACT_APP_WALLET_URL=ws://localhost:9932
```

```typescript
const walletUrl = process.env.REACT_APP_WALLET_URL;
```

### Plain Node.js / Scripts

```bash
WALLET_URL=ws://localhost:9932 node my-script.js
```

```typescript
const walletUrl = process.env.WALLET_URL;
```

## Production: Lace Fallback

In development, connect to `mn serve` via WebSocket. In production, omit the environment variable and fall back to the Lace browser extension. Both return the same `ConnectedAPI` interface, so the rest of your app doesn't change.

```typescript
import { createWalletClient, type ConnectedAPI } from 'midnight-wallet-connector';

const walletUrl = import.meta.env.VITE_WALLET_URL; // undefined in production
const networkId = 'Undeployed';

let wallet: ConnectedAPI;

if (walletUrl) {
  try {
    wallet = await createWalletClient({ url: walletUrl, networkId });
  } catch (err) {
    console.warn('WebSocket wallet not available, falling back to Lace extension');
    wallet = await connectToLace(networkId);
  }
} else {
  wallet = await connectToLace(networkId);
}

// From here on, `wallet` works the same regardless of backend
const balances = await wallet.getUnshieldedBalances();
```

Where `connectToLace` wraps the Midnight Lace extension API:

```typescript
async function connectToLace(networkId: string): Promise<ConnectedAPI> {
  const lace = window.midnight?.mnLace;
  if (!lace) {
    throw new Error('Midnight Lace wallet not found. Is the extension installed?');
  }
  return lace.connect(networkId);
}
```

This is the pattern used by the [bboard-ui example](https://github.com/midnight-ntwrk/midnight-examples) — the canonical reference implementation for Midnight dApps.

## Approval Notifications

When `mn serve` is running in interactive mode (without `--approve-all`), write operations pause for terminal approval. Use the callbacks to show a loading state in your UI:

```typescript
const wallet = await createWalletClient({
  url: 'ws://localhost:9932',
  networkId: 'Undeployed',
  onApprovalPending(method) {
    showToast(`Waiting for terminal approval: ${method}...`);
  },
  onApprovalResolved(method, result) {
    if (result === 'approved') {
      dismissToast();
    } else {
      showToast(`${method} was rejected at the terminal`);
    }
  },
});
```

These callbacks are optional and only relevant during development with `mn serve` in interactive mode.

## Error Handling

All errors thrown by the client are `APIError` objects:

```typescript
import { ErrorCodes, type APIError } from 'midnight-wallet-connector';

try {
  await wallet.submitTransaction(tx);
} catch (err) {
  const apiErr = err as APIError;
  switch (apiErr.code) {
    case ErrorCodes.Rejected:
      // User rejected the transaction at the terminal
      break;
    case ErrorCodes.InvalidRequest:
      // Bad request (e.g. network mismatch)
      break;
    case ErrorCodes.PermissionRejected:
      // Permission denied
      break;
    case ErrorCodes.Disconnected:
      // WebSocket connection lost
      break;
    case ErrorCodes.InternalError:
      // Server-side error
      break;
  }
}
```

## Requirements

- Node.js >= 18
- `ws` (optional peer dependency — Node.js only, browsers use native `WebSocket`)
- A running `mn serve` instance when using the connector directly (install via `npm install -g midnight-wallet-cli`)
