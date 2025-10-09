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

vi.mock('jszip', () => {
  const loadAsync = vi.fn();
  return { default: { loadAsync } };
});

const { default: JSZip } = await import('jszip');

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

// Helper to extract error message from MCP response
function getErrorMessage(body: any): string | undefined {
  // MCP SDK returns errors as result.isError with message in content[0].text
  if (body?.result?.isError && body.result.content?.[0]?.text) {
    return body.result.content[0].text;
  }
  // Fallback for standard JSON-RPC error format
  if (body?.error?.message) {
    return body.error.message;
  }
  return undefined;
}

describe('files/extract PPTX', () => {
  beforeAll(async () => {
    const mod = await import('../src/http');
    app = (mod as any).app ?? (mod as any).default ?? mod;
  });

  it('extracts slide text from PPTX and returns structured blocks', async () => {
    // Mock JSZip to return slides
    const mockZip = {
      files: {
        'ppt/slides/slide1.xml': {
          async: vi.fn().mockResolvedValue('<a:t>Introduction Slide</a:t><a:t>Welcome to the course</a:t><a:t>Key concepts overview</a:t>')
        },
        'ppt/slides/slide2.xml': {
          async: vi.fn().mockResolvedValue('<a:t>Next Slide</a:t>')
        },
      }
    };
    vi.mocked(JSZip.loadAsync).mockResolvedValueOnce(mockZip as any);

    get.mockReset();
    get.mockImplementation((url: string) => {
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
        headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
      });
    });

    const sid = await initSession();
    const body = await callTool(sid, 'extract_file', { fileId: 321, mode: 'slides' });

    expect(body?.result?.structuredContent).toBeTruthy();
    const sc = body.result.structuredContent;

    expect(sc.file.id).toBe(321);
    expect(sc.file.name).toBe('Presentation.pptx');
    expect(sc.charCount).toBeGreaterThan(0);
    expect(Array.isArray(sc.blocks)).toBe(true);
    expect(sc.blocks.length).toBeGreaterThan(0);
    
    // Should have slide structure
    expect(sc.blocks.some((b: any) => b.type === 'heading' && b.text.includes('Slide'))).toBe(true);
  });

  it('handles PPTX with octet-stream content type via extension fallback', async () => {
    const mockZip = {
      files: {
        'ppt/slides/slide1.xml': {
          async: vi.fn().mockResolvedValue('<a:t>Fallback Detection</a:t>')
        }
      }
    };
    vi.mocked(JSZip.loadAsync).mockResolvedValueOnce(mockZip as any);

    get.mockReset();
    get.mockImplementation((url: string) => {
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
        headers: { 'content-type': 'application/octet-stream' }, // Generic type
      });
    });

    const sid = await initSession();
    const body = await callTool(sid, 'extract_file', { fileId: 654 });

    expect(body?.result?.structuredContent?.file?.contentType).toContain('presentationml');
    expect(body.result.structuredContent.blocks.length).toBeGreaterThan(0);
  });

  it('rejects PPTX with too many slides', async () => {
    // Create a mock with over 500 slides using shared mock for performance
    const mockZipWithManySlides = {
      files: {} as Record<string, any>
    };
    
    // Generate 501 slide files with shared mock for speed
    const sharedSlideMock = { async: vi.fn().mockResolvedValue('<a:t>Slide text</a:t>') };
    for (let i = 1; i <= 501; i++) {
      mockZipWithManySlides.files[`ppt/slides/slide${i}.xml`] = sharedSlideMock as any;
    }
    
    vi.mocked(JSZip.loadAsync).mockResolvedValueOnce(mockZipWithManySlides as any);

    get.mockReset();
    get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 999,
            display_name: 'HugePresentation.pptx',
            filename: 'HugePresentation.pptx',
            size: 10240,
            content_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            url: 'https://files.canvas.example/huge',
          },
        });
      }
      return Promise.resolve({
        data: Buffer.from('fake-huge-pptx'),
        headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
      });
    });

    const sid = await initSession();
    const body = await callTool(sid, 'extract_file', { fileId: 999 });

    const errorMessage = getErrorMessage(body);
    expect(errorMessage).toBeTruthy();
    expect(errorMessage).toMatch(/File 999: PPTX file has too many slides \(501 > 500\)/);
  });

  it('respects numeric slide ordering (slide2.xml < slide10.xml)', async () => {
    // Mock zip with slides in non-alphabetical order
    const mockZip = {
      files: {
        'ppt/slides/slide10.xml': {
          async: vi.fn().mockResolvedValue('<a:t>Slide 10</a:t>')
        },
        'ppt/slides/slide2.xml': {
          async: vi.fn().mockResolvedValue('<a:t>Slide 2</a:t>')
        },
        'ppt/slides/slide1.xml': {
          async: vi.fn().mockResolvedValue('<a:t>Slide 1</a:t>')
        }
      }
    };
    vi.mocked(JSZip.loadAsync).mockResolvedValueOnce(mockZip as any);

    get.mockReset();
    get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 777,
            display_name: 'NumericOrder.pptx',
            filename: 'NumericOrder.pptx',
            size: 2048,
            content_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            url: 'https://files.canvas.example/numeric',
          },
        });
      }
      // File download
      return Promise.resolve({
        data: Buffer.from('dummy'),
        headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
      });
    });

    const sid = await initSession();
    const body = await callTool(sid, 'extract_file', { fileId: 777, mode: 'slides' });

    expect(body?.result?.structuredContent).toBeTruthy();
    const blocks = body.result.structuredContent.blocks;
    
    // Should be ordered: slide1, slide2, slide10 (not slide1, slide10, slide2)
    expect(blocks[0].text).toContain('Slide 1');
    expect(blocks[1].text).toContain('Slide 2'); 
    expect(blocks[2].text).toContain('Slide 10');
  });

  it('skips first text run only when title exists', async () => {
    // Test slide with title - should skip first <a:t>
    const slideWithTitle = '<a:t>Title Text</a:t><a:t>Body Text 1</a:t><a:t>Body Text 2</a:t>';
    // Test slide without title - should keep all <a:t>
    const slideWithoutTitle = '<a:t>Body Text 1</a:t><a:t>Body Text 2</a:t>';
    
    const mockZip = {
      files: {
        'ppt/slides/slide1.xml': {
          async: vi.fn().mockResolvedValue(slideWithTitle)
        },
        'ppt/slides/slide2.xml': {
          async: vi.fn().mockResolvedValue(slideWithoutTitle)
        }
      }
    };
    vi.mocked(JSZip.loadAsync).mockResolvedValueOnce(mockZip as any);

    get.mockReset();
    get.mockImplementation((url: string) => {
      if (/\/api\/v1\/files\/\d+/.test(url)) {
        return Promise.resolve({
          data: {
            id: 888,
            display_name: 'ConditionalSkip.pptx',
            filename: 'ConditionalSkip.pptx', 
            size: 1024,
            content_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            url: 'https://files.canvas.example/conditional',
          },
        });
      }
      return Promise.resolve({
        data: Buffer.from('dummy'),
        headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
      });
    });

    const sid = await initSession();
    const body = await callTool(sid, 'extract_file', { fileId: 888, mode: 'slides' });

    expect(body?.result?.structuredContent).toBeTruthy();
    const blocks = body.result.structuredContent.blocks;
    
    // Slide 1 with title: heading should use title, paragraph should have body texts
    expect(blocks[0].text).toBe('Slide 1 — Title Text');
    expect(blocks[1].text).toContain('Body Text 1 Body Text 2');
    
    // Slide 2 without title: heading generic, paragraph should have ALL texts
    expect(blocks[2].text).toBe('Slide 2');
    expect(blocks[3].text).toContain('Body Text 1 Body Text 2');
  });
});