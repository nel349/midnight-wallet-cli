# AI Agent-Friendly Plan for midnight-wallet-cli

## Overview

Three pillars to make the CLI fully usable by AI agents, browser dApps, and HTTP payment flows.

---

## Pillar 1: CLI as a First-Class AI Agent Tool

The CLI already follows Unix conventions (data on stdout, chrome on stderr). These additions make it fully scriptable.

### 1a. `--json` Flag (Global)

Every command outputs structured JSON to stdout when `--json` is passed.

```bash
# balance
$ midnight balance --json
{"address":"mn_addr_undeployed1...","network":"undeployed","balances":{"NIGHT":"5000000"},"utxoCount":3,"txCount":12}

# transfer
$ midnight transfer mn_addr_undeployed1... 100 --json
{"txHash":"a7b3f2...","amount":"100","recipient":"mn_addr_undeployed1...","network":"undeployed"}

# info
$ midnight info --json
{"address":"mn_addr_undeployed1...","network":"undeployed","createdAt":"2026-02-28T...","file":"/home/user/.midnight/wallet.json"}

# generate
$ midnight generate --json
{"address":"mn_addr_undeployed1...","network":"undeployed","mnemonic":"word1 word2...","seed":"a7b3...","file":"~/.midnight/wallet.json"}

# dust status
$ midnight dust status --json
{"dust":"12345","registered":3,"unregistered":0,"nightBalance":"5000000"}

# inspect-cost
$ midnight inspect-cost --json
{"readTime":1000000000,"computeTime":1000000000,"blockUsage":10000,"bytesWritten":10000,"bytesChurned":1000000}

# config get
$ midnight config get network --json
{"key":"network","value":"undeployed"}
```

**Implementation approach:**
- Add `--json` detection in `wallet.ts` (global flag)
- Pass `json: boolean` to each command handler
- Each command builds a result object and either calls `JSON.stringify()` or the existing formatted output
- Errors in JSON mode: `{"error":true,"code":"INSUFFICIENT_BALANCE","message":"...","suggestion":"..."}`

### 1b. `--quiet` / `-q` Flag (Global)

Suppress all stderr output (spinners, headers, animations). Only stdout data.

```bash
$ midnight transfer mn_addr_... 100 -q
a7b3f2...

$ midnight balance -q
NIGHT=5000000
```

**Implementation:** Wrap all `process.stderr.write()` calls behind a global quiet check.

### 1c. Structured Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Invalid arguments / usage error |
| 3 | Wallet not found |
| 4 | Network / connection error |
| 5 | Insufficient balance |
| 6 | Transaction rejected (on-chain) |
| 7 | Operation cancelled (SIGINT) |

### 1d. Error Code Constants

Define error codes in `lib/errors.ts` with machine-readable identifiers:

```typescript
const ErrorCodes = {
  INVALID_ARGS: 'INVALID_ARGS',
  WALLET_NOT_FOUND: 'WALLET_NOT_FOUND',
  NETWORK_ERROR: 'NETWORK_ERROR',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  TX_REJECTED: 'TX_REJECTED',
  STALE_UTXO: 'STALE_UTXO',
  PROOF_TIMEOUT: 'PROOF_TIMEOUT',
  DUST_REQUIRED: 'DUST_REQUIRED',
  CANCELLED: 'CANCELLED',
} as const;
```

---

## Pillar 2: DApp Connector — CLI as Wallet Server

Implement the Midnight DApp Connector API (`@midnight-ntwrk/dapp-connector-api` v4.0.0) as a local server. Browser dApps connect to it; the user approves transactions in the terminal.

### New Command: `midnight serve`

```bash
$ midnight serve [--port 9921] [--auto-approve-reads] [--approve-all]
```

### Architecture

```
Browser DApp                          CLI Terminal
    │                                      │
    │  ws://localhost:9921                  │
    ├──── connect("undeployed") ──────────►│ "DApp 'MyDEX' wants to connect. Allow? [Y/n]"
    │                                      │ User: Y
    │◄──── ConnectedAPI ──────────────────┤
    │                                      │
    │──── makeTransfer([{                  │
    │       kind: "unshielded",            │ ╔═══════════════════════════════╗
    │       type: NIGHT,                   │ ║  Transaction Request          ║
    │       value: 10_000_000n,            │ ║  From: mn_addr_und...q4x      ║
    │       recipient: "mn_addr..."        │ ║  To:   mn_addr_und...f3s      ║
    │     }]) ────────────────────────────►│ ║  Amount: 10.000000 NIGHT      ║
    │                                      │ ║  Approve? [Y/n]               ║
    │                                      │ ╚═══════════════════════════════╝
    │                                      │ User: Y
    │                                      │ ⠋ Generating ZK proof...
    │◄──── { tx: "signed_tx_hex" } ───────┤ ✓ Transaction ready
    │                                      │
    │──── submitTransaction(tx) ──────────►│ ✓ Submitted: a7b3f2...
    │◄──── void ──────────────────────────┤
```

### DApp Connector API Method Mapping

**Auto-approved (read-only):**

