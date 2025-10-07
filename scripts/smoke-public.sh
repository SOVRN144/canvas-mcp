#!/usr/bin/env bash
set -euo pipefail
BASE="${1:?usage: smoke-public.sh https://<public-host>/mcp}"
tmp="$(mktemp)"

get_header_ignore_case() {
  local header_file="$1"
  local name="${2,,}"
  awk -F': ' -v target="$name" 'tolower($1)==target {print $2}' "$header_file"
}

echo '>>> INIT'
curl -sD "$tmp" "$BASE" \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' | jq -e '.result.protocolVersion=="2024-11-05"'
SESSION="$(get_header_ignore_case "$tmp" 'mcp-session-id' | tr -d '\r')"
if [ -z "${SESSION:-}" ]; then
  echo '!! No Mcp-Session-Id header in init response'
  echo '---- HEADERS ----'
  cat "$tmp"
  exit 1
fi
echo "Session: $SESSION"

echo '>>> tools/list'
curl -s "$BASE" \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -H "Mcp-Session-Id: $SESSION" \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | jq -e '.result.tools | any(.name=="echo")'

echo '>>> echo'
curl -s "$BASE" \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -H "Mcp-Session-Id: $SESSION" \
  --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"text":"hello from public"}}}' | jq -e '.result.content[0].text=="hello from public"'

echo '>>> env_check (optional)'
curl -s "$BASE" \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -H "Mcp-Session-Id: $SESSION" \
  --data '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"env_check","arguments":{}}}' | jq .

echo 'OK'
