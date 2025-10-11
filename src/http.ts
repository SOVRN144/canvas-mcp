import 'dotenv/config';
import cors from 'cors';
import express, { NextFunction, type Request, type Response, type ErrorRequestHandler } from 'express';
import { isMain } from './util/isMain.js';
import axios, { AxiosInstance, AxiosHeaders } from 'axios';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import logger from './logger.js';
import { config, getSanitizedCanvasToken, validateConfig } from './config.js';
import { extractFileContent, downloadFileAsBase64 } from './files.js';
import { getAssignment, type CanvasAssignment } from './canvas.js';
import { sanitizeHtmlSafe, htmlToText, truncate, sanitizeHtmlWithLimit } from './sanitize.js';
import { performOcr, isImageOnly, ocrDisabledHint } from './ocr.js';
import type { OcrMode, FileAttachmentContentItem } from './types.js';

// Validate config early to fail fast on misconfiguration
validateConfig();

const IS_MAIN = isMain(import.meta.url);

// Process-level error handlers for fail-fast behavior (only when this module is entrypoint)
if (IS_MAIN) {
  process.on('uncaughtException', (err) => {
    logger.error('uncaughtException during server startup', {
      error: String(err),
      stack: (err as any)?.stack ?? null,
    });
    process.exit(1);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('unhandledRejection during server startup', { reason: String(reason) });
    process.exit(1);
  });
}

const MCP_SESSION_HEADER = 'Mcp-Session-Id';
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_PAGES = 100;
const MAX_RESULTS = 10_000;
const PREVIEW_MAX_CHARS = 2000; // hard-coded limit for now; could be made configurable if needed
// Session timeout (0 = no timeout; sessions persist until server restart)
const SESSION_TTL_MS =
  config.sessionTtlMs !== undefined && Number.isFinite(config.sessionTtlMs)
    ? config.sessionTtlMs
    : 10 * 60 * 1000;
const isProduction = config.nodeEnv === 'production';
const DEBUG_TOKEN = config.debugToken ?? '';

// ---- MCP server configuration + tool schemas ----
// Derive version from runtime package metadata to avoid drift with package.json
const SERVER_VERSION = process.env.npm_package_version ?? '0.0.0';

const EchoInputShape = {
  text: z.string().describe('text to echo'),
} as const;
const EchoInput = z.object(EchoInputShape);

const EnvCheckInputShape = {} as const;
const EnvCheckInput = z.object(EnvCheckInputShape);

const hasCanvas = Boolean((process.env.CANVAS_BASE_URL ?? '').trim() && getSanitizedCanvasToken());

/**
 * Creates and returns a configured Canvas API client if environment is properly set.
 * Returns null if CANVAS_BASE_URL or CANVAS_TOKEN are missing/empty.
 * @returns Configured axios instance or null if Canvas not available
 */
export function getCanvasClient(): AxiosInstance | null {
  const token = getSanitizedCanvasToken();
  const baseURL = process.env.CANVAS_BASE_URL?.trim();
  if (!token || !baseURL) return null;

  const headers = AxiosHeaders.from({
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
  });

  return axios.create({
    baseURL,
    timeout: 30_000,
    headers,
    validateStatus: (s) => s >= 200 && s < 300,
  });
}

/**
 * Returns a configured Canvas API client, throwing an error if not available.
 * Use this in Canvas tool handlers to ensure a client is available.
 * @returns Configured axios instance
 * @throws Error if Canvas client is not configured
 */
export function requireCanvasClient(): AxiosInstance {
  const c = getCanvasClient();
  if (!c) throw new Error('Canvas client not configured');
  return c;
}

const logCanvasErrorEvent = (details: {
  status?: number | null;
  statusText?: string | null;
  details: string;
  url?: string;
  timestamp?: string;
}) => {
  logger.error('[Canvas Error]', {
    timestamp: details.timestamp ?? new Date().toISOString(),
    status: details.status ?? null,
    statusText: details.statusText ?? null,
    details: details.details,
    url: details.url ?? null,
  });
};

const parseCanvasErrors = (data: unknown): string | null => {
  if (!data || typeof data !== 'object') {
    return null;
  }
  const anyData = data as Record<string, unknown>;
  if (Array.isArray(anyData.errors)) {
    return anyData.errors
      .map((err) => {
        if (typeof err === 'string') return err;
        if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') {
          return err.message;
        }
        return JSON.stringify(err);
      })
      .join('; ');
  }
  if (typeof anyData.message === 'string') {
    return anyData.message;
  }
  return null;
};

