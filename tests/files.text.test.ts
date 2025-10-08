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
  default: { create, isAxiosError: (e: any) => !!e?.isAxiosError, AxiosHeaders },
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

async function callTool(sid: string, name: string, args: any) {
  const res = await request(app)
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
    const mod = await import('../src/http');
    app = (mod as any).app ?? (mod as any).default ?? mod;
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
    const preview = body.result.content?.find((c: any) => c.type === 'text')?.text || '';
    expect(preview).toContain('[…]');
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
    
    const preview = body.result.content?.find((c: any) => c.type === 'text')?.text || '';
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
    
    const preview = body.result.content?.find((c: any) => c.type === 'text')?.text || '';
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
    
    const preview = body.result.content?.find((c: any) => c.type === 'text')?.text || '';
    expect(preview).toContain('detected by .txt extension');
  });
});