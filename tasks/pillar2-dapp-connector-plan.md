# Pillar 2: DApp Connector Server — Implementation Plan

## Context

DApps need to connect to wallets to make contract calls, transfers, and read balances. The DApp Connector API v4.0.1 (`@midnight-ntwrk/dapp-connector-api`) defines 18 methods as the standard interface. We implement this as a local WebSocket JSON-RPC server via `midnight serve` so DApps can connect to our CLI wallet.

`getProvingProvider` is mandatory — it's the only way DApps can prove contract transactions. Without it, no contract interaction works through the wallet.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Approval default | Auto-approve reads, prompt for writes | Reads are harmless; writes need user consent |
| Port | 9932 (`DEFAULT_SERVE_PORT`) | Custom memorable port (99=midnight, 32=ws) |
| UI style | Compact status line + live log | Simple, informative, non-intrusive |
| getProvingProvider | Use SDK's `HttpProverClient` or `WasmProver` — no reverse RPC needed | SDK provides ready-made ProvingProvider adapters |
| Shielded support | Pass through to WalletFacade | Facade already handles shielded internally |

## Architecture

```
DApp (browser) ←WS JSON-RPC→ serve.ts ←→ dapp-connector.ts ←→ WalletFacade
                                              ↓
                                        approval.ts (write method gating)
                                        tx-serde.ts (hex ↔ Transaction)
                                        ws-rpc.ts (transport)
```

## Pre-existing Infrastructure (already built)

| File | What | Status |
|------|------|--------|
| `src/lib/ws-rpc.ts` | JSON-RPC 2.0 over WebSocket server, error mapping, bigint serialization, connection tracking | Complete |
| `src/lib/tx-serde.ts` | `serializeTx()`, `deserializeUnsealed/Sealed/Unproven()`, `toHex()`, `fromHex()` | Complete |
| `src/lib/approval.ts` | `promptApproval()`, `isReadOnlyMethod()`, `renderApprovalBox()`, auto-approve modes | Complete |
| `src/lib/facade.ts` | `buildFacade()`, `startAndSyncFacade()`, `stopFacade()`, `suppressSdkTransientErrors()` | Complete |
| `src/lib/transfer.ts` | `ensureDust()`, `registerNightUtxos()`, `suppressRpcNoise()`, full transfer pipeline | Complete |

---

## DApp Connector API v4.0.1 — All 18 Methods

### Handshake (1)

**`connect(networkId: string) → { networkId }`**
- Validate that `networkId` matches wallet's network (case-insensitive: "Undeployed" vs "undeployed")
- On mismatch: `createApiError('InvalidRequest', 'Network mismatch: wallet is on X, requested Y')`
- ws-rpc.ts auto-sets `connection.authenticated = true` on successful connect response

### Read-Only Methods (9) — auto-approved

| Method | Return Shape | SDK Source |
|--------|-------------|------------|
| `getUnshieldedBalances()` | `Record<TokenType, bigint>` | `state.unshielded.balances` |
| `getShieldedBalances()` | `Record<TokenType, bigint>` | `state.shielded.balances` |
| `getDustBalance()` | `{ cap: bigint, balance: bigint }` | `balance`: `state.dust.balance(new Date())` returns plain `bigint`; `cap`: estimate from registered NIGHT UTXO dust generation potential (or use balance as approximation for v1) |
| `getUnshieldedAddress()` | `{ unshieldedAddress: string }` | `state.unshielded.address.asString()` — address is an SDK object with `.asString()` method |
| `getShieldedAddresses()` | `{ shieldedAddress, shieldedCoinPublicKey, shieldedEncryptionPublicKey }` | `state.shielded.address.asString()`; keys: `.coinPublicKeyString()` / `.encryptionPublicKeyString()` |
| `getDustAddress()` | `{ dustAddress: string }` | `state.dust.address.asString()` — field is `.address` not `.dustAddress` |
| `getTxHistory(pageNumber, pageSize)` | `HistoryEntry[]` | `state.unshielded.transactionHistory` (empty if SDK not ready) |
| `getConfiguration()` | `Configuration` | Map `NetworkConfig` → `{ indexerUri, indexerWsUri, proverServerUri, substrateNodeUri, networkId }` |
| `getConnectionStatus()` | `ConnectionStatus` | `{ status: 'connected', networkId }` (alive while WS open) |