const raiseCanvasError = (error: unknown): never => {
  const timestamp = new Date().toISOString();
  const safeMessage = 'Canvas request failed; check server logs for details';

  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const statusText = error.response?.statusText;
    const details = parseCanvasErrors(error.response?.data);
    const fallback = error.message ?? 'Canvas request failed';
    const description = [status ? `Canvas API ${status}${statusText ? ` ${statusText}` : ''}` : 'Canvas API error', details || fallback]
      .filter(Boolean)
      .join(': ');

    logCanvasErrorEvent({
      status: status ?? null,
      statusText: statusText ?? null,
      details: details || fallback,
      ...(error.config?.url ? { url: error.config.url } : {}),
      timestamp,
    });

    if (isProduction) {
      throw new Error(safeMessage);
    }

    throw new Error(description);
  }

  if (error instanceof Error) {
    logCanvasErrorEvent({ status: null, statusText: null, details: error.message, timestamp });
    if (isProduction) {
      throw new Error(safeMessage);
    }
    throw error;
  }

  if (isProduction) {
    logCanvasErrorEvent({ status: null, statusText: null, details: String(error), timestamp });
    throw new Error(safeMessage);
  }

  throw new Error(String(error));
};

const withCanvasErrors = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    raiseCanvasError(error); // never returns
    /* c8 ignore next */ return undefined as never; // unreachable — satisfy TS & express intent
  }
};

const parseNextLink = (linkHeader?: string): string | null => {
  if (!linkHeader) return null;
  const segments = linkHeader.split(',');
  for (const segment of segments) {
    const match = segment.trim().match(/<([^>]+)>;[^;]*rel="next"/i);
    if (match) {
      const nextLink = match[1];
      if (typeof nextLink === 'string') {
        return nextLink;
      }
    }
  }
  return null;
};

const getAll = async <T>(url: string, params?: Record<string, unknown>): Promise<T[]> => {
  const canvasClient = requireCanvasClient();
  const results: T[] = [];
  let nextUrl: string | null = url;
  let query = params;
  let pageCount = 0;
  const seenPaths = new Set<string>();
  const resolutionBase = canvasClient.defaults?.baseURL ?? config.canvasBaseUrl;
  if (!resolutionBase) {
    throw new Error('No Canvas base URL configured for pagination.');
  }

  while (nextUrl) {
    try {
      pageCount += 1;
      if (pageCount > MAX_PAGES) {
        throw new Error(`Pagination exceeded maximum page limit (${MAX_PAGES}).`);
      }

      const isAbsolute = /^https?:\/\//i.test(nextUrl);
      const currentUrl = isAbsolute ? new URL(nextUrl) : new URL(nextUrl, resolutionBase);
      const normalizedPath = `${currentUrl.pathname}${currentUrl.search}`;
      if (seenPaths.has(normalizedPath)) {
        throw new Error('Pagination loop detected while fetching Canvas data.');
      }
      seenPaths.add(normalizedPath);

      const response = query !== undefined
        ? await canvasClient.get(currentUrl.toString(), { params: query })
        : await canvasClient.get(currentUrl.toString());
      const data = response.data as unknown;
      if (!Array.isArray(data)) {
        const msg = parseCanvasErrors(data) || `Unexpected Canvas response for ${url}`;
        throw new Error(msg);
      }
      const pageData = data as T[];
      if (results.length + pageData.length > MAX_RESULTS) {
        throw new Error(`Pagination exceeded maximum result limit (${MAX_RESULTS}).`);
      }
      results.push(...pageData);
      const next = parseNextLink(response.headers['link'] ?? response.headers['Link']);
      if (!next) {
        break;
      }
      nextUrl = next;
      query = undefined;
    } catch (error) {
      raiseCanvasError(error);
    }
  }
  return results;
};

const buildJsonRpcError = (message: string, id: unknown = null) => ({
  jsonrpc: '2.0',
  error: { code: -32000, message },
  id,
});

const redactSessionId = (value: string): string => {
  if (!value) {
    return value;
  }
  return value.length <= 8 ? value : `${value.slice(0, 8)}…`;
};

const fallbackSessionKey = (req: Request) => ipKeyGenerator(req.ip ?? '');

const jsonParseErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (err instanceof SyntaxError && typeof (err as { type?: unknown }).type === 'string') {
    const parseType = (err as { type?: unknown }).type;
    if (parseType === 'entity.parse.failed') {
      let id: unknown = null;
      if (req.body && typeof req.body === 'object') {
        id = (req.body as Record<string, unknown>).id ?? null;
      } else if (typeof (err as { body?: unknown }).body === 'string') {
        try {
          const parsed = JSON.parse((err as { body?: string }).body ?? '');
          if (parsed && typeof parsed === 'object') {
            id = (parsed as Record<string, unknown>).id ?? null;
          }
        } catch {
          // ignore failures to parse invalid JSON bodies
        }
      }
      res.status(400).json(buildJsonRpcError('Invalid JSON', id));
      return;
    }
  }
  next(err);
};

type CanvasModuleItem = {
  id: number;
  type: string;
  title?: string;
  content_id?: number;
  [k: string]: unknown;
};

type CanvasModule = {
  id: number;
  items?: CanvasModuleItem[];
  [k: string]: unknown;
};

type CanvasCourse = {
  id: number;
  name?: string;
  course_code?: string;
  short_name?: string;
};

