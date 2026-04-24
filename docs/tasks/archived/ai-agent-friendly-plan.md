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

Implement the Midnight DApp Connector API (`@midnight-ntwrk/dapp-connector-api` v4.0.1) as a local WebSocket server. Browser dApps connect to it; the user approves transactions in the terminal.

Reference implementation: `/Users/norman/Development/midnight/midnight-libraries/midnight-dapp-connector-api`

### Key Finding: Shielded Support Is NOT a Blocker

The WalletFacade **already handles shielded operations internally**:
- `buildFacade()` already instantiates `ShieldedWallet` with `ZswapSecretKeys`
- `facade.transferTransaction()` natively accepts `type: 'shielded'` outputs
- `facade.initSwap()` accepts shielded inputs/outputs
- `facade.balanceUnboundTransaction()` handles shielded coin selection internally
- `state.shielded.balances`, `.address`, `.coinPublicKey`, `.encryptionPublicKey` are all populated after sync

We do NOT need new shielded transaction logic — just pass through `kind: 'shielded'` from the DApp connector to the facade.

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

### DApp Connector API v4.0.1 — Method-by-Method Gap Analysis

#### Read-Only Methods (9 methods) — All data exists in SDK

| Method | Return Type | SDK Source | Current CLI Status | Gap |
|--------|-------------|------------|-------------------|-----|
| `getUnshieldedBalances()` | `Record<TokenType, bigint>` | `state.unshielded.balances` | `balance` command | None |
| `getUnshieldedAddress()` | `{ unshieldedAddress }` | `state.unshielded.address` | `address` command | None |
| `getShieldedBalances()` | `Record<TokenType, bigint>` | `state.shielded.balances` | Not exposed | Read from FacadeState (data already there) |
| `getShieldedAddresses()` | `{ shieldedAddress, shieldedCoinPublicKey, shieldedEncryptionPublicKey }` | ShieldedWalletState fields | Not exposed | Read 3 fields from state |
| `getDustBalance()` | `{ cap: bigint, balance: bigint }` | `state.dust.walletBalance(date)` + `availableCoinsWithFullInfo()` for cap | `dust status` (balance only) | Need to compute `cap` from dust generation details |
| `getDustAddress()` | `{ dustAddress }` | `state.dust.dustAddress` | Not exposed | Single field read |
| `getTxHistory(page, size)` | `HistoryEntry[]` | `state.unshielded.transactionHistory` (TransactionHistoryService) | Not exposed | Need to investigate pagination on TransactionHistoryService |
| `getConfiguration()` | `Configuration` | NetworkConfig has all URIs | `config`/`info` commands | Map our NetworkConfig → `{ indexerUri, indexerWsUri, proverServerUri, substrateNodeUri, networkId }` |
| `getConnectionStatus()` | `ConnectionStatus` | `state.isSynced` | Not exposed | Track connected/disconnected in serve command |

#### Write Methods (7 methods) — Most have SDK backing

| Method | DApp Sends | SDK Method | Gap |
|--------|-----------|------------|-----|
| `makeTransfer(outputs, opts?)` | `DesiredOutput[]` with `kind`, `type`, `value`, `recipient` | `facade.transferTransaction()` → sign → finalize → serialize | Return serialized tx hex instead of submitting (existing transfer pipeline, different exit path) |
| `submitTransaction(tx)` | Hex-encoded `FinalizedTransaction` | `facade.submitTransaction()` | Deserialize hex → `Transaction.deserialize('signature', 'proof', 'binding', bytes)` → submit |
| `balanceUnsealedTransaction(tx, opts?)` | Hex-encoded `Transaction<SignatureEnabled, Proof, PreBinding>` (= `UnboundTransaction` in facade) | `facade.balanceUnboundTransaction()` → sign → finalize → serialize | Deserialize, balance, sign, finalize, serialize back |
| `balanceSealedTransaction(tx, opts?)` | Hex-encoded `Transaction<SignatureEnabled, Proof, Binding>` (= `FinalizedTransaction`) | `facade.balanceFinalizedTransaction()` → sign → finalize → serialize | Same pattern with FinalizedTransaction |
| `makeIntent(inputs, outputs, opts)` | `DesiredInput[]` + `DesiredOutput[]` + `{ intentId, payFees }` | `facade.initSwap()` → sign → finalize → serialize | New — build swap recipe → sign → finalize → serialize |
| `signData(data, opts)` | String data + `{ encoding: 'hex'\|'base64'\|'text', keyType: 'unshielded' }` | `keystore.signData(payload)` | Handle encoding conversion, prepend data prefix, return `{ data, signature, verifyingKey }` |
| `getProvingProvider(keyMaterialProvider)` | `KeyMaterialProvider` with `getZKIR`, `getProverKey`, `getVerifierKey` | Proof server URL configured per network | Bridge KeyMaterialProvider to ledger ProvingProvider via proof server (most complex gap) |

#### Permission Method (1 method)

| Method | Gap |
|--------|-----|
| `hintUsage(methodNames)` | Terminal prompt: "DApp wants to use: makeTransfer, getBalances. Allow? [Y/n]". Resolve promise after user grants. |

### Transaction Serialization (Critical Infrastructure)

DApp Connector API passes transactions as hex-encoded serialized bytes. The ledger provides:

```
// Serialize:   toHex(tx.serialize())                    → hex string
// Deserialize: Transaction.deserialize(S, P, B, bytes)  → typed Transaction

// Type markers per transaction kind:
//   Unsealed (UnboundTransaction):     'signature', 'proof', 'pre-binding'
//   Sealed (FinalizedTransaction):     'signature', 'proof', 'binding'
//   Unproven (UnprovenTransaction):    'signature', 'pre-proof', 'pre-binding'
```

