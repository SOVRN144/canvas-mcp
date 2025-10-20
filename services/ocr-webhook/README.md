# OCR Webhook (Azure Read + OpenAI Vision)

HTTP service that accepts `{ mime, dataBase64, languages?, maxPages? }` and returns `{ text, pagesOcred, meta }`.

## Routing
- `image/*` → OpenAI Vision via Responses API with `image_url` as a data URL (synchronous).
- `application/pdf` → Deterministic selection per request:
  1. If `PDF_PRESLICE` is truthy **and** `OPENAI_API_KEY` is present → render PDF → PNG via `pdfjs-dist` + `@napi-rs/canvas`, OCR each page with OpenAI.
  2. Else if Azure Vision endpoint+key configured → Azure Read (submit + poll with retry/backoff).
  3. Else if `OPENAI_API_KEY` present → OpenAI preslice fallback (same as step 1).
  4. Else → `501` with `{ error.code: "no_ocr_engine" }`.
- **Soft page limit** (Azure protection): when `PDF_PRESLICE` is falsey and `PDF_SOFT_LIMIT` truthy, PDFs whose page count exceeds `maxPages`/`OCR_MAX_PAGES` are rejected (400) to avoid unexpected Azure spend.

## Env
- `OPENAI_API_KEY` (required for images)
- `OPENAI_VISION_MODEL` (default `gpt-4o`) — supports `gpt-4o`, `gpt-4o-mini`, or other vision-capable models
- `OPENAI_TIMEOUT_MS` (default `60000`) — OpenAI path returns **504** on timeout
- `AZURE_VISION_ENDPOINT` (e.g., `https://<res>.cognitiveservices.azure.com`)
- `AZURE_VISION_KEY`
- `AZURE_VISION_API_VERSION` (default `v3.2`) — Azure Read API version
- `AZURE_POST_TIMEOUT_MS` (default `15000`)
- `AZURE_POLL_MS` (default `1000`)
- `AZURE_POLL_TIMEOUT_MS` (default `30000`) — Azure path returns **504** on poll timeout
- `AZURE_POLL_MAX_ATTEMPTS` (default `60`)
- `AZURE_RETRY_MAX_MS` (default `60000`) — ceiling for Retry-After/backoff delays
- `PDF_PRESLICE` (default false) — set to any truthy string (`1`, `true`, `yes`, `on`) to enable OpenAI preslice routing
- `PDF_SOFT_LIMIT` (default `1`) — when `PDF_PRESLICE=0`, reject PDFs whose page count exceeds `maxPages`/`OCR_MAX_PAGES` (prevents unexpected Azure spend)
- `PRESLICE_DPI` (default `144`) — scale factor for PDF → PNG rendering (`dpi / 72`)
- `PRESLICE_MAX_PAGES` (default `5`) — hard cap on number of pages rendered per request
- `PRESLICE_MAX_OUTPUT_MB` (default `64`) — guardrail on total PNG output size before aborting
- `OCR_WEBHOOK_SECRET` (HMAC; if set, include `X-Signature: sha256=<hex>` over **raw** body)
- `OCR_MAX_BYTES` default `15000000`
- `OCR_MAX_PAGES` default `25`
- `PORT` default `8080`
- `LOG_LEVEL` default `info`

## PDF preslicing (OpenAI Vision)
- Renders PDF pages to PNG using `pdfjs-dist` (legacy build) and `@napi-rs/canvas` (prebuilt binaries; no system packages required).
- Honors `PRESLICE_DPI`, `PRESLICE_MAX_PAGES`, and `PRESLICE_MAX_OUTPUT_MB` to keep memory and CPU bounded.
- Each rendered page is OCR’d with the existing OpenAI Vision image pipeline; `meta.engine` remains `openai-vision` and `meta.pdf.presliced` is `true`.
- If rendering exceeds `PRESLICE_MAX_OUTPUT_MB`, the request fails fast with `413 preslice_output_too_large`.
- The preslicer is lazy-loaded on demand so cold start remains fast for non-PDF traffic.

