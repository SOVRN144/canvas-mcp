import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import request from 'supertest';
import { app } from '../src/http.js';

const CANVAS = process.env.CANVAS_BASE_URL || 'https://canvas.example.com';

describe('get_assignment', () => {
  let sessionId: string;

  beforeEach(async () => {
    nock.cleanAll();
    
    // Initialize session
    nock(CANVAS).get('/api/v1/courses').query(true).reply(200, []);
    
    const initResponse = await request(app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      });
    
    sessionId = initResponse.headers['mcp-session-id'];
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('returns text (mode:text) with truncation flag', async () => {
    const longDescription = '<p>' + 'a'.repeat(60000) + '</p>';
    
    nock(CANVAS)
      .get('/api/v1/courses/123/assignments/456')
      .reply(200, {
        id: 456,
        name: 'Test Assignment',
        description: longDescription,
        points_possible: 100,
        due_at: '2024-12-31T23:59:59Z',
      });

    const response = await request(app)
      .post('/mcp')
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
    expect(nock.isDone()).toBe(true);
  });

  it('returns sanitized HTML (mode:html)', async () => {
    const dangerousHtml = '<p>Safe content</p><script>alert("xss")</script><p>More content</p>';
    
    nock(CANVAS)
      .get('/api/v1/courses/123/assignments/789')
      .reply(200, {
        id: 789,
        name: 'HTML Assignment',
        description: dangerousHtml,
        points_possible: 50,
        due_at: null,
      });

    const response = await request(app)
      .post('/mcp')
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
    expect(nock.isDone()).toBe(true);
  });
});