| Method | Implementation |
|--------|---------------|
| `getUnshieldedAddress()` | Return from wallet.json |
| `getUnshieldedBalances()` | GraphQL subscription (existing balance-subscription.ts) |
| `getDustBalance()` | WalletFacade state |
| `getDustAddress()` | Derive from seed |
| `getShieldedAddresses()` | Derive from seed |
| `getShieldedBalances()` | WalletFacade state (future) |
| `getConfiguration()` | Return network config (indexer, node, proof server URIs) |
| `getConnectionStatus()` | Return connected/disconnected |
| `getTxHistory(page, size)` | WalletFacade state |

**Requires terminal approval:**

| Method | Implementation |
|--------|---------------|
| `makeTransfer(outputs)` | Show amounts/recipients → approve → build tx via WalletFacade → prove → return |
| `balanceUnsealedTransaction(tx)` | Show tx summary → approve → balance via WalletFacade → return |
| `balanceSealedTransaction(tx)` | Show tx summary → approve → balance via WalletFacade → return |
| `makeIntent(inputs, outputs)` | Show swap details → approve → create intent → return |
| `signData(data, opts)` | Show data being signed → approve → sign → return |
| `submitTransaction(tx)` | Submit to node (no additional approval if tx already approved) |
| `hintUsage(methods)` | Show permissions summary → approve/configure |

### Transport Layer

The DApp Connector spec uses `window.midnight` injection (browser extension model). For a CLI wallet, we need a bridge:

**Phase 1: Direct WebSocket**
- CLI starts `ws://localhost:9921` implementing a JSON-RPC protocol
- Each DApp connector method is a JSON-RPC call
- DApps that know about CLI wallets connect directly

**Phase 2: Companion Browser Extension (thin bridge)**
- Tiny browser extension that:
  1. Discovers the CLI WS server on localhost
  2. Injects `window.midnight[uuid]` with `InitialAPI`
  3. Bridges all `ConnectedAPI` calls to the WS server
- Makes the CLI wallet compatible with ANY standard Midnight dApp

**Phase 3: Remote Relay (WalletConnect-style)**
- CLI generates a pairing URI / QR code
- Browser scans/enters it
- Communication over a relay server
- Works when CLI is on a different machine

### WebSocket Protocol (Phase 1)

```typescript
// Client → Server
{ "jsonrpc": "2.0", "id": 1, "method": "connect", "params": { "networkId": "undeployed" } }

// Server → Client (after user approval)
{ "jsonrpc": "2.0", "id": 1, "result": { "status": "connected", "networkId": "undeployed" } }

// Client → Server
{ "jsonrpc": "2.0", "id": 2, "method": "getUnshieldedAddress", "params": {} }

// Server → Client
{ "jsonrpc": "2.0", "id": 2, "result": { "unshieldedAddress": "mn_addr_undeployed1..." } }

// Client → Server (requires approval)
{ "jsonrpc": "2.0", "id": 3, "method": "makeTransfer", "params": {
  "desiredOutputs": [{ "kind": "unshielded", "type": "...", "value": "10000000", "recipient": "mn_addr..." }]
}}

// Server → Client (after user approves + proof completes)
{ "jsonrpc": "2.0", "id": 3, "result": { "tx": "hex_encoded_sealed_transaction" } }

// Error (user rejected)
{ "jsonrpc": "2.0", "id": 3, "error": { "code": -32000, "message": "Rejected", "data": { "type": "DAppConnectorAPIError", "code": "Rejected" } } }
```

### Terminal Approval UI

Using native `readline` (per project constraints — no inquirer):

```
┌─────────────────────────────────────────┐
│  Transaction Request from "MyDEX"       │
├─────────────────────────────────────────┤
│  Action:   makeTransfer                 │
│  Network:  undeployed                   │
│                                         │
│  Outputs:                               │
│    1. 10.000000 NIGHT → mn_addr_un...   │
│                                         │
│  Pay fees: yes                          │
├─────────────────────────────────────────┤
│  [A]pprove  [R]eject  [D]etails        │
└─────────────────────────────────────────┘
```

### New Files

```
src/commands/serve.ts          — entry point, WS server setup, connection management
src/lib/dapp-connector.ts      — ConnectedAPI implementation backed by WalletFacade
src/lib/approval.ts            — terminal prompts for transaction approval
src/lib/ws-rpc.ts              — JSON-RPC over WebSocket transport
```

---

## Pillar 3: x402 Payment Protocol for Midnight

Two modes: the CLI as a **payer** (AI agents buying resources) and as a **facilitator** (verifying payments for servers).

### 3a. Pay Mode — `midnight x402-pay`

AI agents use this to autonomously pay for HTTP 402-gated resources.

```bash
$ midnight x402-pay https://api.example.com/premium-data [--auto-approve] [--max-amount 5] [--json]
```

**Flow:**

