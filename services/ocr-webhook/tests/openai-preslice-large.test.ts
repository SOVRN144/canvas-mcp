import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const LARGE_BUFFER = Buffer.alloc(6_219_172, 1);
const LARGE_BASE64 = LARGE_BUFFER.toString("base64");

const presliceMock = vi.fn();
const openAiCreateMock = vi.fn();

vi.mock("../preslice.js", () => ({
  preslicePdfToPngBuffers: presliceMock
}));

vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      constructor() {
        this.responses = { create: openAiCreateMock };
      }
    }
  };
});

import app from "../server.js";

const ENV_KEYS = [
  "NODE_ENV",
  "LOG_LEVEL",
  "OPENAI_API_KEY",
  "PDF_PRESLICE",
  "PRESLICE_DPI",
  "PRESLICE_MAX_PAGES",
  "PRESLICE_MAX_OUTPUT_MB",
  "AZURE_VISION_ENDPOINT",
  "AZURE_VISION_KEY"
];

const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

afterAll(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (typeof value === "undefined") {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

beforeEach(() => {
  presliceMock.mockReset();
  openAiCreateMock.mockReset();
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "silent";
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.PDF_PRESLICE = "1";
  process.env.PRESLICE_DPI = "96";
  process.env.PRESLICE_MAX_PAGES = "5";
  process.env.PRESLICE_MAX_OUTPUT_MB = "64";
});

describe("OpenAI preslice handling for large PDFs", () => {
  it("processes large base64 payloads with languages hint", async () => {
    presliceMock.mockResolvedValue([Buffer.from("png1"), Buffer.from("png2")]);
    let call = 0;
    openAiCreateMock.mockImplementation(async () => ({ output_text: `page ${++call}` }));

    const res = await request(app)
      .post("/extract")
      .set("Content-Type", "application/json")
      .send({
        mime: "application/pdf",
        dataBase64: LARGE_BASE64,
        languages: ["eng"],
        maxPages: 3
      });

    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).toBeTruthy();
    expect(res.body.meta?.engine).toBe("openai-vision");
    expect(res.body.pagesOcred).toEqual([1, 2]);
    expect(openAiCreateMock).toHaveBeenCalledTimes(2);
    expect(presliceMock).toHaveBeenCalledTimes(1);
  });

  it("returns compact error payload when preslice fails with nested detail", async () => {
    const err = new Error("preslice worker crashed");
    err.status = 502;
    err.code = "preslice_worker_failure";
    err.detail = {
      huge: Array.from({ length: 30 }, (_, i) => ({
        index: i,
        payload: { depth: { value: i } }
      }))
    };
    presliceMock.mockRejectedValueOnce(err);

    const res = await request(app)
      .post("/extract")
      .set("Content-Type", "application/json")
      .send({
        mime: "application/pdf",
        dataBase64: LARGE_BASE64,
        languages: ["eng"],
        maxPages: 3
      });

    expect(res.status).toBe(502);
    expect(res.body.error?.code).toBe("preslice_worker_failure");
    expect(res.body.error?.message).toBe("preslice worker crashed");
    expect(res.body.error?.requestId).toBeTruthy();
    expect(() => JSON.stringify(res.body.error.detail)).not.toThrow();
    expect(Array.isArray(res.body.error.detail?.huge)).toBe(true);
    expect(res.body.error.detail.huge.length).toBeLessThanOrEqual(21);
    expect(res.body.error.detail.huge.at(-1)).toContain("truncated");
    expect(openAiCreateMock).not.toHaveBeenCalled();
  });

  it("rejects invalid base64 input early", async () => {
    const res = await request(app)
      .post("/extract")
      .set("Content-Type", "application/json")
      .send({ mime: "application/pdf", dataBase64: "ZGFYQ@==#", maxPages: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("invalid_base64");
    expect(res.body.error?.requestId).toBeTruthy();
    expect(presliceMock).not.toHaveBeenCalled();
    expect(openAiCreateMock).not.toHaveBeenCalled();
  });

  it("sanitizes Buffer and TypedArray in error detail", async () => {
    const err = Object.assign(new Error("boom"), { status: 500, code: "x" });
    const ta = new Uint8Array(128);
    err.detail = { buf: Buffer.alloc(64), ta, dv: new DataView(ta.buffer) };
    presliceMock.mockRejectedValueOnce(err);

    const res = await request(app)
      .post("/extract")
      .set("Content-Type", "application/json")
      .send({ mime: "application/pdf", dataBase64: LARGE_BASE64, maxPages: 1 });

    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe("x");
    expect(res.body.error?.detail).toBeDefined();
    const detail = res.body.error.detail;
    expect(String(detail.buf)).toMatch(/<Buffer length=\d+>/);
    expect(String(detail.ta)).toMatch(/<Uint8Array length=128>/);
    expect(String(detail.dv)).toMatch(/<DataView length=\d+>/);
  });
});
