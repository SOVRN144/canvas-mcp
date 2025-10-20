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
process.env.AZURE_POLL_TIMEOUT_MS = "100";
process.env.AZURE_POLL_MAX_ATTEMPTS = "2";

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

describe("Azure error mapping", () => {
  beforeEach(() => {
    ax.post.mockReset();
    ax.get.mockReset();
  });

  it("returns 502 when Azure reports failure", async () => {
    ax.post.mockResolvedValueOnce({
      status: 202,
      headers: { "operation-location": "https://azure.example.com/vision/operations/fail" },
    });

    ax.get.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: {
        status: "failed",
        error: { message: "boom" },
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

    expect(response.status).toBe(502);
    expect(response.body.error?.code).toBe("azure_failed");
    expect(response.body.error?.httpStatus).toBe(502);
    expect(response.headers["x-request-id"]).toBeTruthy();

    expect(ax.post).toHaveBeenCalledTimes(1);
    expect(ax.get).toHaveBeenCalledTimes(1);
  });

  it("returns 504 when polling exceeds max attempts", async () => {
    ax.post.mockResolvedValueOnce({
      status: 202,
      headers: { "operation-location": "https://azure.example.com/vision/operations/slow" },
    });

    ax.get.mockResolvedValue({ status: 200, headers: {}, data: { status: "running" } });

    const response = await request(app)
      .post("/extract")
      .set("Content-Type", "application/json")
      .send({
        mime: "application/pdf",
        dataBase64: SAMPLE_PDF_BASE64,
        languages: ["eng"],
        maxPages: 1,
      });

    expect(response.status).toBe(504);
    expect(response.body.error?.code).toBe("azure_timeout");
    expect(response.body.error?.meta?.attempts).toBeGreaterThanOrEqual(2);
    expect(response.headers["x-request-id"]).toBeTruthy();

    expect(ax.post).toHaveBeenCalledTimes(1);
    expect(ax.get.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("returns 502 when Azure submit returns 401 (normalized azure_failed)", async () => {
    ax.post.mockResolvedValueOnce({
      status: 401,
      data: { message: "unauthorized" }
    });

    ax.get.mockResolvedValue({ status: 200, headers: {}, data: {} });

    const response = await request(app)
      .post("/extract")
      .set("Content-Type", "application/json")
      .send({
        mime: "application/pdf",
        dataBase64: SAMPLE_PDF_BASE64
      });

    expect(response.status).toBe(502);
    expect(response.body.error?.code ?? response.body.code).toBe("azure_failed");
    expect(ax.post).toHaveBeenCalledTimes(1);
    expect(ax.get).not.toHaveBeenCalled();
  });
});
