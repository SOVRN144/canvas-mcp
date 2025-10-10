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
  if jq -e '.result.structuredContent.courses | type == "array"' <<<"${LIST_COURSES}" >/dev/null 2>&1; then
    echo "${LIST_COURSES}" | jq '{count: (.result.structuredContent.courses | length), sample: (.result.structuredContent.courses | map({id, name})[:3])}'
  else
    echo "::notice::list_courses unavailable (Canvas 5xx or shape mismatch); continuing"
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

# Optional file testing (skip if no FILE_ID provided)
if [ -n "${FILE_ID:-}" ]; then
  echo "### tools/call extract_file (optional)"
  EXTRACT_RESULT="$(curl -s "${PUBLIC_BASE%/}/mcp" \
    -H 'Accept: application/json, text/event-stream' \
    -H 'Content-Type: application/json' \
    -H "Mcp-Session-Id: ${SESSION}" \
    --data "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"extract_file\",\"arguments\":{\"fileId\":${FILE_ID},\"mode\":\"text\"}}}" || true)"
  
  if echo "${EXTRACT_RESULT}" | jq -e '.result.structuredContent.blocks' >/dev/null 2>&1; then
    echo "First 300 chars from extracted file:"
    echo "${EXTRACT_RESULT}" | jq -r '.result.content[0].text' 2>/dev/null | head -c 300 || echo "Could not extract preview"
    echo "..."
  elif echo "${EXTRACT_RESULT}" | jq -e '.error' >/dev/null 2>&1; then
    echo "::notice::extract_file failed: $(echo "${EXTRACT_RESULT}" | jq -r '.error.message' 2>/dev/null || echo 'unknown error')"
  else
    echo "::notice::extract_file test unavailable or failed"
  fi
  echo
  
  echo "### tools/call download_file (optional)"
  DOWNLOAD_RESULT="$(curl -s "${PUBLIC_BASE%/}/mcp" \
    -H 'Accept: application/json, text/event-stream' \
    -H 'Content-Type: application/json' \
    -H "Mcp-Session-Id: ${SESSION}" \
    --data "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{\"name\":\"download_file\",\"arguments\":{\"fileId\":${FILE_ID},\"maxSize\":1048576}}}" || true)"
  
  if echo "${DOWNLOAD_RESULT}" | jq -e '.result.structuredContent.file.name' >/dev/null 2>&1; then
    echo "${DOWNLOAD_RESULT}" | jq '{filename: .result.structuredContent.file.name, size: .result.structuredContent.file.size, contentType: .result.structuredContent.file.contentType}' 2>/dev/null || echo "Could not parse download result"
  elif echo "${DOWNLOAD_RESULT}" | jq -e '.error' >/dev/null 2>&1; then
    echo "::notice::download_file failed: $(echo "${DOWNLOAD_RESULT}" | jq -r '.error.message' 2>/dev/null || echo 'unknown error')"
  else
    echo "::notice::download_file test unavailable or failed"
  fi
  echo
fi

echo "OK"
