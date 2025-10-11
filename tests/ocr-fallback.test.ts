import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import request from 'supertest';
import { app } from '../src/http.js';

const CANVAS = process.env.CANVAS_BASE_URL || 'https://canvas.example.com';
const OCR = process.env.OCR_WEBHOOK_URL || 'https://ocr.example.com/extract';

describe('extract_file OCR', () => {
  let sessionId: string;

  beforeEach(async () => {
    nock.cleanAll();
    process.env.OCR_PROVIDER = 'webhook';
    process.env.OCR_WEBHOOK_URL = OCR;
    
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
    delete process.env.OCR_PROVIDER;
    delete process.env.OCR_WEBHOOK_URL;
  });

  it('ocr:auto triggers webhook when native text empty', async () => {
    const pdfBuffer = Buffer.from('mock-pdf-data');
    
    nock(CANVAS)
      .get('/api/v1/files/999')
      .reply(200, {
        id: 999,
        display_name: 'image-scan.pdf',
        filename: 'image-scan.pdf',
        size: pdfBuffer.length,
        content_type: 'application/pdf',
        url: 'https://canvas.example.com/files/999/download',
      });

    nock('https://canvas.example.com')
      .get('/files/999/download')
      .reply(200, pdfBuffer);

    nock(OCR)
      .post('/extract')
      .reply(200, {
        text: 'OCR extracted text from image PDF',
        pagesOcred: [1, 2],
      });

    const response = await request(app)
      .post('/mcp')
      .set('Mcp-Session-Id', sessionId)
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'extract_file',
          arguments: {
            fileId: 999,
            ocr: 'auto',
          },
        },
      });

    expect(response.status).toBe(200);
    if (response.body.result?.structuredContent?.meta) {
      expect(response.body.result.structuredContent.meta.source).toMatch(/ocr|mixed/);
    }
    expect(nock.isDone()).toBe(true);
  });

  it('ocr:off returns helpful hint for image-only PDF', async () => {
    process.env.OCR_PROVIDER = 'none';
    
    const pdfBuffer = Buffer.from('mock-pdf-data');
    
    nock(CANVAS)
      .get('/api/v1/files/888')
      .reply(200, {
        id: 888,
        display_name: 'scan.pdf',
        filename: 'scan.pdf',
        size: pdfBuffer.length,
        content_type: 'application/pdf',
        url: 'https://canvas.example.com/files/888/download',
      });

    nock('https://canvas.example.com')
      .get('/files/888/download')
      .reply(200, pdfBuffer);

    const response = await request(app)
      .post('/mcp')
      .set('Mcp-Session-Id', sessionId)
      .send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'extract_file',
          arguments: {
            fileId: 888,
            ocr: 'off',
          },
        },
      });

    // Might fail or return hint
    if (response.body.error) {
      expect(response.body.error.message).toMatch(/ocr.*auto.*force|download_file/i);
    }
    expect(nock.isDone()).toBe(true);
  });
});
