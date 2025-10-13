import axios from 'axios';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { getSanitizedCanvasToken } from './config.js';
import logger from './logger.js';

import type { AxiosInstance } from 'axios';

/**
 * Throws a standardized error for file processing failures.
 * @param fileId Canvas file ID for error context  
 * @param msg Error message describing the failure
 * @throws Always throws an Error with format "File ${fileId}: ${msg}"
 */
function fail(fileId: number, msg: string): never {
  throw new Error(`File ${fileId}: ${msg}`);
}

// Helper for consistent PPTX slide limit error message
const errPptxTooManySlides = (id: number | string, actual: number, limit: number) =>
  `File ${id}: PPTX file has too many slides (${actual} > ${limit})`;
const MAX_EXTRACT_MB = (() => {
  const raw = process.env.MAX_EXTRACT_MB;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  if (raw) logger.warn('Invalid MAX_EXTRACT_MB value; falling back to default', { raw });
  return 15;
})();
export const TRUNCATE_SUFFIX = '…';
// PPTX slide limit to prevent zip-bomb style attacks and excessive processing time
const MAX_PPTX_SLIDES = 500; // configurable later if needed

// PPTX text extraction regex patterns
const PPTX_TEXT_SINGLE = /<a:t[^>]*>([^<]+)<\/a:t>/;       // for title
const PPTX_TEXT_GLOBAL = /<a:t[^>]*>([^<]+)<\/a:t>/g;      // for all text

const ALLOWED_MIME_TYPES = new Set<string>([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // pptx
  'text/plain',
  'text/csv',
  'text/markdown',
]);

type CanvasFile = {
  id: number;
  display_name: string;
  filename: string;
  size: number;
  content_type: string;
  url: string;
};

type FileContentBlock = {
  type: 'heading' | 'paragraph' | 'slide';
  text: string;
};

type ExtractResult = {
  file: {
    id: number;
    name: string;
    contentType: string;
    size: number;
    url: string;  // Canvas signed download URL
  };
  mode: string;
  charCount: number;
  blocks: FileContentBlock[];
  truncated: boolean;
};

type DownloadResult = {
  file: {
    id: number;
    name: string;
    contentType: string;
    size: number;
    dataBase64: string;
  };
};

/**
 * Downloads and returns Canvas file metadata.
 * @param canvasClient The configured Canvas API client
 * @param fileId The Canvas file ID to retrieve
 * @returns Canvas file metadata including id, name, size, content_type, and download url
 * @throws If the Canvas API request fails or returns invalid data
 */
export async function getCanvasFileMeta(canvasClient: AxiosInstance, fileId: number): Promise<CanvasFile> {
  try {
    const response = await canvasClient.get<CanvasFile>(`/api/v1/files/${fileId}`);
    return response.data;
  } catch (error) {
    logger.error('Failed to get Canvas file metadata', { fileId, error: String(error) });
    throw new Error(`File ${fileId}: failed to retrieve metadata from Canvas API`);
  }
}

/**
 * Downloads a Canvas file and returns a Buffer + metadata.
 * @param fileMeta The Canvas file metadata (id, size, url)
 * @returns The binary buffer and resolved content type.
 * @throws If the request fails, times out, or size limits are exceeded.
 */
