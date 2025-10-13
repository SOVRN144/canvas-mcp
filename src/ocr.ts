// src/ocr.ts
import axios from 'axios';
import { config } from './config.js';
import logger from './logger.js';

export interface OcrRequest {
  mime: string;
  dataBase64: string;
  languages: string[];
  maxPages: number;
}

export interface OcrResponse {
  text: string;
  pagesOcred: number[];
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

    const response = await axios.post<OcrResponse>(
      config.ocrWebhookUrl,
      request,
      {
        timeout: config.ocrTimeoutMs,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    logger.info('OCR request successful', {
      pagesOcred: response.data.pagesOcred?.length || 0,
      textLength: response.data.text?.length || 0,
    });

    return response.data;
  } catch (error) {
    const u = new URL(config.ocrWebhookUrl);
    const redactedUrl = `${u.origin}${u.pathname}`;
    
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
