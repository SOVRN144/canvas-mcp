#!/usr/bin/env bash
set -euo pipefail

PUBLIC_BASE="${1:-${PUBLIC_BASE:-${PUBLIC_URL:-}}}"
if [[ -z "${PUBLIC_BASE}" ]]; then
  echo "Usage: scripts/smoke-public.sh <public-base-url>" >&2
  echo "You can also set PUBLIC_BASE or PUBLIC_URL environment variables." >&2
  exit 1
fi

header_file="$(mktemp)"
trap 'rm -f "$header_file"' EXIT

echo "### GET ${PUBLIC_BASE}/healthz"
curl -si "${PUBLIC_BASE%/}/healthz" | sed -n '1,12p'
echo

echo "### initialize"
curl -sD "$header_file" "${PUBLIC_BASE%/}/mcp" \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' | jq -e '.result.protocolVersion=="2024-11-05"'

SESSION="$(awk -F': *' '{if (tolower($1)=="mcp-session-id") print $2}' "$header_file" | tr -d '\r')"
if [[ -z "${SESSION}" ]]; then
  echo "!! No Mcp-Session-Id header in initialize response" >&2
  echo "---- headers ----" >&2
  cat "$header_file" >&2
  exit 1
fi
echo "Session: ${SESSION}"
echo

echo "### tools/list"
LIST="$(curl -s "${PUBLIC_BASE%/}/mcp" \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -H "Mcp-Session-Id: ${SESSION}" \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')"
echo "${LIST}" | jq .
echo "${LIST}" | jq -e '(.result.tools | map(.name) | index("echo")) != null' >/dev/null
echo

if jq -e '.result.tools | map(.name=="list_courses") | any' <<<"${LIST}" >/dev/null 2>&1; then
  echo "### tools/call list_courses"
  LIST_COURSES="$(curl -s "${PUBLIC_BASE%/}/mcp" \
    -H 'Accept: application/json, text/event-stream' \
    -H 'Content-Type: application/json' \
    -H "Mcp-Session-Id: ${SESSION}" \
    --data '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"list_courses","arguments":{}}}')"
  if jq -e '.result.structuredContent.courses' <<<"${LIST_COURSES}" >/dev/null 2>&1; then
    echo "${LIST_COURSES}" | jq '{count: (.result.structuredContent.courses | length), sample: (.result.structuredContent.courses | map({id, name})[:3])}'
  else
    echo "::notice::list_courses unavailable (Canvas 5xx or shape mismatch) — continuing"
  fi
  echo
fi

echo "### tools/call echo (ok)"
SUCCESS="$(curl -s "${PUBLIC_BASE%/}/mcp" \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -H "Mcp-Session-Id: ${SESSION}" \
  --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"text":"hello from public"}}}')"
echo "${SUCCESS}" | jq .
echo "${SUCCESS}" | jq -e '.result.content[0].text == "hello from public"' >/dev/null
echo

echo "### tools/call echo (bad args)"
BAD="$(curl -s "${PUBLIC_BASE%/}/mcp" \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -H "Mcp-Session-Id: ${SESSION}" \
  --data '{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{"name":"echo","arguments":{}}}')"
echo "${BAD}" | jq .
echo "${BAD}" | jq -e '.id == 42 and (.error.code != null)' >/dev/null
echo

if jq -e '.result.tools | map(.name=="env_check") | any' <<<"${LIST}" >/dev/null 2>&1; then
  echo "### env_check (optional)"
  curl -s "${PUBLIC_BASE%/}/mcp" \
    -H 'Accept: application/json, text/event-stream' \
    -H 'Content-Type: application/json' \
    -H "Mcp-Session-Id: ${SESSION}" \
    --data '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"env_check","arguments":{}}}' | jq .
  echo
fi

echo "OK"
