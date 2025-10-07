import request from 'supertest';

process.env.DISABLE_HTTP_LISTEN = '1';

const loadApp = async () => {
  const mod = await import('./http.js');
  if (!mod.app) throw new Error('Failed to load Express app');
  return mod.app as import('express').Express;
};

const ci = (msg: string) => console.log(msg);

(async () => {
  const app = await loadApp();
  let pass = true;
  let healthOk = false;
  let initOk = false;
  let listOk = false;
  let echoOk = false;
  let badOk = false;
  let delOk = false;
  let afterOk = false;

  ci('### /healthz');
  const health = await request(app).get('/healthz');
  healthOk = health.status === 200 && typeof health.body === 'object';
  if (!healthOk) pass = false;
  console.log({ status: health.status, body: health.body });

  ci('### initialize');
  const init = await request(app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json')
    .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  const sessionHeader = init.headers['mcp-session-id'] as string | undefined;
  initOk = init.status === 200 && !!sessionHeader;
  if (!initOk) pass = false;
  console.log({ status: init.status, body: init.body, sessionId: sessionHeader });

  const sessionId = sessionHeader ?? '';

  ci('### tools/list');
  const list = await request(app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json')
    .set('Mcp-Session-Id', sessionId)
    .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const tools = Array.isArray(list.body?.result?.tools) ? list.body.result.tools : [];
  listOk = list.status === 200 && tools.some((tool: any) => tool?.name === 'echo');
  if (!listOk) pass = false;
  console.log({ status: list.status, tools: tools.map((t: any) => t?.name) });

  ci('### tools/call echo (ok)');
  const echo = await request(app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json')
    .set('Mcp-Session-Id', sessionId)
    .send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hello' } } });
  const echoText = echo.body?.result?.content?.[0]?.text;
  echoOk = echo.status === 200 && echoText === 'hello';
  if (!echoOk) pass = false;
  console.log({ status: echo.status, echoText });

  ci('### tools/call echo (bad args)');
  const bad = await request(app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json')
    .set('Mcp-Session-Id', sessionId)
    .send({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'echo', arguments: {} } });
  badOk = bad.status === 200 && bad.body?.id === 42 && bad.body?.error;
  if (!badOk) pass = false;
  console.log({ status: bad.status, body: bad.body });

  ci('### DELETE /mcp');
  const del = await request(app).delete('/mcp').set('Mcp-Session-Id', sessionId);
  delOk = del.status === 204;
  if (!delOk) pass = false;
  console.log({ status: del.status });

  ci('### tools/list after delete (should error)');
  const after = await request(app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json')
    .set('Mcp-Session-Id', sessionId)
    .send({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} });
  const afterMessage = after.body?.error?.message ?? '';
  afterOk = after.status === 401 && /invalid or missing session id/i.test(afterMessage);
  if (!afterOk) pass = false;
  console.log({ status: after.status, body: after.body });

  console.log('\n=== SUMMARY ===');
  console.log({ healthOk, initOk, listOk, echoOk, badOk, delOk, afterOk });

  process.exit(pass ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