```
1. CLI does GET https://api.example.com/premium-data
2. Server returns HTTP 402 + X-PAYMENT-REQUIRED header:
   {
     "scheme": "exact",
     "network": "midnight-mainnet",
     "asset": "NIGHT",
     "amount": "1000000",
     "payTo": "mn_addr_...",
     "maxTimeoutSeconds": 300,
     "facilitator": "https://facilitator.example.com"
   }
3. CLI parses requirements
4. CLI shows: "Resource requires 1.000000 NIGHT. Pay? [Y/n]"
   (or auto-approves with --auto-approve --max-amount 5)
5. CLI builds Midnight transfer transaction (like `midnight transfer`)
6. CLI proves + signs the transaction
7. CLI sends to facilitator /settle (or submits directly to node)
8. CLI retries GET with X-PAYMENT header containing signed tx + tx hash
9. Server verifies payment and returns 200 + resource content
10. CLI outputs resource content to stdout
```

**Midnight-specific considerations:**

- ZK proof latency: `maxTimeoutSeconds` needs to be 300-600s (vs 30-60s on EVM)
- Dust fees must be available before attempting payment
- Payment payload = serialized signed+proved Midnight transaction (hex)
- x402 asset field maps to Midnight token types (hex-encoded ledger token types)

**AI agent auto-approval:**

```bash
# Agent can spend up to 5 NIGHT per request without prompting
$ midnight x402-pay https://api.example.com/data --auto-approve --max-amount 5 --json
{
  "status": "paid",
  "amount": "1.000000",
  "txHash": "a7b3f2...",
  "resource": { ... }
}
```

### 3b. Facilitate Mode — `midnight x402-serve`

Run a Midnight-native x402 facilitator that HTTP servers can use to verify and settle NIGHT payments.

```bash
$ midnight x402-serve --port 5051
```

**Endpoints:**

```
POST /verify
  Body: { paymentPayload, paymentRequirements }
  Response: { valid: true } or { valid: false, error: "..." }

POST /settle
  Body: { paymentPayload, paymentRequirements }
  Response: { txHash: "...", status: "confirmed" }
```

The facilitator:
1. Deserializes the Midnight transaction from the payment payload
2. Verifies it transfers the correct amount to the correct address
3. Submits to the Midnight node
4. Waits for confirmation
5. Returns settlement receipt

### 3c. PaymentRequirements for Midnight

Extending the x402 PaymentRequirements format for Midnight:

```typescript
interface MidnightPaymentRequirements {
  x402Version: 1;
  scheme: 'exact';
  network: 'midnight-mainnet' | 'midnight-preprod' | 'midnight-preview' | 'midnight-undeployed';
  asset: string;           // Token type hex, or "NIGHT" for native
  maxAmountRequired: string; // In micro-units (1 NIGHT = 1000000)
  payTo: string;           // mn_addr_... Bech32m address
  maxTimeoutSeconds: number; // 300-600 recommended (ZK proof time)
  resource: string;        // The protected endpoint path
  description?: string;    // Human-readable description
  facilitator?: string;    // Facilitator URL (optional, can submit directly)
  extra?: {
    shielded?: boolean;    // Allow shielded payment (privacy)
    dustFeeIncluded?: boolean; // Whether amount includes fee overhead
  };
}
```

### New Files

```
src/commands/x402-pay.ts       — HTTP 402 payment client
src/commands/x402-serve.ts     — x402 facilitator server
src/lib/x402.ts                — PaymentRequirements parsing, payload construction, verification
```

---

## Implementation Priority

| Phase | Items | Effort |
|-------|-------|--------|
| **Phase 1** | `--json` flag on all commands | 1-2 days |
| **Phase 1** | `--quiet` flag + structured exit codes | 0.5 day |
| **Phase 1** | `lib/errors.ts` with error code constants | 0.5 day |
| **Phase 2** | `midnight serve` (local WS, DApp connector) | 1-2 weeks |
| **Phase 2** | Terminal approval UI (readline prompts) | 1 week |
| **Phase 2** | JSON-RPC protocol over WebSocket | 1 week |
| **Phase 3** | `midnight x402-pay` (HTTP 402 client) | 1 week |
| **Phase 3** | `midnight x402-serve` (facilitator) | 1 week |
| **Phase 4** | Companion browser extension (window.midnight bridge) | 1-2 weeks |
| **Phase 4** | Remote relay / WalletConnect-style pairing | 1 week |

---

## Dev Experience Improvements (for agents developing this repo)

Alongside the above, add:

- [ ] `npm run verify` script — typecheck + lint + test in one command
- [ ] Biome linter — fast zero-config TS linting/formatting
- [ ] GitHub Actions CI — runs verify on push/PR
- [ ] `.claude/settings.json` — agent permissions + SessionStart hook
- [ ] Pre-commit hooks — typecheck + lint on staged files

---

## References

- Midnight DApp Connector API v4: https://github.com/midnightntwrk/midnight-dapp-connector-api
- x402 Protocol Spec: https://x402.org / https://github.com/coinbase/x402
- x402 Cardano Examples: https://github.com/masumi-network/x402-cardano-examples
- Cardano CIP-30 (DApp Connector inspiration): https://cips.cardano.org/cip/CIP-30
- Midnight Documentation: https://docs.midnight.network
