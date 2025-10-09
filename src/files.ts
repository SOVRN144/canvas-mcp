import axios, { AxiosInstance } from 'axios';
import logger from './logger.js';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import { getSanitizedCanvasToken } from './config.js';

const CANVAS_TOKEN = getSanitizedCanvasToken();
const MAX_EXTRACT_MB = Number(process.env.MAX_EXTRACT_MB) || 15;
const TRUNCATE_SUFFIX = '\n\n[…]';
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
    const response = await canvasClient.get(`/api/v1/files/${fileId}`);
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
    // Create axios instance for file download with Canvas token auth
    const headers: Record<string, string> = {};
    if (CANVAS_TOKEN) {
      headers.Authorization = `Bearer ${CANVAS_TOKEN}`;
    }

    const response = await axios.get(fileMeta.url, {
      responseType: 'arraybuffer',
      headers,
      timeout: 30_000,
      maxRedirects: 5,
    });

    const buffer = Buffer.from(response.data);
    const contentType = response.headers['content-type'] || fileMeta.content_type || 'application/octet-stream';
    
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
    logger.error('Failed to download Canvas file', { 
      fileId: fileMeta.id, 
      url: fileMeta.url,
      error: String(error) 
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
    .replace(/\r\n/g, '\n')            // CRLF -> LF
    .replace(/\r/g, '\n')              // lone CR -> LF
    .replace(/[ \t]+/g, ' ')           // collapse spaces/tabs (not newlines)
    .replace(/[ \t]+\n/g, '\n')        // trim trailing spaces per line
    .replace(/\n[ \t]+/g, '\n')        // trim leading spaces per line
    .replace(/\n{3,}/g, '\n\n')        // keep paragraph breaks (max 2)
    .trim();
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  
  // NEW: honor very small caps
  if (maxChars <= TRUNCATE_SUFFIX.length) {
    return { text: text.substring(0, maxChars), truncated: true };
  }
  
  const sliceEnd = maxChars - TRUNCATE_SUFFIX.length;
  const truncated = text.substring(0, sliceEnd) + TRUNCATE_SUFFIX;
  return { text: truncated, truncated: true };
}

/**
 * Extracts text from PDF files using dynamic ESM import.
 * Expects pdf-parse to provide a default export (modern ESM builds).
 */
async function extractPdfText(buffer: Buffer, fileId: number): Promise<string> {
  try {
    // Dynamic ESM import to work in CI/runtime (no top-level require)
    const pdfParseModule: any = await import('pdf-parse');
    const pdfParseFn: (buf: Buffer) => Promise<{ text: string }> = pdfParseModule?.default;
    if (!pdfParseFn) {
      // Explicit & actionable error; helps if a future package version changes exports.
      throw new Error('pdf-parse: missing default export; please verify pdf-parse installation and version.');
    }

    const data = await pdfParseFn(buffer);
    return normalizeWhitespace(data.text);
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
    const zip = await JSZip.loadAsync(buffer);
    const blocks: FileContentBlock[] = [];
    
    // Extract slide content from PPTX structure
    const slideFiles = Object.keys(zip.files)
      .filter(name => name.startsWith('ppt/slides/slide') && name.endsWith('.xml'))
      .sort((a, b) => {
        const na = Number(a.match(/slide(\d+)\.xml/)?.[1] ?? Number.MAX_SAFE_INTEGER);
        const nb = Number(b.match(/slide(\d+)\.xml/)?.[1] ?? Number.MAX_SAFE_INTEGER);
        return na - nb;
      });
    
    if (slideFiles.length > MAX_PPTX_SLIDES) {
      throw new Error(`File ${fileId}: PPTX file has too many slides (${slideFiles.length} > ${MAX_PPTX_SLIDES})`);
    }
    
    for (const slideFile of slideFiles) {
      const file = zip.files[slideFile];
      if (!file) {
        throw new Error(`File ${fileId}: slide not found (${slideFile})`);
      }
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
      const textMatches = Array.from(slideXml.matchAll(PPTX_TEXT_GLOBAL)).map(m => m[1]);
      const slideTexts = titleMatch ? textMatches.slice(1) : textMatches;
      
      if (slideTexts.length > 0) {
        blocks.push({
          type: 'paragraph',
          text: normalizeWhitespace(slideTexts.join(' '))
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
    throw new Error(`File ${fileMeta.id}: too large for extraction (${Math.round(fileMeta.size / 1024 / 1024)}MB > ${MAX_EXTRACT_MB}MB limit). Use download_file instead.`);
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

  // Prefer header (when specific), else extension; both are now safe strings.
  const finalContentType = normalizedResponseType || normalizedExtensionType;
  
  // Check against strict allow-list
  if (!ALLOWED_MIME_TYPES.has(finalContentType)) {
    throw new Error(`File ${fileMeta.id}: content type not allowed (${finalContentType || 'unknown'})`);
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
    throw new Error(`File ${fileMeta.id}: unsupported content type (${finalContentType || 'unknown'})`);
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
            text: block.text.substring(0, remainingChars) + '…'
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
 * @returns File metadata with base64-encoded data
 * @throws If file exceeds size limit or download fails
 */
export async function downloadFileAsBase64(
  canvasClient: AxiosInstance,
  fileId: number,
  maxSize: number = 8_000_000
): Promise<DownloadResult> {
  // Get file metadata
  const fileMeta = await getCanvasFileMeta(canvasClient, fileId);
  
  // Check size limit
  if (fileMeta.size > maxSize) {
    throw new Error(`File ${fileMeta.id}: too large to attach (${Math.round(fileMeta.size / 1024 / 1024)}MB > ${Math.round(maxSize / 1024 / 1024)}MB). Try extract_file instead.`);
  }
  
  // Download file content
  const { buffer, contentType, name, size } = await downloadCanvasFile(fileMeta);
  
  return {
    file: {
      id: fileMeta.id,
      name,
      contentType,
      size,
      dataBase64: buffer.toString('base64'),
    },
  };
}