import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requireSessionId } from './helpers.js';

import type { Express } from 'express';

// Mock axios before importing app
const get = vi.fn<(url: string, config?: unknown) => Promise<unknown>>();
const post = vi.fn<(url: string, data?: unknown) => Promise<unknown>>();
const create = vi.fn(() => ({ get, post }));
const AxiosHeaders = { from: (_: unknown) => ({}) };

vi.mock('axios', () => ({
  default: {
    create,
    get,
    post,
    isAxiosError: (e: unknown) => typeof e === 'object' && e !== null && 'isAxiosError' in e,
    AxiosHeaders,
  },
  AxiosHeaders,
}));

let app: Express;
let sessionId: string;

describe('get_assignment', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    
    // Set env before importing app
    process.env.NODE_ENV = 'development';  // Set to development to get detailed errors
    process.env.CANVAS_BASE_URL = 'https://canvas.example.com';
    process.env.CANVAS_TOKEN = 'test-token';
    
    // Re-import app fresh
    vi.resetModules();
    const httpModule = await import('../src/http.js');
    if (!httpModule.app) {
      throw new Error('HTTP module did not export app');
    }
    app = httpModule.app;
    
    // Initialize MCP session
    const init = await supertest(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
      });
    
    expect(init.status).toBe(200);
    sessionId = requireSessionId(init.headers['mcp-session-id']);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns text (mode:text) with truncation flag', async () => {
    const longDescription = '<p>' + 'a'.repeat(60000) + '</p>';
    
    get.mockResolvedValueOnce({
      data: {
        id: 456,
        name: 'Test Assignment',
        description: longDescription,
        points_possible: 100,
        due_at: '2024-12-31T23:59:59Z',
      },
    });

    const response = await supertest(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Mcp-Session-Id', sessionId)
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'get_assignment',
          arguments: {
            assignmentId: 456,
            courseId: 123,
            mode: 'text',
            maxChars: 1000,
          },
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.result).toBeDefined();
    expect(response.body.result.structuredContent.assignment.text).toBeDefined();
    expect(response.body.result.structuredContent.assignment.truncated).toBe(true);
    expect(response.body.result.structuredContent.assignment.name).toBe('Test Assignment');
  });

  it('returns sanitized HTML (mode:html)', async () => {
    const dangerousHtml = '<p>Safe content</p><script>alert("xss")</script><p>More content</p>';
    
    get.mockResolvedValueOnce({
      data: {
        id: 789,
        name: 'HTML Assignment',
        description: dangerousHtml,
        points_possible: 50,
        due_at: null,
      },
    });

    const response = await supertest(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Mcp-Session-Id', sessionId)
      .send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'get_assignment',
          arguments: {
            assignmentId: 789,
            courseId: 123,
            mode: 'html',
          },
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.result).toBeDefined();
    const html = response.body.result.structuredContent.assignment.html;
    expect(html).toBeDefined();
    expect(html).not.toContain('<script>');
    expect(html).toContain('Safe content');
  });
});
