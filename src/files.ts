import axios, { AxiosInstance } from 'axios';
import logger from './logger.js';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import { config } from './config.js';

const CANVAS_TOKEN = config.canvasToken?.trim() || undefined;
const MAX_EXTRACT_MB = Number(process.env.MAX_EXTRACT_MB) || 15;

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

export async function getCanvasFileMeta(canvasClient: AxiosInstance, fileId: number): Promise<CanvasFile> {
  try {
    const response = await canvasClient.get(`/api/v1/files/${fileId}`);
    return response.data;
  } catch (error) {
    logger.error('Failed to get Canvas file metadata', { fileId, error: String(error) });
    throw new Error(`Failed to get file metadata for file ${fileId}`);
  }
}

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
    throw new Error(`Failed to download file: ${fileMeta.display_name}`);
  }
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  
  const truncated = text.substring(0, maxChars - 10) + '\n\n[…]';
  return { text: truncated, truncated: true };
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const data = await pdfParse(buffer);
    return normalizeWhitespace(data.text);
  } catch (error) {
    logger.error('Failed to extract PDF text', { error: String(error) });
    throw new Error('Failed to extract text from PDF file');
  }
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return normalizeWhitespace(result.value);
  } catch (error) {
    logger.error('Failed to extract DOCX text', { error: String(error) });
    throw new Error('Failed to extract text from DOCX file');
  }
}

async function extractPptxText(buffer: Buffer): Promise<FileContentBlock[]> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const blocks: FileContentBlock[] = [];
    
    // Extract slide content from PPTX structure
    const slideFiles = Object.keys(zip.files).filter(name => 
      name.startsWith('ppt/slides/slide') && name.endsWith('.xml')
    );
    
    for (const slideFile of slideFiles.sort()) {
      const slideXml = await zip.files[slideFile].async('text');
      
      // Extract title and content from slide XML
      const titleMatch = slideXml.match(/<a:t[^>]*>([^<]+)<\/a:t>/);
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
      const textMatches = slideXml.matchAll(/<a:t[^>]*>([^<]+)<\/a:t>/g);
      const slideTexts = Array.from(textMatches).map(match => match[1]).slice(1); // Skip title
      
      if (slideTexts.length > 0) {
        blocks.push({
          type: 'paragraph',
          text: normalizeWhitespace(slideTexts.join(' '))
        });
      }
    }
    
    return blocks;
  } catch (error) {
    logger.error('Failed to extract PPTX text', { error: String(error) });
    throw new Error('Failed to extract text from PPTX file');
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
  const ext = filename.toLowerCase().split('.').pop();
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
    throw new Error(`File too large for extraction (${Math.round(fileMeta.size / 1024 / 1024)}MB > ${MAX_EXTRACT_MB}MB). Try download_file instead.`);
  }
  
  // Download file content
  const { buffer, contentType, name, size } = await downloadCanvasFile(fileMeta);
  
  // Determine content type with fallback to extension
  const finalContentType = contentType || getMimeTypeFromExtension(name);
  
  let blocks: FileContentBlock[] = [];
  let extractedText = '';
  
  // Extract content based on type
  if (finalContentType.includes('pdf')) {
    extractedText = await extractPdfText(buffer);
    blocks = textToBlocks(extractedText);
  } else if (finalContentType.includes('wordprocessingml.document')) {
    extractedText = await extractDocxText(buffer);
    blocks = textToBlocks(extractedText);
  } else if (finalContentType.includes('presentationml.presentation')) {
    blocks = await extractPptxText(buffer);
    extractedText = blocks.map(b => b.text).join('\n\n');
  } else if (finalContentType.startsWith('text/') || 
             finalContentType.includes('csv') || 
             finalContentType.includes('markdown')) {
    extractedText = normalizeWhitespace(buffer.toString('utf-8'));
    blocks = textToBlocks(extractedText);
  } else {
    // Unsupported content type
    const supportedTypes = ['PDF', 'DOCX', 'PPTX', 'TXT', 'CSV', 'MD'];
    throw new Error(`Unsupported file type: ${finalContentType}. Supported types: ${supportedTypes.join(', ')}. Try download_file instead for other file types.`);
  }
  
  // Apply character limit
  const { text: limitedText, truncated } = truncateText(extractedText, maxChars);
  
  if (truncated) {
    // Update blocks to reflect truncation
    const limitedBlocks: FileContentBlock[] = [];
    let currentLength = 0;
    
    for (const block of blocks) {
      if (currentLength + block.text.length + 10 <= maxChars) {
        limitedBlocks.push(block);
        currentLength += block.text.length;
      } else {
        const remainingChars = maxChars - currentLength - 10;
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

export async function downloadFileAsBase64(
  canvasClient: AxiosInstance,
  fileId: number,
  maxSize: number = 8_000_000
): Promise<DownloadResult> {
  // Get file metadata
  const fileMeta = await getCanvasFileMeta(canvasClient, fileId);
  
  // Check size limit
  if (fileMeta.size > maxSize) {
    throw new Error(`File too large to attach (${Math.round(fileMeta.size / 1024 / 1024)}MB > ${Math.round(maxSize / 1024 / 1024)}MB). Try extract_file instead.`);
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