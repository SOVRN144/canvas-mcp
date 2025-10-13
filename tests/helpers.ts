import supertest from 'supertest';
import { vi } from 'vitest';

import type { Express } from 'express';
import type { SuperTest, Test } from 'supertest';

type LoadedApp = {
  app: Express;
  request: SuperTest<Test>;
  sessionId: string;
};

export async function loadAppWithEnv(
  overrides: Record<string, string> = {}
): Promise<LoadedApp> {
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }

  vi.resetModules();

  const httpModule = await import('../src/http.js');
  const { app } = httpModule;
  if (!app) {
    throw new Error('HTTP module did not export an app instance');
  }

  const request = supertest(app);
  const init = await request
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });

  if (init.status !== 200) {
    throw new Error(`initialize failed: ${init.status} ${JSON.stringify(init.body)}`);
  }

  const sessionHeader = init.headers['mcp-session-id'];
  if (typeof sessionHeader !== 'string') {
    throw new Error('initialize did not return a single Mcp-Session-Id header');
  }

  return { app, request, sessionId: sessionHeader };
}

export function requireSessionId(header: string | string[] | undefined): string {
  if (typeof header === 'string') {
    return header;
  }
  if (Array.isArray(header)) {
    const [first] = header;
    if (typeof first === 'string') {
      return first;
    }
  }
  throw new Error('expected a single Mcp-Session-Id header');
}

export function findTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if ('type' in item && (item as { type?: unknown }).type === 'text') {
      const textValue = (item as { text?: unknown }).text;
      if (typeof textValue === 'string') {
        return textValue;
      }
    }
  }
  return '';
}

export function extractErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const result = (body as { result?: unknown }).result;
  if (result && typeof result === 'object') {
    const structured = result as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    if (structured.isError) {
      const textEntry = structured.content?.[0]?.text;
      if (typeof textEntry === 'string') {
        return textEntry;
      }
    }
  }
  const error = (body as { error?: { message?: unknown } }).error;
  if (error && typeof error.message === 'string') {
    return error.message;
  }
  return undefined;
}
