import axios, { AxiosHeaders } from 'axios';
import type { AxiosInstance, CreateAxiosDefaults } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config, getSanitizedCanvasToken } from '../src/config.js';
import { getCanvasClient } from '../src/http.js';

const ORIGINAL_TOKEN = config.canvasToken;
const ORIGINAL_BASE_URL = config.canvasBaseUrl;

type AxiosFn = (url: string, config?: unknown) => Promise<unknown>;

const noopAxiosFn: AxiosFn = () => Promise.resolve({});

const extractAuthorization = (headers: unknown): string | undefined => {
  const keys = ['authorization', 'Authorization', 'AUTHORIZATION'];
  const pickString = (value: unknown): string | undefined => {
    if (typeof value === 'string') {
      return value;
    }
    if (Array.isArray(value)) {
      return value.find((entry): entry is string => typeof entry === 'string');
    }
    return undefined;
  };

  if (headers instanceof AxiosHeaders) {
    for (const key of keys) {
      const val = headers.get ? headers.get(key) : undefined;
      const resolved = pickString(val);
      if (resolved) {
        return resolved;
      }
    }
    return undefined;
  }

  if (headers && typeof headers === 'object') {
    const dict = headers as Record<string, unknown>;
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(dict, key)) {
        const resolved = pickString(dict[key]);
        if (resolved) return resolved;
      }
    }
  }
  return undefined;
};

describe('Canvas token sanitization', () => {
  let capturedConfig: CreateAxiosDefaults | undefined;

  beforeEach(() => {
    capturedConfig = undefined;
    process.env.CANVAS_BASE_URL = 'https://example.instructure.com';
    process.env.CANVAS_TOKEN = '  abc123\n';
    config.canvasBaseUrl = 'https://example.instructure.com';
    config.canvasToken = '  abc123\n';

    vi.spyOn(axios, 'create').mockImplementation((defaults?: CreateAxiosDefaults) => {
      capturedConfig = defaults;
      return {
        defaults: { headers: defaults?.headers },
        get: vi.fn<AxiosFn>().mockImplementation(noopAxiosFn),
        post: vi.fn<AxiosFn>().mockImplementation(noopAxiosFn),
        put: vi.fn<AxiosFn>().mockImplementation(noopAxiosFn),
        delete: vi.fn<AxiosFn>().mockImplementation(noopAxiosFn),
      } as unknown as AxiosInstance;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    config.canvasBaseUrl = ORIGINAL_BASE_URL;
    config.canvasToken = ORIGINAL_TOKEN;
    delete process.env.CANVAS_BASE_URL;
    delete process.env.CANVAS_TOKEN;
  });

  it('trims Canvas token before creating the client', () => {
    expect(getSanitizedCanvasToken()).toBe('abc123');

    const client = getCanvasClient();
    expect(client).toBeTruthy();
    expect(capturedConfig).toBeTruthy();
    const auth = extractAuthorization(capturedConfig?.headers);
    expect(auth).toBe('Bearer abc123');
  });
});
