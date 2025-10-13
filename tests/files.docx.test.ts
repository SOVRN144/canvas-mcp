import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { Express } from 'express';

import { findTextContent, requireSessionId } from './helpers.js';

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

// Mock mammoth for DOCX extraction
vi.mock('mammoth', () => ({
  default: {
    extractRawText: async (_: unknown) => ({
      value: 'Document title\n\nThis is extracted DOCX content with multiple paragraphs.\n\nSecond paragraph here.'
    })
  }
}));

let app: Express;

async function initSession(): Promise<string> {
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
  return requireSessionId(res.headers['mcp-session-id']);
}

async function callTool(
  sid: string,
  name: string,
  args: Record<string, unknown> | undefined
) {
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
    const mod = await import('../src/http.js');
    if (!mod.app) {
      throw new Error('HTTP module did not export app');
    }
    app = mod.app;
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
    const preview = findTextContent(body.result.content);
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
