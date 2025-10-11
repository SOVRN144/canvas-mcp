import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import request from 'supertest';
import { app } from '../src/http.js';

const CANVAS = process.env.CANVAS_BASE_URL || 'https://canvas.example.com';

describe('download_file ergonomics', () => {
  let sessionId: string;

  beforeEach(async () => {
    nock.cleanAll();
    process.env.DOWNLOAD_MAX_INLINE_BYTES = String(10 * 1024); // 10KB for testing
    
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
    delete process.env.DOWNLOAD_MAX_INLINE_BYTES;
  });

  it('inlines small files with base64 + file content item', async () => {
    const smallContent = Buffer.from('Hello, this is a small text file!');
    
    nock(CANVAS)
      .get('/api/v1/files/111')
      .reply(200, {
        id: 111,
        display_name: 'small.txt',
        filename: 'small.txt',
        size: smallContent.length,
        content_type: 'text/plain',
        url: 'https://canvas.example.com/files/111/download',
      });

    nock('https://canvas.example.com')
      .get('/files/111/download')
      .reply(200, smallContent);

    const response = await request(app)
      .post('/mcp')
      .set('Mcp-Session-Id', sessionId)
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'download_file',
          arguments: {
            fileId: 111,
          },
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.result).toBeDefined();
    expect(response.body.result.structuredContent.file.dataBase64).toBeDefined();
    expect(response.body.result.content[0].type).toBe('file');
    expect(response.body.result.content[0].data).toBe(smallContent.toString('base64'));
    expect(nock.isDone()).toBe(true);
  });

  it('returns URL only for large files', async () => {
    const largeSize = 50 * 1024 * 1024; // 50MB
    
    nock(CANVAS)
      .get('/api/v1/files/222')
      .reply(200, {
        id: 222,
        display_name: 'large-video.mp4',
        filename: 'large-video.mp4',
        size: largeSize,
        content_type: 'video/mp4',
        url: 'https://canvas.example.com/files/222/download?token=secret123',
      });

    const response = await request(app)
      .post('/mcp')
      .set('Mcp-Session-Id', sessionId)
      .send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'download_file',
          arguments: {
            fileId: 222,
          },
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.result).toBeDefined();
    expect(response.body.result.structuredContent.file.url).toBeDefined();
    expect(response.body.result.structuredContent.file.dataBase64).toBeUndefined();
    expect(response.body.result.content[0].type).toBe('text');
    expect(response.body.result.content[0].text).toMatch(/via URL/i);
    expect(nock.isDone()).toBe(true);
  });
});
