# Enhancement Backlog

Documented from quality review on 2026-03-11 (preprod-support branch).

---

## 1. Missing Cleanup Commands

### `mn config unset <key>`

Users can `mn config set proof-server http://...` but cannot reset to defaults without manually editing `~/.midnight/config.json`.

**Scope**: Add `unset` subcommand to config. Deletes the key from config, reverting to default behavior.

**Affected files**:
- `src/commands/config.ts` — add `unset` case
- `src/lib/cli-config.ts` — add `unsetConfigValue(key)` or extend `setConfigValue`
- `src/commands/help.ts` — document subcommand
- `src/mcp-server.ts` — add `midnight_config_unset` tool

**Validatable keys**: `proof-server`, `node`, `indexer-ws`, `wallet`. The `network` key always has a value (defaults to `undeployed`), so unset should reset it to the default rather than deleting.

### `mn cache clear [--network <name>] [--wallet <name>]`

Wallet state cache accumulates in `~/.midnight/cache/`. The `clearWalletCache()` function already exists in `src/lib/wallet-cache.ts` with support for clearing by address, network, or everything. It's just not exposed as a CLI command.

**Scope**: New `cache` command with `clear` subcommand. Alternatively, add as `mn config clear-cache`.

**Affected files**:
- `src/commands/cache.ts` (new) or extend `src/commands/config.ts`
- `src/wallet.ts` — add routing
- `src/commands/help.ts` — document
- `src/mcp-server.ts` — add MCP tool

---

## 2. `mn serve` DX Improvements

The DApp connector server has several "dead air" moments where the server is doing work but showing nothing in the terminal. These improvements make it clearer what's happening during long operations.

### 2a. Phase-based progress logging

**Problem**: After a user approves a transaction, ZK proof generation can take 5-300 seconds with zero terminal output. Same for recipe building and transaction submission.

**Solution**: Log each phase as it starts:
```
  [00:16:42] conn_1 #3 → submitTransaction
  ⠋ Proving...
  ✓ Proved (12.3s)
  ⠋ Submitting to node...
  ✓ Submitted (0.4s) tx:abc123...
  ✓ conn_1 ← submitTransaction (12.7s)
```

**Affected files**:
- `src/lib/dapp-connector.ts` — wrap facade calls with progress logging
- Potentially `src/ui/spinner.ts` if a spinner exists, or create minimal one

### 2b. Phase timing breakdown

**Problem**: Response log shows total time `(47.2s)` but doesn't break down what took time (approval wait vs proving vs submission).

**Solution**: Track phase durations and log them:
```
  ✓ conn_1 ← submitTransaction (47.2s: approve 2.1s, prove 44.8s, submit 0.3s)
```

**Affected files**:
- `src/lib/dapp-connector.ts` — add phase timing
- `src/commands/serve.ts` — update `onResponse` formatting

### 2c. Rejection logging

**Problem**: When a user denies an approval, there's no server-side log. Only the DApp gets the error.

**Solution**: Log rejections to stderr:
```
  ✗ conn_1 #3 → submitTransaction — rejected by operator
```

**Affected files**:
- `src/lib/dapp-connector.ts` — log on rejection path
- `src/commands/serve.ts` — add `onRejection` callback or handle in `onResponse`

### 2d. Progress notifications to DApp clients

**Problem**: The `notify()` infrastructure exists in `ws-rpc.ts` but is only used for `approval:pending` and `approval:resolved`. DApps have no visibility into long operations.

**Solution**: Send structured notifications so DApps can show their own spinners:
```json
{"jsonrpc":"2.0","method":"progress","params":{"phase":"proving","requestId":3}}
{"jsonrpc":"2.0","method":"progress","params":{"phase":"submitting","requestId":3}}
{"jsonrpc":"2.0","method":"progress","params":{"phase":"complete","requestId":3,"txHash":"abc..."}}
```

**Affected files**:
- `src/lib/dapp-connector.ts` — emit notifications at phase boundaries
- `src/lib/ws-rpc.ts` — notification infrastructure already exists

### 2e. Spinner for long operations

**Problem**: Terminal shows nothing during proof generation, recipe building, or submission.

**Solution**: Use a terminal spinner (dots/braille animation) during long-running SDK calls. Clear the spinner line when the operation completes and replace with the result log.

**Affected files**:
- `src/ui/spinner.ts` (new or existing)
- `src/lib/dapp-connector.ts` — wrap long operations with spinner start/stop

---

## Priority Order

1. **Phase progress logging** (2a) — highest impact, addresses the main UX complaint
2. **Rejection logging** (2c) — simple, important for debugging
3. **`mn config unset`** (1) — small scope, completes the config story
4. **`mn cache clear`** (1) — exposes existing function
5. **Phase timing breakdown** (2b) — nice-to-have, builds on 2a
6. **Progress notifications** (2d) — DApp-facing, requires protocol agreement
7. **Spinner** (2e) — polish, builds on 2a
