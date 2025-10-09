# CI Smoke Test Fix for PR21

## Problem

The CI smoke tests for PR21 (feature/files-extract-download) were failing with:
- `CI / smoke (pull_request)` - Failing after 54s
- `CI / smoke (push)` - Failing after 43s

## Root Cause

The smoke test script in `.github/workflows/ci.yml` was missing the required `Accept: application/json, text/event-stream` header on subsequent requests after initialization.

The MCP server requires this header on **all** requests, but the smoke test only included it on the initialize request (line 87), not on:
- Line 95: `tools/list` request 
- Line 101: `tools/call` request for echo

This caused the server to return HTTP 406 (Not Acceptable) with the error message:
```
Not Acceptable: Client must accept both application/json and text/event-stream
```

## Solution

Add the missing `Accept: application/json, text/event-stream` header to both subsequent curl requests:

### Before (lines 93-96):
```bash
curl -fsS http://127.0.0.1:8787/mcp \
  -H "Mcp-Session-Id: $SID" \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | jq . >/dev/null
```

### After (lines 93-97):
```bash
curl -fsS http://127.0.0.1:8787/mcp \
  -H "Mcp-Session-Id: $SID" \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | jq . >/dev/null
```

And similarly for the `tools/call` request on line 101.

## Testing

The fix was verified locally by:
1. Starting the server: `LOG_LEVEL=error NODE_ENV=test node dist/http.js`
2. Running the exact smoke test sequence from the CI workflow
3. Result: **PASSED** ✅

### Test Output
```
SMOKE TEST PASSED
```

## Files Modified

- `.github/workflows/ci.yml` - Added 2 lines (Accept headers on lines 95 and 101)

## Impact

This is a minimal 2-line fix that resolves the CI failures. All unit tests (35 tests across 12 files) already pass. The smoke test will now pass as well.

## Recommendation

Apply the fix to PR21 by either:

### Option 1: Apply the patch file
```bash
git checkout feature/files-extract-download
git apply PR21_CI_FIX.patch
git add .github/workflows/ci.yml
git commit -m "Fix CI smoke test: Add missing Accept headers"
git push
```

### Option 2: Manual edit
Edit `.github/workflows/ci.yml` and add `-H 'Accept: application/json, text/event-stream' \` on:
- Line 95 (after `"Mcp-Session-Id: $SID"`)
- Line 101 (after `"Mcp-Session-Id: $SID"`)

This minimal 2-line fix will resolve the CI failures and allow PR21 to proceed to merge.