const fetchModules = async (courseId: number, includeItems: boolean): Promise<CanvasModule[]> => {
  const params: Record<string, unknown> = { per_page: 100 };
  if (includeItems) {
    params['include[]'] = 'items';
  }
  const modules = await getAll<CanvasModule>(`/api/v1/courses/${courseId}/modules`, params);
  if (!includeItems) {
    return modules;
  }
  const withItems = await Promise.all(
    modules.map(async (module: CanvasModule) => {
      if (module.items && Array.isArray(module.items)) {
        return module;
      }
      const items = await getAll<CanvasModuleItem>(`/api/v1/courses/${courseId}/modules/${module.id}/items`, {
        per_page: 100,
      });
      return { ...module, items };
    })
  );
  return withItems;
};

const ListCoursesInputShape = {} as const;
const ListCoursesInput = z.object(ListCoursesInputShape);

const ListModulesInputShape = {
  courseId: z.number(),
  includeItems: z.boolean().optional(),
} as const;
const ListModulesInput = z.object(ListModulesInputShape);

const ListFilesInputShape = {
  courseId: z.number(),
} as const;
const ListFilesInput = z.object(ListFilesInputShape);

const GetAssignmentInputShape = {
  assignmentId: z.number().describe('Canvas assignment id'),
  courseId: z.number().describe('Canvas course id (preferred if known)'),
  mode: z.enum(['html', 'text']).optional().default('text'),
  maxChars: z.number().int().positive().max(100_000).optional(),
} as const;
const GetAssignmentInput = z.object(GetAssignmentInputShape).strict();

const ExtractFileInputShape = {
  fileId: z.number(),
  mode: z.enum(['text', 'outline', 'slides']).optional(),
  maxChars: z.number().int().positive().max(100_000).optional(),
  ocr: z.enum(['off', 'auto', 'force']).optional().default('auto').describe('Use OCR for image-only PDFs or force OCR'),
  ocrLanguages: z.array(z.string()).optional().default(['eng']),
  maxOcrPages: z.number().int().min(1).max(200).optional().default(20),
} as const;
const ExtractFileInput = z.object(ExtractFileInputShape);

const DownloadFileInputShape = {
  fileId: z.number(),
  maxSize: z
    .coerce.number()
    .int()
    .positive()
    .max(MAX_FILE_SIZE)
    .optional(),
} as const;
const DownloadFileInput = z.object(DownloadFileInputShape).strict();

type RegisterToolArgs = Parameters<McpServer['registerTool']>;

