import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { hmacHeader, performOcr } from '../src/ocr.js';
import { createAxiosMockSuite } from './helpers.js';

const axiosMocks = createAxiosMockSuite();

const snapshotEnv = (): NodeJS.ProcessEnv => ({ ...process.env });

const restoreEnv = (snapshot: NodeJS.ProcessEnv) => {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
};

describe('OCR webhook signing', () => {
  let envSnapshot: NodeJS.ProcessEnv;
  let previousProvider: typeof config.ocrProvider;
  let previousUrl: string;
  let previousSecret: string;

  beforeEach(() => {
    axiosMocks.reset();
    axiosMocks.install();
    envSnapshot = snapshotEnv();
    previousProvider = config.ocrProvider;
    previousUrl = config.ocrWebhookUrl;
    previousSecret = config.ocrWebhookSecret ?? '';
    config.ocrProvider = 'webhook';
    config.ocrWebhookUrl = 'https://ocr.test/extract';
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    config.ocrProvider = previousProvider;
    config.ocrWebhookUrl = previousUrl;
    config.ocrWebhookSecret = previousSecret;
    axiosMocks.reset();
    vi.restoreAllMocks();
  });

  it('produces deterministic HMAC header', () => {
    const secret = 'dev-secret-123456';
    const body = JSON.stringify({ mime: 'image/png', dataBase64: 'dGVzdA==' });
    expect(hmacHeader(secret, body)).toBe(
      'sha256=7541c53e5ead0167efb8def4dd4e40b6a8599aa4cbd715a9638e19ff10bc2c82'
    );
  });

  it('posts literal body and signature when secret present', async () => {
    process.env.OCR_WEBHOOK_SECRET = 'dev-secret-123456';
    config.ocrWebhookSecret = 'dev-secret-123456';
    axiosMocks.post.mockResolvedValueOnce({ data: { text: 'ok', pagesOcred: [] } });

    await performOcr({
      mime: 'application/pdf',
      dataBase64: 'ZGF0YQ==',
      languages: ['eng'],
      maxPages: 3,
      requestId: 'req-789',
    });

    expect(axiosMocks.post).toHaveBeenCalledTimes(1);
    const [urlArg, dataArg, configArg] = axiosMocks.post.mock.calls[0] ?? [];
    expect(urlArg).toBe('https://ocr.test/extract');
    expect(typeof dataArg).toBe('string');
    const expectedPayload = {
      mime: 'application/pdf',
      dataBase64: 'ZGF0YQ==',
      languages: ['eng'],
      maxPages: 3,
    };
    expect(dataArg).toBe(JSON.stringify(expectedPayload));
    expect(configArg?.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-Request-ID': 'req-789',
    });
    const signature = configArg?.headers?.['X-Signature'];
    expect(signature).toBe(hmacHeader('dev-secret-123456', dataArg as string));
    expect(configArg?.transformRequest).toBeTruthy();
    expect(Array.isArray(configArg.transformRequest)).toBe(true);
    expect(configArg.transformRequest?.length).toBe(1);
    const transformer = configArg.transformRequest?.[0];
    expect(typeof transformer).toBe('function');
    expect(transformer?.('__test__')).toBe('__test__');
    expect(configArg?.maxBodyLength).toBe(Infinity);
    expect(configArg?.timeout).toBe(config.ocrTimeoutMs);
  });

  it('omits signature when secret missing', async () => {
    delete process.env.OCR_WEBHOOK_SECRET;
    config.ocrWebhookSecret = '';
    axiosMocks.post.mockResolvedValueOnce({ data: { text: '', pagesOcred: [] } });

    await performOcr({
      mime: 'image/png',
      dataBase64: 'ZGVtbw==',
    });

    expect(axiosMocks.post).toHaveBeenCalledTimes(1);
    const [, dataArg, configArg] = axiosMocks.post.mock.calls[0] ?? [];
    expect(dataArg).toBe(JSON.stringify({ mime: 'image/png', dataBase64: 'ZGVtbw==' }));
    expect(configArg?.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(configArg?.headers?.['X-Signature']).toBeUndefined();
    expect(configArg?.transformRequest).toBeTruthy();
    expect(Array.isArray(configArg.transformRequest)).toBe(true);
    expect(configArg.transformRequest?.length).toBe(1);
    const transformer = configArg.transformRequest?.[0];
    expect(typeof transformer).toBe('function');
    expect(transformer?.('payload')).toBe('payload');
    expect(configArg?.maxBodyLength).toBe(Infinity);
    expect(configArg?.timeout).toBe(config.ocrTimeoutMs);
  });
});
