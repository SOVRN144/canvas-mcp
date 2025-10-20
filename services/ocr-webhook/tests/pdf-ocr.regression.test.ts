import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  LOG_LEVEL: process.env.LOG_LEVEL,
  AZURE_VISION_ENDPOINT: process.env.AZURE_VISION_ENDPOINT,
  AZURE_VISION_KEY: process.env.AZURE_VISION_KEY,
  AZURE_POLL_MS: process.env.AZURE_POLL_MS,
  AZURE_POLL_TIMEOUT_MS: process.env.AZURE_POLL_TIMEOUT_MS,
  AZURE_POLL_MAX_ATTEMPTS: process.env.AZURE_POLL_MAX_ATTEMPTS,
};

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.AZURE_VISION_ENDPOINT = "https://azure.example.com";
process.env.AZURE_VISION_KEY = "azure-read-key";
process.env.AZURE_POLL_MS = "1";
process.env.AZURE_POLL_TIMEOUT_MS = "200";
process.env.AZURE_POLL_MAX_ATTEMPTS = "4";

vi.mock("morgan", () => {
  const noopFactory = () => (_req, _res, next) => next();
  return Object.assign(noopFactory, { default: noopFactory });
});

vi.mock("axios", () => {
  return {
    default: {
      post: vi.fn(),
      get: vi.fn(),
    },
  };
});

import axios from "axios";
import app from "../server.js";

const ax = vi.mocked(axios, { deep: true });

const SAMPLE_PDF_BASE64 =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMjAwXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0NyA+PgpzdHJlYW0KQlQKL0YxIDE4IFRmCjcyIDEwMCBUZAooQ2FudmFzIE9DUiBTbW9rZSkgVGoKRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzMzggMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MDgKJSVFT0YK";

afterAll(() => {
  Object.entries(originalEnv).forEach(([key, value]) => {
    if (typeof value === "undefined") {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });
});

describe("PDF OCR regression", () => {
  beforeEach(() => {
    ax.post.mockReset();
    ax.get.mockReset();
  });

  it("extracts text from PDF via Azure Read", async () => {
    ax.post.mockResolvedValueOnce({
      status: 202,
      headers: { "operation-location": "https://azure.example.com/vision/operations/abc123" },
    });

    ax.get.mockResolvedValueOnce({ status: 200, headers: {}, data: { status: "running" } });
    ax.get.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: {
        status: "succeeded",
        analyzeResult: {
          pages: [
            {
              lines: [
                { text: "Hello from Azure" },
                { text: "Second line" },
              ],
            },
          ],
        },
      },
    });

    const response = await request(app)
      .post("/extract")
      .set("Content-Type", "application/json")
      .send({
        mime: "application/pdf",
        dataBase64: SAMPLE_PDF_BASE64,
        languages: ["eng"],
        maxPages: 1,
      });

    expect(response.status).toBe(200);
    expect(response.headers["x-request-id"]).toBeTruthy();
    expect(response.body.meta?.engine).toBe("azure-read");
    expect(Array.isArray(response.body.pagesOcred)).toBe(true);
    expect(typeof response.body.text).toBe("string");
    expect(response.body.text.length).toBeGreaterThan(0);

    expect(ax.post).toHaveBeenCalledTimes(1);
    expect(ax.get.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
