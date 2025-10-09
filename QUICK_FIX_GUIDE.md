# Quick Fix Guide for PR21 CI Failures

## The Problem
PR21's CI smoke tests are failing with HTTP 406 errors.

## The Solution (2 lines)
Add the missing `Accept` header to two curl commands in `.github/workflows/ci.yml`

## How to Fix (Choose One Method)

### Option A: Use the Patch File (Easiest)
```bash
cd /path/to/canvas-mcp
git checkout feature/files-extract-download
git apply PR21_CI_FIX.patch
git add .github/workflows/ci.yml
git commit -m "Fix CI smoke test: Add missing Accept headers"
git push origin feature/files-extract-download
```

### Option B: Manual Edit
1. Open `.github/workflows/ci.yml`
2. Find line 94 (should be: `-H "Mcp-Session-Id: $SID" \`)
3. Add a new line after it: `-H 'Accept: application/json, text/event-stream' \`
4. Find line 100 (should be: `-H "Mcp-Session-Id: $SID" \`)
5. Add a new line after it: `-H 'Accept: application/json, text/event-stream' \`
6. Save, commit, and push

## What Changed
```diff
  curl -fsS http://127.0.0.1:8787/mcp \
    -H "Mcp-Session-Id: $SID" \
+   -H 'Accept: application/json, text/event-stream' \
    -H 'Content-Type: application/json' \
    --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | jq . >/dev/null
```

## Why This Works
The MCP server requires the `Accept: application/json, text/event-stream` header on ALL requests. The smoke test had it on the initialize request but was missing it on tools/list and tools/call requests, causing HTTP 406 (Not Acceptable) errors.

## Verification
- ✅ Tested locally with exact CI smoke test sequence
- ✅ All 35 unit tests pass
- ✅ Minimal change (2 lines added)

## More Details
See `ANALYSIS_SUMMARY.md` for complete technical analysis.
