import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios, { AxiosHeaders } from 'axios';

const ORIGINAL_ENV = { ...process.env };

const loadServer = async () => {
  await import('../src/http');
};

describe('Canvas token sanitization', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, ORIGINAL_ENV);
    process.env.CANVAS_BASE_URL = 'https://example.instructure.com';
    process.env.CANVAS_TOKEN = '  abc123\n';
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, ORIGINAL_ENV);
  });

  it('uses trimmed CANVAS_TOKEN when building Authorization headers', async () => {
    let capturedConfig: any;
    vi.spyOn(axios, 'create').mockImplementation((config?: any) => {
      capturedConfig = config;
      return {
        defaults: { headers: config?.headers ?? undefined },
        get: vi.fn(),
      } as any;
    });

    await loadServer();

    expect(capturedConfig).toBeTruthy();
    const headers = capturedConfig?.headers as AxiosHeaders | Record<string, any> | undefined;
    const authHeader =
      (headers as AxiosHeaders | undefined)?.get?.('Authorization') ??
      (headers as AxiosHeaders | undefined)?.get?.('authorization') ??
      (headers as AxiosHeaders | undefined)?.get?.('AUTHORIZATION') ??
      (headers as Record<string, any> | undefined)?.Authorization ??
      (headers as Record<string, any> | undefined)?.authorization;
    expect(authHeader).toBe('Bearer abc123');
  });
});
