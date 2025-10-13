import supertest from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { findTextContent, requireSessionId } from './helpers.js';

import type { Express } from 'express';

// Set env before importing
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
  sid: string,
  name: string,
  args: Record<string, unknown> | undefined
) {
  const res = await supertest(app)
    .post('/mcp')
    .set('Mcp-Session-Id', sid)
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json')
    .send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args ?? {} },
    });
  expect(res.status).toBe(200);
  return res.body;
}

describe('files/extract plain text', () => {
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

  it('extracts plain text and handles truncation', async () => {
    const longText = 'This is a very long text file that will be used to test the truncation functionality. '.repeat(100);
    
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 111,
            display_name: 'notes.txt',
            filename: 'notes.txt',
            size: longText.length,
            content_type: 'text/plain',
            url: 'https://files.canvas.example/txt',
          },
        });
      }
      return Promise.resolve({
        data: Buffer.from(longText),
        headers: { 'content-type': 'text/plain' },
      });
    });

    const sid = await initSession();
    const body = await callTool(sid, 'extract_file', { fileId: 111, maxChars: 200 });

    expect(body?.result?.structuredContent).toBeTruthy();
    const sc = body.result.structuredContent;

    expect(sc.file.id).toBe(111);
    expect(sc.file.name).toBe('notes.txt');
    expect(sc.truncated).toBe(true);
    expect(sc.charCount).toBeLessThanOrEqual(200);
    
    // Should show truncation in content
    const preview = findTextContent(body.result.content);
    expect(preview).toMatch(/[\u2026]/); // Match single ellipsis character
  });

  it('handles CSV files as text', async () => {
    const csvContent = 'Name,Age,City\nJohn,25,NYC\nJane,30,LA\nBob,35,Chicago';
    
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 222,
            display_name: 'data.csv',
            filename: 'data.csv',
            size: csvContent.length,
            content_type: 'text/csv',
            url: 'https://files.canvas.example/csv',
          },
        });
      }
      return Promise.resolve({
        data: Buffer.from(csvContent),
        headers: { 'content-type': 'text/csv' },
      });
    });

    const sid = await initSession();
    const body = await callTool(sid, 'extract_file', { fileId: 222 });

    expect(body?.result?.structuredContent?.file?.contentType).toBe('text/csv');
    expect(body.result.structuredContent.blocks.length).toBeGreaterThan(0);
    
    const preview = findTextContent(body.result.content);
    expect(preview).toContain('Name,Age,City');
  });

  it('handles content-type with charset parameter', async () => {
    const textContent = 'This is plain text content with UTF-8 encoding.';
    
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 333,
            display_name: 'utf8.txt',
            filename: 'utf8.txt',
            size: textContent.length,
            content_type: 'text/plain',
            url: 'https://files.canvas.example/utf8',
          },
        });
      }
      return Promise.resolve({
        data: Buffer.from(textContent),
        headers: { 'content-type': 'text/plain; charset=utf-8' }, // With charset parameter
      });
    });

    const sid = await initSession();
    const body = await callTool(sid, 'extract_file', { fileId: 333 });

    expect(body?.result?.structuredContent?.file?.contentType).toBe('text/plain'); // Normalized (no charset)
    expect(body.result.structuredContent.blocks.length).toBeGreaterThan(0);
    
    const preview = findTextContent(body.result.content);
    expect(preview).toContain('UTF-8 encoding');
  });

  it('handles undefined content-type header with extension-based detection', async () => {
    const textContent = 'This is a plain text file detected by .txt extension.';
    
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 444,
            display_name: 'readme.txt',
            filename: 'readme.txt',
            size: textContent.length,
            content_type: 'text/plain', // Canvas metadata has type
            url: 'https://files.canvas.example/readme',
          },
        });
      }
      return Promise.resolve({
        data: Buffer.from(textContent),
        headers: {}, // No content-type header - will fall back to extension
      });
    });

    const sid = await initSession();
    const body = await callTool(sid, 'extract_file', { fileId: 444 });

    expect(body?.result?.structuredContent?.file?.contentType).toBe('text/plain'); // From extension
    expect(body.result.structuredContent.blocks.length).toBeGreaterThan(0);
    
    const preview = findTextContent(body.result.content);
    expect(preview).toContain('detected by .txt extension');
  });

  it('handles completely missing content-type header with uppercase extension', async () => {
    const textContent = 'Plain text file with uppercase extension handling.';
    
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 555,
            display_name: 'foo.TXT', // Uppercase extension
            filename: 'foo.TXT',
            size: textContent.length,
            // content_type omitted (undefined) to match real Canvas behavior
            url: 'https://files.canvas.example/foo',
          },
        });
      }
      return Promise.resolve({
        data: Buffer.from(textContent),
        headers: {}, // Completely missing content-type header (undefined)
      });
    });

    const sid = await initSession();
    const body = await callTool(sid, 'extract_file', { fileId: 555 });

    // Should resolve via extension normalization: .TXT -> text/plain
    expect(body?.result?.structuredContent?.file?.contentType).toBe('text/plain');
    expect(body.result.structuredContent.blocks.length).toBeGreaterThan(0);
    
    const preview = findTextContent(body.result.content);
    expect(preview).toContain('uppercase extension');
  });
});
