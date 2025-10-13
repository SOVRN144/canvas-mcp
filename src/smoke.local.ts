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
  let getMissingOk = false;
  let getInvalidOk = false;
  let delOk = false;
  let deleteInvalidOk = false;
  let afterOk = false;

  ci('### /healthz');
  const health = await request(app).get('/healthz');
  healthOk = health.status === 200 && typeof health.body === 'object';
  if (!healthOk) pass = false;
  console.log({ status: health.status, body: health.body });

  ci('### GET /mcp (missing session)');
  const getMissing = await request(app).get('/mcp');
  const missingMessage = getMissing.body?.error?.message ?? '';
  getMissingOk = getMissing.status === 400 && /missing session id/i.test(missingMessage);
  if (!getMissingOk) pass = false;
  console.log({ status: getMissing.status, body: getMissing.body });

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
  const toolNames = tools
    .map((tool) => {
      if (tool && typeof tool === 'object' && 'name' in tool) {
        const name = (tool as { name?: unknown }).name;
        return typeof name === 'string' ? name : undefined;
      }
      return undefined;
    })
    .filter((name): name is string => typeof name === 'string');
  listOk = list.status === 200 && toolNames.includes('echo');
  if (!listOk) pass = false;
  console.log({ status: list.status, tools: toolNames });

  if (toolNames.includes('list_courses')) {
    ci('### tools/call list_courses');
    const listCourses = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .set('Mcp-Session-Id', sessionId)
      .send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_courses', arguments: {} } });
    const courses = listCourses.body?.result?.structuredContent?.courses;
    if (Array.isArray(courses)) {
      console.log({ status: listCourses.status, count: courses.length, sample: courses.slice(0, 3) });
    } else {
      console.log('::notice::list_courses unavailable (Canvas 5xx or shape mismatch) — continuing');
    }
  }

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

  ci('### GET /mcp (invalid session)');
  const getInvalid = await request(app)
    .get('/mcp')
    .set('Mcp-Session-Id', `${sessionId}-invalid`);
  const invalidGetMessage = getInvalid.body?.error?.message ?? '';
  getInvalidOk = getInvalid.status === 401 && /invalid session id/i.test(invalidGetMessage);
  if (!getInvalidOk) pass = false;
  console.log({ status: getInvalid.status, body: getInvalid.body });

  ci('### DELETE /mcp');
  const del = await request(app).delete('/mcp').set('Mcp-Session-Id', sessionId);
  delOk = del.status === 204;
  if (!delOk) pass = false;
  console.log({ status: del.status });

  ci('### DELETE /mcp (invalid session)');
  const deleteInvalid = await request(app)
    .delete('/mcp')
    .set('Mcp-Session-Id', `${sessionId}-invalid`);
  const invalidDeleteMessage = deleteInvalid.body?.error?.message ?? '';
  deleteInvalidOk = deleteInvalid.status === 401 && /invalid session id/i.test(invalidDeleteMessage);
  if (!deleteInvalidOk) pass = false;
  console.log({ status: deleteInvalid.status, body: deleteInvalid.body });

  ci('### tools/list after delete (should error)');
  const after = await request(app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json')
    .set('Mcp-Session-Id', sessionId)
    .send({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} });
  const afterMessage = after.body?.error?.message ?? '';
  afterOk = after.status === 401 && /invalid session id/i.test(afterMessage);
  if (!afterOk) pass = false;
  console.log({ status: after.status, body: after.body });

  console.log('\n=== SUMMARY ===');
  console.log({
    healthOk,
    getMissingOk,
    initOk,
    listOk,
    echoOk,
    badOk,
    getInvalidOk,
    delOk,
    deleteInvalidOk,
    afterOk,
  });

  process.exit(pass ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
