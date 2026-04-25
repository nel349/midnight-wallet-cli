#!/bin/bash
# measure-mcp-tokens.sh — measure the byte size of MCP responses so we can
# track token consumption over time. See docs/tasks/archived/token-budget-plan.md
# for the policy this script supports.
#
# Usage:  ./scripts/measure-mcp-tokens.sh
# Output: per-call bytes + estimated tokens to stdout, one CSV-ish line each.
#
# Token estimate ≈ bytes / 3.5. Real token counts depend on the consuming
# LLM's tokenizer; 3.5 chars/token is a reasonable mid-point for JSON-heavy
# content across Claude, GPT-4, and similar.

set -euo pipefail

MCP_ENTRY="${MCP_ENTRY:-src/wallet.ts}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${OUT_DIR:-/tmp/mcp-measure}"
mkdir -p "$OUT_DIR"

# Standard init preamble every MCP session begins with.
read -r -d '' INIT_PREAMBLE <<'EOF' || true
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"measure","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
EOF

# Send a sequence of JSON-RPC messages, capture the full response, and return
# bytes of the message with the given id. All ids used inside this script
# start at 2 so they don't collide with the init id=1.
measure_call() {
  local label="$1" call_id="$2" body="$3"
  local payload="${INIT_PREAMBLE}
${body}"
  local file="$OUT_DIR/${label}.ndjson"
  printf '%s\n' "$payload" \
    | timeout 45 npx tsx "$REPO_ROOT/$MCP_ENTRY" --mcp 2>/dev/null \
    > "$file" || true
  # Each JSON-RPC response is one line; filter by the id we care about.
  local bytes
  bytes="$(grep "\"id\":${call_id}" "$file" | wc -c | tr -d ' ')"
  local tokens
  tokens="$(( (bytes + 3) / 7 * 2 ))"  # ≈ bytes / 3.5, integer rounded
  printf '%-28s  bytes=%7s  est_tokens=%7s\n' "$label" "$bytes" "$tokens"
}

# ── Layer A: protocol surface (every session pays these once) ─────────────
measure_call "tools_list"        "2" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
measure_call "resources_list"    "2" '{"jsonrpc":"2.0","id":2,"method":"resources/list"}'
measure_call "skill_read"        "2" '{"jsonrpc":"2.0","id":2,"method":"resources/read","params":{"uri":"midnight-wallet://skill"}}'

# ── Layer B: representative tool calls ─────────────────────────────────────
measure_call "wallet_list"       "2" '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"midnight_wallet_list"}}'
measure_call "wallet_info"       "2" '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"midnight_wallet_info","arguments":{"name":"dev-alice"}}}'
measure_call "balance"           "2" '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"midnight_balance","arguments":{"wallet":"dev-alice","network":"undeployed"}}}'
measure_call "dust_status"       "2" '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"midnight_dust_status","arguments":{"wallet":"dev-alice","network":"undeployed"}}}'
measure_call "localnet_status"   "2" '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"midnight_localnet_status"}}'
measure_call "transfer_pending"  "2" '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"midnight_transfer","arguments":{"to":"dev-bob","amount":"100","wallet":"dev-alice","network":"undeployed"}}}'

echo
echo "raw responses captured in $OUT_DIR"
