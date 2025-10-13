import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callTool,
  createAxiosMockSuite,
  extractErrorMessage,
  loadAppWithEnv,
  LoadedAppContext,
} from './helpers.js';

type JsZipMockFile = { async: (type: string) => Promise<string> };
type JsZipMock = { files: Record<string, JsZipMockFile> };

const jsZipLoadAsyncMock = vi.fn<(input: unknown) => Promise<JsZipMock>>();

vi.mock('jszip', () => ({
  default: { loadAsync: jsZipLoadAsyncMock },
}));

const axiosMocks = createAxiosMockSuite();
let context: LoadedAppContext | undefined;

describe('files/extract PPTX', () => {
  beforeEach(async () => {
    axiosMocks.reset();
    axiosMocks.install();
    jsZipLoadAsyncMock.mockReset();

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

  it('extracts slide text from PPTX and returns structured blocks', async () => {
    const mockZip: JsZipMock = {
      files: {
        'ppt/slides/slide1.xml': {
          async: () => Promise.resolve('<a:t>Introduction Slide</a:t><a:t>Welcome to the course</a:t><a:t>Key concepts overview</a:t>'),
        },
        'ppt/slides/slide2.xml': {
          async: () => Promise.resolve('<a:t>Next Slide</a:t>'),
        },
      },
    };
    jsZipLoadAsyncMock.mockResolvedValueOnce(mockZip);

    axiosMocks.get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 321,
            display_name: 'Presentation.pptx',
            filename: 'Presentation.pptx',
            size: 5120,
            content_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            url: 'https://files.canvas.example/pptx',
          },
        });
      }
      return Promise.resolve({
        data: Buffer.from('fake-pptx-binary'),
        headers: {
          'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        },
      });
    });

    const body = await callTool(context!, 'extract_file', { fileId: 321, mode: 'slides' });

    const structured = body.result?.structuredContent;
    expect(structured?.file?.id).toBe(321);
    expect(structured?.file?.name).toBe('Presentation.pptx');
    expect(structured?.charCount).toBeGreaterThan(0);
    expect(structured?.blocks?.length).toBeGreaterThan(0);

    const hasHeading = structured?.blocks?.some((block) => {
      if (!block || typeof block !== 'object') {
        return false;
      }
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate.type === 'heading' && typeof candidate.text === 'string' && candidate.text.includes('Slide');
    });
    expect(hasHeading).toBe(true);
  });

  it('handles PPTX with octet-stream content type via extension fallback', async () => {
    const mockZip: JsZipMock = {
      files: {
        'ppt/slides/slide1.xml': {
          async: () => Promise.resolve('<a:t>Fallback Detection</a:t>'),
        },
      },
    };
    jsZipLoadAsyncMock.mockResolvedValueOnce(mockZip);

    axiosMocks.get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 654,
            display_name: 'Slides.pptx',
            filename: 'Slides.pptx',
            size: 3072,
            content_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            url: 'https://files.canvas.example/slides',
          },
        });
      }
      return Promise.resolve({
        data: Buffer.from('fake-pptx-data'),
        headers: { 'content-type': 'application/octet-stream' },
      });
    });

    const body = await callTool(context!, 'extract_file', { fileId: 654 });

    const structured = body.result?.structuredContent;
    expect(structured?.file?.contentType).toContain('presentationml');
    expect(structured?.blocks?.length).toBeGreaterThan(0);
  });

  it('rejects PPTX with too many slides', async () => {
    const mockZip: JsZipMock = { files: {} };
    const sharedSlide: JsZipMockFile = {
      async: () => Promise.resolve('<a:t>Slide text</a:t>'),
    };
    for (let i = 0; i <= 500; i += 1) {
      mockZip.files[`ppt/slides/slide${i}.xml`] = sharedSlide;
    }
    jsZipLoadAsyncMock.mockResolvedValueOnce(mockZip);

    axiosMocks.get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 987,
            display_name: 'TooManySlides.pptx',
            filename: 'TooManySlides.pptx',
            size: 1024 * 1024,
            content_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            url: 'https://files.canvas.example/toomany',
          },
        });
      }
      return Promise.resolve({
        data: Buffer.from('fake-pptx-overflow'),
        headers: {
          'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        },
      });
    });

    const body = await callTool(context!, 'extract_file', { fileId: 987, mode: 'slides' });
    const errorMessage = extractErrorMessage(body);
    expect(errorMessage).toBeTruthy();
    expect(errorMessage).toMatch(/too many slides/i);
  });
});
