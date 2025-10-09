# Smoke-Canvas CI Job Fix

## Problem

The `smoke-canvas` CI job in PR #21 was failing with errors indicating:
1. "Server at http://127.0.0.1:8787/mcp did not start"
2. "401 Unauthorized" errors

## Root Causes Identified

### 1. Missing Build Step
The original workflow was using `npx tsx src/http.ts` to run the TypeScript source directly without building. While this works with tsx, it:
- Doesn't validate that the project builds correctly
- Doesn't test the actual production artifact (`dist/http.js`)
- Could mask build-time issues

### 2. Weak Readiness Check
The readiness check used `nc -z 127.0.0.1 8787` (netcat) which only verifies the TCP port is listening. This doesn't guarantee:
- The HTTP server is actually responding
- The MCP server initialization is complete
- The server can handle requests properly

### 3. Invalid Session ID (PR 21 specific)
PR #21 had an additional "Smoke: tools/list" step that used `uuidgen` to create a random UUID and tried to use it as a session ID without proper initialization. This caused 401 Unauthorized errors because:
- MCP server requires initialization to get a valid session ID
- Random UUIDs are not valid session IDs
- The step was redundant (main smoke test already covered this)

## Solution Applied

### 1. Added Proper Build Step
```yaml
- name: Build
  if: ${{ steps.canvas_guard.outputs.has_canvas == 'true' }}
  run: |
    npm ci || npm install
    npm run typecheck
    npm run build
```

### 2. Changed Server Startup
```yaml
- name: Start Canvas MCP server
  if: ${{ steps.canvas_guard.outputs.has_canvas == 'true' }}
  run: |
    set -euo pipefail
    LOG_LEVEL=error NODE_ENV=test node dist/http.js > server.log 2>&1 &
    echo $! > server.pid
```

### 3. Added Robust HTTP Readiness Check
```yaml
- name: Wait for Canvas server (POST initialize readiness)
  if: ${{ steps.canvas_guard.outputs.has_canvas == 'true' }}
  timeout-minutes: 3
  run: |
    set -euo pipefail
    for i in $(seq 1 60); do
      code=$(curl -sS -o /dev/null -w "%{http_code}" \
        -H 'Accept: application/json, text/event-stream' \
        -H 'Content-Type: application/json' \
        --data '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' \
        http://127.0.0.1:8787/mcp || true)
      [ "$code" = "200" ] && exit 0
      sleep 1
    done
    echo "::error::Server did not become ready"
    [ -f server.log ] && tail -n 200 server.log || true
    exit 1
```

### 4. Removed Problematic Step
Removed the "Smoke: tools/list" step with `uuidgen` from PR #21. The main "Canvas smoke" step already performs comprehensive testing with proper session management.

### 5. Additional Improvements
- Added PR security check: `github.event.pull_request.head.repo.full_name == github.repository` to prevent exposing secrets to PRs from forks
- Improved error logging to show `server.log` when readiness check fails
- Updated step condition variable names for consistency (`canvas_guard` instead of `canvas_env`)

## Files Modified

- `.github/workflows/ci.yml` - Updated smoke-canvas job (70 lines added, 29 deleted)

## Testing

✅ YAML syntax validation passed
✅ TypeScript compilation passed
✅ Build step completes successfully
✅ Local simulation of the workflow logic confirmed proper execution flow
✅ CodeQL security analysis found no issues

## Impact

This fix ensures:
1. The server is properly built before starting
2. The server is fully ready before running tests
3. No invalid session IDs are used
4. Better error diagnostics when startup fails
5. Protection against secret exposure in fork PRs

The changes are minimal and focused on making the CI workflow more robust and production-like.
