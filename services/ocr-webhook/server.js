import express from "express";
import crypto from "crypto";
import morgan from "morgan";
import axios from "axios";
import OpenAI from "openai";
import { PDFDocument } from "pdf-lib";

// ---- env & defaults ----
const PORT = process.env.PORT || 8080;
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4o";
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 60000);

const AZURE_VISION_ENDPOINT = (process.env.AZURE_VISION_ENDPOINT || "").replace(/\/+$/, "");
const AZURE_VISION_KEY = process.env.AZURE_VISION_KEY;
const AZURE_VISION_API_VERSION = process.env.AZURE_VISION_API_VERSION || "v3.2";
const AZURE_POST_TIMEOUT_MS = Number(process.env.AZURE_POST_TIMEOUT_MS || 15000);
const AZURE_POLL_MS = Number(process.env.AZURE_POLL_MS || 1500);
const AZURE_POLL_TIMEOUT_MS = Number(process.env.AZURE_POLL_TIMEOUT_MS || 30000);
const AZURE_RETRY_MAX = Number(process.env.AZURE_RETRY_MAX || 5);
const AZURE_RETRY_BASE_MS = Number(process.env.AZURE_RETRY_BASE_MS || 400);
const AZURE_RETRY_JITTER_MS = Number(process.env.AZURE_RETRY_JITTER_MS || 250);
const AZURE_RETRY_MAX_MS = Number(process.env.AZURE_RETRY_MAX_MS || 60000);

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
app.use(morgan("tiny"));

// health
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// readiness (presence booleans only — no secret values)
app.get("/ready", (_req, res) => {
  res.json({
    ok: true,
    openai: Boolean(OPENAI_API_KEY),
    azure: Boolean(AZURE_VISION_ENDPOINT && AZURE_VISION_KEY),
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

function backoffMs(attempt) {
  const base = AZURE_RETRY_BASE_MS * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * AZURE_RETRY_JITTER_MS);
  return base + jitter;
}

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

async function ocrWithAzurePdf({ data, maxPages, languageHint }) {
  if (!AZURE_VISION_ENDPOINT || !AZURE_VISION_KEY) {
    throw Object.assign(new Error("Azure Vision endpoint/key missing"), { status: 500 });
  }
  const started = Date.now();

  // Pre-slice (optional)
  const slice = await preslicePdfIfNeeded(data, maxPages);
  const toSend = slice.bytes;

  // Build submit URL with optional language hint; default to readingOrder=natural
  const qs = new URLSearchParams({ readingOrder: "natural" });
  if (languageHint) qs.set("language", languageHint);
  const submitUrl = `${AZURE_VISION_ENDPOINT}/vision/${AZURE_VISION_API_VERSION}/read/analyze?${qs.toString()}`;

  // Submit
  const submit = await axios.post(submitUrl, toSend, {
    headers: {
      "Ocp-Apim-Subscription-Key": AZURE_VISION_KEY,
      "Content-Type": "application/pdf"
    },
    timeout: AZURE_POST_TIMEOUT_MS,
    maxBodyLength: Infinity,
    validateStatus: s => s === 202
  });

  const opLoc = submit.headers["operation-location"];
  if (!opLoc) throw Object.assign(new Error("Azure Read missing Operation-Location"), { status: 502 });
  const opId = opLoc.split("/").pop();

  // Poll with bounded retries/backoff for transient 429/5xx, honor Retry-After
  const deadline = Date.now() + AZURE_POLL_TIMEOUT_MS;
  let resultJson = null;
  let attempt = 0;

  while (Date.now() < deadline) {
    await sleep(AZURE_POLL_MS);

    try {
      const poll = await axios.get(
        `${AZURE_VISION_ENDPOINT}/vision/${AZURE_VISION_API_VERSION}/read/analyzeResults/${opId}`,
        {
          headers: { "Ocp-Apim-Subscription-Key": AZURE_VISION_KEY },
          timeout: Math.max(2000, AZURE_POLL_MS),
          validateStatus: () => true
        }
      );

      const httpStatus = poll.status;

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
        if ((httpStatus === 429 || httpStatus >= 500) && attempt < AZURE_RETRY_MAX) {
          const retryAfterMs = parseRetryAfter(poll.headers['retry-after']);
          let delay;
          if (retryAfterMs !== null) {
            delay = clamp(retryAfterMs, AZURE_POLL_MS, AZURE_RETRY_MAX_MS);
          } else {
            delay = backoffMs(attempt);
          }
          attempt++;
          await sleep(delay);
          continue;
        }

        // Exceeded retries or other error
        const e = new Error(`Azure poll HTTP ${httpStatus}`);
        e.status = httpStatus || 502;
        e.detail = poll.data;
        throw e;
      }

      // HTTP 200 - check operation status
      const st = poll.data?.status;
      if (st === "succeeded") { resultJson = poll.data; break; }
      if (st === "failed") {
        const e = new Error("Azure Read failed");
        e.status = 502;
        e.detail = poll.data;
        throw e;
      }
      // notStarted/running → continue polling
      continue;

    } catch (err) {
      // Axios errors (network, timeout, etc.)
      if (!err.response) {
        throw Object.assign(new Error("Azure Read network error"), { status: 502, detail: err.message });
      }
      // Re-throw errors we've already handled above
      throw err;
    }
  }

  if (!resultJson) throw Object.assign(new Error("Azure Read timeout"), { status: 408 });

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

      const out = await ocrWithAzurePdf({ data: buf, maxPages: effMaxPages, languageHint });
      return res.json({ ...out, requestId });
    } else {
      return bad(res, 415, `Unsupported mime: ${mime}`, { code: "unsupported_mime" });
    }
  } catch (err) {
    const code = err.status || 500;
    if (LOG_LEVEL !== "silent") {
      console.error(`[${requestId}] OCR error`, { code, message: err.message });
    }
    return res.status(code).json({ error: { code: String(code), httpStatus: code, message: "OCR failed", requestId } });
  }
});

app.listen(PORT, () => {
  console.log(JSON.stringify({ level: "info", message: "OCR webhook listening", port: PORT }));
});
