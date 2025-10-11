process.env.NODE_ENV = 'development';  // Set to development to get detailed errors
process.env.CANVAS_BASE_URL = 'https://example.canvas.test';
process.env.CANVAS_TOKEN = 'x';
process.env.DISABLE_HTTP_LISTEN = '1';

import { describe, it, beforeAll, expect, vi } from 'vitest';
import request from 'supertest';

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

// Helper to extract error message from MCP response
function getErrorMessage(body: any): string | undefined {
  // MCP SDK returns errors as result.isError with message in content[0].text
  if (body?.result?.isError && body.result.content?.[0]?.text) {
    return body.result.content[0].text;
  }
  // Fallback for standard JSON-RPC error format
  if (body?.error?.message) {
    return body.error.message;
  }
  return undefined;
}

describe('files/download (download_file)', () => {
  beforeAll(async () => {
    const mod = await import('../src/http');
    app = (mod as any).app ?? (mod as any).default ?? mod;
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
    const text = body.result.content?.find((c: any) => c.type === 'text')?.text || '';
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

    const errorMessage = getErrorMessage(body);
    expect(errorMessage).toBeTruthy();
    expect(errorMessage).toMatch(/too large|maxSize|extract_file/i);
  });
});