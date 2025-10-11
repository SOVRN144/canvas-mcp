// src/types.ts

/** Controls OCR behavior for extract_file. */
export type OcrMode = 'off' | 'auto' | 'force';

/** Indicates where extracted text came from. */
export type ExtractSource = 'native' | 'ocr' | 'mixed';

/**
 * MCP-compatible content item for returning an attached file
 * directly in the tool result (base64 payload).
 */
export interface FileAttachmentContentItem {
  type: 'file';
  /** RFC 2046 MIME type, e.g. "application/pdf" */
  mimeType: string;
  /** Safe display name for UIs */
  name: string;
  /** Base64-encoded file payload */
  data: string;
  /** Optional decoded size (bytes) */
  sizeBytes?: number;
  /** Optional upstream identifier (e.g., Canvas file id) */
  fileId?: number | string;
}

/** Common text content item. */
export interface TextContentItem {
  type: 'text';
  text: string;
}

/** Shape used inside structuredContent for downloaded files. */
export interface StructuredContentFile {
  id: number | string;
  name: string;
  contentType: string;
  size: number;              // bytes
  dataBase64?: string;       // present when inlining small files
  url?: string;              // present when returning a signed URL for large files
  source?: ExtractSource;    // optional: where any extracted text came from
}