### Engine selection matrix

| Condition | Engine |
| --- | --- |
| `PDF_PRESLICE` truthy **and** `OPENAI_API_KEY` set | OpenAI preslice |
| else if Azure endpoint & key present | Azure Read |
| else if `OPENAI_API_KEY` set | OpenAI preslice fallback |
| else | `501` `no_ocr_engine` |

Trailing slashes on `AZURE_VISION_ENDPOINT` are ignored automatically.

## Run
```bash
npm i
export OPENAI_API_KEY=sk-...
export AZURE_VISION_ENDPOINT=https://<res>.cognitiveservices.azure.com
export AZURE_VISION_KEY=<key>
export OCR_WEBHOOK_SECRET=dev-secret
export PDF_PRESLICE=1   # enable pre-slicing (optional)
npm start
```

## Health / Ready
```bash
curl -s http://127.0.0.1:8080/healthz
# -> { "ok": true }

curl -s http://127.0.0.1:8080/ready | jq .
# -> { "ok": true, "openai": true|false, "azure": true|false, "hmac": true|false, "pdfPreslice": true|false }
```

## cURL smokes (with HMAC)

HMAC covers the raw body. Header must be: `X-Signature: sha256=<hex>`.

**Request-ID correlation**: Send `X-Request-ID` header to correlate logs; the service echoes it in response headers and includes `requestId` in the response body.

### Image:

```bash
IMG=sample.jpg
B64=$(base64 < "$IMG" | tr -d '\n')
PAYLOAD=$(jq -nc --arg m "image/jpeg" --arg d "$B64" '{mime:$m, dataBase64:$d}')
SIG=$(printf %s "$PAYLOAD" | openssl dgst -sha256 -hmac "$OCR_WEBHOOK_SECRET" -binary | xxd -p -c 256)

curl -s http://127.0.0.1:8080/extract \
  -H 'content-type: application/json' \
  -H 'X-Request-ID: demo-123' \
  -H "x-signature: sha256=$SIG" \
  -d "$PAYLOAD" | jq .
```

### PDF (OpenAI preslice):
```bash
export PDF_PRESLICE=1
PDF=scan.pdf
B64=$(base64 < "$PDF" | tr -d '\n')
# request only first 10 pages to be rendered/OCR'd
PAYLOAD=$(jq -nc --arg m "application/pdf" --arg d "$B64" '{mime:$m, dataBase64:$d, maxPages:10}')
SIG=$(printf %s "$PAYLOAD" | openssl dgst -sha256 -hmac "$OCR_WEBHOOK_SECRET" -binary | xxd -p -c 256)

curl -s http://127.0.0.1:8080/extract \
  -H 'content-type: application/json' \
  -H "x-signature: sha256=$SIG" \
  -d "$PAYLOAD" | jq .
# meta.engine === "openai-vision"; meta.pdf.presliced === true
```

### Negative smoke (soft limit):
```bash
# With PDF_PRESLICE=0 and PDF_SOFT_LIMIT=1, a 100-page PDF with maxPages=10 should be rejected
export PDF_PRESLICE=0
export PDF_SOFT_LIMIT=1
PDF=big.pdf
B64=$(base64 < "$PDF" | tr -d '\n')
PAYLOAD=$(jq -nc --arg m "application/pdf" --arg d "$B64" '{mime:$m, dataBase64:$d, maxPages:10}')
SIG=$(printf %s "$PAYLOAD" | openssl dgst -sha256 -hmac "$OCR_WEBHOOK_SECRET" -binary | xxd -p -c 256)

curl -s http://127.0.0.1:8080/extract \
  -H 'content-type: application/json' \
  -H "x-signature: sha256=$SIG" \
  -d "$PAYLOAD" | jq .
# -> 400 with { error:{ code:"pdf_page_limit", pages:100, maxPages:10, ... } }
```

## MCP integration (env on MCP server):

