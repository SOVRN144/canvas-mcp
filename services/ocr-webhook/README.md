# OCR Webhook (Azure Read + OpenAI Vision)

HTTP service that accepts `{ mime, dataBase64, languages?, maxPages? }` and returns `{ text, pagesOcred, meta }`.

## Routing
- `image/*` → OpenAI Vision via Responses API (sync)
- `application/pdf` → Azure Vision Read (async submit+poll with retry/backoff)
- Optional **PDF pre-slicing**: if `PDF_PRESLICE=1`, the webhook trims the input PDF to `maxPages` (or `OCR_MAX_PAGES`) **before** sending to Azure (controls cost/latency).
- **Soft page limit**: if `PDF_PRESLICE=0` and `PDF_SOFT_LIMIT=1`, PDFs whose page count exceeds `maxPages`/`OCR_MAX_PAGES` are rejected with a 400 error (prevents unexpected Azure spend).

## Env
- `OPENAI_API_KEY` (required for images)
- `OPENAI_VISION_MODEL` (default `gpt-4o`) — supports `gpt-4o`, `gpt-4o-mini`, or other vision-capable models
- `OPENAI_TIMEOUT_MS` (default `15000`) — OpenAI path returns **504** on timeout
- `AZURE_VISION_ENDPOINT` (e.g., `https://<res>.cognitiveservices.azure.com`)
- `AZURE_VISION_KEY`
- `AZURE_VISION_API_VERSION` (default `v3.2`) — Azure Read API version
- `AZURE_POST_TIMEOUT_MS` (default `15000`)
- `AZURE_POLL_MS` (default `1500`)
- `AZURE_POLL_TIMEOUT_MS` (default `30000`) — Azure path returns **408** on poll timeout
- `AZURE_RETRY_MAX` (default `5`) — transient 429/5xx retries during polling
- `AZURE_RETRY_BASE_MS` (default `400`)
- `AZURE_RETRY_JITTER_MS` (default `250`)
- `AZURE_RETRY_MAX_MS` (default `60000`) — ceiling for Retry-After parsing and backoff delays
- `PDF_PRESLICE` (default `0`) — set to `1` to enable in-memory page trimming
- `PDF_SOFT_LIMIT` (default `1`) — when `PDF_PRESLICE=0`, reject PDFs whose page count exceeds `maxPages`/`OCR_MAX_PAGES` (prevents unexpected Azure spend)
- `OCR_WEBHOOK_SECRET` (HMAC; if set, include `X-Signature: sha256=<hex>` over **raw** body)
- `OCR_MAX_BYTES` default `15000000`
- `OCR_MAX_PAGES` default `25`
- `PORT` default `8080`
- `LOG_LEVEL` default `info`

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

### PDF (with pre-slicing):
```bash
export PDF_PRESLICE=1
PDF=scan.pdf
B64=$(base64 < "$PDF" | tr -d '\n')
# request only first 10 pages sent to Azure
PAYLOAD=$(jq -nc --arg m "application/pdf" --arg d "$B64" '{mime:$m, dataBase64:$d, maxPages:10}')
SIG=$(printf %s "$PAYLOAD" | openssl dgst -sha256 -hmac "$OCR_WEBHOOK_SECRET" -binary | xxd -p -c 256)

curl -s http://127.0.0.1:8080/extract \
  -H 'content-type: application/json' \
  -H "x-signature: sha256=$SIG" \
  -d "$PAYLOAD" | jq .
# meta.pdf should include: { presliced:true, originalPages:<N>, submittedPages:10 }
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
- **Pre-slicing**: Uses `pdf-lib` in memory. For very large PDFs, memory usage rises with page count; keep `OCR_MAX_BYTES` conservative and consider streaming input upstream if needed.
- **Soft limit**: When `PDF_PRESLICE=0` and `PDF_SOFT_LIMIT=1`, PDFs exceeding `maxPages`/`OCR_MAX_PAGES` are rejected immediately to prevent unexpected Azure spend. Enable `PDF_PRESLICE=1` to automatically trim instead.
- **Azure polling**: The poller treats non-200 HTTP responses as errors. On 429/5xx, it retries up to `AZURE_RETRY_MAX`, honoring `Retry-After` headers (supports both seconds and HTTP-date formats) with clamping to `[AZURE_POLL_MS, AZURE_RETRY_MAX_MS]`. Other 4xx statuses fail fast. Long timeouts surface a 408.
- **Timeout semantics**: OpenAI path returns **504** on timeout; Azure path returns **408** on internal poll timeout.
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
