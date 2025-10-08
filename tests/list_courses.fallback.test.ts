import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import axios from 'axios';

// Mock axios before importing http.ts
vi.mock('axios');
const mockedAxios = vi.mocked(axios);

// Set required env vars before importing
process.env.CANVAS_BASE_URL = 'https://example.canvas.test';
process.env.CANVAS_TOKEN = 'x';
process.env.DISABLE_HTTP_LISTEN = '1';

describe('list_courses fallback behavior', () => {
  let app: any;
  let mockAxiosInstance: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    
    // Mock axios instance methods
    mockAxiosInstance = {
      get: vi.fn(),
      defaults: {
        baseURL: 'https://example.canvas.test'
      }
    };

    // Mock axios.create to return our mock instance
    mockedAxios.create.mockReturnValue(mockAxiosInstance);
    mockedAxios.isAxiosError.mockImplementation((error: any) => !!error?.isAxiosError);

    // Dynamically import after mocking
    const httpModule = await import('../src/http.js');
    app = httpModule.app;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('should fallback when primary 500 → fallback 200 (array)', async () => {
    // Setup mock responses
    mockAxiosInstance.get
      .mockRejectedValueOnce({
        isAxiosError: true,
        response: { 
          status: 500, 
          statusText: 'Internal Server Error', 
          data: { errors: [{ message: 'Boom' }] }
        },
        config: { url: '/api/v1/courses' },
        message: 'Request failed with status code 500'
      })
      .mockResolvedValueOnce({
        data: [{ id: 1, name: '', course_code: 'C101', short_name: 'Intro' }],
        headers: {}
      });

    // Initialize session
    const init = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    
    const sessionId = init.headers['mcp-session-id'];
    expect(sessionId).toBeDefined();
    expect(init.status).toBe(200);

    // Call list_courses tool
    const result = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .set('Mcp-Session-Id', sessionId)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_courses', arguments: {} } });

    // Verify the fallback worked
    expect(result.status).toBe(200);
    expect(result.body.result?.structuredContent?.courses).toHaveLength(1);
    expect(result.body.result?.structuredContent?.courses[0]).toStrictEqual({ id: 1, name: 'C101' });

    // Verify axios get was called twice
    expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
    
    // First call should have enrollment_type filter
    expect(mockAxiosInstance.get).toHaveBeenNthCalledWith(1, '/api/v1/courses', {
      params: { per_page: 50, 'enrollment_type[]': 'student' }
    });
    
    // Second call (fallback) should not have enrollment_type filter
    expect(mockAxiosInstance.get).toHaveBeenNthCalledWith(2, '/api/v1/courses', {
      params: { per_page: 50 }
    });
  });

  it('should fail when primary 500 → fallback 500', async () => {
    // Setup both calls to fail with 500
    const errorResponse = {
      isAxiosError: true,
      response: { 
        status: 500, 
        statusText: 'Internal Server Error', 
        data: { errors: [{ message: 'Boom' }] }
      },
      config: { url: '/api/v1/courses' },
      message: 'Request failed with status code 500'
    };
    
    mockAxiosInstance.get
      .mockRejectedValueOnce(errorResponse)
      .mockRejectedValueOnce(errorResponse);

    // Initialize session
    const init = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    
    const sessionId = init.headers['mcp-session-id'];
    expect(sessionId).toBeDefined();
    expect(init.status).toBe(200);

    // Call list_courses tool and expect it to fail
    const result = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .set('Mcp-Session-Id', sessionId)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_courses', arguments: {} } });

    // Verify the error response
    expect(result.status).toBe(200);
    expect(result.body.result.isError).toBe(true);
    expect(result.body.result.content[0].text).toMatch(/Canvas/);

    // Verify both API calls were attempted
    expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
  });
});