```bash
export OCR_PROVIDER=webhook
export OCR_WEBHOOK_URL=http://127.0.0.1:8080/extract
export OCR_WEBHOOK_SECRET=dev-secret
export OCR_TIMEOUT_MS=20000
```

## Response shape (MCP extract_file expects):
```json
{
  "text": "…",
  "pagesOcred": [1,2],
  "requestId": "demo-123",
  "meta": {
    "engine": "azure-read|openai-vision",
    "source": "ocr",
    "durationMs": 1234,
    "pdf": { "presliced": true, "originalPages": 120, "submittedPages": 10 }
  }
}
```

## Notes
- **Request-ID passthrough**: Send `X-Request-ID` header to correlate logs; the service echoes it in response headers and includes `requestId` in both success and error responses.
- **Language hints**: You may pass `languages` as an array or string; only the first is forwarded to Azure as `language`. If unsure, omit it—incorrect hints can reduce recall.
- **PDF preslicing**: Uses `pdfjs-dist` + `@napi-rs/canvas` to rasterize pages for the OpenAI path. Azure trimming (when OpenAI unavailable) still uses `pdf-lib` to copy the first N pages without rendering.
- **Soft limit**: When `PDF_PRESLICE=0` and `PDF_SOFT_LIMIT=1`, PDFs exceeding `maxPages`/`OCR_MAX_PAGES` are rejected immediately to prevent unexpected Azure spend. Enable `PDF_PRESLICE=1` to automatically trim instead.
- **Azure polling**: The poller treats non-200 HTTP responses as errors. On 429/5xx, it retries honoring `Retry-After` headers (HTTP-date or seconds) with clamping to `[AZURE_POLL_MS, AZURE_RETRY_MAX_MS]`. Other 4xx statuses fail fast. Long timeouts surface a 504 with `code:"azure_timeout"`.
- **Timeout semantics**: Both engines return **504** on timeout (Azure uses `code:"azure_timeout"`; OpenAI reports `message:"OpenAI OCR timed out"`).
- **Error responses**: All errors include `{ error: { code: string, httpStatus: number, message: string, ...extra } }` format.
- **Base64 validation**: Strict validation with canonical form checking to prevent malformed input.
- **Docker**: Image runs as non-root user `app:app` with `HEALTHCHECK` for container orchestration.

## Acceptance Criteria

1. `npm start` serves:
   - `/healthz` → `{ ok: true }`
   - `/ready` → `{ ok:true, openai:boolean, azure:boolean, hmac:boolean, pdfPreslice:boolean }` (no secret values)

2. `POST /extract` with a small **JPEG/PNG** returns:
   - `200` with `{ text, pagesOcred:[1], meta.engine:"openai-vision", meta.source:"ocr" }`

3. `POST /extract` with a **scanned PDF** returns:
   - `200` with `{ text, pagesOcred:[...], meta.engine:"azure-read", meta.source:"ocr" }` after internal submit+poll
   - Polling is resilient to transient `429/5xx` via backoff

4. **Pre-slicing behavior** (when `PDF_PRESLICE=1` and PDF has more pages than `maxPages`):
   - Response must include `meta.pdf = { presliced:true, originalPages: >maxPages, submittedPages: maxPages }`
   - If PDF pages ≤ `maxPages`, `presliced:false` and `submittedPages = originalPages`

5. **Soft limit** (when `PDF_PRESLICE=0` and `PDF_SOFT_LIMIT=1`):
   - A PDF whose page count exceeds `maxPages`/`OCR_MAX_PAGES` returns `400`
   - Payload includes: `{ error: { code:"pdf_page_limit", pages: <N>, maxPages: <M>, hint: "Enable PDF_PRESLICE=1..." } }`

6. Bad inputs:
   - Missing fields → `400`
   - Oversize payload → `400 "Payload too large"`
   - Unsupported mime → `415`
   - Invalid HMAC (when secret set) → `401`
   - Azure timeout → `408`

7. Logs **never** print base64 or extracted text (only minimal metadata/errors + requestId)

8. Dockerfile builds and runs: `docker build . && docker run -p 8080:8080`
