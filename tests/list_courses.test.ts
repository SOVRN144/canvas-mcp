import axios from 'axios';
import type { AxiosError, AxiosInstance } from 'axios';
import type { Express } from 'express';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireSessionId } from './helpers.js';

type AxiosResponseStub = { data: unknown; headers: Record<string, unknown> };
type AxiosInstanceMock = {
  get: ReturnType<typeof vi.fn<(url: string, config?: unknown) => Promise<AxiosResponseStub>>>;
  post: ReturnType<typeof vi.fn<(url: string, config?: unknown) => Promise<AxiosResponseStub>>>;
  put: ReturnType<typeof vi.fn<(url: string, config?: unknown) => Promise<AxiosResponseStub>>>;
  delete: ReturnType<typeof vi.fn<(url: string, config?: unknown) => Promise<AxiosResponseStub>>>;
  interceptors: {
    request: { use: ReturnType<typeof vi.fn<(onFulfilled: unknown, onRejected?: unknown) => void>> };
    response: { use: ReturnType<typeof vi.fn<(onFulfilled: unknown, onRejected?: unknown) => void>> };
  };
  defaults: {
    baseURL: string;
    headers: { common: Record<string, unknown> };
  };
};

describe('list_courses', () => {
  let app: Express;
  let mockAxiosInstance: AxiosInstanceMock;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.CANVAS_BASE_URL = 'https://example.canvas.test';
    process.env.CANVAS_TOKEN = 'x';
    process.env.DISABLE_HTTP_LISTEN = '1';
    
    // Mock axios instance methods
    const viFnAxios = () =>
      vi.fn<(url: string, config?: unknown) => Promise<AxiosResponseStub>>();
    const get = viFnAxios();
    const post = viFnAxios();
    const put = viFnAxios();
    const del = viFnAxios();
    const useRequest = vi.fn<(onFulfilled: unknown, onRejected?: unknown) => void>();
    const useResponse = vi.fn<(onFulfilled: unknown, onRejected?: unknown) => void>();

    mockAxiosInstance = {
      get,
      post,
      put,
      delete: del,
      interceptors: {
        request: { use: useRequest },
        response: { use: useResponse },
      },
      defaults: {
        baseURL: 'https://example.canvas.test',
        headers: { common: {} },
      },
    };

    // Mock axios.create to return our mock instance
    vi.spyOn(axios, 'create').mockImplementation(
      () => mockAxiosInstance as unknown as AxiosInstance
    );
    vi.spyOn(axios, 'isAxiosError').mockImplementation(
      (error: unknown): error is AxiosError =>
        typeof error === 'object' && error !== null && 'isAxiosError' in error
    );

    // Dynamically import after mocking
    const httpModule = await import('../src/http.js');
    if (!httpModule.app) {
      throw new Error('HTTP module did not export app');
    }
    app = httpModule.app;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('should return courses successfully (200)', async () => {
    // Setup successful response
    mockAxiosInstance.get.mockResolvedValueOnce({
      data: [{ id: 1, name: '', course_code: 'C101', short_name: 'Intro' }],
      headers: {}
    });

    // Initialize session
    const init = await supertest(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    
    const sessionId = requireSessionId(init.headers['mcp-session-id']);
    expect(init.status).toBe(200);

    // Call list_courses tool
    const result = await supertest(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .set('Mcp-Session-Id', sessionId)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_courses', arguments: {} } });

    const body = result.body as {
      result?: {
        structuredContent?: { courses?: Array<{ id: number; name: string }> };
      };
    };

    expect(result.status).toBe(200);
    expect(body.result?.structuredContent?.courses).toEqual([{ id: 1, name: 'C101' }]);

    // Verify correct API call
    expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
    expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/v1/courses', {
      params: { per_page: 50, enrollment_type: 'student', enrollment_state: 'active' }
    });
  });

  it('should handle 5xx error', async () => {
    // Setup 5xx error response
    mockAxiosInstance.get.mockRejectedValueOnce({
      isAxiosError: true,
      response: { 
        status: 500, 
        statusText: 'Internal Server Error', 
        data: { errors: [{ message: 'Boom' }] }
      },
      config: { url: '/api/v1/courses' },
      message: 'Request failed with status code 500'
    });

    // Initialize session
    const init = await supertest(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    
    const sessionId = requireSessionId(init.headers['mcp-session-id']);
    expect(init.status).toBe(200);

    // Call list_courses tool and expect error
    const result = await supertest(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .set('Mcp-Session-Id', sessionId)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_courses', arguments: {} } });

    // Verify error response (JSON-RPC error in 200 envelope)
    const body = result.body as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    expect(result.status).toBe(200);
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toMatch(/Canvas/);
  });

  it('should handle non-array response body', async () => {
    // Setup non-array response
    mockAxiosInstance.get.mockResolvedValueOnce({
      data: { message: 'oops' },
      headers: {}
    });

    // Initialize session
    const init = await supertest(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    
    const sessionId = requireSessionId(init.headers['mcp-session-id']);
    expect(init.status).toBe(200);

    // Call list_courses tool and expect error
    const result = await supertest(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .set('Mcp-Session-Id', sessionId)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_courses', arguments: {} } });

    // Verify error response
    const body = result.body as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    expect(result.status).toBe(200);
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toMatch(/Canvas/);
  });
});
