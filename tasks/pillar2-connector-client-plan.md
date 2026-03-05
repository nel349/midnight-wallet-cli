# DApp Connector Client Library — `midnight-wallet-connector`

## Context

Pillar 2 (DApp Connector Server) is implemented — `midnight serve` exposes all 18 ConnectedAPI methods over WebSocket JSON-RPC on port 9932. DApp developers now need a client library to connect to this server. Without it, they'd need to manually handle WebSocket connection, JSON-RPC framing, and bigint serialization.

The bboard example UI currently polls `window.midnight.mnLace` for the Lace wallet extension. To use our CLI wallet instead, developers need a drop-in client that returns the same `ConnectedAPI` interface over WebSocket transport.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Location | `packages/connector/` subdirectory in CLI repo | Keeps protocol in sync, shared CI |
| npm package | `midnight-wallet-connector` (public, unscoped) | Not @midnight-ntwrk — that's the official SDK |
| Types | Own compatible type definitions | `@midnight-ntwrk/dapp-connector-api` is on GitHub Package Registry, not public npm. Structural typing ensures compatibility. |
| Browser + Node | Runtime WebSocket detection | `globalThis.WebSocket` in browser, dynamic `import('ws')` in Node |
| Bigint handling | Per-method conversion maps | Server sends `bigint.toString()`, client converts known fields back to `bigint` |
| Reconnection | Manual in v1 | `disconnect()` + `onDisconnect()` — auto-reconnect adds session complexity |
| getProvingProvider | Returns `proverServerUri` + stub methods | Real proving requires bidirectional RPC (future) |
| Build | `tsc` for declarations + `tsup` for ESM/CJS bundles | Standard library publishing pattern |

## Architecture

```
DApp code
  └─ import { createWalletClient } from 'midnight-wallet-connector'
       └─ WalletClient (implements ConnectedAPI)
            └─ RpcTransport (WebSocket JSON-RPC 2.0)
                 └─ ws://localhost:9932 → midnight serve
```

## Developer Experience

```typescript
import { createWalletClient } from 'midnight-wallet-connector';

const wallet = await createWalletClient({
  url: 'ws://localhost:9932',
  networkId: 'Undeployed',
});

// All methods return proper types with native bigint
const balances = await wallet.getUnshieldedBalances();
const config = await wallet.getConfiguration();
const { unshieldedAddress } = await wallet.getUnshieldedAddress();

// Write methods trigger terminal approval on the serve side
const { tx } = await wallet.makeTransfer(
  [{ kind: 'unshielded', type: NATIVE_TOKEN, value: 100_000_000n, recipient: addr }],
);

wallet.disconnect();
```

## Package Structure

```
packages/connector/
  package.json
  tsconfig.json
  tsup.config.ts
  src/
    index.ts              # Public API exports
    client.ts             # createWalletClient factory → WalletClient
    transport.ts          # WebSocket JSON-RPC transport (browser + Node)
    bigint.ts             # Per-method bigint string↔native conversion
    errors.ts             # APIError reconstruction from JSON-RPC errors
    types.ts              # ConnectedAPI-compatible type definitions
  src/__tests__/
    client.test.ts        # Integration: full client against mock WS server
    transport.test.ts     # Unit: JSON-RPC framing, error handling, timeout
    bigint.test.ts        # Unit: string→bigint conversion maps
```

## Files to Create

### 1. `packages/connector/src/types.ts` — ConnectedAPI-compatible types

Own type definitions matching `@midnight-ntwrk/dapp-connector-api@4.0.1`. Structurally compatible — TypeScript duck typing means these work interchangeably with the official types.

Types to define:
- `ConnectedAPI` (WalletConnectedAPI & HintUsage)
- `WalletConnectedAPI` — exported separately for consumers who need just the wallet methods
- `HintUsage` — the `hintUsage()` method interface
- `Configuration`, `ConnectionStatus`, `HistoryEntry`, `TxStatus`, `ExecutionStatus`
- `DesiredOutput`, `DesiredInput`, `TokenType`
- `SignDataOptions`, `Signature`
- `KeyMaterialProvider`, `ProvingProvider`
- `APIError`, `ErrorCode`

Not included (not needed for client):
- `InitialAPI` — our `createWalletClient` replaces the window injection discovery pattern

### 2. `packages/connector/src/transport.ts` — WebSocket JSON-RPC transport

Core transport that handles:
- WebSocket connection (auto-detect browser `WebSocket` vs Node `ws`)
- JSON-RPC 2.0 request/response framing with auto-incrementing IDs
- Pending call map: `Map<number, { resolve, reject }>`
- Bigint serialization in outbound params (replacer: `bigint.toString()`)
- Configurable per-call timeout (default 5 minutes for proof-heavy ops)
- Disconnect detection and callback

### 3. `packages/connector/src/bigint.ts` — Bigint conversion

Per-method conversion functions for response data. Only these methods return bigint:

| Method | Fields to convert |
|--------|-------------------|
| `getUnshieldedBalances` | All values in `Record<string, string>` → `Record<string, bigint>` |
| `getShieldedBalances` | All values in `Record<string, string>` → `Record<string, bigint>` |
| `getDustBalance` | `cap` and `balance` strings → bigint |

