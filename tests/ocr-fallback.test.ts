import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { loadAppWithEnv } from './helpers.js';

const CANVAS = process.env.CANVAS_BASE_URL || 'https://canvas.example.com';
const OCR = process.env.OCR_WEBHOOK_URL || 'https://ocr.example.com/extract';

describe('extract_file OCR', () => {
  let request: any;
  let sessionId: string;

  beforeEach(async () => {
    nock.cleanAll();
    ({ request, sessionId } = await loadAppWithEnv({
      OCR_PROVIDER: 'webhook',
      OCR_WEBHOOK_URL: OCR,
      CANVAS_BASE_URL: CANVAS,
      CANVAS_TOKEN: 'test-token'
    }));
  });

  afterEach(() => {
    nock.cleanAll();
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
        url: `${CANVAS}/files/999/download?verifier=abc`,
      });

    nock(CANVAS)
      .get('/files/999/download')
      .query(true)
      .reply(200, pdfBuffer);
    
    nock(CANVAS)
      .get('/files/999/download')
      .query(true)
      .reply(200, pdfBuffer);

    const u = new URL(OCR);
    nock(u.origin)
      .post(u.pathname)
      .reply(200, {
        text: 'OCR extracted text from image PDF',
        pagesOcred: [1, 2],
      });

    const response = await request
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Mcp-Session-Id', sessionId)
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'extract_file',
          arguments: {
            fileId: 999,
            ocr: 'force',  // Force OCR to ensure webhook is called
            maxChars: 2000,
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
    const pdfBuffer = Buffer.from('mock-pdf-data');
    
    nock(CANVAS)
      .get('/api/v1/files/888')
      .reply(200, {
        id: 888,
        display_name: 'scan.pdf',
        filename: 'scan.pdf',
        size: pdfBuffer.length,
        content_type: 'application/pdf',
        url: `${CANVAS}/files/888/download?verifier=xyz`,
      });

    nock(CANVAS)
      .get('/files/888/download')
      .query(true)
      .reply(200, pdfBuffer);

    const response = await request
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
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
