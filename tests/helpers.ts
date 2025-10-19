import axios, { AxiosHeaders } from 'axios';
import type { AxiosInstance, CreateAxiosDefaults } from 'axios';
import type { Express } from 'express';
import supertest from 'supertest';
import type { SuperTest, Test } from 'supertest';
import { expect, vi } from 'vitest';
import { config } from '../src/config.js';

export type ToolCallResult = {
  content?: Array<{ type?: string; text?: string }>;
  result?: {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: {
      file?: {
        id?: number;
        name?: string;
        contentType?: string;
      };
      blocks?: Array<{ type?: string; text?: string }>;
      charCount?: number;
      truncated?: boolean;
      meta?: Record<string, unknown>;
      [key: string]: unknown;
    };
  };
  error?: { message?: string };
};

export type LoadedAppContext = {
  app: Express;
  request: SuperTest<Test>;
  sessionId: string;
  restoreEnv: () => void;
};

const snapshotEnv = (): NodeJS.ProcessEnv => ({ ...process.env });

export async function loadAppWithEnv(
  overrides: Record<string, string> = {}
): Promise<LoadedAppContext> {
  const previousEnv = snapshotEnv();
  const previousDisable = config.disableHttpListen;
  const previousCanvasBaseUrl = config.canvasBaseUrl;
  const previousCanvasToken = config.canvasToken;
  const previousOcrProvider = config.ocrProvider;
  const previousOcrWebhook = config.ocrWebhookUrl;
  const previousOcrWebhookSecret = config.ocrWebhookSecret;
  const nextEnv = { ...previousEnv, DISABLE_HTTP_LISTEN: '1', ...overrides };
  Object.assign(process.env, nextEnv);
  config.disableHttpListen = true;
  if (overrides.CANVAS_BASE_URL) {
    config.canvasBaseUrl = overrides.CANVAS_BASE_URL;
  }
  if (overrides.CANVAS_TOKEN) {
    config.canvasToken = overrides.CANVAS_TOKEN;
  }
  if (overrides.OCR_PROVIDER) {
    config.ocrProvider = overrides.OCR_PROVIDER as typeof config.ocrProvider;
  }
  if (overrides.OCR_WEBHOOK_URL) {
    config.ocrWebhookUrl = overrides.OCR_WEBHOOK_URL;
  }
  if (overrides.OCR_WEBHOOK_SECRET) {
    config.ocrWebhookSecret = overrides.OCR_WEBHOOK_SECRET;
  }

  const httpModule = await import('../src/http.js');
  const { app } = httpModule;
  if (!app) {
    throw new Error('HTTP module did not export an app instance');
  }

  const request = supertest(app);
  const init = await request
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });

  expect(init.status).toBe(200);
  const sessionId = requireSessionId(init.headers['mcp-session-id']);

  const restoreEnv = () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, previousEnv);
    config.disableHttpListen = previousDisable;
    config.canvasBaseUrl = previousCanvasBaseUrl;
    config.canvasToken = previousCanvasToken;
    config.ocrProvider = previousOcrProvider;
    config.ocrWebhookUrl = previousOcrWebhook;
    config.ocrWebhookSecret = previousOcrWebhookSecret;
  };

  return { app, request, sessionId, restoreEnv };
}

type AxiosGetFn = (url: string, config?: unknown) => Promise<unknown>;
type AxiosDataFn = (url: string, data?: unknown, config?: unknown) => Promise<unknown>;

export const createAxiosMockSuite = () => {
  const get = vi.fn<AxiosGetFn>();
  const post = vi.fn<AxiosDataFn>();
  const put = vi.fn<AxiosDataFn>();
  const del = vi.fn<AxiosGetFn>();
  const cloneHeaders = (headers?: Record<string, unknown>) => {
    if (!headers) {
      return Object.create(null) as Record<string, unknown>;
    }
    const clone = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of Object.entries(headers)) {
      Reflect.defineProperty(clone, key, {
        value,
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
    return clone;
  };
  const createHeaders = vi.fn((headers?: Record<string, unknown>) => {
    const instance = new AxiosHeaders();
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        if (Array.isArray(value)) {
          for (const entry of value) {
            if (typeof entry === 'string') {
              instance.set(key, entry);
            }
          }
        } else if (typeof value === 'string') {
          instance.set(key, value);
        } else if (value != null) {
          instance.set(key, String(value));
        }
      }
    }
    return instance;
  });

  const install = () => {
    vi.spyOn(axios, 'get').mockImplementation((url: string, config?: unknown) => get(url, config));
    vi.spyOn(axios, 'post').mockImplementation((url: string, data?: unknown, config?: unknown) => post(url, data, config));
    vi.spyOn(axios, 'put').mockImplementation((url: string, data?: unknown, config?: unknown) => put(url, data, config));
    vi.spyOn(axios, 'delete').mockImplementation((url: string, config?: unknown) => del(url, config));
    vi.spyOn(axios, 'create').mockImplementation((config?: CreateAxiosDefaults) => {
      const headersCopy = cloneHeaders(config?.headers as Record<string, unknown> | undefined);
      return {
        defaults: {
          headers: headersCopy,
          baseURL: config?.baseURL ?? '',
        },
        get,
        post,
        put,
        delete: del,
      } as unknown as AxiosInstance;
    });
    vi.spyOn(AxiosHeaders, 'from').mockImplementation((init?: unknown) => createHeaders(init as Record<string, unknown>));
  };

  const reset = () => {
    get.mockReset();
    post.mockReset();
    put.mockReset();
    del.mockReset();
    createHeaders.mockReset();
  };

  return { get, post, put, del, createHeaders, install, reset };
};

export async function callTool(
  context: LoadedAppContext,
  name: string,
  args: Record<string, unknown> | undefined
): Promise<ToolCallResult> {
  const res = await context.request
    .post('/mcp')
    .set('Mcp-Session-Id', context.sessionId)
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json')
    .send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args ?? {} },
    });

  expect(res.status).toBe(200);
  return res.body as ToolCallResult;
}

export function requireSessionId(header: string | string[] | undefined): string {
  if (typeof header === 'string') {
    return header;
  }
  if (Array.isArray(header)) {
    const [first] = header;
    if (typeof first === 'string') {
      return first;
    }
  }
  throw new Error('expected a single Mcp-Session-Id header');
}

export function findTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if ('type' in item && (item as { type?: unknown }).type === 'text') {
      const textValue = (item as { text?: unknown }).text;
      if (typeof textValue === 'string') {
        return textValue;
      }
    }
  }
  return '';
}

export function extractErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const result = (body as { result?: unknown }).result;
  if (result && typeof result === 'object') {
    const structured = result as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    if (structured.isError) {
      const textEntry = structured.content?.[0]?.text;
      if (typeof textEntry === 'string') {
        return textEntry;
      }
    }
  }
  const error = (body as { error?: { message?: unknown } }).error;
  if (error && typeof error.message === 'string') {
    return error.message;
  }
  return undefined;
}
