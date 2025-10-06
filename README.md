# canvas-mcp

Minimal MCP server (Streamable HTTP) with an `echo` tool.

## Dev
```bash
npm i
npm run dev
# SANITY MCP on http://127.0.0.1:8787/mcp
```

Smoke:
```bash
H=$(mktemp)
curl -sD "$H" http://127.0.0.1:8787/mcp \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":"1","method":"initialize"}' | jq .
SESSION=$(awk -F': ' '/^[Mm]cp-[Ss]ession-[Ii]d:/ {print $2}' "$H" | tr -d '\r'); echo "Session: $SESSION"
curl -s http://127.0.0.1:8787/mcp \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -H "Mcp-Session-Id: $SESSION" \
  --data '{"jsonrpc":"2.0","id":"2","method":"tools/list","params":{}}' | jq .
```

Install & quick local smoke (non-blocking):
```bash
npm i
nohup npm run dev >/tmp/mcp-dev.log 2>&1 &
sleep 1
H=$(mktemp)
curl -sD "$H" http://127.0.0.1:8787/mcp \
  -H 'Accept: application/json, text/event-stream' -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":"1","method":"initialize"}' | jq . || true
pkill -f "tsx src/http.ts" || true
```
