import request from 'supertest';
import { app } from '../src/http.js';

describe('pending session races', () => {
  it('does not delete a newer pending promise for the same key', async () => {
    const initPayload = {
      jsonrpc: '2.0',
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    };

    const init1 = request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .send({ ...initPayload, id: 1 });

    const init2 = request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .send({ ...initPayload, id: 2 });

    const [res1, res2] = await Promise.all([init1, init2]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res1.headers['mcp-session-id']).toBeDefined();
    expect(res2.headers['mcp-session-id']).toBeDefined();
  });
});
