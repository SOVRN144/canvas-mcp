import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callTool,
  createAxiosMockSuite,
  loadAppWithEnv,
  LoadedAppContext,
} from './helpers.js';

const axiosMocks = createAxiosMockSuite();
let context: LoadedAppContext | undefined;

describe('list_courses', () => {
  beforeEach(async () => {
    axiosMocks.reset();
    axiosMocks.install();
    vi.spyOn(axios, 'isAxiosError').mockImplementation((error: unknown): error is Error => error instanceof Error);

    context = await loadAppWithEnv({
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

  it('returns courses successfully', async () => {
    axiosMocks.get.mockResolvedValueOnce({
      data: [{ id: 1, name: '', course_code: 'C101', short_name: 'Intro' }],
      headers: {},
    });

    const body = await callTool(context!, 'list_courses', {});
    expect(body.result?.structuredContent?.courses).toEqual([{ id: 1, name: 'C101' }]);
    expect(axiosMocks.get).toHaveBeenCalledWith('/api/v1/courses', {
      params: { per_page: 50, enrollment_type: 'student', enrollment_state: 'active' },
    });
  });

  it('handles Canvas 5xx error', async () => {
    axiosMocks.get.mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 500,
        statusText: 'Internal Server Error',
        data: { errors: [{ message: 'Boom' }] },
      },
      config: { url: '/api/v1/courses' },
      message: 'Request failed',
    });

    const body = await callTool(context!, 'list_courses', {});
    expect(body.result?.isError).toBe(true);
  });

  it('handles unexpected response shape', async () => {
    axiosMocks.get.mockResolvedValueOnce({
      data: { message: 'oops' },
      headers: {},
    });

    const body = await callTool(context!, 'list_courses', {});
    expect(body.result?.isError).toBe(true);
  });
});
