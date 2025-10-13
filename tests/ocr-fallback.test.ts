import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callTool,
  createAxiosMockSuite,
  extractErrorMessage,
  loadAppWithEnv,
  LoadedAppContext,
} from './helpers.js';

vi.mock('pdf-parse', () => ({
  default: (_buf: Buffer) => Promise.resolve({ text: '' }),
}));

const axiosMocks = createAxiosMockSuite();
let context: LoadedAppContext | undefined;

describe('extract_file OCR', () => {
  beforeEach(async () => {
    axiosMocks.reset();
    axiosMocks.install();

    context = await loadAppWithEnv({
      NODE_ENV: 'development',
      OCR_PROVIDER: 'webhook',
      OCR_WEBHOOK_URL: 'https://ocr.example.com/extract',
      CANVAS_BASE_URL: 'https://canvas.example.com',
      CANVAS_TOKEN: 'test-token',
    });
  });

  afterEach(() => {
    context?.restoreEnv();
    context = undefined;
    axiosMocks.reset();
    vi.restoreAllMocks();
  });

  it('ocr:force triggers webhook', async () => {
    const fileId = 999;
    const pdfBuffer = Buffer.from('%PDF-1.4 mock pdf data');

    axiosMocks.get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: fileId,
            display_name: 'image-scan.pdf',
            filename: 'image-scan.pdf',
            size: pdfBuffer.length,
            content_type: 'application/pdf',
            url: 'https://canvas.example.com/files/999/download?token=abc',
          },
        });
      }
      return Promise.resolve({
        data: pdfBuffer,
        headers: { 'content-type': 'application/pdf' },
      });
    });

    axiosMocks.post.mockResolvedValueOnce({
      data: { text: 'OCR extracted text from image PDF', pagesOcred: [1, 2] },
    });

    const body = await callTool(context!, 'extract_file', {
      fileId,
      ocr: 'force',
      maxChars: 2000,
    });
    const meta = body.result?.structuredContent?.meta as { source?: string; pagesOcred?: number[] } | undefined;
    expect(meta?.source).toMatch(/ocr|mixed/);
    expect(meta?.pagesOcred).toEqual([1, 2]);

    expect(axiosMocks.post).toHaveBeenCalledWith(
      'https://ocr.example.com/extract',
      expect.objectContaining({
        mime: 'application/pdf',
        languages: ['eng'],
        maxPages: 20,
      }),
      expect.any(Object)
    );
  });

  it('ocr:off returns helpful hint for image-only PDF', async () => {
    const fileId = 888;
    const pdfBuffer = Buffer.from('%PDF-1.4 mock pdf data');

    axiosMocks.get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: fileId,
            display_name: 'scan.pdf',
            filename: 'scan.pdf',
            size: pdfBuffer.length,
            content_type: 'application/pdf',
            url: 'https://canvas.example.com/files/888/download?token=xyz',
          },
        });
      }
      return Promise.resolve({
        data: pdfBuffer,
        headers: { 'content-type': 'application/pdf' },
      });
    });

    const body = await callTool(context!, 'extract_file', {
      fileId,
      ocr: 'off',
    });

    const errMsg = extractErrorMessage(body) ?? '';
    expect(errMsg).toMatch(/ocr.*auto.*force|download_file/i);
  });
});
