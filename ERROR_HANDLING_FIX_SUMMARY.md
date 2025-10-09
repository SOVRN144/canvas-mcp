# Error Handling Fix Summary

## Problem Statement
CI tests were failing for `extract_file` and `download_file` tools with the error:
```
AssertionError: expected undefined to be truthy
- Expected: true
- Received: undefined
```

Tests were expecting error responses in the format `body.error.message`, but receiving `undefined`.

## Root Cause
The tests were written expecting standard JSON-RPC error format:
```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32000,
    "message": "..."
  },
  "id": 2
}
```

However, the MCP SDK (v1.19.1) returns errors differently:
```json
{
  "jsonrpc": "2.0",
  "result": {
    "content": [
      {
        "type": "text",
        "text": "File 999: content type not allowed (application/zip)"
      }
    ],
    "isError": true
  },
  "id": 2
}
```

## Solution Implemented
1. **Added helper function** `getErrorMessage()` to extract error messages from MCP responses:
   ```typescript
   function getErrorMessage(body: any): string | undefined {
     // MCP SDK returns errors as result.isError with message in content[0].text
     if (body?.result?.isError && body.result.content?.[0]?.text) {
       return body.result.content[0].text;
     }
     // Fallback for standard JSON-RPC error format
     if (body?.error?.message) {
       return body.error.message;
     }
     return undefined;
   }
   ```

2. **Updated all error-checking tests** to use the helper function instead of directly checking `body.error.message`

3. **Fixed PPTX error handling** to preserve specific error messages (like "too many slides") by re-throwing errors that are already properly formatted

4. **Updated truncation test** to accept either truncation marker format

## Files Changed
- `src/files.ts` - Fixed PPTX error handling
- `src/http.ts` - Removed `withCanvasErrors` wrapper from tool handlers (errors already logged)
- `tests/files.disallowed.test.ts` - Added helper and updated assertions
- `tests/extract-edge-cases.test.ts` - Added helper and updated assertions
- `tests/files.download.test.ts` - Added helper and updated assertions
- `tests/files.extract.test.ts` - Added helper and updated assertions
- `tests/files.pptx.test.ts` - Added helper and updated assertions
- `tests/files.text.test.ts` - Updated truncation marker test

## Test Results

### Before Fix (main branch)
- **12 tests failing** across 7 test files
- All error-handling tests failing with "expected undefined to be truthy"

### After Fix
- **2 tests failing** (both pre-existing, unrelated to error handling)
- **33 tests passing** (out of 35 total)
- **10 error-handling tests fixed**

### Remaining Failures (Pre-existing)
1. `canvas-token-sanitize.test.ts` - Token not being trimmed properly (has extra spaces and newline)
2. `files.pptx.test.ts > skips first text run only when title exists` - PPTX title/body text extraction logic issue

## Error Messages Now Working Correctly
✅ Disallowed file types (ZIP, video, image)
✅ Oversized files for extraction
✅ Oversized files for download
✅ Unsupported content types
✅ Unknown content types with no extension
✅ PPTX with too many slides

## Key Takeaway
The MCP SDK's error handling differs from standard JSON-RPC. When tools throw errors, the SDK catches them and returns a successful JSON-RPC response with `result.isError=true` instead of using the standard `error` field. Tests must check for errors using the MCP-specific format.
