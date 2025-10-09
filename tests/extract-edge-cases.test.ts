import { describe, it, beforeAll, expect, vi } from 'vitest';
import request from 'supertest';

// Set env before importing
process.env.CANVAS_BASE_URL = 'https://example.canvas.test';
process.env.CANVAS_TOKEN = 'x';
process.env.DISABLE_HTTP_LISTEN = '1';

// Mock axios
const get = vi.fn();
const create = vi.fn(() => ({ get }));
const AxiosHeaders = { from: (_: any) => ({}) };
vi.mock('axios', () => ({
  default: { create, get, isAxiosError: (e: any) => !!e?.isAxiosError, AxiosHeaders },
  AxiosHeaders,
}));

let app: any;

async function initSession() {
  const res = await request(app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json')
    .send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });

  return res.headers['mcp-session-id'];
}

async function callTool(sessionId: string, tool: string, args: any) {
  const res = await request(app)
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

  return res.body;
}

describe('files/extract edge cases', () => {
  beforeAll(async () => {
    const mod = await import('../src/http');
    app = (mod as any).app ?? (mod as any).default ?? mod;
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
    const body = await callTool(sid, 'extract_file', { fileId: 101 });

    expect(body?.result?.structuredContent?.file?.contentType).toBe('text/plain');
    expect(body.result.structuredContent.blocks.length).toBeGreaterThan(0);
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
    const body = await callTool(sid, 'extract_file', { fileId: 102 });

    expect(body?.result?.structuredContent?.file?.contentType).toBe('text/csv');
    expect(body.result.structuredContent.blocks.length).toBeGreaterThan(0);
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

    expect(body?.error).toBeTruthy();
    expect(body.error.message).toMatch(/File 103: content type not allowed/);
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

    expect(body?.error).toBeTruthy();
    expect(body.error.message).toMatch(/File 104: too large for extraction.*Use download_file instead/);
  });
});