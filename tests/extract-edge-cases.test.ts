import supertest from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { extractErrorMessage, requireSessionId } from './helpers.js';

import type { Express } from 'express';

// Set env before importing
process.env.NODE_ENV = 'development';  // Set to development to get detailed errors
process.env.CANVAS_BASE_URL = 'https://example.canvas.test';
process.env.CANVAS_TOKEN = 'x';
process.env.DISABLE_HTTP_LISTEN = '1';

// Mock axios
const get = vi.fn<(url: string) => Promise<unknown>>();
const create = vi.fn(() => ({ get }));
const AxiosHeaders = { from: (_: unknown) => ({}) };
vi.mock('axios', () => ({
  default: {
    create,
    get,
    isAxiosError: (e: unknown) => typeof e === 'object' && e !== null && 'isAxiosError' in e,
    AxiosHeaders,
  },
  AxiosHeaders,
}));

let app: Express;

type ToolCallResult = {
  result?: {
    structuredContent?: {
      file?: { contentType?: string };
      blocks?: Array<unknown>;
    };
  };
};

async function initSession(): Promise<string> {
  const res = await supertest(app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json')
    .send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });

  return requireSessionId(res.headers['mcp-session-id']);
}

async function callTool(
  sessionId: string,
  tool: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const res = await supertest(app)
    .post('/mcp')
    .set('Mcp-Session-Id', sessionId)
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json')
    .send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    });

  expect(res.status).toBe(200);
  return res.body as unknown;
}

describe('files/extract edge cases', () => {
  beforeAll(async () => {
    const mod = await import('../src/http.js');
    if (!mod.app) {
      throw new Error('HTTP module did not export app');
    }
    app = mod.app;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('handles missing header + .TXT extension → resolves as text/plain', async () => {
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 101,
            display_name: 'test.TXT',
            filename: 'test.TXT',
            size: 100,
            // content_type missing (undefined)
            url: 'https://files.canvas.example/test',
          },
        });
      }
      // File download - no content-type header
      return Promise.resolve({
        data: Buffer.from('Hello World'),
        headers: {}, // No content-type
      });
    });

    const sid = await initSession();
    const body = (await callTool(sid, 'extract_file', { fileId: 101 })) as ToolCallResult;

    expect(body?.result?.structuredContent?.file?.contentType).toBe('text/plain');
    expect((body?.result?.structuredContent?.blocks?.length ?? 0)).toBeGreaterThan(0);
  });

  it('handles header with charset → accepted after normalization', async () => {
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 102,
            display_name: 'data.csv',
            filename: 'data.csv',
            size: 200,
            content_type: 'text/csv; charset=utf-8',
            url: 'https://files.canvas.example/data',
          },
        });
      }
      return Promise.resolve({
        data: Buffer.from('name,value\ntest,123'),
        headers: { 'content-type': 'text/csv; charset=utf-8' },
      });
    });

    const sid = await initSession();
    const body = (await callTool(sid, 'extract_file', { fileId: 102 })) as ToolCallResult;

    expect(body?.result?.structuredContent?.file?.contentType).toBe('text/csv');
    expect((body?.result?.structuredContent?.blocks?.length ?? 0)).toBeGreaterThan(0);
  });

  it('throws for unknown header + no extension', async () => {
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 103,
            display_name: 'mystery',
            filename: 'mystery', // no extension
            size: 50,
            content_type: 'application/x-unknown-binary',
            url: 'https://files.canvas.example/mystery',
          },
        });
      }
      return Promise.resolve({
        data: Buffer.from('binary data'),
        headers: { 'content-type': 'application/x-unknown-binary' },
      });
    });

    const sid = await initSession();
    const body = await callTool(sid, 'extract_file', { fileId: 103 });

    const errorMessage = extractErrorMessage(body);
    expect(errorMessage).toBeTruthy();
    expect(errorMessage).toMatch(/File 103: content type not allowed/);
  });

  it('throws standardized error for oversized file', async () => {
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 104,
            display_name: 'huge.pdf',
            filename: 'huge.pdf',
            size: 20 * 1024 * 1024, // 20MB > 15MB default limit
            content_type: 'application/pdf',
            url: 'https://files.canvas.example/huge',
          },
        });
      }
      // Should not reach file download due to size check
      return Promise.resolve({
        data: Buffer.from('dummy'),
        headers: { 'content-type': 'application/pdf' },
      });
    });

    const sid = await initSession();
    const body = await callTool(sid, 'extract_file', { fileId: 104 });

    const errorMessage = extractErrorMessage(body);
    expect(errorMessage).toBeTruthy();
    expect(errorMessage).toMatch(/File 104: too large for extraction.*Use download_file instead/);
  });
});