**Address encoding note**: All addresses from FacadeState are SDK objects (UnshieldedAddress, ShieldedAddress, DustAddress), NOT plain strings. Each has an `.asString()` method that returns the bech32m-encoded string. Use `address.asString()` — no need for `MidnightBech32m.encode()`.

### Write Methods (7) — require terminal approval

Each write method:
1. Builds `ApprovalRequest` with method name, network, details (amount, recipient, etc.)
2. Calls `promptApproval(request, approvalOptions)`
3. If rejected → `createApiError('Rejected', 'User rejected the request')`
4. Executes SDK operation
5. Returns result

**`makeTransfer(desiredOutputs, options?)`**
- Parse `DesiredOutput[]`: `{ kind, type, value, recipient }` — value arrives as string (JSON has no bigint)
- Convert to SDK's `CombinedTokenTransfer[]` — field mapping:
  - `kind` ('shielded'|'unshielded') → `type` (wrapper discriminant)
  - `type` (hex TokenType) → `type` (RawTokenType) on inner TokenTransfer
  - `value` (string→bigint) → `amount` (bigint)
  - `recipient` (bech32m string) → `receiverAddress` (UnshieldedAddress/ShieldedAddress object)
- Nest in `{ type: kind, outputs: [{ amount, receiverAddress, type }] }`
- Pipeline: `transferTransaction(outputs, secrets, {ttl, payFees})` → `signRecipe(recipe, keystore.signData)` → `finalizeRecipe(signed)` → `serializeTx(finalized)`
- Secrets: `{ shieldedSecretKeys: bundle.zswapSecretKeys, dustSecretKey: bundle.dustSecretKey }`
- Return `{ tx: hexString }`

**`submitTransaction(tx: string)`**
- `deserializeSealed(tx)` → `facade.submitTransaction(sealedTx)`
- SDK returns txHash (string), but DApp Connector spec says `Promise<void>` — we discard the hash
- Return void

**`balanceUnsealedTransaction(tx, options?)`**
- `deserializeUnsealed(tx)` → `facade.balanceUnboundTransaction(unboundTx, secrets, {ttl})`
- Sign → finalize → serialize
- Return `{ tx: hexString }`

**`balanceSealedTransaction(tx, options?)`**
- `deserializeSealed(tx)` → `facade.balanceFinalizedTransaction(sealedTx, secrets, {ttl})`
- Sign → finalize → serialize
- Return `{ tx: hexString }`

**`makeIntent(desiredInputs, desiredOutputs, options)`**
- `options` is **required** (not optional): `{ intentId: number | 'random', payFees: boolean }`
- Parse inputs/outputs, convert bigint strings
- `facade.initSwap(inputs, outputs, secrets, {ttl, payFees})`
- Note: facade.initSwap() does NOT accept intentId — check if SDK supports it at another level, otherwise ignore
- Sign → finalize → serialize
- Return `{ tx: hexString }`

**`signData(data, options)`**
- Decode based on `options.encoding`: hex → `fromHex()`, base64 → `Buffer.from(data, 'base64')`, text → `Buffer.from(data, 'utf-8')`
- `keystore.signData(payload)` → returns hex-encoded signature string (not raw bytes)
- `keystore.getPublicKey()` → returns hex-encoded verifying key string (not raw bytes)
- Return `{ data: originalData, signature: hexSignature, verifyingKey: hexVerifyingKey }`

**`getProvingProvider(keyMaterialProvider)` — SDK Adapter**

The SDK provides ready-made ProvingProvider adapters — no bidirectional RPC needed.

Implementation options:
- **Server proving** (recommended): `HttpProverClient.create({url: proofServerUrl})` → `.asProvingProvider()` — delegates to the proof server at the configured URL (e.g. `http://localhost:6300`)
- **WASM proving** (alternative): `WasmProver.create({keyMaterialProvider})` → `.asProvingProvider()` — runs proofs locally using the DApp's key material

