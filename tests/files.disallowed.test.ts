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

describe('files/extract disallowed types', () => {
  beforeAll(async () => {
    const mod = await import('../src/http');
    app = (mod as any).app ?? (mod as any).default ?? mod;
  });

  it('rejects ZIP files with standardized error', async () => {
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 999,
            display_name: 'archive.zip',
            filename: 'archive.zip',
            size: 1024,
            content_type: 'application/zip',
            url: 'https://files.canvas.example/zip',
          },
        });
      }
      return Promise.resolve({
        data: Buffer.from('fake-zip-binary'),
        headers: { 'content-type': 'application/zip' },
      });
    });

    const sid = await initSession();
    const body = await callTool(sid, 'extract_file', { fileId: 999 });

    expect(body?.error).toBeTruthy();
    expect(body.error.message).toMatch(/File 999: content type not allowed \(application\/zip\)/);
  });

  it('rejects video files with standardized error', async () => {
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 888,
            display_name: 'lecture.mp4',
            filename: 'lecture.mp4',
            size: 5120,
            content_type: 'video/mp4',
            url: 'https://files.canvas.example/video',
          },
        });
      }
      return Promise.resolve({
        data: Buffer.from('fake-video-binary'),
        headers: { 'content-type': 'video/mp4' },
      });
    });

    const sid = await initSession();
    const body = await callTool(sid, 'extract_file', { fileId: 888 });

    expect(body?.error).toBeTruthy();
    expect(body.error.message).toMatch(/File 888: content type not allowed \(video\/mp4\)/);
  });

  it('rejects image files with standardized error', async () => {
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 777,
            display_name: 'diagram.png',
            filename: 'diagram.png',
            size: 2048,
            content_type: 'image/png',
            url: 'https://files.canvas.example/image',
          },
        });
      }
      return Promise.resolve({
        data: Buffer.from('fake-png-binary'),
        headers: { 'content-type': 'image/png' },
      });
    });

    const sid = await initSession();
    const body = await callTool(sid, 'extract_file', { fileId: 777 });

    expect(body?.error).toBeTruthy();
    expect(body.error.message).toMatch(/File 777: content type not allowed \(image\/png\)/);
  });
});