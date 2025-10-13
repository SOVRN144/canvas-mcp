/* eslint-disable security/detect-object-injection */
import axios, { AxiosHeaders } from 'axios';
import type { AxiosInstance, CreateAxiosDefaults } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


const ORIGINAL_ENV = { ...process.env };

const loadServer = async () => {
  await import('../src/http.js');
};

const getAuthorizationHeader = (headers: unknown): string | undefined => {
  if (!headers) return undefined;

  const keys = ['Authorization', 'authorization', 'AUTHORIZATION'] as const;
  const findString = (value: unknown): string | undefined => {
    if (typeof value === 'string') {
      return value;
    }
    if (Array.isArray(value)) {
      const firstString = value.find((entry: unknown): entry is string => typeof entry === 'string');
      return firstString;
    }
    return undefined;
  };

  if (headers instanceof AxiosHeaders) {
    for (const key of keys) {
      const value = headers.get?.(key);
      const resolved = findString(value);
      if (resolved) {
        return resolved;
      }
    }
    return undefined;
  }

  if (typeof headers === 'object') {
    const dict = headers as Record<string, unknown>;
    for (const key of keys) {
      const resolved = findString(dict[key]);
      if (resolved) {
        return resolved;
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
    vi.restoreAllMocks();
    vi.resetModules();
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, ORIGINAL_ENV);
  });

  it('uses trimmed CANVAS_TOKEN when building Authorization headers', async () => {
    let capturedConfig: CreateAxiosDefaults | undefined;
    vi.spyOn(axios, 'create').mockImplementation((config?: CreateAxiosDefaults): AxiosInstance => {
      capturedConfig = config;
      return {
        defaults: { headers: config?.headers },
        get: vi.fn(),
        post: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
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
