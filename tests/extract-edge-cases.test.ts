import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callTool,
  createAxiosMockSuite,
  extractErrorMessage,
  loadAppWithEnv,
  LoadedAppContext,
} from './helpers.js';

const axiosMocks = createAxiosMockSuite();
let context: LoadedAppContext | undefined;

describe('files/extract edge cases', () => {
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

  it('handles missing header with .TXT extension by treating as text/plain', async () => {
    axiosMocks.get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 101,
            display_name: 'test.TXT',
            filename: 'test.TXT',
            size: 100,
            url: 'https://files.canvas.example/test',
          },
        });
      }
      return Promise.resolve({
        data: Buffer.from('Hello World'),
        headers: {},
      });
    });

    const body = await callTool(context!, 'extract_file', { fileId: 101 });
    const structured = body.result?.structuredContent;
    expect(structured?.file?.contentType).toBe('text/plain');
    expect(structured?.blocks?.length).toBeGreaterThan(0);
  });

  it('normalizes charset parameters on content-types', async () => {
    axiosMocks.get.mockImplementation((url: string) => {
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

    const body = await callTool(context!, 'extract_file', { fileId: 102 });
    const structured = body.result?.structuredContent;
    expect(structured?.file?.contentType).toBe('text/csv');
    expect(structured?.blocks?.length).toBeGreaterThan(0);
  });

  it('throws when content-type is unsupported and no extension is present', async () => {
    axiosMocks.get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 103,
            display_name: 'mystery',
            filename: 'mystery',
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

    const body = await callTool(context!, 'extract_file', { fileId: 103 });
    const errorMessage = extractErrorMessage(body);
    expect(errorMessage).toBeTruthy();
    expect(errorMessage).toMatch(/File 103: content type not allowed/);
  });

  it('throws standardized error for oversized file before download', async () => {
    axiosMocks.get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 104,
            display_name: 'huge.pdf',
            filename: 'huge.pdf',
            size: 20 * 1024 * 1024,
            content_type: 'application/pdf',
            url: 'https://files.canvas.example/huge',
          },
        });
      }
      return Promise.resolve({
        data: Buffer.from('dummy'),
        headers: { 'content-type': 'application/pdf' },
      });
    });

    const body = await callTool(context!, 'extract_file', { fileId: 104 });
    const errorMessage = extractErrorMessage(body);
    expect(errorMessage).toBeTruthy();
    expect(errorMessage).toMatch(/too large/);
  });
});
