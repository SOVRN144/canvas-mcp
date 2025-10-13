import axios, { AxiosHeaders } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AxiosInstance, AxiosRequestConfig } from 'axios';

const ORIGINAL_ENV = { ...process.env };

const loadServer = async () => {
  await import('../src/http.js');
};

const getAuthorizationHeader = (headers: unknown): string | undefined => {
  if (!headers) {
    return undefined;
  }
  if (headers instanceof AxiosHeaders) {
    return (
      headers.get?.('Authorization') ??
      headers.get?.('authorization') ??
      headers.get?.('AUTHORIZATION') ??
      undefined
    );
  }
  if (typeof headers === 'object') {
    const dict = headers as Record<string, unknown>;
    for (const key of ['Authorization', 'authorization', 'AUTHORIZATION'] as const) {
      const value = dict[key];
      if (typeof value === 'string') {
        return value;
      }
    }
  }
  return undefined;
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
    let capturedConfig: AxiosRequestConfig | undefined;
    vi.spyOn(axios, 'create').mockImplementation((config?: AxiosRequestConfig) => {
      capturedConfig = config;
      return {
        defaults: { headers: config?.headers ?? undefined },
        get: vi.fn(),
      } as unknown as AxiosInstance;
    });

    await loadServer();

    expect(capturedConfig).toBeTruthy();
    if (!capturedConfig) {
      throw new Error('axios.create was not invoked');
    }
    const authHeader = getAuthorizationHeader(capturedConfig.headers);
    expect(authHeader).toBe('Bearer abc123');
  });
});
