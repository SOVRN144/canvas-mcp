process.env.NODE_ENV = 'development';  // Set to development to get detailed errors
process.env.CANVAS_BASE_URL = 'https://example.canvas.test';
process.env.CANVAS_TOKEN = 'x';
process.env.DISABLE_HTTP_LISTEN = '1';

import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { extractErrorMessage, findTextContent, requireSessionId } from './helpers.js';

import type { Express } from 'express';

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

describe('files/download (download_file)', () => {
  beforeAll(async () => {
    const mod = await import('../src/http.js');
    if (!mod.app) {
      throw new Error('HTTP module did not export app');
    }
    app = mod.app;
  });

  it('returns a base64 attachment when under limit', async () => {
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 777,
            display_name: 'Week1.pptx',
            filename: 'Week1.pptx',
            size: 1024 * 100, // 100 KB
            content_type:
              'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            url: 'https://files.canvas.example/pptx',
          },
        });
      }
      return Promise.resolve({
        data: Buffer.from('fake-pptx-binary'),
        headers: {
          'content-type':
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        },
      });
    });

    const sid = await initSession();
    const body = await callTool(sid, 'download_file', { fileId: 777, maxSize: 1024 * 1024 });

    expect(body?.result?.structuredContent?.file).toBeTruthy();
    const file = body.result.structuredContent.file;
    expect(file.name).toBe('Week1.pptx');
    expect(typeof file.dataBase64).toBe('string');
    expect(file.dataBase64.length).toBeGreaterThan(0);

    // Also expect a human text line
    const text = findTextContent(body.result.content);
    expect(text).toMatch(/Attached file/i);
  });

  it('rejects when file exceeds maxSize', async () => {
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 888,
            display_name: 'Big.pptx',
            filename: 'Big.pptx',
            size: 10 * 1024 * 1024, // 10 MB
            content_type:
              'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            url: 'https://files.canvas.example/bigpptx',
          },
        });
      }
      return Promise.resolve({
        data: Buffer.alloc(10),
        headers: {
          'content-type':
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        },
      });
    });

    const sid = await initSession();
    const body = await callTool(sid, 'download_file', { fileId: 888, maxSize: 1024 }); // 1 KB

    const errorMessage = extractErrorMessage(body);
    expect(errorMessage).toBeTruthy();
    expect(errorMessage).toMatch(/too large|maxSize|extract_file/i);
  });
});