const createServer = () => {
  const server = new McpServer({ name: 'sanity-mcp', version: SERVER_VERSION });
  const toolNames: string[] = [];

  const addTool = (...args: RegisterToolArgs) => {
    const [name] = args;
    toolNames.push(String(name));
    server.registerTool(...args);
  };

  addTool(
    'echo',
    {
      title: 'Echo',
      description: 'Returns the text you send',
      inputSchema: EchoInputShape,
    },
    (args) => {
      const { text } = EchoInput.parse(args);
      return { content: [{ type: 'text', text }] };
    }
  );

  addTool(
    'env_check',
    {
      title: 'Env check',
      description: 'Reports if Canvas env vars are present (no secrets returned)',
      inputSchema: EnvCheckInputShape,
    },
    (args) => {
      EnvCheckInput.parse(args ?? {});
      const summary = {
        hasCanvasBaseUrl: Boolean((process.env.CANVAS_BASE_URL ?? '').trim()),
        hasCanvasToken: Boolean(getSanitizedCanvasToken()),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(summary) }],
        structuredContent: summary,
      };
    }
  );

  if (hasCanvas) {
    // Canvas tools registered; handlers call requireCanvasClient() with error handling.
    // Trigger axios.create during registration for testing
    getCanvasClient();
    
    addTool(
      'list_courses',
      {
        title: 'List courses',
        description: 'Lists active student enrollments',
        inputSchema: ListCoursesInputShape,
      },
      async (args) => {
        ListCoursesInput.parse(args ?? {});
        return withCanvasErrors(async () => {
          const canvasClient = requireCanvasClient();
          
          const fetchCourses = async (params: Record<string, unknown>): Promise<CanvasCourse[]> => {
            const response = await canvasClient.get('/api/v1/courses', { params });
            const data = response.data as unknown;
            if (!Array.isArray(data)) {
              throw new Error('Unexpected Canvas response: courses is not an array');
            }
            return data as CanvasCourse[];
          };

          const params = {
            per_page: 50,
            enrollment_type: 'student',
            enrollment_state: 'active',
          } satisfies Record<string, unknown>;

          const courses = await fetchCourses(params);

          const mapped = courses.map((course) => {
            const id = course.id;
            const name = course.name || course.course_code || course.short_name || `course-${id}`;
            return { id, name };
          });
          const preview = { count: mapped.length, sample: mapped.slice(0, 5) };
          return {
            content: [{ type: 'text', text: JSON.stringify(preview) }],
            structuredContent: { courses: mapped },
          };
        });
      }
    );

    addTool(
      'list_modules',
      {
        title: 'List modules',
        description: 'Lists modules (optionally including items) for a course',
        inputSchema: ListModulesInputShape,
      },
      async (args) => {
        const { courseId, includeItems = true } = ListModulesInput.parse(args ?? {});
        return withCanvasErrors(async () => {
          const modules = await fetchModules(courseId, includeItems);
          const preview = { count: modules.length, sample: modules.slice(0, 3) };
          return {
            content: [{ type: 'text', text: JSON.stringify(preview) }],
            structuredContent: { modules },
          };
        });
      }
    );

    addTool(
      'list_files_from_modules',
      {
        title: 'List files from modules',
        description: 'Lists files reachable via modules for a course',
        inputSchema: ListFilesInputShape,
      },
      async (args) => {
        const { courseId } = ListFilesInput.parse(args ?? {});
        return withCanvasErrors(async () => {
          const canvasClient = requireCanvasClient();   // <-- create once
          const modules = await fetchModules(courseId, true);
          const fileItems = modules
            .flatMap((module) => (Array.isArray(module.items) ? module.items : []))
            .filter((item): item is CanvasModuleItem => item?.type === 'File' && typeof item?.content_id === 'number');
          const files = await Promise.all(
            fileItems.map((item) =>
              withCanvasErrors(async () => {
                const response = await canvasClient.get(`/api/v1/files/${item.content_id}`);
                const file = response.data as {
                  id: number;
                  display_name?: string;
                  filename?: string;
                  updated_at?: string;
                  modified_at?: string;
                  url?: string;
                  public_url?: string;
                };
                const id = file.id;
                const name = file.display_name || file.filename || `file-${id}`;
                const updatedAt = file.updated_at ?? file.modified_at ?? null;
                const url = file.url ?? file.public_url ?? null;
                return { id, name, updated_at: updatedAt, url };
              })
            )
          );
          const preview = { count: files.length, sample: files.slice(0, 5) };
          return {
            content: [{ type: 'text', text: JSON.stringify(preview) }],
            structuredContent: { files },
          };
        });
      }
    );

    /**
     * Get assignment details tool
     * Fetches Canvas assignment with sanitized HTML or plain text description
     * @param assignmentId Canvas assignment ID
     * @param courseId Canvas course ID
     * @param mode Return format: html (sanitized) or text (plain)
     * @param maxChars Maximum characters to return
     * @returns Assignment details with sanitized content
     * @throws If assignment not found or Canvas API fails
     */
    addTool(
      'get_assignment',
      {
        title: 'Get assignment details',
        description: 'Fetch Canvas assignment with sanitized HTML or plain text description',
        inputSchema: GetAssignmentInputShape,
      },
      async (args) => {
        const { assignmentId, courseId, mode = 'text', maxChars = 50_000 } = GetAssignmentInput.parse(args ?? {});
        return withCanvasErrors(async () => {
          const canvasClient = requireCanvasClient();
          const assignment = await getAssignment(canvasClient, courseId, assignmentId);
          
          const description = assignment.description || '';
          
          if (mode === 'html') {
            // Sanitize HTML with safe truncation
            const { html, truncated } = sanitizeHtmlWithLimit(description, maxChars ?? 100_000);
            
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  name: assignment.name,
                  pointsPossible: assignment.points_possible ?? null,
                  dueAt: assignment.due_at ?? null,
                }).substring(0, 300),
              }],
              structuredContent: {
                assignment: {
                  id: assignment.id,
                  name: assignment.name,
                  pointsPossible: assignment.points_possible ?? null,
                  dueAt: assignment.due_at ?? null,
                  html,
                  truncated,
                },
              },
            };
          } else {
            // Convert to text and truncate
            const sanitized = sanitizeHtmlSafe(description);
            const plainText = htmlToText(sanitized);
            const result = maxChars ? truncate(plainText, maxChars) : { text: plainText, truncated: false };
            
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  name: assignment.name,
                  pointsPossible: assignment.points_possible ?? null,
                  dueAt: assignment.due_at ?? null,
                }).substring(0, 300),
              }],
              structuredContent: {
                assignment: {
                  id: assignment.id,
                  name: assignment.name,
                  pointsPossible: assignment.points_possible ?? null,
                  dueAt: assignment.due_at ?? null,
                  text: result.text,
                  truncated: result.truncated,
                },
              },
            };
          }
        });
      }
    );

    /**
     * Extract text from Canvas file tool
     * Downloads and extracts readable text from Canvas files (PDF/DOCX/PPTX/TXT)
     * @param fileId Canvas file ID to extract from
     * @param mode Extraction mode (text, outline, slides)
     * @param maxChars Maximum characters to return
     * @param ocr OCR mode: off, auto, or force
     * @param ocrLanguages Languages for OCR (default: ['eng'])
     * @param maxOcrPages Maximum pages to OCR (default: 20)
     * @returns Structured content with text blocks and metadata
     * @throws If file is too large, unsupported type, or Canvas API fails
     */
    addTool(
      'extract_file',
      {
        title: 'Extract text from Canvas file',
        description: 'Download and extract text from a Canvas file (PDF/DOCX/PPTX/TXT) with optional OCR',
        inputSchema: ExtractFileInputShape,
      },
      async (args) => {
        const { 
          fileId, 
          mode = 'text', 
          maxChars = 50_000,
          ocr = 'auto',
          ocrLanguages = ['eng'],
          maxOcrPages = 20,
        } = ExtractFileInput.parse(args ?? {});
        
        return withCanvasErrors(async () => {
          const canvasClient = requireCanvasClient();
          
          // Try native extraction first
          let result = await extractFileContent(canvasClient, fileId, mode, maxChars);
          let extractSource: 'native' | 'ocr' | 'mixed' = 'native';
          let pagesOcred: number[] | undefined;
          
          const fullText = result.blocks.map(b => b.text).join('\n\n');
          const isPdf = result.file.contentType === 'application/pdf';
          
          // Handle OCR logic
          if (isPdf && ocr !== 'off') {
            const needsOcr = ocr === 'force' || isImageOnly(fullText);
            
            if (needsOcr) {
              // Early OCR availability check
              if (config.ocrProvider !== 'webhook') {
                throw new Error(ocrDisabledHint());
              }
              if (!config.ocrWebhookUrl) {
                throw new Error('OCR webhook not configured; set OCR_WEBHOOK_URL');
              }
              
              // Download file for OCR using URL from extract result
              const { default: axios } = await import('axios');
              const downloadResponse = await axios.get(result.file.url!, {
                responseType: 'arraybuffer',
                headers: { Authorization: `Bearer ${getSanitizedCanvasToken()}` },
              });
              const buffer = Buffer.from(downloadResponse.data);
              const dataBase64 = buffer.toString('base64');
              
              // Perform OCR
              const ocrResult = await performOcr({
                mime: 'application/pdf',
                dataBase64,
                languages: ocrLanguages,
                maxPages: maxOcrPages,
              });
              
              pagesOcred = ocrResult.pagesOcred;
              
              if (ocr === 'force' || !fullText.trim()) {
                // Use OCR text exclusively
                const truncated = truncate(ocrResult.text, maxChars);
                result = {
                  ...result,
                  blocks: [{ type: 'paragraph', text: truncated.text }],
                  charCount: truncated.text.length,
                  truncated: truncated.truncated,
                };
                extractSource = 'ocr';
              } else {
                // Mix native + OCR
                const combined = `${fullText}\n\n[OCR Text]\n${ocrResult.text}`;
                const truncated = truncate(combined, maxChars);
                result = {
                  ...result,
                  blocks: [{ type: 'paragraph', text: truncated.text }],
                  charCount: truncated.text.length,
                  truncated: truncated.truncated,
                };
                extractSource = 'mixed';
              }
            }
          } else if (isPdf && ocr === 'off' && isImageOnly(fullText)) {
            throw new Error(ocrDisabledHint());
          }
          
          // Build preview
          const previewText = result.blocks.map(b => b.text).join('\n\n');
          const preview = previewText.length > PREVIEW_MAX_CHARS
            ? previewText.substring(0, PREVIEW_MAX_CHARS).trimEnd() + '…'
            : previewText;

          const summary = `Extracted ${result.charCount} characters from ${result.file.name} (${Math.round(result.file.size / 1024)}KB)${result.truncated ? ' [truncated]' : ''}`;

          return {
            content: [
              { type: 'text', text: `${summary}\n\n${preview}` },
            ],
            structuredContent: {
              ...result,
              meta: {
                source: extractSource,
                ...(pagesOcred ? { pagesOcred } : {}),
                truncated: result.truncated,
              },
            },
          };
        });
      }
    );

    /**
     * Download Canvas file as attachment tool
     * Downloads Canvas files as base64 attachments with size limits
     * Small files are inlined; large files return URL only
     * @param fileId Canvas file ID to download
     * @param maxSize Maximum file size in bytes
     * @returns Base64-encoded file data for chat attachment (small) or URL (large)
     * @throws If file exceeds size limit or download fails
     */
    addTool(
      'download_file',
      {
        title: 'Download Canvas file as attachment',
        description: 'Download a Canvas file by id; small files inlined as base64, large files return URL',
        inputSchema: DownloadFileInputShape,
      },
      async (args) => {
        const { fileId, maxSize = 8_000_000 } = DownloadFileInput.parse(args ?? {});
        return withCanvasErrors(async () => {
          const canvasClient = requireCanvasClient();
          const { getCanvasFileMeta } = await import('./files.js');
          
          // Fetch file metadata once
          const fileMeta = await getCanvasFileMeta(canvasClient, fileId);
          const { id, display_name, filename, size, content_type, url } = fileMeta;
          const name = display_name || filename || `file-${id}`;
          const sizeMB = (size / 1024 / 1024).toFixed(1);
          
          // Check if we should inline or return URL
          if (size > config.downloadMaxInlineBytes) {
            // Large file: return URL only (no download, no maxSize check)
            if (!url) {
              throw new Error(`File ${id}: Signed download URL missing from Canvas metadata`);
            }
            
            const attachmentText = `Attached file (via URL): ${name} (${sizeMB} MB, ${content_type})`;
            
            // Redact query params from URL for logging
            const urlForLog = url.split('?')[0];
            logger.info('Returning large file URL', { fileId: id, size, urlPreview: urlForLog });
            
            return {
              content: [{ type: 'text', text: attachmentText }],
              structuredContent: {
                file: {
                  id,
                  name,
                  contentType: content_type,
                  size,
                  url, // Full signed URL with query params
                },
              },
            };
          } else {
            // Small file: check maxSize, then inline as base64
            if (size > maxSize) {
              throw new Error(`File ${id} is too large (${sizeMB} MB exceeds maxSize limit of ${(maxSize / 1024 / 1024).toFixed(1)} MB)`);
            }
            
            // Reuse fileMeta to avoid duplicate fetch
            const result = await downloadFileAsBase64(canvasClient, fileId, maxSize, fileMeta);
            
            const attachmentText = `Attached file: ${name} (${sizeMB} MB, ${content_type})`;
            
            return {
              content: [{ type: 'text', text: attachmentText }],
              structuredContent: {
                file: {
                  id,
                  name,
                  contentType: content_type,
                  size,
                  dataBase64: result.file.dataBase64,
                },
              },
            };
          }
        });
      }
    );
  }

  return { server, toolNames };
};

