import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callTool,
  createAxiosMockSuite,
  findTextContent,
  loadAppWithEnv,
  LoadedAppContext,
} from './helpers.js';

const axiosMocks = createAxiosMockSuite();
let context: LoadedAppContext | undefined;

describe('files/extract plain text', () => {
  beforeEach(async () => {
    axiosMocks.reset();
    axiosMocks.install();

    context = await loadAppWithEnv({
      NODE_ENV: 'development',
      CANVAS_BASE_URL: 'https://example.canvas.test',
      CANVAS_TOKEN: 'x',
    });
  });

  afterEach(() => {
    context?.restoreEnv();
    context = undefined;
    axiosMocks.reset();
    vi.restoreAllMocks();
  });

  it('extracts plain text and handles truncation', async () => {
    const longText = 'This is a very long text file used to test truncation. '.repeat(100);

    axiosMocks.get.mockImplementation((url: string) => {
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

    const body = await callTool(context!, 'extract_file', { fileId: 111, maxChars: 200 });

    const structured = body.result?.structuredContent;
    expect(structured?.file?.id).toBe(111);
    expect(structured?.file?.name).toBe('notes.txt');
    expect(structured?.truncated).toBe(true);
    expect(structured?.charCount).toBeLessThanOrEqual(200);

    const preview = findTextContent(body.result?.content);
    expect(preview).toMatch(/\u2026/);
  });

  it('handles CSV files as text', async () => {
    const csvContent = 'Name,Age,City\nJohn,25,NYC\nJane,30,LA\nBob,35,Chicago';

    axiosMocks.get.mockImplementation((url: string) => {
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

    const body = await callTool(context!, 'extract_file', { fileId: 222 });

    const structured = body.result?.structuredContent;
    expect(structured?.file?.contentType).toBe('text/csv');
    expect(structured?.blocks?.length).toBeGreaterThan(0);

    const preview = findTextContent(body.result?.content);
    expect(preview).toContain('Name,Age,City');
  });

  it('handles content-type with charset parameter', async () => {
    const textContent = 'This is plain text content with UTF-8 encoding.';

    axiosMocks.get.mockImplementation((url: string) => {
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
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    });

    const body = await callTool(context!, 'extract_file', { fileId: 333 });

    const structured = body.result?.structuredContent;
    expect(structured?.file?.contentType).toBe('text/plain');

    const preview = findTextContent(body.result?.content);
    expect(preview).toContain('UTF-8 encoding');
  });

  it('handles undefined content-type header with extension-based detection', async () => {
    const textContent = 'This is a plain text file detected by .txt extension.';

    axiosMocks.get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 444,
            display_name: 'readme.txt',
            filename: 'readme.txt',
            size: textContent.length,
            content_type: 'text/plain',
            url: 'https://files.canvas.example/readme',
          },
        });
      }
      return Promise.resolve({
        data: Buffer.from(textContent),
        headers: { },
      });
    });

    const body = await callTool(context!, 'extract_file', { fileId: 444 });

    const structured = body.result?.structuredContent;
    expect(structured?.file?.contentType).toBe('text/plain');

    const preview = findTextContent(body.result?.content);
    expect(preview).toContain('plain text file');
  });
});
