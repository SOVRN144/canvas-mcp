import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const SAMPLE_PDF_BASE64 =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMjAwXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0NyA+PgpzdHJlYW0KQlQKL0YxIDE4IFRmCjcyIDEwMCBUZAooQ2FudmFzIE9DUiBTbW9rZSkgVGoKRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzMzggMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MDgKJSVFT0YK";

const OPENAI_CREATE = vi.fn();
vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      constructor() {
        this.responses = { create: OPENAI_CREATE };
      }
    }
  };
});

const AXIOS_STUB = {
  post: vi.fn(),
  get: vi.fn()
};

vi.mock("axios", () => ({ default: AXIOS_STUB }));

const axiosMock = AXIOS_STUB;

const ENV_KEYS = [
  "NODE_ENV",
  "LOG_LEVEL",
  "OPENAI_API_KEY",
  "OPENAI_TIMEOUT_MS",
  "OPENAI_VISION_MODEL",
  "PDF_PRESLICE",
  "PDF_SOFT_LIMIT",
  "PRESLICE_DPI",
  "PRESLICE_MAX_PAGES",
  "PRESLICE_MAX_OUTPUT_MB",
  "AZURE_VISION_ENDPOINT",
  "AZURE_VISION_KEY",
  "AZURE_VISION_API_VERSION",
  "AZURE_POST_TIMEOUT_MS",
  "AZURE_POLL_MS",
  "AZURE_POLL_TIMEOUT_MS",
  "AZURE_POLL_MAX_ATTEMPTS",
  "AZURE_RETRY_MAX_MS"
];

const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));

async function loadApp() {
  vi.resetModules();
  return (await import("../server.js")).default;
}

beforeEach(() => {
  OPENAI_CREATE.mockReset();
  axiosMock.post.mockReset();
  axiosMock.get.mockReset();
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "silent";
});

afterEach(() => {
  vi.clearAllTimers();
});

afterAll(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (typeof value === "undefined") {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("PDF engine routing", () => {
  it("uses OpenAI preslice when PDF_PRESLICE truthy and Azure disabled", async () => {
    process.env.OPENAI_API_KEY = "test-openai";
    process.env.PDF_PRESLICE = "1";
    process.env.PRESLICE_DPI = "96";
    process.env.PRESLICE_MAX_PAGES = "1";
    process.env.PRESLICE_MAX_OUTPUT_MB = "4";
    OPENAI_CREATE.mockImplementation(async () => ({ output_text: "page 1 text" }));

    const app = await loadApp();
    const res = await request(app)
      .post("/extract")
      .set("Content-Type", "application/json")
      .send({ mime: "application/pdf", dataBase64: SAMPLE_PDF_BASE64 });

    expect(res.status).toBe(200);
    expect(res.body.meta?.engine).toBe("openai-vision");
    expect(Array.isArray(res.body.pagesOcred)).toBe(true);
    expect(res.body.pagesOcred.length).toBeGreaterThanOrEqual(1);
    expect(OPENAI_CREATE).toHaveBeenCalledTimes(1);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  it("falls back to OpenAI preslice when Azure missing and PDF_PRESLICE unset", async () => {
    process.env.OPENAI_API_KEY = "test-openai";
    process.env.PRESLICE_DPI = "72";
    process.env.PRESLICE_MAX_PAGES = "1";
    process.env.PRESLICE_MAX_OUTPUT_MB = "4";
    OPENAI_CREATE.mockImplementation(async () => ({ output_text: "fallback text" }));

    const app = await loadApp();
    const res = await request(app)
      .post("/extract")
      .set("Content-Type", "application/json")
      .send({ mime: "application/pdf", dataBase64: SAMPLE_PDF_BASE64 });

    expect(res.status).toBe(200);
    expect(res.body.meta?.engine).toBe("openai-vision");
    expect(OPENAI_CREATE).toHaveBeenCalledTimes(1);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  it("prefers Azure when configured and PDF_PRESLICE disabled", async () => {
    process.env.AZURE_VISION_ENDPOINT = "https://azure.example.com";
    process.env.AZURE_VISION_KEY = "azure-key";
    process.env.PDF_PRESLICE = "0";

    axiosMock.post.mockResolvedValueOnce({
      status: 202,
      headers: { "operation-location": "https://azure.example.com/vision/operations/abc" },
      data: {}
    });
    axiosMock.get.mockResolvedValueOnce({ status: 200, headers: {}, data: { status: "running" } });
    axiosMock.get.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: {
        status: "succeeded",
        analyzeResult: {
          readResults: [
            { lines: [{ text: "Azure text" }] }
          ]
        }
      }
    });

    const app = await loadApp();
    const res = await request(app)
      .post("/extract")
      .set("Content-Type", "application/json")
      .send({ mime: "application/pdf", dataBase64: SAMPLE_PDF_BASE64 });

    expect(res.status).toBe(200);
    expect(res.body.meta?.engine).toBe("azure-read");
    expect(axiosMock.post).toHaveBeenCalledTimes(1);
    expect(OPENAI_CREATE).not.toHaveBeenCalled();
  });

  it("returns 501 when neither Azure nor OpenAI configured", async () => {
    const app = await loadApp();
    const res = await request(app)
      .post("/extract")
      .set("Content-Type", "application/json")
      .send({ mime: "application/pdf", dataBase64: SAMPLE_PDF_BASE64 });

    expect(res.status).toBe(501);
    expect(res.body.error?.code).toBe("no_ocr_engine");
    expect(OPENAI_CREATE).not.toHaveBeenCalled();
    expect(axiosMock.post).not.toHaveBeenCalled();
  });
});