// ---- Express wiring ----
export const app = express();

const allowedOrigins = config.corsAllowOrigins;

const trustProxyValue = process.env.TRUST_PROXY;
if (typeof trustProxyValue === 'string' && trustProxyValue.length > 0) {
  const normalizedTrustProxy = trustProxyValue === 'true' ? true : trustProxyValue === 'false' ? false : trustProxyValue;
  app.set('trust proxy', normalizedTrustProxy);
}

const globalMcpLimiter = rateLimit({
  windowMs: 60_000,
  limit: 100,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  identifier: 'mcp-global',
  skip: (req) => req.method === 'OPTIONS',
  handler: (_req, res) => {
    res.status(429).json(buildJsonRpcError('Global rate limit exceeded'));
  },
});

const toolsCallLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  identifier: 'tools-call',
  keyGenerator: (req) => {
    const rawSessionId = req.header(MCP_SESSION_HEADER);
    const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
    if (sessionId && sessionId.trim().length > 0) {
      return sessionId.trim();
    }
    return fallbackSessionKey(req);
  },
  skip: (req) => {
    const body = req.body;
    if (typeof body !== 'object' || body === null) {
      return true;
    }
    const method = (body as { method?: unknown }).method;
    return method !== 'tools/call';
  },
  handler: (req, res) => {
    const id =
      typeof req.body === 'object' && req.body !== null ? (req.body as Record<string, unknown>).id ?? null : null;
    res.status(429).json(buildJsonRpcError('Session rate limit exceeded', id));
  },
});

