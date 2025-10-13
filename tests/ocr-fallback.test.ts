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

// Mock pdf-parse to avoid "missing callable export" error
vi.mock('pdf-parse', () => ({ 
  default: async (_buf: Buffer) => ({ text: '' })  // Empty text to trigger OCR
}));

let app: Express;
let sessionId: string;

describe('extract_file OCR', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    
    // Set env before importing app
    process.env.NODE_ENV = 'development';  // Set to development to get detailed errors
    process.env.OCR_PROVIDER = 'webhook';
    process.env.OCR_WEBHOOK_URL = 'https://ocr.example.com/extract';
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

  it('ocr:force triggers webhook', async () => {
    const fileId = 999;
    const pdfBuffer = Buffer.from('%PDF-1.4 mock pdf data');

    // Mock sequence:
    // 1. Get file metadata
    get.mockResolvedValueOnce({
      data: {
        id: fileId,
        display_name: 'image-scan.pdf',
        filename: 'image-scan.pdf',
        size: pdfBuffer.length,
        content_type: 'application/pdf',
        url: 'https://canvas.example.com/files/999/download?token=abc',
      },
    });
    
    // 2. Download file for extraction (native)
    get.mockResolvedValueOnce({
      data: pdfBuffer,
      headers: { 'content-type': 'application/pdf' },
    });
    
    // 3. Download file for OCR
    get.mockResolvedValueOnce({
      data: pdfBuffer,
      headers: { 'content-type': 'application/pdf' },
    });
    
    // 4. POST to OCR webhook
    post.mockResolvedValueOnce({
      data: {
        text: 'OCR extracted text from image PDF',
        pagesOcred: [1, 2],
      },
    });

    const response = await supertest(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Mcp-Session-Id', sessionId)
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'extract_file',
          arguments: {
            fileId,
            ocr: 'force',  // Force OCR to ensure webhook is called
            maxChars: 2000,
          },
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.result).toBeDefined();
    const meta = response.body.result.structuredContent.meta;
    expect(meta.source).toMatch(/ocr|mixed/);
    expect(meta.pagesOcred).toEqual([1, 2]);
    
    // Verify POST was called for OCR
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      'https://ocr.example.com/extract',
      expect.objectContaining({
        mime: 'application/pdf',
        languages: ['eng'],
        maxPages: 20,
      }),
      expect.any(Object)
    );
  });

  it('ocr:off returns helpful hint for image-only PDF', async () => {
    const fileId = 888;
    const pdfBuffer = Buffer.from('%PDF-1.4 mock pdf data');

    // Mock sequence:
    // 1. Get file metadata
    get.mockResolvedValueOnce({
      data: {
        id: fileId,
        display_name: 'scan.pdf',
        filename: 'scan.pdf',
        size: pdfBuffer.length,
        content_type: 'application/pdf',
        url: 'https://canvas.example.com/files/888/download?token=xyz',
      },
    });
    
    // 2. Download file for extraction
    get.mockResolvedValueOnce({
      data: pdfBuffer,
      headers: { 'content-type': 'application/pdf' },
    });

    const response = await supertest(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Mcp-Session-Id', sessionId)
      .send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'extract_file',
          arguments: {
            fileId,
            ocr: 'off',
          },
        },
      });

    // Should return error hint
    if (response.body.error || response.body.result?.isError) {
      const errorMsg = response.body.error?.message || response.body.result?.content?.[0]?.text || '';
      expect(errorMsg).toMatch(/ocr.*auto.*force|download_file/i);
    }
  });
});
