import 'dotenv/config';
import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import axios, { AxiosInstance } from 'axios';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MCP_SESSION_HEADER = 'Mcp-Session-Id';
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
// Robust TTL parsing with sane default (10m) when env is missing/empty/invalid
const rawSessionTtl = process.env.SESSION_TTL_MS;
const SESSION_TTL_MS = (() => {
  const v = rawSessionTtl ? Number.parseInt(rawSessionTtl, 10) : NaN;
  return Number.isFinite(v) && v > 0 ? v : 10 * 60 * 1000;
})();

// ---- MCP server + echo tool ----
// Derive version from runtime package metadata to avoid drift with package.json
const SERVER_VERSION = process.env.npm_package_version ?? '0.0.0';
const server = new McpServer({ name: 'sanity-mcp', version: SERVER_VERSION });

const registeredTools: string[] = [];
const originalRegisterTool = (server as any).registerTool?.bind(server);
if (typeof originalRegisterTool === 'function') {
  (server as any).registerTool = (name: string, def: unknown, handler: unknown) => {
    registeredTools.push(String(name));
    return originalRegisterTool(name, def, handler);
  };
}

const EchoInputShape = {
  text: z.string().describe('text to echo'),
};
const EchoInput = z.object(EchoInputShape);
server.registerTool(
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

const EnvCheckInputShape = {} as const;
const EnvCheckInput = z.object(EnvCheckInputShape);
server.registerTool(
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
  while (nextUrl) {
    try {
      const response = await canvasClient.get(nextUrl, { params: query });
      const data = response.data as unknown;
      if (!Array.isArray(data)) {
        const msg = parseCanvasErrors(data) || `Unexpected Canvas response for ${url}`;
        throw new Error(msg);
      }
      results.push(...(data as T[]));
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

if (hasCanvas && canvasClient) {
  const ListCoursesInputShape = {} as const;
  const ListCoursesInput = z.object(ListCoursesInputShape);
  server.registerTool(
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

  const ListModulesInputShape = {
    courseId: z.number(),
    includeItems: z.boolean().optional(),
  } as const;
  const ListModulesInput = z.object(ListModulesInputShape);
  server.registerTool(
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

  const ListFilesInputShape = {
    courseId: z.number(),
  } as const;
  const ListFilesInput = z.object(ListFilesInputShape);
  server.registerTool(
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

  const DownloadFileInputShape = {
    fileId: z.number(),
  } as const;
  const DownloadFileInput = z.object(DownloadFileInputShape);
  server.registerTool(
    'download_file',
    {
      title: 'Download file',
      description: 'Downloads a file by id to a temporary location',
      inputSchema: DownloadFileInputShape,
    },
    async (args) => {
      const { fileId } = DownloadFileInput.parse(args ?? {});
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
        const downloadResponse = await axios.get<ArrayBuffer>(downloadUrl, {
          responseType: 'arraybuffer',
          headers: { Authorization: `Bearer ${CANVAS_TOKEN}` },
        });
        await fs.writeFile(targetPath, Buffer.from(downloadResponse.data));
        const payload = { path: targetPath };
        return {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      });
    }
  );
}

// ---- Express wiring ----
const app = express();

const allowedOrigins = (process.env.CORS_ALLOW_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors((req, callback) => {
    const origin = req.header('Origin');
    const allow = !origin || allowedOrigins.includes(origin);
    if (allow) {
      callback(null, { origin: true, exposedHeaders: [MCP_SESSION_HEADER] });
      return;
    }
    callback(new Error('Not allowed by CORS'));
  })
);

app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof Error && err.message === 'Not allowed by CORS') {
    res.status(403).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'CORS origin not allowed' },
      id: null,
    });
    return;
  }
  next(err);
});

// Parse JSON only on POST /mcp
app.post(
  '/mcp',
  express.json({
    limit: '2mb',
    type: ['application/json', 'application/*+json', 'text/plain'],
  })
);

type NodeReq = IncomingMessage;
type NodeRes = ServerResponse;
const asNode = (req: Request): NodeReq => req as unknown as NodeReq;
const asNodeRes = (res: Response): NodeRes => res as unknown as NodeRes;

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  createdAt: number;
  lastSeen: number;
}
const sessions: Record<string, SessionEntry> = Object.create(null);

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

const isSessionExpired = (entry: SessionEntry) => Date.now() - entry.lastSeen > SESSION_TTL_MS;

const closeSession = (sessionId: string, entry: SessionEntry) => {
  try {
    entry.transport.close();
  } catch {
    // ignore shutdown errors
  }
  delete sessions[sessionId];
};

const getActiveSession = (sessionId: string): SessionEntry | undefined => {
  if (!sessionId) {
    return undefined;
  }
  const entry = sessions[sessionId];
  if (!entry) {
    return undefined;
  }
  if (isSessionExpired(entry)) {
    closeSession(sessionId, entry);
    return undefined;
  }
  return entry;
};

setInterval(() => {
  if (SESSION_TTL_MS <= 0) {
    return;
  }
  const now = Date.now();
  for (const [sessionId, entry] of Object.entries(sessions)) {
    if (now - entry.lastSeen > SESSION_TTL_MS) {
      closeSession(sessionId, entry);
    }
  }
}, 60_000).unref();

app.post('/mcp', async (req: Request, res: Response) => {
  try {
    const sessionId = req.header(MCP_SESSION_HEADER) ?? '';
    const requestId =
      req.body && typeof req.body === 'object'
        ? (req.body as Record<string, unknown>).id ?? null
        : null;
    const existing = getActiveSession(sessionId);

    if (!existing) {
      if (sessionId) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Invalid or missing session ID' },
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
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newId) => {
          sessions[newId] = {
            transport,
            createdAt: Date.now(),
            lastSeen: Date.now(),
          };
        },
        onsessionclosed: (closedId) => {
          delete sessions[closedId];
        },
      });

      await server.connect(transport);
      const payload = normalizeInitializePayload(req.body);
      await transport.handleRequest(asNode(req), asNodeRes(res), payload);
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
  const sessionId = req.header(MCP_SESSION_HEADER) ?? '';
  const entry = getActiveSession(sessionId);
  if (!entry) {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Invalid or missing session ID' },
      id: null,
    });
    return;
  }
  entry.lastSeen = Date.now();
  await entry.transport.handleRequest(asNode(req), asNodeRes(res));
});

app.delete('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.header(MCP_SESSION_HEADER) ?? '';
  const entry = getActiveSession(sessionId);
  if (!entry) {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Invalid or missing session ID' },
      id: null,
    });
    return;
  }
  try {
    entry.transport.close();
  } finally {
    delete sessions[sessionId];
  }
  res.status(204).end();
});

const PORT = Number(process.env.PORT ?? '8787');
const SHOULD_LISTEN = process.env.DISABLE_HTTP_LISTEN !== '1';
if (SHOULD_LISTEN) {
  app.listen(PORT, '127.0.0.1', () => console.log(`SANITY MCP on http://127.0.0.1:${PORT}/mcp`));
} else {
  console.log(JSON.stringify({ registeredTools }, null, 2));
}