const mcpJsonParser = express.json({
  limit: '2mb',
  type: ['application/json', 'application/*+json', 'text/plain'],
});

app.use(
  cors((req, callback) => {
    const origin = req.header('Origin');
    if (!origin) {
      callback(null, { origin: false, exposedHeaders: [MCP_SESSION_HEADER] });
      return;
    }
    if (allowedOrigins.length === 0) {
      callback(new Error('Not allowed by CORS'));
      return;
    }
    if (allowedOrigins.includes(origin)) {
      callback(null, { origin: true, exposedHeaders: [MCP_SESSION_HEADER] });
      return;
    }
    callback(new Error('Not allowed by CORS'));
  })
);

app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof Error && err.message === 'Not allowed by CORS') {
    res.status(403).json({
      ...buildJsonRpcError('Not allowed by CORS'),
    });
    return;
  }
  next(err);
});

app.use(jsonParseErrorHandler);

app.use('/mcp', globalMcpLimiter);

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.get('/_debug/sessions', (req, res) => {
  if (isProduction) {
    const token = req.header('X-Debug-Token');
    if (!DEBUG_TOKEN || token !== DEBUG_TOKEN) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
  }

  const now = Date.now();
  const payload = Array.from(sessions.entries()).map(([id, entry]) => {
    const base = {
      id: isProduction ? redactSessionId(id) : id,
      createdAt: new Date(entry.createdAt).toISOString(),
      lastSeen: new Date(entry.lastSeen).toISOString(),
      idleMs: now - entry.lastSeen,
      expiresAt: SESSION_TTL_MS > 0 ? new Date(entry.lastSeen + SESSION_TTL_MS).toISOString() : null,
    };
    if (!isProduction) {
      return { ...base, tools: entry.toolNames };
    }
    return base;
  });
  res.json(payload);
});

type NodeReq = IncomingMessage;
type NodeRes = ServerResponse;
const asNode = (req: Request): NodeReq => req as unknown as NodeReq;
const asNodeRes = (res: Response): NodeRes => res as unknown as NodeRes;