export async function downloadCanvasFile(fileMeta: CanvasFile): Promise<{ buffer: Buffer; contentType: string; name: string; size: number }> {
  try {
    // Use centralized token handling for file download
    const token = getSanitizedCanvasToken();
    const headers: Record<string, string> = { Accept: '*/*' }; // Canvas needs Accept: */* for binary files
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await axios.get(fileMeta.url, {
      responseType: 'arraybuffer',
      headers,
      timeout: 30_000,
      maxRedirects: 5,
    });

    const buffer = Buffer.from(response.data as ArrayBuffer);
    const contentType = (response.headers['content-type'] as string | undefined) || fileMeta.content_type || 'application/octet-stream';
    
    // Validate downloaded size and warn on mismatch
    const tolerance = 1024; // 1KB
    if (typeof fileMeta.size === 'number' && Math.abs(buffer.length - fileMeta.size) > tolerance) {
      logger.warn('Downloaded file size mismatch', {
        fileId: fileMeta.id,
        expected: fileMeta.size,
        actual: buffer.length,
      });
    }
    
    return {
      buffer,
      contentType,
      name: fileMeta.display_name || fileMeta.filename,
      size: buffer.length,
    };
  } catch (error) {
    const safeUrl = (() => {
      try {
        const parsed = new URL(fileMeta.url);
        parsed.search = '';
        return parsed.toString();
      } catch {
        return '(redacted)';
      }
    })();
    logger.error('Failed to download Canvas file', {
      fileId: fileMeta.id,
      url: safeUrl,
      error: String(error),
    });
    throw new Error(`File ${fileMeta.id}: failed to download file (${String(error)})`);
  }
}

// Normalize a MIME type string by removing parameters and lowercasing.
// Always returns a string (empty when input is falsy).
function normalizeMime(input?: string): string {
  if (!input) return '';
  const parts = String(input).split(';', 1);
  const base = (parts[0] ?? '').trim().toLowerCase();
  return base;
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  if (maxChars <= TRUNCATE_SUFFIX.length) return { text: text.substring(0, maxChars), truncated: true };
  const sliceEnd = maxChars - TRUNCATE_SUFFIX.length;
  return { text: text.substring(0, sliceEnd) + TRUNCATE_SUFFIX, truncated: true };
}

async function extractPdfText(buffer: Buffer, fileId: number): Promise<string> {
  try {
    // Dynamic ESM import to work in CI/runtime (no top-level require)
    const pdfParseModule = await import('pdf-parse');
    const maybePdfParse =
      typeof pdfParseModule === 'function' ? pdfParseModule : pdfParseModule.default;
    if (typeof maybePdfParse !== 'function') {
      throw new Error('pdf-parse: missing callable export');
    }
    const pdfParse = maybePdfParse as (buf: Buffer) => Promise<{ text: string }>;
    const { text } = await pdfParse(buffer);
    return normalizeWhitespace(text);
  } catch (error) {
    logger.error('Failed to extract PDF text', { fileId, error: String(error) });
    throw new Error(`File ${fileId}: failed to extract text from PDF file`);
  }
}

async function extractDocxText(buffer: Buffer, fileId: number): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return normalizeWhitespace(result.value);
  } catch (error) {
    logger.error('Failed to extract DOCX text', { fileId, error: String(error) });
    throw new Error(`File ${fileId}: failed to extract text from DOCX file`);
  }
}

/**
 * Extracts basic text from PPTX slides.
 * Note: This is a lightweight extractor using basic regex on XML; it may miss bullets, tables, notes,
 * or complex formatting. A full XML parser could improve coverage but adds complexity.
 * For richer results, use mode='outline' or a dedicated parser.
 */
