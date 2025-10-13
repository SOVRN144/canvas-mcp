import supertest from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requireSessionId } from './helpers.js';

import type { Express } from 'express';

// Mock axios before importing app
const get = vi.fn<(url: string, config?: unknown) => Promise<unknown>>();
const post = vi.fn<(url: string, data?: unknown) => Promise<unknown>>();
const create = vi.fn(() => ({ get, post }));
const AxiosHeaders = { from: (_: unknown) => ({}) };

vi.mock('axios', () => ({
  default: {
    create,
    get,
    post,
    isAxiosError: (e: unknown) => typeof e === 'object' && e !== null && 'isAxiosError' in e,
    AxiosHeaders,
  },
  AxiosHeaders,
}));

let app: Express;
let sessionId: string;

describe('download_file ergonomics', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    
    // Set env before importing app
    process.env.NODE_ENV = 'development';  // Set to development to get detailed errors
    process.env.DOWNLOAD_MAX_INLINE_BYTES = String(10 * 1024); // 10KB for test
    process.env.CANVAS_BASE_URL = 'https://canvas.example.com';
    process.env.CANVAS_TOKEN = 'test-token';
    
    // Re-import app fresh
    vi.resetModules();
    const httpModule = await import('../src/http.js');
    if (!httpModule.app) {
      throw new Error('HTTP module did not export app');
    }
    app = httpModule.app;
    
    // Initialize MCP session
    const init = await supertest(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
      });
    
    expect(init.status).toBe(200);
    sessionId = requireSessionId(init.headers['mcp-session-id']);
  });

  it('inlines small files with base64', async () => {
    const fileId = 7001;
    const fileContent = Buffer.from('Hello, this is a small text file!');

    // Mock sequence: metadata fetch, then file download
    get.mockResolvedValueOnce({
      data: {
        id: fileId,
        size: fileContent.length,
        content_type: 'text/plain',
        display_name: 'hello.txt',
        filename: 'hello.txt',
        url: 'https://canvas.example.com/files/7001/download?token=abc',
      },
    });
    
    get.mockResolvedValueOnce({
      data: fileContent,
      headers: { 'content-type': 'text/plain' },
    });

    const res = await supertest(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Mcp-Session-Id', sessionId)
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'download_file', arguments: { fileId } },
      });

    expect(res.status).toBe(200);
    expect(res.body.result).toBeDefined();
    const file = res.body.result.structuredContent.file;
    expect(file.name).toBe('hello.txt');
    expect(file.dataBase64).toBeTruthy();
    expect(file.dataBase64).toBe(fileContent.toString('base64'));
  });

  it('returns URL only for large files', async () => {
    const fileId = 7002;
    const largeSize = 50 * 1024 * 1024; // 50MB

    // Only metadata fetch, no file download
    get.mockResolvedValueOnce({
      data: {
        id: fileId,
        size: largeSize,
        content_type: 'application/pdf',
        display_name: 'large.pdf',
        filename: 'large.pdf',
        url: 'https://canvas.example.com/files/7002/download?token=xyz',
      },
    });

    const res = await supertest(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Mcp-Session-Id', sessionId)
      .send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'download_file',
          arguments: {
            fileId,
            // Don't set maxSize - let it use default, which will be checked against config
          },
        },
      });

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    if (!res.body.result) {
      console.error('Response body:', JSON.stringify(res.body, null, 2));
    }
    expect(res.body.result).toBeDefined();
    const file = res.body.result.structuredContent.file;
    expect(file.url).toMatch(/^https:\/\/canvas\.example\.com\/files\/\d+\/download/);
    expect(file.dataBase64).toBeUndefined();
    expect(file.size).toBe(largeSize);
  });
});
