# Top-3 MVP Features for Canvas MCP

This PR implements three new capabilities for the Canvas MCP server:

## 🎯 Features

### 1. **Assignment Details** (`get_assignment`)
Fetch and sanitize Canvas assignment descriptions with HTML/text output modes.

**Tool**: `get_assignment`

**Arguments**:
- `assignmentId` (number, required): Canvas assignment ID
- `courseId` (number, required): Canvas course ID  
- `mode` (string, optional): `"html"` or `"text"` (default: `"text"`)
- `maxChars` (number, optional): Character limit (max: 100,000)

**Response**:
```json
{
  "content": [{"type": "text", "text": "{name, pointsPossible, dueAt}"}],
  "structuredContent": {
    "assignment": {
      "id": 456,
      "name": "Assignment Name",
      "pointsPossible": 100,
      "dueAt": "2024-12-31T23:59:59Z",
      "text": "Sanitized plain text...",  // mode:text
      "html": "<p>Sanitized HTML...</p>", // mode:html
      "truncated": false
    }
  }
}
```

**Security**: Strips all dangerous HTML (scripts, event handlers), adds security headers to links.

---

### 2. **OCR Fallback** (extended `extract_file`)
Webhook-based OCR for image-only PDFs with configurable language support.

**Extended Arguments**:
- `ocr` (string, optional): `"off"` | `"auto"` | `"force"` (default: `"auto"`)
- `ocrLanguages` (array, optional): Language codes (default: `["eng"]`)
- `maxOcrPages` (number, optional): Page limit for OCR (default: 20, max: 200)

**Behavior**:
- **`off`**: Native extraction only; error if image-only PDF detected
- **`auto`**: Try native first; fall back to OCR if text is empty/sparse
- **`force`**: Always use OCR regardless of native text

**Response Meta**:
```json
{
  "meta": {
    "source": "native" | "ocr" | "mixed",
    "pagesOcred": [1, 2, 3],
    "truncated": false
  }
}
```

**Environment**:
```bash
OCR_PROVIDER=webhook                      # "none" | "webhook"
OCR_WEBHOOK_URL=https://ocr.example.com   # Required if provider=webhook
OCR_TIMEOUT_MS=20000                      # Request timeout (default: 20s)
```

**Webhook Contract**:
```json
// Request
POST /extract
{
  "mime": "application/pdf",
  "dataBase64": "...",
  "languages": ["eng"],
  "maxPages": 20
}

// Response
{
  "text": "Extracted text...",
  "pagesOcred": [1, 2, 3]
}
```

---

### 3. **Download Ergonomics** (enhanced `download_file`)
Smart inline/URL behavior based on file size.

**Behavior**:
- **Small files** (≤ `DOWNLOAD_MAX_INLINE_BYTES`): Inline base64 in `structuredContent`
- **Large files** (> limit): Return Canvas signed URL only (no download)

**Environment**:
```bash
DOWNLOAD_MAX_INLINE_BYTES=10485760  # 10MB default
DOWNLOAD_URL_TTL_SEC=600            # URL TTL (informational; Canvas controls actual expiry)
```

**Response (Small)**:
```json
{
  "content": [{"type": "text", "text": "Attached file: ..."}],
  "structuredContent": {
    "file": {
      "id": 111,
      "name": "document.pdf",
      "contentType": "application/pdf",
      "size": 5242880,
      "dataBase64": "..."  // Present for small files
    }
  }
}
```

**Response (Large)**:
```json
{
  "content": [{"type": "text", "text": "Attached file (via URL): ..."}],
  "structuredContent": {
    "file": {
      "id": 222,
      "name": "large-video.mp4",
      "contentType": "video/mp4",
      "size": 52428800,
      "url": "https://canvas.instructure.com/files/222/download?..."  // Canvas signed URL
    }
  }
}
```

---

## 📦 New Modules

### `src/types.ts`
Type definitions for OCR modes, extract sources, and MCP content items.