The returned `ProvingProvider` has two methods (`check` and `prove`) that the DApp calls directly. The wallet just creates the adapter and returns it.

Packages: `@midnight-ntwrk/wallet-sdk-prover-client` (HttpProverClient, WasmProver)

### Permission Method (1)

**`hintUsage(methodNames: string[])`**
- Log method names to stderr: `dim('DApp hints usage: ...')`
- Resolve immediately (no permission persistence in v1)

---

## Transaction Type Mapping

| DApp Connector Term | Ledger Type | Deserialization Markers | tx-serde Function |
|--------------------|--------------|-----------------------|-------------------|
| Unsealed | `Transaction<SignatureEnabled, Proof, PreBinding>` | `'signature', 'proof', 'pre-binding'` | `deserializeUnsealed()` |
| Sealed | `Transaction<SignatureEnabled, Proof, Binding>` | `'signature', 'proof', 'binding'` | `deserializeSealed()` |
| Unproven | `Transaction<SignatureEnabled, PreProof, PreBinding>` | `'signature', 'pre-proof', 'pre-binding'` | `deserializeUnproven()` |

| DApp Connector Method | SDK Facade Method |
|-----------------------|-------------------|
| `balanceUnsealedTransaction()` | `facade.balanceUnboundTransaction()` |
| `balanceSealedTransaction()` | `facade.balanceFinalizedTransaction()` |

---

## Files to Create

### `src/lib/dapp-connector.ts`

Core logic file. Factory function returns handler map for ws-rpc.

```
createDAppConnector(options) → { handlers, dispose }

Options:
  - bundle: FacadeBundle (from buildFacade)
  - networkConfig: NetworkConfig
  - approvalOptions: ApprovalOptions
  - sendRequest: reverse RPC function (for getProvingProvider)

State management:
  - Subscribe to facade.state(), cache latest synced FacadeState
  - getState() throws Disconnected if not synced

Handler map:
  - Record<string, RpcHandler> mapping all 18 method names + prove/check
```

### `src/commands/serve.ts`

CLI entry point following existing command patterns.

Args: `--port`, `--wallet`, `--network`, `--approve-all`, `--auto-approve-reads`, `--json`

Lifecycle:
1. Parse args, load wallet, resolve network
2. Display header on stderr (network, address, port)
3. `buildFacade()` with spinner
4. `startAndSyncFacade()` with progress spinner
5. `createDAppConnector()` — get handler map
6. `createRpcServer({port, handlers, onConnect, onDisconnect, onRequest})`
7. Display "Server ready — listening on ws://localhost:{port}"
8. If `--json`: write `{port, network, address, status: 'listening'}` to stdout
9. Live log connection/request events to stderr (dim)
10. SIGINT → close RPC server → dispose connector → stop facade → exit 0

---

## Files to Modify

### `src/lib/constants.ts`
- Add `DEFAULT_SERVE_PORT = 9932`

### `src/wallet.ts`
- Add `serve` case to command switch
- Add `'serve'` to `FACADE_COMMANDS` set (for process.exit(0) after completion)

### `src/commands/help.ts`
- Add serve command spec to `COMMAND_SPECS`

### `src/ui/art.ts`
- Add `['serve', 'Start DApp Connector server']` to `COMMAND_BRIEFS`

---

## Implementation Order

| Step | File(s) | What | Dependencies |
|------|---------|------|-------------|
| 1 | `constants.ts` | Add `DEFAULT_SERVE_PORT` | None |
| 2 | `dapp-connector.ts` | All 18 handlers (read methods, write methods with approval, getProvingProvider via SDK adapter) | Step 1 |
| 3 | `serve.ts` | Command entry point | Step 2 |
| 4 | `wallet.ts` | Add dispatch | Step 3 |
| 5 | `help.ts` + `art.ts` | Add to help system | Step 3 |
| 6 | Tests | dapp-connector, serve command | Steps 1-5 |

---

## Error Handling

