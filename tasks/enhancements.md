# Enhancement Backlog

Documented from quality review on 2026-03-11 (preprod-support branch).

---

## 1. Missing Cleanup Commands — DONE

### `mn config unset <key>` ✓

Implemented `unsetConfigValue()` in cli-config.ts, `unset` case in config command, help docs, MCP tool, and tests.

### `mn cache clear [--network <name>] [--wallet <name>]` ✓

New `cache` command with `clear` subcommand. Supports scoping by `--network` or `--wallet`. Routes through wallet.ts, help docs, MCP tool.

---

## 2. `mn serve` DX Improvements — DONE

### 2a. Phase-based progress logging ✓

Phase tracker module (`src/lib/phase-tracker.ts`) tracks timing for approve, building, signing, proving, submitting phases. Wired into all write handlers in dapp-connector.ts.

### 2b. Phase timing breakdown ✓

onResponse in serve.ts now shows timing breakdown: `✓ conn_1 ← submitTransaction (47.2s: approve 2.1s, prove 44.8s, submit 0.3s)`

### 2c. Rejection logging ✓

onResponse error handling now checks `error.code === 'Rejected'` and displays "rejected by operator" instead of raw error message.

### 2d. Progress notifications to DApp clients ✓

Phase tracker sends `progress` notifications via context.notify() at phase start/complete. DApps receive structured progress events.

### 2e. Spinner for long operations ✓

Phase callbacks in serve.ts wire to spinner — starts on first phase, updates on each subsequent phase, stops after proving or submitting completes.

---

## Implementation Summary

All items complete. Changes across:
- `src/lib/cli-config.ts` — `unsetConfigValue()`
- `src/commands/config.ts` — `unset` case
- `src/commands/cache.ts` — new cache clear command
- `src/wallet.ts` — `cache` routing
- `src/lib/phase-tracker.ts` — new pure phase timing module
- `src/lib/ws-rpc.ts` — enriched RpcHandlerContext (requestId, metadata), structured onResponse error
- `src/lib/dapp-connector.ts` — DAppConnectorCallbacks, phase tracking in all write handlers
- `src/commands/serve.ts` — spinner wiring, rejection labels, timing breakdown
- `src/commands/help.ts` — updated config spec, added cache spec, updated MCP tool count
- `src/mcp-server.ts` — added config_unset and cache_clear tools
- `src/ui/art.ts` — added cache to COMMAND_BRIEFS
- Tests: phase-tracker, cli-config unset tests, mcp-server coverage updated