All other methods return strings, objects, or void — no conversion needed.

Outbound bigint→string conversion is handled by the transport layer's `jsonReplacer` (not bigint.ts).
This covers `DesiredOutput.value` and `DesiredInput.value` which are `bigint` in the API types.

### 4. `packages/connector/src/errors.ts` — Error reconstruction

Reconstruct typed `APIError` from JSON-RPC error responses. The server embeds error metadata in `error.data`:
```json
{ "code": -32000, "message": "User rejected", "data": { "type": "DAppConnectorAPIError", "code": "Rejected" } }
```

Error code mapping (reverse of server's `API_ERROR_TO_RPC_CODE`):
- `-32000` → Rejected
- `-32001` → PermissionRejected
- `-32002` → Disconnected
- `-32602` → InvalidRequest
- `-32603` → InternalError

### 5. `packages/connector/src/client.ts` — WalletClient factory

```typescript
interface WalletClientOptions {
  url: string;           // ws://localhost:9932
  networkId: string;     // 'Undeployed', 'PreProd', 'Preview'
  timeout?: number;      // per-call timeout ms (default: 300_000)
}

interface WalletClient extends ConnectedAPI {
  disconnect(): void;
  onDisconnect(handler: () => void): void;
}

function createWalletClient(options: WalletClientOptions): Promise<WalletClient>
```

Factory opens transport, calls `connect({ networkId })`, returns object implementing all 18 methods.

Each method converts positional API params to named JSON-RPC params, then delegates to `transport.call(method, params)`. Response bigints are converted back per-method.

**Positional → Named param mapping** (11 of 18 methods need this):

| API method signature | JSON-RPC params object |
|---------------------|----------------------|
| `getTxHistory(pageNumber, pageSize)` | `{ pageNumber, pageSize }` |
| `makeTransfer(desiredOutputs, options?)` | `{ desiredOutputs, options }` |
| `submitTransaction(tx)` | `{ tx }` |
| `balanceUnsealedTransaction(tx, options?)` | `{ tx, options }` |
| `balanceSealedTransaction(tx, options?)` | `{ tx, options }` |
| `makeIntent(desiredInputs, desiredOutputs, options)` | `{ desiredInputs, desiredOutputs, options }` |
| `signData(data, options)` | `{ data, options }` |
| `getProvingProvider(keyMaterialProvider)` | `{}` (param ignored by server — v1 limitation) |
| `hintUsage(methodNames)` | `{ methodNames }` |
| `connect(networkId)` | `{ networkId }` (called internally by factory) |

The 8 no-param read methods (`getUnshieldedBalances`, etc.) send `{}`.

**getProvingProvider** — Server returns `{ provingProvider: 'ready', proverServerUri: string }`. Client exposes `proverServerUri` and stubs `check()`/`prove()` with errors explaining JSON-RPC limitation.

### 6. `packages/connector/src/index.ts` — Public API

Exports: `createWalletClient`, `WalletClient`, `WalletClientOptions`, and all types from `types.ts`.

### 7. `packages/connector/package.json`

```json
{
  "name": "midnight-wallet-connector",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "peerDependencies": {
    "ws": ">=8.0.0"
  },
  "peerDependenciesMeta": {
    "ws": { "optional": true }
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsup": "^8.0.0",
    "vitest": "^3.0.0",
    "ws": "^8.19.0",
    "@types/ws": "^8.5.0"
  }
}
```

Runtime dependencies: **zero**. `ws` is optional peer dep (Node only).

## Files to Modify

### 8. Root `package.json` — Add workspace

Add npm workspaces config so the connector package is recognized:
```json
{ "workspaces": ["packages/*"] }
```

## Implementation Order

1. Scaffold: `package.json`, `tsconfig.json`, `tsup.config.ts`
2. `types.ts` — all ConnectedAPI-compatible type definitions
3. `errors.ts` — APIError reconstruction
4. `bigint.ts` — per-method conversion functions
5. `transport.ts` — WebSocket JSON-RPC transport
6. `client.ts` — `createWalletClient` factory
7. `index.ts` — public exports
8. Tests: `transport.test.ts`, `bigint.test.ts`, `client.test.ts`

## Testing

Tests use `vitest` with a **real WebSocket server** (using `ws`) that mimics the CLI server's protocol. No mocks of our own code.

- **`transport.test.ts`**: Connect, send RPC, receive response, handle errors, timeout, bigint param serialization
- **`bigint.test.ts`**: `reviveBalanceRecord`, `reviveDustBalance`, empty records, edge cases
- **`client.test.ts`**: Full integration — mock WS server with handlers matching real protocol, verify all 18 methods dispatch correctly, bigint round-trip (server sends `"5000000"`, client returns `5000000n`), network mismatch error, disconnect callback

## Verification

- `npm run typecheck` — zero errors (in packages/connector)
- `npm run build` — produces dist/index.mjs, dist/index.js, dist/index.d.ts
- `npm test` — all tests pass
- Manual: `mn serve` + test script that imports `createWalletClient` and calls read methods
- Verify: `WalletClient` is structurally assignable to official `ConnectedAPI` type
