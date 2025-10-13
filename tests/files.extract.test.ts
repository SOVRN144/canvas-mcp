import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callTool,
  createAxiosMockSuite,
  extractErrorMessage,
  findTextContent,
  loadAppWithEnv,
  LoadedAppContext,
} from './helpers.js';

vi.mock('pdf-parse', () => ({
  default: (_buf: Buffer) =>
    Promise.resolve({
      text: 'Slide 1: Intro\nAcoustics is the science of sound. This text is long enough to bypass OCR heuristics.',
    }),
}));

const axiosMocks = createAxiosMockSuite();
let context: LoadedAppContext | undefined;

describe('files/extract (extract_file)', () => {
  beforeEach(async () => {
    axiosMocks.reset();
    axiosMocks.install();

    context = await loadAppWithEnv({
      NODE_ENV: 'development',
      CANVAS_BASE_URL: 'https://example.canvas.test',
      CANVAS_TOKEN: 'x',
      MAX_EXTRACT_MB: '15',
    });
  });

  afterEach(() => {
    context?.restoreEnv();
    context = undefined;
    axiosMocks.reset();
    vi.restoreAllMocks();
  });

  it('extracts text from a PDF (happy path)', async () => {
    axiosMocks.get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 123,
            display_name: 'Week1.pdf',
            filename: 'Week1.pdf',
            size: 1024,
            content_type: 'application/pdf',
            url: 'https://files.canvas.example/abc?token=secret',
          },
        });
      }
      return Promise.resolve({
        data: Buffer.from('%PDF-1.4 fake pdf bytes'),
        headers: { 'content-type': 'application/pdf' },
      });
    });

    const body = await callTool(context!, 'extract_file', { fileId: 123, mode: 'text' });

    const structured = body?.result?.structuredContent;
    expect(structured).toBeTruthy();
    expect(structured?.file?.id).toBe(123);
    expect(structured?.file?.name).toBe('Week1.pdf');
    expect(structured?.charCount).toBeGreaterThan(0);
    expect(Array.isArray(structured?.blocks)).toBe(true);
    const preview = findTextContent(body?.result?.content);
    expect(preview).toContain('Acoustics');
  });

  it('rejects overly large files with a helpful error', async () => {
    axiosMocks.get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 999,
            display_name: 'Huge.pdf',
            filename: 'Huge.pdf',
            size: 50 * 1024 * 1024,
            content_type: 'application/pdf',
            url: 'https://files.canvas.example/big',
          },
        });
      }
      return Promise.resolve({
        data: Buffer.alloc(1),
        headers: { 'content-type': 'application/pdf' },
      });
    });

    const body = await callTool(context!, 'extract_file', { fileId: 999 });

    const errorMessage = extractErrorMessage(body);
    expect(errorMessage).toBeTruthy();
    expect(errorMessage).toMatch(/too large|extract_file/i);
  });

  it('returns a clear error for unsupported content-types', async () => {
    axiosMocks.get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 555,
            display_name: 'notes.exe',
            filename: 'notes.exe',
            size: 2048,
            content_type: 'application/x-msdownload',
            url: 'https://files.canvas.example/exe',
          },
        });
      }
      return Promise.resolve({
        data: Buffer.alloc(0),
        headers: { 'content-type': 'application/octet-stream' },
      });
    });

    const body = await callTool(context!, 'extract_file', { fileId: 555 });
    const errorMessage = extractErrorMessage(body);
    expect(errorMessage).toBeTruthy();
    expect(errorMessage).toMatch(/unsupported|content[-\s]?type/i);
  });
});
