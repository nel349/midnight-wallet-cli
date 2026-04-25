#!/bin/bash
# measure-blank-flow.sh — end-to-end blank-start MCP flow check with byte
# measurements for each step. Complements scripts/measure-mcp-tokens.sh
# (which measures representative single calls); this one covers the full
# agent-path that would break if any cold-start readiness gate regresses.
#
# Flow: tools_list → skill_read → localnet_up → airdrop → dust_register → balance
#
# Usage:   ./scripts/measure-blank-flow.sh
# Output:  per-step bytes + estimated tokens, plus totals.
# Responses saved to $OUT_DIR for inspection on failure.
#
# Prerequisites:
#   - Docker running
#   - `midnight-wallet-mcp` available on PATH (`npm link` from repo root)
#   - A wallet named `dev-alice` generated (`mn wallet generate dev-alice --network undeployed`)
#
# Token estimate ≈ bytes / 3.5 (same heuristic as measure-mcp-tokens.sh).

set -uo pipefail

OUT_DIR="${OUT_DIR:-/tmp/mcp-blank-flow}"
WALLET="${WALLET:-dev-alice}"
NETWORK="${NETWORK:-undeployed}"

mkdir -p "$OUT_DIR"

# Tear down any existing localnet so each run is a true blank-start.
echo "=== Blank-start setup: tearing down localnet ==="
mn localnet down 2>&1 | tail -1 || true
echo

INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"measure","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}'

send() {
  local label=$1 body=$2
  local out_file="$OUT_DIR/${label}.out"
  ( printf '%s\n%s\n' "$INIT" "$body"; sleep 1 ) \
    | timeout 300 midnight-wallet-mcp 2>/dev/null > "$out_file" || true
  grep '"id":2' "$out_file" | wc -c | tr -d ' '
}

total=0
measure() {
  local label=$1 body=$2
  local b
  b=$(send "$label" "$body")
  printf '%-30s  bytes=%7s  est_tokens=%7s\n' "$label" "$b" "$(( b * 2 / 7 ))"
  total=$(( total + b ))
}

echo "=== Blank-start agent flow (wallet=$WALLET, network=$NETWORK) ==="
measure "tools_list"        '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
measure "skill_core"        '{"jsonrpc":"2.0","id":2,"method":"resources/read","params":{"uri":"midnight-wallet://skill/core"}}'
measure "localnet_up"       '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"midnight_localnet_up"}}'
measure "airdrop"           "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"midnight_airdrop\",\"arguments\":{\"amount\":\"1000\",\"wallet\":\"$WALLET\",\"network\":\"$NETWORK\"}}}"
measure "dust_register"     "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"midnight_dust_register\",\"arguments\":{\"wallet\":\"$WALLET\",\"network\":\"$NETWORK\"}}}"
measure "balance"           "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"midnight_balance\",\"arguments\":{\"wallet\":\"$WALLET\",\"network\":\"$NETWORK\"}}}"

echo
echo "TOTAL bytes:      $total"
echo "TOTAL est tokens: $(( total * 2 / 7 ))"
echo
echo "Responses: $OUT_DIR"
