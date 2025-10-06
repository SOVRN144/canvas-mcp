import 'dotenv/config';
import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
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
app.listen(PORT, () => console.log(`SANITY MCP on http://127.0.0.1:${PORT}/mcp`));
