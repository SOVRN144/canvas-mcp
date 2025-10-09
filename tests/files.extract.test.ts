import { describe, it, beforeAll, expect, vi } from 'vitest';
import request from 'supertest';

// ---- Env must be set BEFORE importing the app ----
process.env.CANVAS_BASE_URL = 'https://example.canvas.test';
process.env.CANVAS_TOKEN = 'x';
process.env.MAX_EXTRACT_MB = '15';

// Mock axios (used by Canvas API + file download)
const get = vi.fn();
const create = vi.fn(() => ({ get }));
const AxiosHeaders = { from: (_: any) => ({}) };
vi.mock('axios', () => ({
  default: { create, get, isAxiosError: (e: any) => !!e?.isAxiosError, AxiosHeaders },
  AxiosHeaders,
}));

// Mock PDF extraction so tests don't depend on real parsers
vi.mock('pdf-parse', () => ({
  default: async (_buf: Buffer) => ({
    text: 'Slide 1: Intro\nAcoustics is the science of sound.',
  }),
}));

// If your implementation uses mammoth/jszip for DOCX/PPTX, you can add mocks here as needed.

let app: any;

// Small helpers
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
  const sid = res.headers['mcp-session-id'];
  expect(sid).toBeTruthy();
  return sid;
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

describe('files/extract (extract_file)', () => {
  beforeAll(async () => {
    // Import after env + mocks are ready
    const mod = await import('../src/http');
    app = (mod as any).app ?? (mod as any).default ?? mod;
  });

  it('extracts text from a PDF (happy path)', async () => {
    // Arrange: first axios GET → file meta; second → file bytes
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 123,
            display_name: 'Week1.pdf',
            filename: 'Week1.pdf',
            size: 1024,
            content_type: 'application/pdf',
            url: 'https://files.canvas.example/abc',
          },
        });
      }
      // file bytes
      return Promise.resolve({
        data: Buffer.from('%PDF-1.4 fake pdf bytes'),
        headers: { 'content-type': 'application/pdf' },
      });
    });

    const sid = await initSession();
    const body = await callTool(sid, 'extract_file', { fileId: 123, mode: 'text' });

    // Assert JSON-RPC result
    expect(body?.result).toBeTruthy();
    expect(body.result.structuredContent).toBeTruthy();
    const sc = body.result.structuredContent;

    expect(sc.file.id).toBe(123);
    expect(sc.file.name).toBe('Week1.pdf');
    expect(sc.charCount).toBeGreaterThan(0);
    expect(Array.isArray(sc.blocks)).toBe(true);
    expect(sc.blocks.length).toBeGreaterThan(0);
    // preview text should be present
    const preview = body.result.content?.find((c: any) => c.type === 'text')?.text || '';
    expect(preview).toContain('Acoustics'); // from our pdf-parse mock
  });

  it('rejects overly large files with a helpful error', async () => {
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 999,
            display_name: 'Huge.pdf',
            filename: 'Huge.pdf',
            size: 50 * 1024 * 1024, // 50 MB
            content_type: 'application/pdf',
            url: 'https://files.canvas.example/big',
          },
        });
      }
      return Promise.resolve({
        data: Buffer.alloc(1), // won't be used
        headers: { 'content-type': 'application/pdf' },
      });
    });

    const sid = await initSession();
    const body = await callTool(sid, 'extract_file', { fileId: 999 });

    expect(body?.error).toBeTruthy();
    expect(String(body.error.message)).toMatch(/too large|extract_file/i);
  });

  it('returns a clear error for unsupported content-types', async () => {
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 55,
            display_name: 'image.png',
            filename: 'image.png',
            size: 2048,
            content_type: 'image/png',
            url: 'https://files.canvas.example/img',
          },
        });
      }
      return Promise.resolve({
        data: Buffer.from([0, 1, 2, 3]),
        headers: { 'content-type': 'image/png' },
      });
    });

    const sid = await initSession();
    const body = await callTool(sid, 'extract_file', { fileId: 55 });

    expect(body?.error).toBeTruthy();
    expect(String(body.error.message)).toMatch(/unsupported|image|download_file/i);
  });
});