async function extractPptxText(buffer: Buffer, fileId: number): Promise<FileContentBlock[]> {
  try {
    // Buffer extends Uint8Array, which JSZip accepts
    const zip = await JSZip.loadAsync(buffer as Uint8Array);
    const blocks: FileContentBlock[] = [];
    
    // Extract slide content from PPTX structure
    const slideFiles = Object.keys(zip.files)
      .filter(n => n.startsWith('ppt/slides/slide') && n.endsWith('.xml'))
      .sort((a,b) => (Number(a.match(/slide(\d+)\.xml/)?.[1] ?? 1e9)) - (Number(b.match(/slide(\d+)\.xml/)?.[1] ?? 1e9)));
    
    if (slideFiles.length > MAX_PPTX_SLIDES) {
      throw new Error(errPptxTooManySlides(fileId, slideFiles.length, MAX_PPTX_SLIDES));
    }
    
    for (const slideFile of slideFiles) {
      const file = zip.files[slideFile];
      if (!file) fail(fileId, `slide not found (${slideFile})`);
      const slideXml = await file.async('text');
      
      // Extract title and content from slide XML
      const titleMatch = slideXml.match(PPTX_TEXT_SINGLE);
      const slideNumber = slideFile.match(/slide(\d+)\.xml/)?.[1] || '1';
      
      if (titleMatch) {
        blocks.push({
          type: 'heading',
          text: `Slide ${slideNumber} — ${titleMatch[1]}`
        });
      } else {
        blocks.push({
          type: 'heading',
          text: `Slide ${slideNumber}`
        });
      }
      
      // Extract all text content
      const textMatches = Array.from(slideXml.matchAll(PPTX_TEXT_GLOBAL), m => m[1]);
      const bodyRuns = titleMatch ? textMatches.slice(1) : textMatches;
      
      if (bodyRuns.length) {
        blocks.push({
          type: 'paragraph',
          text: normalizeWhitespace(bodyRuns.join('\n'))
        });
      }
    }
    
    return blocks;
  } catch (error) {
    // Re-throw errors that are already properly formatted (start with "File <id>:")
    if (error instanceof Error && error.message.startsWith(`File ${fileId}:`)) {
      throw error;
    }
    logger.error('Failed to extract PPTX text', { fileId, error: String(error) });
    throw new Error(`File ${fileId}: failed to extract text from PPTX file`);
  }
}

function textToBlocks(text: string): FileContentBlock[] {
  const paragraphs = text.split('\n\n').filter(p => p.trim().length > 0);
  return paragraphs.map(paragraph => ({
    type: 'paragraph' as const,
    text: paragraph.trim()
  }));
}

function getMimeTypeFromExtension(filename: string): string {
  const parts = filename.toLowerCase().split('.');
  const ext = parts.length > 1 ? parts.pop()! : '';
  if (!ext) return 'application/octet-stream';
  switch (ext) {
    case 'pdf': return 'application/pdf';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'txt': return 'text/plain';
    case 'csv': return 'text/csv';
    case 'md': return 'text/markdown';
    default: return 'application/octet-stream';
  }
}

/**
 * Extracts text content from a Canvas file.
 * @param canvasClient The configured Canvas API client
 * @param fileId The Canvas file ID to extract from
 * @param mode The extraction mode (text, outline, slides)
 * @param maxChars Maximum characters to return (default 50,000)
 * @returns Structured extraction result with file info, blocks, and metadata
 * @throws If file is too large, unsupported content type, or extraction fails
 */