DApp Connector errors use tagged error type:
```
APIError = Error & { type: 'DAppConnectorAPIError', code: ErrorCode, reason: string }
ErrorCode = 'InternalError' | 'Rejected' | 'InvalidRequest' | 'PermissionRejected' | 'Disconnected'
```

Already implemented: `createApiError(code, reason)` in ws-rpc.ts, with error code → JSON-RPC code mapping:
- Rejected → -32000
- PermissionRejected → -32001
- Disconnected → -32002
- InvalidRequest → -32602
- InternalError → -32603

---

## WebSocket Protocol Examples

```jsonc
// Handshake
→ { "jsonrpc": "2.0", "id": 1, "method": "connect", "params": { "networkId": "undeployed" } }
← { "jsonrpc": "2.0", "id": 1, "result": { "networkId": "Undeployed" } }

// Read balance
→ { "jsonrpc": "2.0", "id": 2, "method": "getUnshieldedBalances" }
← { "jsonrpc": "2.0", "id": 2, "result": { "0000...0001": "5000000" } }

// Transfer (prompts terminal approval)
→ { "jsonrpc": "2.0", "id": 3, "method": "makeTransfer", "params": {
     "desiredOutputs": [{ "kind": "unshielded", "type": "0000...0001", "value": "10000000", "recipient": "mn_addr_..." }]
   }}
← { "jsonrpc": "2.0", "id": 3, "result": { "tx": "hex_sealed_transaction..." } }

// User rejected
← { "jsonrpc": "2.0", "id": 3, "error": { "code": -32000, "message": "User rejected the request", "data": { "type": "DAppConnectorAPIError", "code": "Rejected" } } }

// getProvingProvider — wallet returns a ProvingProvider backed by proof server
→ { "jsonrpc": "2.0", "id": 4, "method": "getProvingProvider", "params": { "keyMaterialProvider": "..." } }
← { "jsonrpc": "2.0", "id": 4, "result": { "provingProvider": "ready" } }
// Note: Over WebSocket, the ProvingProvider is used server-side by the wallet.
// DApps call prove/check as separate RPC methods that the wallet proxies to the proof server.
```

---

## Testing Strategy

| Test File | What | Approach |
|-----------|------|----------|
| `dapp-connector.test.ts` | Handler return shapes, approval gating, network mismatch, DesiredOutput→CombinedTokenTransfer conversion, error cases | Stub FacadeBundle at SDK boundary |
| `serve-command.test.ts` | Start server, connect client, send connect + read, verify responses | Integration test with real WS |

## Verification Checklist

- [ ] `npm run typecheck` — zero errors
- [ ] `npm run build` — compiles
- [ ] `npm test` — all tests pass
- [ ] Manual: `mn serve`, connect via wscat, send `connect` + `getUnshieldedBalances`
- [ ] Manual: test approval prompt with a `makeTransfer` call

## Known Risks

| Risk | Mitigation |
|------|-----------|
| **Address encoding**: FacadeState returns SDK objects, not strings | All address types have `.asString()` method — use that, no `MidnightBech32m.encode()` needed |
| **DesiredOutput → CombinedTokenTransfer** field mapping | `kind`→`type`, `value`→`amount`, `recipient` string→Address object — conversion layer in dapp-connector.ts |
| **`getDustBalance` cap field**: `state.dust.balance(date)` returns plain `bigint`, not `{cap, balance}` | Use balance for both or estimate cap from NIGHT UTXOs; document as approximation for v1 |
| **`getTxHistory`** may not work in SDK v2 RC | Return empty array with descriptive message if SDK throws "Not yet implemented" |
| **`getProvingProvider`**: Simplified — use SDK's `HttpProverClient` or `WasmProver` | No reverse RPC needed; packages: `@midnight-ntwrk/wallet-sdk-prover-client` |
| **`makeIntent` intentId**: DApp Connector requires it but `facade.initSwap()` has no intentId param | Pass through `payFees`; ignore `intentId` if facade doesn't support it |
| **Shielded address public keys**: Not direct string fields | Use `ShieldedAddress.coinPublicKeyString()` and `.encryptionPublicKeyString()` methods |
