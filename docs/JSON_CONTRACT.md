# JSON Contract

What `mn` (`midnight-wallet-cli`) and `midnight-wallet-mcp` promise to never
break, in exchange for integrators getting a stable surface to build on.

This document is **the line we will not cross without a major version bump.**
Every shape here is what `--json` mode emits today and what every consumer
should be able to rely on tomorrow.

The non-JSON (human-formatted) stderr output is decorative and may change
freely. The contract is JSON only.

## Stability rules

1. **Additive only.** New fields may appear at any version. Existing field
   names, types, and locations stay frozen.
2. **No renames.** If a field needs a different name, both names exist
   side by side until the next major bump.
3. **No removals.** A field that ever shipped stays.
4. **No type changes.** A string stays a string; a number stays a number.
5. **No nesting changes.** A field at the top level stays at the top level.
   Nested forms that integrators depend on (see balance.balances.NIGHT)
   stay nested.

If we must make a breaking change, it's a major version bump and an
explicit `BREAKING CHANGES` section in the changelog naming every
field involved.

## Surfaces under contract

### Network names

```
"undeployed" | "preprod" | "preview"
```

These three values are stable. Adding a new network (e.g. `mainnet`)
is additive. Renaming or removing one is a major bump.

### Address formats

Bech32m, network-tagged in the HRP:

- Unshielded: `mn_addr_<network>1...`
- Shielded:   `mn_shield-addr_<network>1...`

The HRP encoding is stable. Tools may rely on `mn_addr_<network>` as
a parseable network indicator.

### Wallet file (`~/.midnight/wallets/<name>.json`)

Path, schema, and permissions are stable:

- Path: `~/.midnight/wallets/<name>.json` (per OS user)
- Permissions: `0600` on file, `0700` on directory
- Required fields: `seed`, `mnemonic`, `addresses`, `shieldedAddresses`,
  `createdAt`
- `addresses` and `shieldedAddresses` are objects keyed by network name

### Config file (`~/.midnight/config.json`)

Valid keys:

- `network` (canonical)
- `proof-server`
- `node`
- `indexer-ws`
- `wallet`

Aliases (transparently resolved to a canonical key):

- `network-id` → `network` (added 2026-04-27 for midnight-expert
  compatibility)

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Unknown error |
| 2 | Invalid arguments |
| 3 | Wallet not found |
| 4 | Network error |
| 5 | Insufficient balance / `DUST_REQUIRED` |
| 6 | TX_REJECTED / `STALE_UTXO` / `PROOF_TIMEOUT` |
| 7 | Cancelled |

The numeric codes and the error code strings are stable. Internal helpers
in `src/lib/exit-codes.ts` are the source of truth.

### Error code strings

Stable identifiers used in error messages and structured error objects:

- `DUST_REQUIRED`
- `STALE_UTXO`
- `PROOF_TIMEOUT`
- `INVALID_DUST_SPEND_PROOF`

Hooks and parsers may rely on substring matching against these.

## Command JSON shapes (`--json`)

Each entry shows the canonical shape. Fields marked **alias** are
backward-compatibility mirrors of another field in the same object.

### `mn balance <address> --json`

```jsonc
{
  "address": "mn_addr_undeployed1...",
  "network": "undeployed",
  "balances": { "NIGHT": "1000.000000" },
  "NIGHT": "1000.000000",   // alias of balances.NIGHT (added 2026-04-27)
  "utxoCount": 1,
  "txCount": 2
}
```

### `mn balance --wallet <name> --json`

Wallet-based balance also includes shielded fields. Shape per current
code in `src/commands/balance.ts`. (Subject to the same additive-only
rule once formally documented here.)

### `mn info --wallet <name> --json`

```jsonc
{
  "addresses": {
    "preprod": "mn_addr_preprod1...",
    "preview": "mn_addr_preview1...",
    "undeployed": "mn_addr_undeployed1..."
  },
  "shieldedAddresses": { /* same shape, mn_shield-addr_<net>1... */ },
  "activeNetwork": "undeployed",
  "activeAddress": "mn_addr_undeployed1...",
  "createdAt": "2026-03-26T05:27:33.721Z",
  "file": "/Users/<user>/.midnight/wallets/<name>.json"
}
```

### `mn dust status --wallet <name> --json`

```jsonc
{
  "subcommand": "status",
  "registered": true,
  "registeredUtxos": 1,
  "unregisteredUtxos": 0,
  "dustBalance": "1050.675442999999998",
  "dustAvailable": true,
  "eventsApplied": 19,
  "ownedUtxos": 1,
  "cached": true,
  "network": "undeployed"
}
```

### `mn contract deploy --json`

```jsonc
{
  "subcommand": "deploy",
  "contractName": "counter",
  "address": "9b3e083bf850ca17983d34110337d384d2dc626da8223c3fb2dbd3f8a2df35a3",
  "network": "preprod"
}
```

### `mn wallet list --json`

Per `src/commands/wallet.ts`, list of wallet names, addresses,
networks, with the active wallet marked. Shape stable.

### `mn config get <key>`

Plain stdout: the raw value as a string, no JSON wrapper. `--json`
not currently supported; if added, output will be `{"key": "...", "value": "..."}`.

## MCP tool names

Every tool name shipped in `src/mcp-server.ts` is stable. The current
24 tools (which midnight-expert documents as 25 due to a prior off-by-one):

```
midnight_address              midnight_airdrop
midnight_balance              midnight_cache_clear
midnight_config_get           midnight_config_set
midnight_config_unset         midnight_dust_register
midnight_dust_status          midnight_generate (deprecated, kept)
midnight_genesis_address      midnight_info
midnight_inspect_cost         midnight_localnet_clean
midnight_localnet_down        midnight_localnet_status
midnight_localnet_stop        midnight_localnet_up
midnight_transfer             midnight_wallet_generate
midnight_wallet_info          midnight_wallet_list
midnight_wallet_remove        midnight_wallet_use
```

Tool **parameter names** are also stable. A new optional parameter is
additive; renaming or removing one is a major bump.

## Compatibility aliases (additive shims)

Additions made on our side so existing integrations keep working
without touching their code:

| Surface | Canonical | Alias | Added | For |
|---|---|---|---|---|
| Config key | `network` | `network-id` | 2026-04-27 | midnight-expert setup-test-wallets |
| Balance JSON | `balances.NIGHT` | top-level `NIGHT` | 2026-04-27 | midnight-expert session-start-health |

If you're an integrator and you depend on a shape we haven't documented
here yet, **open an issue.** We'd rather codify it now than discover
it broken in your release later.
