import cors from 'cors';
import express, { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const MCP_SESSION_HEADER = 'Mcp-Session-Id';

// ---- MCP server + one simple tool (Echo) ----
const server = new McpServer({ name: 'sanity-mcp', version: '0.0.5' });

const EchoInputShape = {
  text: z.string().describe('text to echo')
};
const EchoInput = z.object(EchoInputShape);
server.registerTool(
  'echo',
  {
    title: 'Echo',
    description: 'Returns the text you send',
    inputSchema: EchoInputShape
  },
  (args) => {
    const { text } = EchoInput.parse(args);
    return { content: [{ type: 'text', text }] };
  }
);

// ---- Express + Streamable HTTP transport (session-managed) ----
const app = express();
app.use(cors({ origin: '*', exposedHeaders: [MCP_SESSION_HEADER] }));

// parse JSON only on POST /mcp so req.body is available
app.post('/mcp', express.json({
  limit: '2mb',
  type: ['application/json', 'application/*+json', 'text/plain']
}));

const sessions: Record<string, StreamableHTTPServerTransport> = Object.create(null);
const isInitialize = (b: any) => b && b.jsonrpc === '2.0' && b.method === 'initialize';

app.post('/mcp', async (req: Request, res: Response) => {
  try {
    const sid = req.header(MCP_SESSION_HEADER) || '';
    const transport = sid ? sessions[sid] : undefined;

    if (!transport) {
      // first contact MUST be initialize without a session header
      if (sid || !isInitialize(req.body)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: Server not initialized' },
          id: null
        });
        return;
      }

      const newTransport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newId) => {
          sessions[newId] = newTransport;
        },
        onsessionclosed: (closedId) => {
          delete sessions[closedId];
        }
      });

      await server.connect(newTransport);
      await newTransport.handleRequest(req as any, res as any, req.body);
      return;
    }

    await transport.handleRequest(req as any, res as any, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        id: null
      });
    }
  }
});

// GET /mcp for SSE on existing session
app.get('/mcp', async (req: Request, res: Response) => {
  const sid = req.header(MCP_SESSION_HEADER) || '';
  const transport = sid ? sessions[sid] : undefined;
  if (!transport) return res.status(400).send('Invalid or missing session ID');
  await transport.handleRequest(req as any, res as any);
});

// DELETE /mcp to close session
app.delete('/mcp', async (req: Request, res: Response) => {
  const sid = req.header(MCP_SESSION_HEADER) || '';
  const transport = sid ? sessions[sid] : undefined;
  if (!transport) return res.status(400).send('Invalid or missing session ID');
  try {
    transport.close();
  } finally {
    delete sessions[sid];
  }
  res.status(204).end();
});

const PORT = Number(process.env.PORT ?? '8787');
app.listen(PORT, () => console.error(`SANITY MCP on http://127.0.0.1:${PORT}/mcp`));
