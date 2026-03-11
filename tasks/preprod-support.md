# Preprod Network Support

## Goal

Enable the Midnight CLI to work on the preprod (and preview) testnets. The architecture already supports multi-network — this document captures what's ready, what's missing, and the implementation checklist.

## Current State

### Already Working

The multi-network foundation is complete:

| Component | Status | Notes |
|---|---|---|
| Network types | Done | `NetworkName = 'preprod' \| 'preview' \| 'undeployed'` |
| Endpoint configs | Done | Preprod/preview indexer, node URLs in `NETWORK_CONFIGS` |
| Network resolution | Done | 5-step priority: `--network` → wallet → address prefix → config → `undeployed` |
| SDK network ID mapping | Done | `NETWORK_ID_MAP` in facade, transfer, dapp-connector |
| Wallet generation | Done | Stores network, derives network-specific addresses |
| Address detection | Done | `mn_addr_preprod1`, `mn_addr_preview1`, `mn_addr_undeployed1` |
| CLI config | Done | `midnight config set network preprod` works |
| MCP server | Done | Tool definitions accept all three networks |
| Balance command | Done | Uses network-resolved indexer endpoint |
| Airdrop guard | Done | Correctly blocks non-undeployed |
| Localnet isolation | Done | Docker detection only runs for undeployed |

### What's Missing

#### 1. Proof Server Strategy

**Problem:** `proofServer` is hardcoded to `http://localhost:6300` for all networks in `src/lib/network.ts`. Preprod and preview don't have hosted proof servers — users must run one locally.

**Decision:** Users run their own local proof server. The CLI needs a `--proof-server` flag to override the default URL.

**Commands affected:**
- `midnight transfer` — builds and submits transactions (needs prover)
- `midnight dust register` — registers UTXOs (needs prover)
- `mn serve` / dapp-connector — exposes `proverServerUri` to connected dApps

#### 2. Endpoint Override Flags

Currently only `--indexer-ws` exists on the balance command. For preprod users who might run custom infrastructure, we need consistent override flags.

| Flag | Commands | Purpose |
|---|---|---|
| `--proof-server <url>` | transfer, dust register, serve | Override proof server URL |
| `--node <url>` | transfer, dust register | Override substrate node RPC URL |
| `--indexer-ws <url>` | balance (already exists), transfer, dust register | Override indexer WebSocket URL |

#### 3. Documentation Updates

- README: mention preprod/preview support, proof server requirement
- `--help` text: show that `--network preprod` is available
- DESIGN.md: update if it says "undeployed only"

## Key Files

| File | Role |
|---|---|
| `src/lib/network.ts` | Network configs, endpoint resolution |
| `src/lib/resolve-network.ts` | Network selection priority chain |
| `src/lib/facade.ts` | WalletFacade init, uses all endpoints |
| `src/lib/transfer.ts` | Transfer execution, uses proof server |
| `src/commands/transfer.ts` | Transfer CLI, needs `--proof-server` flag |
| `src/commands/dust.ts` | Dust register CLI, needs `--proof-server` flag |
| `src/lib/dapp-connector.ts` | Serve mode, exposes endpoints to dApps |
| `src/mcp-server.ts` | MCP tool definitions |

## Preprod Infrastructure

Midnight preprod endpoints (already configured in `NETWORK_CONFIGS`):

```
Indexer HTTP:  https://indexer.preprod.midnight.network/api/v3/graphql
Indexer WS:    wss://indexer.preprod.midnight.network/api/v3/graphql/ws
Node RPC:      wss://rpc.preprod.midnight.network
Proof Server:  http://localhost:6300  (user-provided, no hosted option)
```

## Prerequisites for Users

To use the CLI on preprod, a user needs:
1. A running proof server — start one with:
   ```bash
   docker run -p 6300:6300 midnightntwrk/proof-server:8.0.0-rc.5
   ```
   Or point to a custom URL via `--proof-server` flag or `midnight config set proof-server <url>`
2. A wallet generated for preprod: `midnight generate --network preprod`
3. tDUST tokens for fees (acquired from the Midnight faucet or community)

## Implementation Checklist

- [ ] Add `--proof-server <url>` flag to transfer command
- [ ] Add `--proof-server <url>` flag to dust register command
- [ ] Add `--node <url>` flag to transfer command
- [ ] Add `--node <url>` flag to dust register command
- [ ] Add `--indexer-ws <url>` flag to transfer command (balance already has it)
- [ ] Add `--indexer-ws <url>` flag to dust register command
- [ ] Thread endpoint overrides through to `resolveNetworkConfig()` or pass directly
- [ ] Support persistent endpoint config: `midnight config set proof-server <url>`, `node`, `indexer-ws`
- [ ] Flag overrides take priority over config, config overrides network defaults
- [ ] Add `--proof-server` support to `mn serve` / dapp-connector
- [ ] Update MCP server tool definitions with endpoint override parameters
- [ ] Test `midnight generate --network preprod` produces correct address prefix
- [ ] Test `midnight balance --network preprod` against live preprod indexer
- [ ] Test `midnight transfer --network preprod --proof-server <url>` end-to-end
- [ ] Update README with preprod usage section
- [ ] Update help text to show preprod examples

## Known Limitations

- **Airdrop**: Only available on undeployed network (genesis wallet). Preprod tokens come from the Midnight faucet.
- **Localnet**: `midnight localnet up/down/status` only applies to undeployed.
- **Proof server**: No hosted option — users must run their own. This is the biggest UX friction point for preprod.
- **Shielded operations**: Depend on proof server availability and correct circuit keys.

## Resolved Questions

1. **Indexer API version** — Preprod indexer uses the same `/api/v3/graphql` API. Verify during testing.
2. **Persistent endpoint config** — Yes, endpoint overrides should be settable via `midnight config set` (e.g. `midnight config set proof-server http://my-server:6300`) in addition to per-command flags. Flags override config.
3. **Doctor integration** — Preprod endpoint reachability checks belong in the existing `midnight doctor` plan (see `tasks/status-and-doctor-plan.md`). Doctor already plans to probe RPC, indexer, faucet, explorer, and proof server. No separate work needed here — just ensure doctor respects `--network preprod`.
4. **Proof server for preprod users** — Users run the same Docker image used by localnet: `docker run -p 6300:6300 midnightntwrk/proof-server:8.0.0-rc.5`. No special binary needed. Document this one-liner in the preprod usage section.