interface SessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  toolNames: string[];
  createdAt: number;
  lastSeen: number;
}
const sessions = new Map<string, SessionEntry>();
const pendingSessions = new Map<string, Promise<void>>();
let shuttingDown = false;
let httpServer: Server | null = null;

const waitForPendingSession = async (sessionId: string): Promise<void> => {
  if (!sessionId) {
    return;
  }
  const pending = pendingSessions.get(sessionId);
  if (!pending) {
    return;
  }
  try {
    await pending;
  } catch {
    // initialization failures are surfaced on the original request
  }
};

const isInitialize = (body: unknown) =>
  typeof body === 'object' && body !== null && (body as { method?: unknown }).method === 'initialize';

const normalizeInitializePayload = (body: unknown): unknown => {
  if (typeof body !== 'object' || body === null) {
    return body;
  }
  const request = body as Record<string, unknown>;
  if (request.method !== 'initialize') {
    return body;
  }
  const rawParams = request.params;
  const params: Record<string, unknown> =
    typeof rawParams === 'object' && rawParams !== null ? { ...(rawParams as Record<string, unknown>) } : {};
  if (!('capabilities' in params)) {
    params.capabilities = {};
  }
  if (!('clientInfo' in params)) {
    params.clientInfo = {
      name: 'unknown-client',
      version: '0.0.0',
    };
  }
  if (!('protocolVersion' in params)) {
    params.protocolVersion = DEFAULT_PROTOCOL_VERSION;
  }
  return { ...request, params };
};

const isSessionExpired = (entry: SessionEntry) => SESSION_TTL_MS > 0 && Date.now() - entry.lastSeen > SESSION_TTL_MS;

const closeSession = (
  sessionId: string,
  entry?: SessionEntry,
  options: { initiatedByTransport?: boolean } = {}
) => {
  const target = entry ?? sessions.get(sessionId);
  if (!target) {
    return;
  }

  const mappedEntry = sessions.get(sessionId);
  if (!entry || mappedEntry === entry) {
    sessions.delete(sessionId);
  }

  if (!options.initiatedByTransport) {
    try {
      target.transport.close();
    } catch {
      // ignore shutdown errors
    }
  }

  target.server.close().catch(() => {
    // ignore close errors
  });
};

const getActiveSession = (sessionId: string): SessionEntry | undefined => {
  if (!sessionId) {
    return undefined;
  }
  const entry = sessions.get(sessionId);
  if (!entry) {
    return undefined;
  }
  if (isSessionExpired(entry)) {
    if (sessions.get(sessionId) === entry) {
      closeSession(sessionId, entry);
    } else {
      try {
        entry.transport.close();
      } catch {
        // ignore shutdown errors
      }
      entry.server.close().catch(() => {
        // ignore close errors
      });
    }
    return undefined;
  }
  return entry;
};

setInterval(() => {
  if (SESSION_TTL_MS <= 0) {
    return;
  }
  for (const [sessionId, entry] of sessions.entries()) {
    if (isSessionExpired(entry)) {
      closeSession(sessionId, entry);
    }
  }
}, 60_000).unref();

app.post('/mcp', mcpJsonParser, toolsCallLimiter, async (req: Request, res: Response) => {
  try {
    const sessionId = req.header(MCP_SESSION_HEADER) ?? '';
    const requestId =
      req.body && typeof req.body === 'object'
        ? (req.body as Record<string, unknown>).id ?? null
        : null;
    if (shuttingDown) {
      res.status(503).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Server shutting down' },
        id: requestId,
      });
      return;
    }
    let existing = getActiveSession(sessionId);
    if (!existing && sessionId) {
      await waitForPendingSession(sessionId);
      existing = getActiveSession(sessionId);
    }

    if (!existing) {
      if (sessionId) {
        res.status(401).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Invalid session ID' },
          id: requestId,
        });
        return;
      }
      if (!isInitialize(req.body)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Initialize first by POSTing an initialize request without Mcp-Session-Id header.',
          },
          id: requestId,
        });
        return;
      }
      const { server: sessionServer, toolNames } = createServer();
      const preSessionId = randomUUID();
      let initializedSessionId: string | undefined;
      let pending: Promise<void> | null = null;
      const pendingKeys = new Set<string>();
      const registerPendingKey = (key: string) => {
        if (!pending) {
          return;
        }
        pendingKeys.add(key);
        pendingSessions.set(key, pending);
      };

      res.setHeader(MCP_SESSION_HEADER, preSessionId);
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
        sessionIdGenerator: () => preSessionId,
        onsessioninitialized: (newId) => {
          const activeId = newId ?? preSessionId;
          initializedSessionId = activeId;
          if (!res.headersSent) {
            const currentHeader = res.getHeader(MCP_SESSION_HEADER);
            if (currentHeader !== activeId) {
              res.setHeader(MCP_SESSION_HEADER, activeId);
            }
          }
          registerPendingKey(activeId);
          sessions.set(activeId, {
            server: sessionServer,
            transport,
            toolNames: [...toolNames],
            createdAt: Date.now(),
            lastSeen: Date.now(),
          });
        },
        onsessionclosed: (closedId) => {
          closeSession(closedId, undefined, { initiatedByTransport: true });
        },
      });

      const run = async () => {
        await sessionServer.connect(transport);
        const payload = normalizeInitializePayload(req.body);
        try {
          await transport.handleRequest(asNode(req), asNodeRes(res), payload);
        } catch (error) {
          if (initializedSessionId) {
            closeSession(initializedSessionId);
          } else {
            try {
              transport.close();
            } catch {
              // ignore shutdown errors
            }
            sessionServer.close().catch(() => {
              // ignore close errors
            });
          }
          throw error;
        }
      };

      const pendingPromise = run();
      pending = pendingPromise;
      registerPendingKey(preSessionId);

      try {
        await pendingPromise;
      } finally {
        for (const key of pendingKeys) {
          // We intentionally compare the Promise object identity to avoid deleting a
          // newer promise that may have replaced this entry during a race.
          /* codeql[js/missing-await]: do not await here; identity comparison is intentional */
          const current = pendingSessions.get(key);
          if (Object.is(current, pendingPromise)) {
            pendingSessions.delete(key);
          }
        }
      }
      return;
    }

    existing.lastSeen = Date.now();
    await existing.transport.handleRequest(asNode(req), asNodeRes(res), req.body);
  } catch (error) {
    if (!res.headersSent) {
      const message = error instanceof Error ? error.message : String(error);
      const requestId =
        req.body && typeof req.body === 'object'
          ? (req.body as Record<string, unknown>).id ?? null
          : null;
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message },
        id: requestId,
      });
    }
  }
});