### `src/canvas.ts`
Canvas API client functions (`getAssignment`).

### `src/sanitize.ts`
HTML sanitization utilities:
- `sanitizeHtmlSafe()`: Opinionated allowlist-based sanitizer
- `htmlToText()`: Lightweight HTML→text converter
- `truncate()`: Safe text truncation with ellipsis

### `src/ocr.ts`
OCR webhook client:
- `performOcr()`: POST to webhook with retry/timeout handling
- `isImageOnly()`: Heuristic to detect image-only documents
- `ocrDisabledHint()`: User-facing error message

### `src/index.ts`
Public exports for types.

---

## 🔧 Configuration Summary

```bash
# Canvas (existing)
CANVAS_BASE_URL=https://invictus.instructure.com
CANVAS_TOKEN=<your-token>

# OCR (new)
OCR_PROVIDER=webhook
OCR_WEBHOOK_URL=https://ocr.example.com/extract
OCR_TIMEOUT_MS=20000

# Downloads (new)
DOWNLOAD_MAX_INLINE_BYTES=10485760  # 10MB
DOWNLOAD_URL_TTL_SEC=600

# Protocol (new)
ENFORCE_ACCEPT_HEADER=true
```

---

## 🧪 Testing

**New Test Suites**:
- `tests/get-assignment.test.ts`: Assignment fetching (text/HTML modes, truncation)
- `tests/ocr-fallback.test.ts`: OCR auto/force/off modes
- `tests/download-ergonomics.test.ts`: Small vs. large file handling

**Run**:
```bash
npm run typecheck  # ✅ Passes
npm test           # Existing tests + new suites
```

---

## 🔒 Security Notes

- **HTML Sanitization**: Strict allowlist (no `<script>`, `<iframe>`, event handlers)
- **Token Redaction**: Logs show first/last 3 chars only (`redact()` helper)
- **URL Logging**: Canvas signed URLs logged without query params at info level
- **No Token Leakage**: Download URLs are Canvas-native signed links; our token never exposed

---

## 📝 Example Usage

### Get Assignment
```bash
curl -X POST http://localhost:8787/mcp \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "get_assignment",
      "arguments": {
        "courseId": 123,
        "assignmentId": 456,
        "mode": "text",
        "maxChars": 5000
      }
    }
  }'
```

### Extract with OCR
```bash
curl -X POST http://localhost:8787/mcp \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "extract_file",
      "arguments": {
        "fileId": 789,
        "ocr": "auto",
        "ocrLanguages": ["eng", "spa"],
        "maxOcrPages": 10
      }
    }
  }'
```

### Download File
```bash
curl -X POST http://localhost:8787/mcp \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "download_file",
      "arguments": {
        "fileId": 222
      }
    }
  }'
```

---

## ✅ Acceptance Criteria

- [x] `npm run typecheck` passes
- [x] New tools registered and visible via `tools/list`
- [x] `get_assignment` returns sanitized text/HTML with truncation
- [x] `extract_file` with `ocr:"auto"` falls back to webhook when native text empty
- [x] `download_file` inlines small files, returns URL for large files
- [x] No token leakage in logs or responses
- [x] Accept header enforcement maintained
- [ ] Full test suite passes (test infrastructure needs session handling fixes)

---

## 🚀 Next Steps

1. Deploy OCR webhook endpoint (or use mock for testing)
2. Update client documentation with new tool schemas
3. Add monitoring/alerts for OCR webhook failures
4. Consider caching OCR results for frequently accessed files

---

## 📊 Impact

- **Assignments**: ~500 LOC added (canvas.ts, sanitize.ts)
- **OCR**: ~400 LOC added (ocr.ts, extract updates)
- **Downloads**: ~100 LOC modified (ergonomics logic)
- **Tests**: ~300 LOC added (3 new test suites)
- **Total**: ~1,300 LOC added

---

**Review**: @coderabbitai
