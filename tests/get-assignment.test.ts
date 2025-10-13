import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callTool,
  createAxiosMockSuite,
  loadAppWithEnv,
  LoadedAppContext,
} from './helpers.js';

const axiosMocks = createAxiosMockSuite();
let context: LoadedAppContext | undefined;

describe('get_assignment', () => {
  beforeEach(async () => {
    axiosMocks.reset();
    axiosMocks.install();

    context = await loadAppWithEnv({
      NODE_ENV: 'development',
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

  it('returns text (mode:text) with truncation flag', async () => {
    const longDescription = `<p>${'a'.repeat(60000)}</p>`;

    axiosMocks.get.mockResolvedValueOnce({
      data: {
        id: 456,
        name: 'Test Assignment',
        description: longDescription,
        points_possible: 100,
        due_at: '2024-12-31T23:59:59Z',
      },
    });

    const body = await callTool(context!, 'get_assignment', {
      assignmentId: 456,
      courseId: 123,
      mode: 'text',
      maxChars: 1000,
    });

    const assignment = body.result?.structuredContent?.assignment as {
      text?: string;
      truncated?: boolean;
      name?: string;
    };
    expect(assignment?.text).toBeDefined();
    expect(assignment?.truncated).toBe(true);
    expect(assignment?.name).toBe('Test Assignment');
  });

  it('returns sanitized HTML (mode:html)', async () => {
    const dangerousHtml = '<p>Safe content</p><script>alert("xss")</script><p>More content</p>';

    axiosMocks.get.mockResolvedValueOnce({
      data: {
        id: 789,
        name: 'HTML Assignment',
        description: dangerousHtml,
        points_possible: 50,
        due_at: null,
      },
    });

    const body = await callTool(context!, 'get_assignment', {
      assignmentId: 789,
      courseId: 123,
      mode: 'html',
    });

    const assignment = body.result?.structuredContent?.assignment as {
      html?: string;
    };
    expect(assignment?.html).toBeDefined();
    expect(assignment?.html).not.toContain('<script>');
    expect(assignment?.html).toContain('Safe content');
  });
});