app.get('/mcp', async (req: Request, res: Response) => {
  if (shuttingDown) {
    res.status(503).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Server shutting down' },
      id: null,
    });
    return;
  }
  const sessionId = req.header(MCP_SESSION_HEADER) ?? '';
  let entry = getActiveSession(sessionId);
  if (!entry) {
    await waitForPendingSession(sessionId);
    entry = getActiveSession(sessionId);
  }
  if (!entry) {
    const status = sessionId ? 401 : 400;
    const message = sessionId ? 'Invalid session ID' : 'Missing session ID';
    res.status(status).json({
      jsonrpc: '2.0',
      error: { code: -32000, message },
      id: null,
    });
    return;
  }
  entry.lastSeen = Date.now();
  await entry.transport.handleRequest(asNode(req), asNodeRes(res));
});

app.delete('/mcp', async (req: Request, res: Response) => {
  if (shuttingDown) {
    res.status(503).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Server shutting down' },
      id: null,
    });
    return;
  }
  const sessionId = req.header(MCP_SESSION_HEADER) ?? '';
  let entry = getActiveSession(sessionId);
  if (!entry) {
    await waitForPendingSession(sessionId);
    entry = getActiveSession(sessionId);
  }
  if (!entry) {
    const status = sessionId ? 401 : 400;
    const message = sessionId ? 'Invalid session ID' : 'Missing session ID';
    res.status(status).json({
      jsonrpc: '2.0',
      error: { code: -32000, message },
      id: null,
    });
    return;
  }
  closeSession(sessionId, entry);
  res.status(204).end();
});

// General fallback defaults (these also work in CI)
const PORT = (() => {
  const raw = process.env.PORT ?? config.port ?? 8787;
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 1 || num > 65535) {
    throw new Error(`Invalid PORT: ${raw}`);
  }
  return num;
})();
const HOST = process.env.HOST ?? '127.0.0.1';

const stopHttpServer = async (): Promise<void> => {
  if (!httpServer) {
    return;
  }
  await new Promise<void>((resolve) => {
    httpServer?.close(() => {
      resolve();
    });
  });
  httpServer = null;
};

const handleShutdown = async (signal: NodeJS.Signals) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  const pending = Array.from(pendingSessions.values());
  pendingSessions.clear();
  await stopHttpServer();
  await Promise.allSettled(pending);
  for (const [sessionId, entry] of Array.from(sessions.entries())) {
    closeSession(sessionId, entry);
  }
  sessions.clear();
  if (signal === 'SIGINT') {
    logger.info('Received SIGINT, shut down gracefully.');
  } else if (signal === 'SIGTERM') {
    logger.info('Received SIGTERM, shut down gracefully.');
  }
};

(['SIGINT', 'SIGTERM'] as const).forEach((signal) => {
  process.once(signal, () => {
    void handleShutdown(signal);
  });
});

// Only start HTTP listener when executed as main AND not explicitly disabled.
if (IS_MAIN && !config.disableHttpListen) {
  try {
    httpServer = app.listen(PORT, HOST, () => {
      // Single-line log the CI can show when tailing server.log
      logger.info(`MCP server listening`, { host: HOST, port: PORT, path: '/mcp' });
    });
  } catch (e) {
    logger.error('Failed to start HTTP server', { error: String(e) });
    process.exit(1);
  }
} else {
  const { toolNames } = createServer();
  logger.info('Registered tools (listen disabled)', { toolNames });
}
