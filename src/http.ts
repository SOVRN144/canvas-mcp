import cors from 'cors';
import express, { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MCP_SESSION_HEADER = 'Mcp-Session-Id';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS ?? 10 * 60 * 1000);

// ---- MCP server + echo tool ----
const server = new McpServer({ name: 'sanity-mcp', version: '0.0.6' });

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

// ---- Express wiring ----
const app = express();

const allowedOrigins = (process.env.CORS_ALLOW_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors((req, callback) => {
    const origin = req.header('Origin');
    if (!origin) {
      callback(null, { origin: true, exposedHeaders: [MCP_SESSION_HEADER] });
      return;
    }
    if (allowedOrigins.includes(origin)) {
      callback(null, { origin, exposedHeaders: [MCP_SESSION_HEADER] });
      return;
    }
    callback(new Error('Not allowed by CORS'));
  })
);

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

const respondInitializeFirst = (res: Response) =>
  res.status(400).json({
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message: 'Initialize first by POSTing an initialize request without Mcp-Session-Id header.',
    },
    id: null,
  });

const touch = (sessionId: string) => {
  const entry = sessions[sessionId];
  if (entry) {
    entry.lastSeen = Date.now();
  }
};

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, entry] of Object.entries(sessions)) {
    if (now - entry.lastSeen > SESSION_TTL_MS) {
      try {
        entry.transport.close();
      } catch {
        // ignore close errors during cleanup
      }
      delete sessions[sessionId];
    }
  }
}, 60_000).unref();

app.post('/mcp', async (req: Request, res: Response) => {
  try {
    const sessionId = req.header(MCP_SESSION_HEADER) ?? '';
    const existing = sessionId ? sessions[sessionId] : undefined;

    if (!existing) {
      if (sessionId || !isInitialize(req.body)) {
        respondInitializeFirst(res);
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
      await transport.handleRequest(asNode(req), asNodeRes(res), req.body);
      return;
    }

    touch(sessionId);
    await existing.transport.handleRequest(asNode(req), asNodeRes(res), req.body);
  } catch (error) {
    if (!res.headersSent) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message },
        id: null,
      });
    }
  }
});

app.get('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.header(MCP_SESSION_HEADER) ?? '';
  const entry = sessionId ? sessions[sessionId] : undefined;
  if (!entry) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  touch(sessionId);
  await entry.transport.handleRequest(asNode(req), asNodeRes(res));
});

app.delete('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.header(MCP_SESSION_HEADER) ?? '';
  const entry = sessionId ? sessions[sessionId] : undefined;
  if (!entry) {
    res.status(400).send('Invalid or missing session ID');
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
