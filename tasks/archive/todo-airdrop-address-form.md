# Airdrop to a bech32m address (no managed wallet required)

## Goal

Let `mn airdrop` fund any bech32m address directly, without requiring
the recipient seed to be imported into `~/.midnight/wallets/`.

New form:

    mn airdrop <amount> --to <bech32m-address> [--network <name>] [--shielded]

Existing forms (`--wallet <name|file>`, no flag = active wallet) keep
working unchanged.

## Behavior

- `--to` and `--wallet` are mutually exclusive — error if both are given.
- With `--to`:
  - No wallet file is loaded.
  - Network is resolved through the normal chain (`--network` flag,
    then config, then `undeployed`).
  - Recipient address must be bech32m for the resolved network. If the
    prefix doesn't match the resolved network, error with both names
    surfaced.
  - Unshielded form: address must start with `mn_addr_`.
  - Shielded form (`--shielded`): address must start with `mn_shield-addr_`.
  - Success path skips the "shielded address cache" step (there's no
    wallet file to write into).
- Without `--to`: today's behavior — load wallet, use its derived address.
- Network restriction (`undeployed` only) still applies — funding lives
  in the genesis seed which only exists on localnet.

## Surface area

- `src/commands/airdrop.ts` — branch on `--to` vs `--wallet`; lift the
  recipient-address resolution above the wallet load.
- `src/commands/help.ts` — add `--to` to the airdrop spec + an example.
- `src/commands/manual.ts` — add a `--to` example in COMMON FLOWS.
- `src/mcp-server.ts` — add optional `to` parameter to `midnight_airdrop`.
- `src/__tests__/airdrop-command.test.ts` — argument-validation tests for
  the new flag (no live SDK calls; mirror the style of existing tests).

## Out of scope

- Changing genesis seed / network restrictions.
- Anything in `mn transfer` (workaround already exists).
- MCP confirmation flow (airdrop already has `destructiveHint`).
