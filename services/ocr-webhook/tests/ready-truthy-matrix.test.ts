import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const ENV_KEYS = [
  "NODE_ENV",
  "LOG_LEVEL",
  "PDF_PRESLICE",
  "OPENAI_API_KEY",
  "AZURE_VISION_ENDPOINT",
  "AZURE_VISION_KEY"
];

const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));

async function loadApp() {
  vi.resetModules();
  return (await import("../server.js")).default;
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "silent";
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

describe("/ready flag parsing", () => {
  const truthyValues = ["1", "true", "TRUE", "yes", "YES", "on", "On"];

  for (const val of truthyValues) {
    it(`reports pdfPreslice true for PDF_PRESLICE=${val}`, async () => {
      process.env.PDF_PRESLICE = val;
      const app = await loadApp();
      const res = await request(app).get("/ready");
      expect(res.status).toBe(200);
      expect(res.body.pdfPreslice).toBe(true);
    });
  }

  it("reports pdfPreslice false when unset", async () => {
    const app = await loadApp();
    const res = await request(app).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body.pdfPreslice).toBe(false);
  });

  it("reports openai true when key present", async () => {
    process.env.OPENAI_API_KEY = "k";
    const app = await loadApp();
    const res = await request(app).get("/ready");
    expect(res.body.openai).toBe(true);
  });

  it("reports azure true only when endpoint and key present", async () => {
    process.env.AZURE_VISION_ENDPOINT = "https://azure.example.com/";
    process.env.AZURE_VISION_KEY = "";
    let app = await loadApp();
    let res = await request(app).get("/ready");
    expect(res.body.azure).toBe(false);

    process.env.AZURE_VISION_ENDPOINT = "https://azure.example.com/";
    process.env.AZURE_VISION_KEY = "key";
    app = await loadApp();
    res = await request(app).get("/ready");
    expect(res.body.azure).toBe(true);
  });
});
