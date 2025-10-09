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

// Mock mammoth for DOCX extraction
vi.mock('mammoth', () => ({
  default: {
    extractRawText: async (_: any) => ({
      value: 'Document title\n\nThis is extracted DOCX content with multiple paragraphs.\n\nSecond paragraph here.'
    })
  }
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

describe('files/extract DOCX', () => {
  beforeAll(async () => {
    const mod = await import('../src/http');
    app = (mod as any).app ?? (mod as any).default ?? mod;
  });

  it('extracts text from DOCX and returns structured blocks', async () => {
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 456,
            display_name: 'Document.docx',
            filename: 'Document.docx',
            size: 2048,
            content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            url: 'https://files.canvas.example/docx',
          },
        });
      }
      // file bytes
      return Promise.resolve({
        data: Buffer.from('fake-docx-binary'),
        headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      });
    });

    const sid = await initSession();
    const body = await callTool(sid, 'extract_file', { fileId: 456, mode: 'text' });

    expect(body?.result?.structuredContent).toBeTruthy();
    const sc = body.result.structuredContent;

    expect(sc.file.id).toBe(456);
    expect(sc.file.name).toBe('Document.docx');
    expect(sc.charCount).toBeGreaterThan(0);
    expect(Array.isArray(sc.blocks)).toBe(true);
    expect(sc.blocks.length).toBeGreaterThan(0);
    
    // Should contain text from mammoth mock
    const preview = body.result.content?.find((c: any) => c.type === 'text')?.text || '';
    expect(preview).toContain('extracted DOCX content');
  });

  it('honors character limit and shows truncation', async () => {
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 789,
            display_name: 'LongDoc.docx',
            filename: 'LongDoc.docx',
            size: 1024,
            content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            url: 'https://files.canvas.example/long',
          },
        });
      }
      return Promise.resolve({
        data: Buffer.from('fake-long-docx'),
        headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      });
    });

    const sid = await initSession();
    const body = await callTool(sid, 'extract_file', { fileId: 789, maxChars: 50 });

    expect(body?.result?.structuredContent?.truncated).toBe(true);
    expect(body.result.structuredContent.charCount).toBeLessThanOrEqual(50);
  });
});