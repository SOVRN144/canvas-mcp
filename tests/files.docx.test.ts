import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callTool,
  createAxiosMockSuite,
  findTextContent,
  loadAppWithEnv,
  LoadedAppContext,
} from './helpers.js';

vi.mock('mammoth', () => ({
  default: {
    extractRawText: () =>
      Promise.resolve({
        value: 'Document title\n\nThis is extracted DOCX content with multiple paragraphs.\n\nSecond paragraph here.',
      }),
  },
}));

const axiosMocks = createAxiosMockSuite();
let context: LoadedAppContext | undefined;

describe('files/extract DOCX', () => {
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

  it('extracts text content from DOCX', async () => {
    axiosMocks.get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 101,
            display_name: 'Week1.docx',
            filename: 'Week1.docx',
            size: 2048,
            content_type:
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            url: 'https://files.canvas.example/docx',
          },
        });
      }
      return Promise.resolve({
        data: Buffer.from('fake-docx-zip'),
        headers: {
          'content-type':
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
      });
    });

    const body = await callTool(context!, 'extract_file', { fileId: 101, mode: 'text' });

    const structured = body?.result?.structuredContent;
    expect(structured?.file?.name).toBe('Week1.docx');
    expect(structured?.blocks?.length).toBeGreaterThan(0);

    const text = findTextContent(body?.result?.content);
    expect(text).toMatch(/Document title/);
  });

  it('truncates long DOCX content when maxChars is set', async () => {
    axiosMocks.get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 102,
            display_name: 'Essay.docx',
            filename: 'Essay.docx',
            size: 10_000,
            content_type:
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            url: 'https://files.canvas.example/essay',
          },
        });
      }
      return Promise.resolve({
        data: Buffer.from('fake-docx-zip'),
        headers: {
          'content-type':
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
      });
    });

    const body = await callTool(context!, 'extract_file', { fileId: 102, maxChars: 50 });

    const structured = body?.result?.structuredContent;
    expect(structured?.truncated).toBe(true);
    expect((structured?.blocks?.[0]?.text ?? '').length).toBeLessThanOrEqual(50);
  });
});
