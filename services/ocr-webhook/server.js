import express from "express";
import crypto from "crypto";
import axios from "axios";
import OpenAI from "openai";
import { PDFDocument } from "pdf-lib";
import imageSize from "image-size";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
let requestLogger = (_req, _res, next) => next();
try {
  const morgan = require("morgan");
  requestLogger = morgan("tiny");
} catch {
  // Morgan is optional in CI/tests; fallback to no-op logger.
}

// ---- env & defaults ----
const PORT = process.env.PORT || 8080;
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4o";
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 60000);

const MIN_IMAGE_PX = parseInt(process.env.MIN_IMAGE_PX || "0", 10);

const PDF_PRESLICE = String(process.env.PDF_PRESLICE || "0") === "1";
const PDF_SOFT_LIMIT = String(process.env.PDF_SOFT_LIMIT || "1") === "1";

const OCR_WEBHOOK_SECRET = process.env.OCR_WEBHOOK_SECRET || ""; // if set, requests must be HMAC-signed
const OCR_MAX_BYTES = Number(process.env.OCR_MAX_BYTES || 15_000_000); // 15 MB default
const OCR_MAX_PAGES = Number(process.env.OCR_MAX_PAGES || 25);

const app = express();
app.disable("x-powered-by");

// capture raw body for HMAC verify
app.use(express.json({
  limit: Math.ceil(OCR_MAX_BYTES * 1.5),
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

// minimal logging (never log base64 or OCR text)
app.use(requestLogger);

// health
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// readiness (presence booleans only — no secret values)
app.get("/ready", (_req, res) => {
  const { endpoint, key } = getAzureConfig();
  res.json({
    ok: true,
    openai: Boolean(OPENAI_API_KEY),
    azure: Boolean(endpoint && key),
    hmac: Boolean(OCR_WEBHOOK_SECRET),
    pdfPreslice: PDF_PRESLICE
  });
});

// helpers
function bad(res, httpStatus, message, extra = {}) {
  const code = typeof extra.code === "string" ? extra.code : String(httpStatus);
  const { code: _drop, ...rest } = extra;
  return res.status(httpStatus).json({ error: { code, httpStatus, message, ...rest } });
}

function verifySignature(req) {
  if (!OCR_WEBHOOK_SECRET) return true;
  const header = req.get("x-signature") || "";
  const m = header.match(/^sha256=(.+)$/i);
  if (!m) return false;
  const expected = m[1].toLowerCase();
  const actual = crypto.createHmac("sha256", OCR_WEBHOOK_SECRET)
    .update(req.rawBody || Buffer.from(""))
    .digest("hex")
    .toLowerCase();
  const a = Buffer.from(actual);
  const e = Buffer.from(expected);
  return a.length === e.length && crypto.timingSafeEqual(a, e);
}

function bytesFromBase64Strict(b64) {
  if (typeof b64 !== "string") return null;
  const clean = b64.replace(/\s+/g, "");
  const ok = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(clean);
  if (!ok) return null;
  const buf = Buffer.from(clean, "base64");
  const canon = buf.toString("base64").replace(/=+$/, "");
  const target = clean.replace(/=+$/, "");
  return canon === target ? buf : null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function coerceMaxPages(v) {
  const n = Number.parseInt(String(v), 10);
  if (!Number.isFinite(n) || n <= 0) return OCR_MAX_PAGES;
  return Math.min(OCR_MAX_PAGES, Math.floor(n));
}

function parseRetryAfter(h) {
  if (!h) return null;
  const s = Array.isArray(h) ? h[0] : String(h);
  const sec = Number(s);
  if (Number.isFinite(sec) && sec >= 0) return sec * 1000;
  const when = Date.parse(s);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

function getAzureConfig() {
  const endpoint = (process.env.AZURE_VISION_ENDPOINT || "").replace(/\/+$/, "");
  const key = process.env.AZURE_VISION_KEY;
  const apiVersion = process.env.AZURE_VISION_API_VERSION || "v3.2";

  const postTimeoutMsRaw = Number(process.env.AZURE_POST_TIMEOUT_MS);
  const postTimeoutMs = Number.isFinite(postTimeoutMsRaw) && postTimeoutMsRaw > 0 ? postTimeoutMsRaw : 15000;

  const pollMsRaw = Number(process.env.AZURE_POLL_MS);
  const pollMs = Number.isFinite(pollMsRaw) && pollMsRaw > 0 ? pollMsRaw : 1000;

  const pollTimeoutRaw = Number(process.env.AZURE_POLL_TIMEOUT_MS);
  const pollTimeoutMs = Number.isFinite(pollTimeoutRaw) && pollTimeoutRaw > 0 ? pollTimeoutRaw : 30000;

  const pollMaxAttemptsRaw = Number.parseInt(process.env.AZURE_POLL_MAX_ATTEMPTS || "30", 10);
  const pollMaxAttempts = Number.isFinite(pollMaxAttemptsRaw) && pollMaxAttemptsRaw > 0 ? pollMaxAttemptsRaw : 30;

  const retryMaxMsRaw = Number(process.env.AZURE_RETRY_MAX_MS);
  const retryMaxMs = Number.isFinite(retryMaxMsRaw) && retryMaxMsRaw > 0 ? retryMaxMsRaw : 60000;

  return {
    endpoint,
    key,
    apiVersion,
    postTimeoutMs,
    pollMs,
    pollTimeoutMs,
    pollMaxAttempts,
    retryMaxMs
  };
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

async function withTimeout(promise, ms, onTimeoutMsg = "Request timed out") {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await promise(ctrl.signal);
  } catch (err) {
    if (ctrl.signal.aborted) {
      const e = new Error(onTimeoutMsg);
      e.status = 504;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

async function countPdfPages(pdfBytes) {
  // Minimal parse just to read page count; throws if encrypted/invalid
  const doc = await PDFDocument.load(pdfBytes);
  return doc.getPageCount();
}

async function ocrWithOpenAI({ mime, data }) {
  if (!OPENAI_API_KEY) throw Object.assign(new Error("OPENAI_API_KEY missing"), { status: 500 });
  const client = new OpenAI({ apiKey: OPENAI_API_KEY });
  const started = Date.now();

  // Build data URL for Responses API
  const dataUrl = `data:${mime};base64,${data.toString("base64")}`;

  // Use withTimeout helper so we return 504 on timeouts (as documented)
  const run = async (signal) => {
    const resp = await client.responses.create(
      {
        model: OPENAI_VISION_MODEL, // default set above; keep override support
        temperature: 0,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Extract the exact text from this image. Return only the raw text. No commentary." },
              { type: "input_image", image_url: dataUrl } // spec: string data URL
            ]
          }
        ]
      },
      { signal } // AbortSignal must be the 2nd arg to cancel the HTTP call
    );

    const text = (resp.output_text || "").trim();
    return {
      text,
      pagesOcred: [1],
      meta: { engine: "openai-vision", durationMs: Date.now() - started, source: "ocr" }
    };
  };

  return await withTimeout(run, OPENAI_TIMEOUT_MS, "OpenAI OCR timed out");
}

// ---- optional PDF pre-slicing to enforce maxPages & reduce cost ----
async function preslicePdfIfNeeded(pdfBytes, maxPages) {
  if (!PDF_PRESLICE) {
    return { bytes: pdfBytes, originalPages: undefined, submittedPages: undefined, presliced: false };
  }
  const src = await PDFDocument.load(pdfBytes);
  const total = src.getPageCount();
  const limit = Math.max(1, Math.min(maxPages, total));
  if (limit >= total) {
    return { bytes: pdfBytes, originalPages: total, submittedPages: total, presliced: false };
  }

  const dst = await PDFDocument.create();
  const idxs = Array.from({ length: limit }, (_, i) => i);
  const copied = await dst.copyPages(src, idxs);
  copied.forEach(p => dst.addPage(p));
  const out = await dst.save(); // Uint8Array
  return {
    bytes: Buffer.from(out),
    originalPages: total,
    submittedPages: limit,
    presliced: true
  };
}

async function ocrWithAzurePdf({ data, maxPages, languageHint, requestId }) {
  const {
    endpoint,
    key,
    apiVersion,
    postTimeoutMs,
    pollMs,
    pollTimeoutMs,
    pollMaxAttempts,
    retryMaxMs
  } = getAzureConfig();

  if (!endpoint || !key) {
    throw Object.assign(new Error("Azure Vision endpoint/key missing"), { status: 500 });
  }
  const started = Date.now();

  // Pre-slice (optional)
  const slice = await preslicePdfIfNeeded(data, maxPages);
  const toSend = slice.bytes;

  // Build submit URL with optional language hint; default to readingOrder=natural
  const qs = new URLSearchParams({ readingOrder: "natural" });
  if (languageHint) qs.set("language", languageHint);
  const submitUrl = `${endpoint}/vision/${apiVersion}/read/analyze?${qs.toString()}`;

  // Submit
  const submit = await axios.post(submitUrl, toSend, {
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/pdf"
    },
    timeout: postTimeoutMs,
    maxBodyLength: Infinity,
    validateStatus: s => s === 202
  });

  const opLoc = submit.headers["operation-location"];
  if (!opLoc) throw Object.assign(new Error("Azure Read missing Operation-Location"), { status: 502 });
  const opId = opLoc.split("/").pop();

  // Poll with bounded retries/backoff for transient 429/5xx, honor Retry-After
  const deadline = Date.now() + pollTimeoutMs;
  const maxAttempts = pollMaxAttempts;
  let resultJson = null;
  let attempt = 0;
  let delayMs = pollMs;

  while (attempt < maxAttempts && Date.now() < deadline) {
    if (attempt > 0) {
      await sleep(Math.max(0, delayMs ?? 0));
    }
    attempt++;

    try {
      const poll = await axios.get(
        `${endpoint}/vision/${apiVersion}/read/analyzeResults/${opId}`,
        {
          headers: { "Ocp-Apim-Subscription-Key": key },
          timeout: clamp(Math.max(500, pollMs * 5), 500, pollTimeoutMs),
          validateStatus: () => true
        }
      );

      const httpStatus = poll.status;
      const retryAfterMs = parseRetryAfter(poll.headers["retry-after"]);
      const boundedDelay = retryAfterMs !== null
        ? clamp(retryAfterMs, pollMs, retryMaxMs)
        : pollMs;
      delayMs = boundedDelay;

      // Handle non-200 responses
      if (httpStatus !== 200) {
        // Fail fast for 4xx (except 429) and other non-retryable statuses
        if (httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429) {
          const e = new Error(`Azure poll HTTP ${httpStatus}`);
          e.status = httpStatus;
          e.detail = poll.data;
          throw e;
        }

        // Retry 429 and 5xx with Retry-After support
        if (httpStatus === 429 || httpStatus >= 500) {
          delayMs = boundedDelay;
          continue;
        }

        // Other errors
        const e = new Error(`Azure poll HTTP ${httpStatus}`);
        e.status = httpStatus || 502;
        e.detail = poll.data;
        throw e;
      }

      // HTTP 200 - check operation status
      const st = poll.data?.status;
      if (st === "succeeded") { resultJson = poll.data; break; }
      if (st === "failed") {
        const detailMessage =
          poll.data?.error?.message ??
          poll.data?.analyzeResult?.errors?.[0]?.message ??
          "unknown";
        const azureError = new Error(`Azure Read failed: ${detailMessage}`);
        azureError.status = 502;
        azureError.code = "azure_failed";
        azureError.detail = poll.data;
        throw azureError;
      }
      // notStarted/running → continue polling
      continue;

    } catch (err) {
      if (err && typeof err === "object" && (err.code || err.status)) {
        throw err;
      }
      // Axios errors (network, timeout, etc.)
      if (!err?.response) {
        const networkErr = new Error("Azure Read network error");
        networkErr.status = 502;
        networkErr.detail = err instanceof Error ? err.message : String(err);
        throw networkErr;
      }
      throw err;
    }
  }

  if (!resultJson) {
    if (attempt >= maxAttempts) {
      if (LOG_LEVEL !== "silent") {
        console.error(`Azure Read exceeded poll attempts`, { requestId, opId, attempts: attempt });
      }
      const e = new Error(`Azure Read timed out after ${attempt} polls`);
      e.status = 504;
      e.code = "azure_timeout";
      e.meta = { attempts: attempt };
      e.detail = { opId };
      throw e;
    }
    const timeoutErr = new Error("Azure Read timed out before completion");
    timeoutErr.status = 504;
    timeoutErr.code = "azure_timeout";
    timeoutErr.detail = { opId };
    throw timeoutErr;
  }

  // normalize result
  const analyze = resultJson.analyzeResult || {};
  const pages = analyze.readResults || analyze.pages || [];
  const lines = [];
  const pagesOcred = [];

  pages.forEach((p, idx) => {
    const L = (p.lines || []).map(l => l.text).filter(Boolean);
    if (L.length) { pagesOcred.push(idx + 1); lines.push(L.join("\n")); }
  });

  return {
    text: lines.join("\n\n"),
    pagesOcred,
    meta: {
      engine: "azure-read",
      durationMs: Date.now() - started,
      source: "ocr",
      pdf: {
        presliced: slice.presliced,
        originalPages: slice.originalPages,
        submittedPages: slice.submittedPages
      }
    }
  };
}

// ---- POST /extract ----
app.post("/extract", async (req, res) => {
  // Request-ID passthrough for log correlation
  const requestId = req.get("x-request-id") || crypto.randomUUID();
  res.set("X-Request-ID", requestId);

  try {
    if (!verifySignature(req)) return bad(res, 401, "Invalid signature", { code: "invalid_signature" });

    const { mime, dataBase64, languages, maxPages } = req.body || {};
    if (typeof mime !== "string" || typeof dataBase64 !== "string") {
      return bad(res, 400, "Missing required fields: mime, dataBase64", { code: "missing_fields" });
    }
    const buf = bytesFromBase64Strict(dataBase64);
    if (!buf) return bad(res, 400, "dataBase64 is not valid base64", { code: "invalid_base64" });
    if (buf.length > OCR_MAX_BYTES) return bad(res, 400, "Payload too large", { code: "payload_too_large", maxBytes: OCR_MAX_BYTES });

    // Optional language hint (Azure: wrong code can reduce recall; default to none)
    const languageHint = Array.isArray(languages) ? languages[0]
                        : (typeof languages === "string" ? languages : undefined);

    if (mime.startsWith("image/") && MIN_IMAGE_PX > 0) {
      if (buf.length === 0) {
        return bad(res, 400, "Image is empty or corrupt", { code: "image_too_small", minPixels: MIN_IMAGE_PX });
      }
      let dims;
      try {
        dims = imageSize(buf);
      } catch {
        return bad(res, 400, "Unable to determine image dimensions", { code: "image_inspection_failed" });
      }
      const width = Number(dims?.width ?? 0);
      const height = Number(dims?.height ?? 0);
      if (!width || !height) {
        return bad(res, 400, "Image dimensions missing", { code: "image_inspection_failed" });
      }
      if (width < MIN_IMAGE_PX || height < MIN_IMAGE_PX) {
        return bad(res, 400, `Image too small; minimum is ${MIN_IMAGE_PX}px`, {
          code: "image_too_small",
          width,
          height,
          minPixels: MIN_IMAGE_PX
        });
      }
    }

    if (mime.startsWith("image/")) {
      const out = await ocrWithOpenAI({ mime, data: buf });
      return res.json({ ...out, requestId });
    } else if (mime === "application/pdf") {
      const effMaxPages = coerceMaxPages(maxPages);

      if (!PDF_PRESLICE && PDF_SOFT_LIMIT) {
        try {
          const pages = await countPdfPages(buf);
          if (pages > effMaxPages) {
            return bad(res, 400, "PDF exceeds page limit", {
              code: "pdf_page_limit",
              pages,
              maxPages: effMaxPages,
              hint: "Enable PDF_PRESLICE=1 to trim before Azure, or increase maxPages/OCR_MAX_PAGES."
            });
          }
        } catch {
          return bad(res, 400, "Unable to inspect PDF page count", {
            code: "pdf_inspection_failed",
            hint: "If the file is encrypted or malformed, enable PDF_PRESLICE=1 or re-export the PDF."
          });
        }
      }

      const out = await ocrWithAzurePdf({ data: buf, maxPages: effMaxPages, languageHint, requestId });
      return res.json({ ...out, requestId });
    } else {
      return bad(res, 415, `Unsupported mime: ${mime}`, { code: "unsupported_mime" });
    }
  } catch (err) {
    const status = err?.status ?? err?.statusCode ?? 500;
    if (LOG_LEVEL !== "silent") {
      console.error(`[${requestId}] OCR error`, { status, code: err?.code, message: err?.message });
    }
    const errorPayload = {
      code: typeof err?.code === "string" ? err.code : String(status),
      httpStatus: status,
      message: "OCR failed",
      requestId
    };
    if (err.meta && typeof err.meta === "object" && err.meta !== null) {
      errorPayload.meta = err.meta;
    }
    return res.status(status).json({ error: errorPayload });
  }
});

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(JSON.stringify({ level: "info", message: "OCR webhook listening", port: PORT }));
  });
}

export default app;
