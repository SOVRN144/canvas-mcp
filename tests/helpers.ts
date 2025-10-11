// tests/helpers.ts
import type { SuperTest, Test } from 'supertest';
import supertest from 'supertest';

export async function loadAppWithEnv(overrides: Record<string, string> = {}) {
  // Set env first so config snapshots pick it up on import
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;

  // Ensure modules re-read env
  const viAny: any = (global as any).vi ?? undefined;
  if (viAny?.resetModules) viAny.resetModules();

  // Import app AFTER env is set
  const { app } = await import('../src/http.js');

  const request: SuperTest<Test> = supertest(app);

  // Initialize session (MCP contract)
  const init = await request
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } }
    });

  if (init.status !== 200) {
    throw new Error(`initialize failed: ${init.status} ${JSON.stringify(init.body)}`);
  }
  const sid = init.headers['mcp-session-id'];
  if (!sid) throw new Error('initialize did not return Mcp-Session-Id header');

  return { app, request, sessionId: sid as string };
}
