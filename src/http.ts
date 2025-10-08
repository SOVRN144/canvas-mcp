import 'dotenv/config';
import cors from 'cors';
import express, { NextFunction, type Request, type Response, type ErrorRequestHandler } from 'express';
import axios, { AxiosInstance, AxiosHeaders, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Transform, type TransformCallback, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

const MCP_SESSION_HEADER = 'Mcp-Session-Id';
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_PAGES = 100;
const MAX_RESULTS = 10_000;
// Robust TTL parsing with sane default (10m) when env is missing/empty/invalid
const rawSessionTtl = process.env.SESSION_TTL_MS;
const SESSION_TTL_MS = (() => {
  const v = rawSessionTtl ? Number.parseInt(rawSessionTtl, 10) : NaN;
  return Number.isFinite(v) && v > 0 ? v : 10 * 60 * 1000;
})();
const isProduction = process.env.NODE_ENV === 'production';
const DEBUG_TOKEN = process.env.DEBUG_TOKEN?.trim() ?? '';

// ---- MCP server configuration + tool schemas ----
// Derive version from runtime package metadata to avoid drift with package.json
const SERVER_VERSION = process.env.npm_package_version ?? '0.0.0';

const EchoInputShape = {
  text: z.string().describe('text to echo'),
} as const;
const EchoInput = z.object(EchoInputShape);

const EnvCheckInputShape = {} as const;
const EnvCheckInput = z.object(EnvCheckInputShape);

const CANVAS_BASE_URL = process.env.CANVAS_BASE_URL?.trim() || '';
const CANVAS_TOKEN = process.env.CANVAS_TOKEN?.trim() || '';
const hasCanvas = Boolean(CANVAS_BASE_URL && CANVAS_TOKEN);

const canvasClient: AxiosInstance | null = hasCanvas
  ? axios.create({
      baseURL: CANVAS_BASE_URL,
      headers: { Authorization: `Bearer ${CANVAS_TOKEN}` },
      timeout: 15_000,
    })
  : null;

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
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const statusText = error.response?.statusText;
    const details = parseCanvasErrors(error.response?.data);
    const fallback = typeof error.message === 'string' ? error.message : 'Canvas request failed';
    const description = [status ? `Canvas API ${status}${statusText ? ` ${statusText}` : ''}` : 'Canvas API error', details || fallback]
      .filter(Boolean)
      .join(': ');
    throw new Error(description);
  }
  if (error instanceof Error) {
    throw error;
  }
  throw new Error(String(error));
};

