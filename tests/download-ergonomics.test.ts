import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { loadAppWithEnv } from './helpers.js';

const CANVAS = process.env.CANVAS_BASE_URL || 'https://canvas.example.com';

describe('download_file ergonomics', () => {
  let request: any;
  let sessionId: string;

  beforeEach(async () => {
    nock.cleanAll();
    ({ request, sessionId } = await loadAppWithEnv({
      DOWNLOAD_MAX_INLINE_BYTES: String(10 * 1024), // 10KB for test
      CANVAS_BASE_URL: CANVAS,
      CANVAS_TOKEN: 'test-token'
    }));
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('inlines small files with base64 + file content item', async () => {
    const fileId = 7001;

    nock(CANVAS).get(`/api/v1/files/${fileId}`).reply(200, {
      id: fileId, 
      size: 5120, 
      content_type: 'text/plain',
      display_name: 'hello.txt',
      filename: 'hello.txt', 
      url: `${CANVAS}/files/${fileId}/download?download_frd=1&verifier=abc`
    });
    
    nock(CANVAS).get(`/files/${fileId}/download`).query(true)
      .reply(200, 'hello world', { 'Content-Type': 'text/plain' });

    const res = await request
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Mcp-Session-Id', sessionId)
      .send({ 
        jsonrpc: '2.0', 
        id: 2, 
        method: 'tools/call', 
        params: { name: 'download_file', arguments: { fileId } } 
      });

    expect(res.status).toBe(200);
    const file = res.body.result.structuredContent.file;
    expect(file.dataBase64).toBeTruthy();
    expect(nock.isDone()).toBe(true);
  });

  it('returns URL only for large files', async () => {
    const fileId = 7002;

    nock(CANVAS).get(`/api/v1/files/${fileId}`).reply(200, {
      id: fileId, 
      size: 50 * 1024 * 1024, 
      content_type: 'application/pdf',
      display_name: 'large.pdf',
      filename: 'large.pdf', 
      url: `${CANVAS}/files/${fileId}/download?download_frd=1&verifier=big`
    });

    const res = await request
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Mcp-Session-Id', sessionId)
      .send({ 
        jsonrpc: '2.0', 
        id: 3, 
        method: 'tools/call', 
        params: { 
          name: 'download_file', 
          arguments: { 
            fileId,
            maxSize: 100 * 1024 * 1024  // Set higher than file size
          } 
        } 
      });

    expect(res.status).toBe(200);
    const file = res.body.result.structuredContent.file;
    expect(file.url).toMatch(/^https:\/\/canvas\.example\.com\/files\/\d+\/download/);
    expect(file.dataBase64).toBeUndefined();

    const items = res.body.result.content || [];
    expect(items.find((x: any) => x.type === 'file')).toBeUndefined();
    expect(nock.isDone()).toBe(true);
  });
});
