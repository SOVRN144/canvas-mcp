import { createCanvas } from "@napi-rs/canvas";

const PDFJS_MODULE = "pdfjs-dist/legacy/build/pdf.mjs";

class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)));
    const context = canvas.getContext("2d");
    return { canvas, context };
  }

  reset(canvasAndContext, width, height) {
    const { canvas } = canvasAndContext;
    canvas.width = Math.max(1, Math.floor(width));
    canvas.height = Math.max(1, Math.floor(height));
  }

  destroy(canvasAndContext) {
    const { canvas } = canvasAndContext;
    canvas.width = 0;
    canvas.height = 0;
  }
}

function toNumber(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function preslicePdfToPngBuffers(pdfBuffer, opts = {}) {
  const dpi = toNumber(opts.dpi ?? process.env.PRESLICE_DPI, 144);
  const maxPages = toNumber(opts.maxPages ?? process.env.PRESLICE_MAX_PAGES, 5);
  const maxOutputMB = toNumber(opts.maxOutputMB ?? process.env.PRESLICE_MAX_OUTPUT_MB, 64);

  let pdfjs;
  try {
    pdfjs = await import(PDFJS_MODULE);
  } catch (e) {
    const err = new Error("pdfjs-dist not available");
    err.code = "preslice_missing_dep";
    err.status = 501;
    err.detail = String(e?.message ?? e);
    throw err;
  }

  if (!pdfBuffer || typeof pdfBuffer.length !== "number") {
    const err = new Error("Invalid PDF buffer");
    err.code = "preslice_invalid_input";
    err.status = 400;
    throw err;
  }

  const data = new Uint8Array(pdfBuffer);
  const loadingTask = pdfjs.getDocument({ data, useSystemFonts: true });
  const doc = await loadingTask.promise;

  const scale = Math.max(0.1, dpi / 72);
  const factory = new NodeCanvasFactory();

  const pngBuffers = [];
  let totalBytes = 0;
  const byteLimit = Math.max(1, maxOutputMB) * 1024 * 1024;
  const pageCount = Math.min(doc.numPages, Math.max(1, maxPages));

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });

    const { canvas, context } = factory.create(viewport.width, viewport.height);

    await page.render({
      canvasContext: context,
      viewport,
      canvasFactory: factory
    }).promise;

    const png = canvas.toBuffer("image/png");
    totalBytes += png.length;
    if (totalBytes > byteLimit) {
      const err = new Error(`Preslice output exceeds ${maxOutputMB}MB`);
      err.code = "preslice_output_too_large";
      err.status = 413;
      throw err;
    }

    pngBuffers.push(png);
    factory.destroy({ canvas, context });
  }

  await doc.cleanup();
  await loadingTask.destroy?.();

  return pngBuffers;
}
