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

describe('files/extract disallowed types', () => {
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

  it('rejects ZIP files with standardized error', async () => {
    axiosMocks.get.mockImplementation((url: string) => {
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

    const body = await callTool(context!, 'extract_file', { fileId: 999 });
    const errorMessage = extractErrorMessage(body);
    expect(errorMessage).toBeTruthy();
    expect(errorMessage).toMatch(/File 999: content type not allowed/);
    expect(axiosMocks.get).toHaveBeenCalledTimes(1);
  });

  it('rejects video files with standardized error', async () => {
    axiosMocks.get.mockImplementation((url: string) => {
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

    const body = await callTool(context!, 'extract_file', { fileId: 888 });
    const errorMessage = extractErrorMessage(body);
    expect(errorMessage).toBeTruthy();
    expect(errorMessage).toMatch(/File 888: content type not allowed/);
    expect(axiosMocks.get).toHaveBeenCalledTimes(1);
  });

  it('rejects image files with standardized error', async () => {
    axiosMocks.get.mockImplementation((url: string) => {
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

    const body = await callTool(context!, 'extract_file', { fileId: 777 });
    const errorMessage = extractErrorMessage(body);
    expect(errorMessage).toBeTruthy();
    expect(errorMessage).toMatch(/File 777: content type not allowed/);
    expect(axiosMocks.get).toHaveBeenCalledTimes(1);
  });
});