const withCanvasErrors = async <T>(operation: () => Promise<T>): Promise<T> => {
  return await operation().catch((error) => {
    raiseCanvasError(error);
    return undefined as never;
  });
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
  if (!canvasClient) {
    throw new Error('Canvas client not configured');
  }
  const results: T[] = [];
  let nextUrl: string | null = url;
  let query = params;
  let pageCount = 0;
  const seenPaths = new Set<string>();
  const resolutionBase = canvasClient.defaults?.baseURL ?? CANVAS_BASE_URL;
  if (!resolutionBase) {
    throw new Error('No Canvas base URL configured for pagination.');
  }

  while (nextUrl) {
    try {
      pageCount += 1;
      if (pageCount > MAX_PAGES) {
        throw new Error(`Pagination exceeded maximum page limit (${MAX_PAGES}).`);
      }

      const currentUrl = new URL(nextUrl, resolutionBase);
      const normalizedPath = `${currentUrl.pathname}${currentUrl.search}`;
      if (seenPaths.has(normalizedPath)) {
        throw new Error('Pagination loop detected while fetching Canvas data.');
      }
      seenPaths.add(normalizedPath);

      const response =
        query !== undefined
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

const sanitizeFilename = (name: string): string =>
  name.replace(/[\\/:*?"<>|]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'file';

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
        hasCanvasBaseUrl: Boolean(process.env.CANVAS_BASE_URL),
        hasCanvasToken: Boolean(process.env.CANVAS_TOKEN),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(summary) }],
        structuredContent: summary,
      };
    }
  );

  if (hasCanvas && canvasClient) {
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
          const courses = await getAll<{ id: number; name?: string; course_code?: string; short_name?: string }>(
            '/api/v1/courses',
            {
              per_page: 100,
              'enrollment_type[]': 'student',
              enrollment_state: 'active',
            }
          );
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

    addTool(
      'download_file',
      {
        title: 'Download file',
        description: 'Downloads a file by id to a temporary location',
        inputSchema: DownloadFileInputShape,
      },
      async (args) => {
        const { fileId, maxSize: requestedMaxSize } = DownloadFileInput.parse(args ?? {});
        return withCanvasErrors(async () => {
          const metadataResponse = await canvasClient.get(`/api/v1/files/${fileId}`);
          const file = metadataResponse.data as {
            display_name?: string;
            filename?: string;
            url?: string;
            public_url?: string;
          };
          const downloadUrl = file.url ?? file.public_url;
          if (!downloadUrl) {
            throw new Error('File does not expose a downloadable URL');
          }
          const baseName = file.display_name || file.filename || `file-${fileId}`;
          const safeBase = sanitizeFilename(baseName);
          const extension = path.extname(safeBase);
          const stem = extension ? safeBase.slice(0, -extension.length) : safeBase;
          const filename = `${stem || 'file'}-${fileId}-${Date.now()}${extension}`;
          const targetPath = path.join(os.tmpdir(), filename);
          const normalizedMaxSize = Math.min(requestedMaxSize ?? MAX_FILE_SIZE, MAX_FILE_SIZE);

          const allowedHosts = new Set<string>();
          let baseHost: string | null = null;
          if (CANVAS_BASE_URL) {
            try {
              const baseUrl = new URL(CANVAS_BASE_URL);
              if (baseUrl.protocol === 'https:') {
                baseHost = baseUrl.hostname.toLowerCase();
                allowedHosts.add(baseHost);
              }
            } catch {
              baseHost = null;
            }
          }

          let initialHost: string;
          try {
            const initialUrl = new URL(downloadUrl);
            if (initialUrl.protocol !== 'https:') {
              throw new Error('Only HTTPS downloads are allowed');
            }
            initialHost = initialUrl.hostname.toLowerCase();
            allowedHosts.add(initialHost);
          } catch {
            throw new Error('Download URL is invalid');
          }

          // Known Canvas CDN hostnames can be allowed without forwarding credentials
          allowedHosts.add('files.instructure.com');
          allowedHosts.add('canvas-user-content.com');

          const shouldSendAuthForHost = (hostname: string) =>
            Boolean(CANVAS_TOKEN) && baseHost !== null && hostname === baseHost;

          const fetchBinary = async (
            urlString: string,
            remainingRedirects: number,
            sendAuth: boolean
          ): Promise<AxiosResponse<Readable>> => {
            const currentUrl = new URL(urlString);
            const headers =
              sendAuth && CANVAS_TOKEN
                ? AxiosHeaders.from({ Authorization: `Bearer ${CANVAS_TOKEN}` })
                : undefined;

            try {
              const requestConfig: AxiosRequestConfig<unknown> = {
                responseType: 'stream',
                maxRedirects: 0,
                maxContentLength: normalizedMaxSize,
                maxBodyLength: normalizedMaxSize,
                timeout: 30_000,
                validateStatus: (status) => status >= 200 && status < 300,
              };
              if (headers) {
                requestConfig.headers = headers;
              }

              const response = await axios.get<Readable>(currentUrl.toString(), requestConfig);

              const contentLengthHeader = response.headers['content-length'];
              if (typeof contentLengthHeader === 'string') {
                const length = Number.parseInt(contentLengthHeader, 10);
                if (Number.isFinite(length) && length > normalizedMaxSize) {
                  throw new Error(`File exceeds maximum size of ${normalizedMaxSize} bytes`);
                }
              }

              return response;
            } catch (error) {
              if (
                axios.isAxiosError(error) &&
                error.response &&
                error.response.status >= 300 &&
                error.response.status < 400
              ) {
                if (remainingRedirects <= 0) {
                  throw new Error('Too many redirects while downloading file');
                }
                const locationHeader =
                  error.response.headers?.['location'] ?? error.response.headers?.['Location'];
                if (!locationHeader) {
                  throw new Error('Redirect response missing Location header');
                }
                const nextUrl = new URL(locationHeader, currentUrl);
                if (nextUrl.protocol !== 'https:') {
                  throw new Error('Redirected to non-HTTPS URL');
                }
                const nextHost = nextUrl.hostname.toLowerCase();
                if (!allowedHosts.has(nextHost)) {
                  throw new Error(`Redirected to disallowed host: ${nextHost}`);
                }
                const nextSendAuth = shouldSendAuthForHost(nextHost);
                return fetchBinary(nextUrl.toString(), remainingRedirects - 1, nextSendAuth);
              }
              throw error;
            }
          };

          const downloadResponse = await fetchBinary(
            downloadUrl,
            3,
            shouldSendAuthForHost(initialHost)
          );

          const readableStream = downloadResponse.data;
          let streamedBytes = 0;
          const sizeGuard = new Transform({
            transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
              const projectedSize = streamedBytes + chunk.length;
              if (projectedSize > normalizedMaxSize) {
                callback(new Error(`File exceeds maximum size of ${normalizedMaxSize} bytes`));
                return;
              }
              streamedBytes = projectedSize;
              callback(null, chunk);
            },
          });

          const writer = createWriteStream(targetPath, { flags: 'w' });
          try {
            await pipeline(readableStream, sizeGuard, writer);
          } catch (error) {
            await fs.unlink(targetPath).catch(() => undefined);
            throw error;
          }

          const cleanupTimer = setTimeout(() => {
            void fs.unlink(targetPath).catch(() => undefined);
          }, 5 * 60 * 1000);
          cleanupTimer.unref();
          const payload = { path: targetPath };
          return {
            content: [{ type: 'text', text: JSON.stringify(payload) }],
            structuredContent: payload,
          };
        });
      }
    );
  }

  return { server, toolNames };
};

// ---- Express wiring ----
export const app = express();

const allowedOrigins = (process.env.CORS_ALLOW_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

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
          if (pendingSessions.get(key) === pendingPromise) {
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

const PORT = Number(process.env.PORT ?? '8787');
const SHOULD_LISTEN = process.env.DISABLE_HTTP_LISTEN !== '1';

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
    console.log('Received SIGINT, shut down gracefully.');
  } else if (signal === 'SIGTERM') {
    console.log('Received SIGTERM, shut down gracefully.');
  }
};

(['SIGINT', 'SIGTERM'] as const).forEach((signal) => {
  process.once(signal, () => {
    void handleShutdown(signal);
  });
});

if (SHOULD_LISTEN) {
  httpServer = app.listen(PORT, '127.0.0.1', () => console.log(`SANITY MCP on http://127.0.0.1:${PORT}/mcp`));
} else {
  const { toolNames } = createServer();
  console.log(JSON.stringify({ registeredTools: toolNames }, null, 2));
}
