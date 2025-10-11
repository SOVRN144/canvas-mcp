# canvas-mcp

[![CI](https://github.com/SOVRN144/canvas-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/SOVRN144/canvas-mcp/actions/workflows/ci.yml)
[![CodeQL](https://github.com/SOVRN144/canvas-mcp/actions/workflows/codeql.yml/badge.svg)](https://github.com/SOVRN144/canvas-mcp/actions/workflows/codeql.yml)

Minimal MCP server (Streamable HTTP) with an `echo` tool.

## Repo Health

This repository maintains several health and security checks:

- **Lint**: ESLint with TypeScript, import ordering, and security rules
- **Typecheck**: TypeScript strict mode with additional safety flags
- **Tests**: Vitest with coverage reporting
- **Coverage**: Test coverage tracked in CI
- **CodeQL**: GitHub's security analysis for JavaScript/TypeScript
- **Scorecards**: OSSF Scorecard for supply chain security
- **Dependabot**: Automated dependency updates (weekly)

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development workflow.

## Dev
```bash
npm i
npm run dev
# SANITY MCP on http://127.0.0.1:8787/mcp
```

## Configuration
Copy `.env.example` to `.env` and adjust values as needed:
- `CORS_ALLOW_ORIGINS`: comma-separated list of browser origins allowed to call the MCP server. Leave empty to block all browser origins while still allowing CLI clients (no `Origin` header). Do **not** expose `Mcp-Session-Id` to `*`; always use an allowlist for browser-based connectors.
- `SESSION_TTL_MS`: idle session timeout (in milliseconds). Defaults to 600000 (10 minutes) when unset; idle sessions close automatically once expired.

## Tools

### Text Extraction & Downloads
- **`extract_file`**: Extract text from Canvas files (PDF, DOCX, PPTX, TXT). Default max characters: **50,000**. Supports optional OCR for image-only PDFs.
- **`get_assignment`**: Fetch Canvas assignment details with sanitized HTML or plain text description. Default max characters: **100,000**.
- **`download_file`**: Download Canvas files. Small files (≤10KB by default) are inlined as base64; larger files return a signed URL. If a file exceeds the `maxSize` parameter and is a supported document type, the error message will suggest using `extract_file` instead.

### Canvas Data
- **`list_courses`**: List all Canvas courses for the authenticated user.
- **`list_modules`**: List modules and items for a course.
- **`list_files_from_modules`**: Extract file references from course modules.

All text extraction tools support a `maxChars` parameter to control output length. When not specified, the defaults above apply.

## Smoke
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

## Install & Local Smoke (non-blocking)
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
