import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callTool,
  createAxiosMockSuite,
  extractErrorMessage,
  findTextContent,
  loadAppWithEnv,
  LoadedAppContext,
} from './helpers.js';

const axiosMocks = createAxiosMockSuite();
let context: LoadedAppContext | undefined;

describe('files/download (download_file)', () => {
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

  it('returns a base64 attachment when under limit', async () => {
    axiosMocks.get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 777,
            display_name: 'Week1.pptx',
            filename: 'Week1.pptx',
            size: 1024 * 100,
            content_type:
              'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            url: 'https://files.canvas.example/pptx?token=secret',
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

    const body = await callTool(context!, 'download_file', { fileId: 777, maxSize: 1024 * 1024 });

    const file = body?.result?.structuredContent?.file as {
      name?: string;
      dataBase64?: string;
    } | undefined;
    expect(file).toBeTruthy();
    expect(file?.name).toBe('Week1.pptx');
    expect(typeof file?.dataBase64).toBe('string');
    expect(file?.dataBase64?.length ?? 0).toBeGreaterThan(0);

    const text = findTextContent(body?.result?.content);
    expect(text).toMatch(/Attached file/i);
  });

  it('rejects when file exceeds maxSize', async () => {
    axiosMocks.get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 888,
            display_name: 'Big.pptx',
            filename: 'Big.pptx',
            size: 10 * 1024 * 1024,
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

    const body = await callTool(context!, 'download_file', { fileId: 888, maxSize: 1024 });

    const errorMessage = extractErrorMessage(body);
    expect(errorMessage).toBeTruthy();
    expect(errorMessage).toMatch(/too large|maxSize|extract_file/i);
  });
});
