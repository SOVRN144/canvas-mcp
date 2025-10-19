// src/ocr.ts
import crypto from 'node:crypto';
import axios from 'axios';
import { config } from './config.js';
import logger from './logger.js';

export interface OcrRequest {
  mime: string;
  dataBase64: string;
  languages?: string[];
  maxPages?: number;
  requestId?: string;
}

export interface OcrResponse {
  text: string;
  pagesOcred: number[];
  meta?: {
    engine?: string;
    source?: string;
    durationMs?: number;
  };
}

/**
 * Computes deterministic HMAC-SHA256 signature header.
 * @param secret Shared secret for HMAC
 * @param body Exact request body bytes to sign
 * @returns e.g. "sha256=<hex>"
 */
export function hmacHeader(secret: string, body: string | Buffer): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(typeof body === 'string' ? Buffer.from(body, 'utf8') : body);
  return `sha256=${hmac.digest('hex')}`;
}
/**
 * Sends a document to the OCR webhook for text extraction.
 * @param request OCR request with base64 data and options
 * @returns OCR response with extracted text and page info
 * @throws If webhook is not configured or request fails
 */
export async function performOcr(request: OcrRequest): Promise<OcrResponse> {
  if (config.ocrProvider !== 'webhook' || !config.ocrWebhookUrl) {
    throw new Error('OCR webhook not configured; set OCR_PROVIDER=webhook and OCR_WEBHOOK_URL');
  }

  try {
    const u = new URL(config.ocrWebhookUrl);
    const redactedUrl = `${u.origin}${u.pathname}`;
    
    logger.info('Sending OCR request to webhook', {
      url: redactedUrl,
      mime: request.mime,
      languages: request.languages,
      maxPages: request.maxPages,
      dataSize: request.dataBase64.length,
    });

    const payload: {
      mime: string;
      dataBase64: string;
      languages?: string[];
      maxPages?: number;
    } = {
      mime: request.mime,
      dataBase64: request.dataBase64,
    };
    if (request.languages !== undefined) {
      payload.languages = request.languages;
    }
    if (request.maxPages !== undefined) {
      payload.maxPages = request.maxPages;
    }

    const body: string = JSON.stringify(payload);
    const secret = (config.ocrWebhookSecret ?? '').trim();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (request.requestId) {
      headers['X-Request-ID'] = request.requestId;
    }

    if (secret.length > 0) {
      headers['X-Signature'] = hmacHeader(secret, body);
      logger.debug('OCR HMAC', {
        bodyLen: body.length,
        sigPrefix: headers['X-Signature']?.slice(0, 16),
      });
    }

    const response = await axios.post(config.ocrWebhookUrl, body, {
      timeout: config.ocrTimeoutMs,
      headers,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      transformRequest: [(data: string) => data],
    });

    const raw = response.data as unknown;
    if (!raw || typeof raw !== 'object') {
      throw new Error('Invalid OCR response payload');
    }
    const responsePayload = raw as { text?: unknown; pagesOcred?: unknown; meta?: unknown };
    const textValue: unknown = responsePayload.text;
    if (typeof textValue !== 'string') {
      throw new Error('OCR response missing text');
    }
    const pagesValue: unknown = responsePayload.pagesOcred;
    if (pagesValue !== undefined && !Array.isArray(pagesValue)) {
      throw new Error('OCR response pagesOcred must be an array');
    }
    const metaValue: unknown = responsePayload.meta;
    if (metaValue !== undefined && (metaValue === null || typeof metaValue !== 'object')) {
      throw new Error('OCR response meta must be an object');
    }
    const pagesOcred = Array.isArray(pagesValue)
      ? pagesValue.filter((entry): entry is number => typeof entry === 'number')
      : [];
    const meta = metaValue && typeof metaValue === 'object' ? (metaValue as OcrResponse['meta']) : undefined;
    const result: OcrResponse = {
      text: textValue,
      pagesOcred,
      ...(meta ? { meta } : {}),
    };

    logger.info('OCR request successful', {
      pagesOcred: result.pagesOcred.length,
      textLength: result.text.length,
    });

    return result;
  } catch (error) {
    // Robust URL redaction (avoid throwing in error handler)
    const redactedUrl = (() => {
      try {
        const u = new URL(config.ocrWebhookUrl);
        return `${u.origin}${u.pathname}`;
      } catch {
        return '(invalid OCR_WEBHOOK_URL)';
      }
    })();
    
    logger.error('OCR webhook request failed', {
      url: redactedUrl,
      error: String(error),
    });
    throw new Error(`OCR extraction failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Determines if native text extraction looks image-only (heuristic).
 * @param text Native extracted text
 * @returns true if text appears to be from an image-only document
 */
export function isImageOnly(text: string): boolean {
  if (!text) return true;
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  // Very short text might indicate image-only
  if (trimmed.length < 50) return true;
  return false;
}

/**
 * Returns a helpful error message when OCR is needed but disabled.
 */
export function ocrDisabledHint(): string {
  return 'PDF appears image-only; retry with ocr:"auto" or ocr:"force" (or use download_file).';
}