Confirmed by bboard and zkloan examples in midnight-libraries (see BrowserDeployedBoardManager.ts, ZKLoanContext.tsx).

### Error Handling

DApp Connector errors use a tagged error type (not class-based — no `instanceof`):

```
ErrorCodes: InternalError | Rejected | InvalidRequest | PermissionRejected | Disconnected

APIError = Error & {
  type: 'DAppConnectorAPIError';
  code: ErrorCode;
  reason: string;
}

// Detection: error.type === 'DAppConnectorAPIError'
```

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

```
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

// Note: bigint values serialized as strings in JSON-RPC (JSON has no bigint)
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

### Implementation Steps (dependency order)

| Step | Files | What | Depends On |
|------|-------|------|------------|
| 1 | `src/lib/tx-serde.ts` | Hex ↔ transaction serialization helpers (toHex/fromHex + typed deserialize wrappers) | Nothing |
| 2 | `src/lib/errors.ts` | APIError factory matching DApp Connector error codes | Nothing |
| 3 | `src/lib/dapp-connector.ts` | WalletConnectedAPI implementation — read-only methods first (balances, addresses, config, history) | Step 1 |
| 4 | `src/lib/dapp-connector.ts` | Write methods: makeTransfer, balanceUnsealed/Sealed, submitTransaction, signData | Steps 1-3 |
| 5 | `src/lib/dapp-connector.ts` | makeIntent + getProvingProvider | Step 4 |
| 6 | `src/lib/approval.ts` | Terminal readline prompts (approve/reject/details) for write operations | Nothing |
| 7 | `src/lib/ws-rpc.ts` | JSON-RPC over WebSocket server (`ws` already in deps) | Nothing |
| 8 | `src/commands/serve.ts` | Entry point: facade lifecycle + WS server + approval flow + connection management | Steps 2-7 |
| 9 | Integration test | Test against bboard or counter example DApp from midnight-libraries | Step 8 |

### New Files

```
src/lib/tx-serde.ts            — hex ↔ ledger Transaction serialization/deserialization
src/lib/errors.ts              — DApp Connector APIError factory + CLI error codes
src/lib/dapp-connector.ts      — ConnectedAPI implementation backed by WalletFacade
src/lib/approval.ts            — terminal prompts for transaction approval (readline)
src/lib/ws-rpc.ts              — JSON-RPC over WebSocket transport
src/commands/serve.ts          — entry point, WS server setup, connection management
```

### What We Do NOT Need to Build

- **New shielded transaction code** — WalletFacade already coordinates shielded+unshielded+dust
- **New SDK dependencies** — `ws`, all wallet-sdk packages, `ledger-v7` already installed
- **Standalone shielded CLI commands** — useful later but not blocking for DApp connector
- **Pillar 1 (`--json`/`--quiet`)** — independent, can be done before or after
- **Pillar 3 (x402)** — completely independent

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

| Phase | Items | Depends On |
|-------|-------|------------|
| **Phase 1a** | `lib/errors.ts` — CLI error codes + DApp Connector APIError factory | Nothing |
| **Phase 1b** | `--json` flag on all commands | Phase 1a |
| **Phase 1c** | `--quiet` flag + structured exit codes | Phase 1a |
| **Phase 2a** | `lib/tx-serde.ts` — transaction hex serialization helpers | Nothing |
| **Phase 2b** | `lib/dapp-connector.ts` — read-only methods (balances, addresses, config, history) | Phase 2a |
| **Phase 2c** | `lib/dapp-connector.ts` — write methods (makeTransfer, balance*, submit, signData) | Phase 2a, 2b |
| **Phase 2d** | `lib/dapp-connector.ts` — makeIntent + getProvingProvider | Phase 2c |
| **Phase 2e** | `lib/approval.ts` — terminal approval prompts (readline) | Nothing |
| **Phase 2f** | `lib/ws-rpc.ts` — JSON-RPC over WebSocket server | Nothing |
| **Phase 2g** | `commands/serve.ts` — `midnight serve` entry point | Phase 1a, 2b-2f |
| **Phase 2h** | Integration test against bboard/counter example DApp | Phase 2g |
| **Phase 3** | `midnight x402-pay` + `midnight x402-serve` | Phase 2c |
| **Phase 4a** | Companion browser extension (window.midnight bridge) | Phase 2g |
| **Phase 4b** | Remote relay / WalletConnect-style pairing | Phase 2g |

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

- Midnight DApp Connector API v4.0.1: `/Users/norman/Development/midnight/midnight-libraries/midnight-dapp-connector-api`
- BBoard example (balanceUnsealedTransaction usage): `/Users/norman/Development/midnight/midnight-libraries/example-bboard/bboard-ui/src/contexts/BrowserDeployedBoardManager.ts`
- ZKLoan example (wallet connect + balance flow): `/Users/norman/Development/midnight/midnight-libraries/zkloan-credit-scorer/zkloan-credit-scorer-ui/src/contexts/ZKLoanContext.tsx`
- React wallet connect guide: `/Users/norman/Development/midnight/midnight-libraries/midnight-docs/docs/guides/react-wallet-connect.mdx`
- WalletFacade types: `node_modules/@midnight-ntwrk/wallet-sdk-facade/dist/index.d.ts`
- Ledger Transaction class (serialize/deserialize): `node_modules/@midnight-ntwrk/ledger-v7/ledger-v7.d.ts` line 2181
- x402 Protocol Spec: https://x402.org / https://github.com/coinbase/x402
- x402 Cardano Examples: https://github.com/masumi-network/x402-cardano-examples
- Cardano CIP-30 (DApp Connector inspiration): https://cips.cardano.org/cip/CIP-30
- Midnight Documentation: https://docs.midnight.network