export async function extractFileContent(
  canvasClient: AxiosInstance,
  fileId: number,
  mode: string = 'text',
  maxChars: number = 50_000
): Promise<ExtractResult> {
  // Get file metadata
  const fileMeta = await getCanvasFileMeta(canvasClient, fileId);
  
  // Check size limit for extraction
  const maxBytes = MAX_EXTRACT_MB * 1024 * 1024;
  if (fileMeta.size > maxBytes) {
    const mb = Math.round(fileMeta.size / (1024*1024));
    fail(fileMeta.id, `too large for extraction (${mb}MB > ${MAX_EXTRACT_MB}MB limit). Use download_file instead.`);
  }
  
  // Download file content
  const { buffer, contentType, name, size } = await downloadCanvasFile(fileMeta);
  
  // Determine content type with explicit detection order
  const responseType = contentType; // header
  const extensionType = getMimeTypeFromExtension(name);

  // responseType is the HTTP header (may include params), extensionType from filename.
  // If responseType is present but is 'application/octet-stream', treat it as empty.
  const normalizedResponseType =
    (responseType && responseType !== 'application/octet-stream')
      ? normalizeMime(responseType)
      : '';

  const normalizedExtensionType = normalizeMime(extensionType);

  // Content-type resolution order:
  // 1. HTTP header (if specific and not generic)
  // 2. File extension fallback (if header is missing/generic)
  // 3. Error if neither yields a recognized type
  const finalContentType = normalizedResponseType || normalizedExtensionType;
  
  if (!finalContentType) {
    fail(fileMeta.id, 'unable to determine content type');
  }
  
  // Check against strict allow-list
  if (!ALLOWED_MIME_TYPES.has(finalContentType)) {
    fail(fileMeta.id, `content type not allowed (${finalContentType || 'unknown'})`);
  }
  
  let blocks: FileContentBlock[] = [];
  let extractedText = '';
  
  // Extract content based on type
  if (finalContentType.includes('pdf')) {
    extractedText = await extractPdfText(buffer, fileMeta.id);
    blocks = textToBlocks(extractedText);
  } else if (finalContentType.includes('wordprocessingml.document')) {
    extractedText = await extractDocxText(buffer, fileMeta.id);
    blocks = textToBlocks(extractedText);
  } else if (finalContentType.includes('presentationml.presentation')) {
    blocks = await extractPptxText(buffer, fileMeta.id);
    extractedText = blocks.map(b => b.text).join('\n\n');
  } else if (finalContentType === 'text/plain' || 
             finalContentType === 'text/csv' || 
             finalContentType === 'text/markdown') {
    extractedText = normalizeWhitespace(buffer.toString('utf-8'));
    blocks = textToBlocks(extractedText);
  } else {
    // Fallback for any content type that passed allow-list but wasn't handled above
    fail(fileMeta.id, `unsupported content type (${finalContentType})`);
  }
  
  // Apply character limit
  const { text: limitedText, truncated } = truncateText(extractedText, maxChars);
  
  if (truncated) {
    // Update blocks to reflect truncation
    const limitedBlocks: FileContentBlock[] = [];
    let currentLength = 0;
    
    for (const block of blocks) {
      if (currentLength + block.text.length + TRUNCATE_SUFFIX.length <= maxChars) {
        limitedBlocks.push(block);
        currentLength += block.text.length;
      } else {
        const remainingChars = maxChars - currentLength - TRUNCATE_SUFFIX.length;
        if (remainingChars > 0) {
          limitedBlocks.push({
            ...block,
            text: block.text.substring(0, remainingChars) + TRUNCATE_SUFFIX
          });
        }
        break;
      }
    }
    blocks = limitedBlocks;
  }
  
  return {
    file: {
      id: fileMeta.id,
      name,
      contentType: finalContentType,
      size,
      url: fileMeta.url,  // Add signed download URL
    },
    mode,
    charCount: limitedText.length,
    blocks,
    truncated,
  };
}

/**
 * Downloads a Canvas file and returns it as base64 for attachment.
 * @param canvasClient The configured Canvas API client
 * @param fileId The Canvas file ID to download
 * @param maxSize Maximum file size in bytes (default 8MB)
 * @param fileMeta Optional pre-fetched file metadata to avoid duplicate fetch
 * @returns File metadata with base64-encoded data
 * @throws If file exceeds size limit or download fails
 */
export async function downloadFileAsBase64(
  canvasClient: AxiosInstance,
  fileId: number,
  maxSize: number = 8_000_000,
  fileMeta?: CanvasFile
): Promise<DownloadResult> {
  // Get file metadata (or use provided)
  const meta = fileMeta ?? await getCanvasFileMeta(canvasClient, fileId);
  
  // Check size limit
  if (meta.size > maxSize) {
    fail(meta.id, `too large for download (${meta.size} bytes > ${maxSize} bytes limit).`);
  }
  
  // Download file content
  const { buffer, contentType, name, size } = await downloadCanvasFile(meta);
  
  return {
    file: {
      id: meta.id,
      name,
      contentType,
      size,
      dataBase64: buffer.toString('base64'),
    },
  };
}
