import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHttpServer } from '../src/http.mjs';
import { GatewayError } from '../src/jobs.mjs';

const token = 'EXAMPLE_NOT_A_SECRET';
const allowedHost = 'gateway.example.test';
const allowedOrigin = 'https://client.example.test';

// Node's fetch normalizes Host. Use the real HTTP transport when deliberately
// exercising hostile Host headers, including through the SDK's fetch hook.
function httpFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers)), signal: init.signal }, (incoming) => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('error', reject);
      incoming.on('end', () => resolve(new Response(
        [204, 304].includes(incoming.statusCode) ? null : Buffer.concat(chunks),
        { status: incoming.statusCode, headers: incoming.headers },
      )));
    });
    outgoing.on('error', reject);
    outgoing.end(init.body);
  });
}

async function fixture(t, overrides = {}) {
  const calls = [];
  const service = {
    listProjects: async () => ({ projects: [{ id: 'project-1', name: 'Example' }], warnings: [] }),
    proxyStatus: () => ({ enabled: true }),
    setProxyEnabled: async (enabled) => ({ enabled }),
    startCodex: async (input) => { calls.push(['codex', input]); return { jobId: 'job-1', status: 'queued' }; },
    followup: async (input) => { calls.push(['followup', input]); return { jobId: 'job-2', status: 'queued' }; },
    startOpenAI: async (input) => { calls.push(['openai', input]); return { jobId: 'job-3', status: 'queued' }; },
    getStatus: async (jobId) => ({ jobId, status: 'completed' }),
    getResult: async (jobId) => ({ jobId, result: 'Example result' }),
    cancel: async (jobId) => ({ jobId, status: 'cancelled' }),
    ...overrides,
  };
  const server = createHttpServer({ service, token, allowedHosts: [allowedHost], allowedOrigins: [allowedOrigin] });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const headers = { host: allowedHost, authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const send = (body, options = {}) => httpFetch(url, { method: 'POST', headers, body: JSON.stringify(body), ...options });
  const rpc = async (method, params = {}, id = 1) => {
    const response = await send({ jsonrpc: '2.0', id, method, params });
    assert.equal(response.status, 200);
    return response.json();
  };
  return { calls, server, url, headers, send, rpc };
}

test('official SDK client initializes, lists all tools, and starts/polls a job', async (t) => {
  const { calls, url, headers } = await fixture(t);
  const client = new Client({ name: 'gateway-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers }, fetch: httpFetch });
  t.after(() => client.close());
  await client.connect(transport);
  const listing = await client.listTools();
  assert.deepEqual(listing.tools.map((tool) => tool.name).sort(), ['projects_list', 'proxy_status', 'proxy_set_enabled', 'codex_start', 'codex_followup', 'openai_start', 'job_status', 'job_result', 'job_cancel'].sort());
  const projects = await client.callTool({ name: 'projects_list', arguments: {} });
  assert.equal(projects.structuredContent.projects[0].id, 'project-1');
  const started = await client.callTool({ name: 'codex_start', arguments: { project: 'project-1', prompt: 'Inspect this project', requestId: 'request-1' } });
  assert.equal(started.structuredContent.jobId, 'job-1');
  assert.deepEqual(calls, [['codex', { project: 'project-1', prompt: 'Inspect this project', mode: 'read-only', requestId: 'request-1' }]]);
  await client.callTool({ name: 'codex_start', arguments: { project: 'project-1', prompt: 'Commit authorized changes', mode: 'workspace-write-git', requestId: 'request-git-1' } });
  assert.equal(calls[1][1].mode, 'workspace-write-git');
  assert.equal((await client.callTool({ name: 'job_status', arguments: { jobId: 'job-1' } })).structuredContent.status, 'completed');
  assert.equal((await client.callTool({ name: 'job_result', arguments: { jobId: 'job-1' } })).structuredContent.result, 'Example result');
  assert.equal((await client.callTool({ name: 'codex_followup', arguments: { jobId: 'job-1', prompt: 'Explain more', requestId: 'request-2' } })).structuredContent.jobId, 'job-2');
  assert.equal((await client.callTool({ name: 'openai_start', arguments: { prompt: 'Explain MCP', requestId: 'request-3' } })).structuredContent.jobId, 'job-3');
  assert.equal((await client.callTool({ name: 'job_cancel', arguments: { jobId: 'job-1' } })).structuredContent.status, 'cancelled');
});

test('legacy MCP initialize and stateless POST requests work without a session', async (t) => {
  const { send, rpc } = await fixture(t);
  const response = await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'legacy-test', version: '1.0.0' } } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('mcp-session-id'), null);
  assert.equal((await response.json()).result.serverInfo.name, 'grok-codex-gateway');
  assert.equal((await send({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  assert.equal((await rpc('tools/list')).result.tools.length, 9);
});

test('bearer authentication, exact Host and Origin gates reject unauthorized calls', async (t) => {
  const { send, headers, calls } = await fixture(t);
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  const cases = [
    [{ ...headers, authorization: '' }, 401],
    [{ ...headers, authorization: 'Bearer EXAMPLE_WRONG_NOT_A_SECRET' }, 401],
    [{ ...headers, host: 'attacker.example.test', 'x-forwarded-host': allowedHost }, 403],
    [{ ...headers, host: `${allowedHost}:9999` }, 403],
    [{ ...headers, origin: 'https://attacker.example.test' }, 403],
    [{ ...headers, origin: `${allowedOrigin}:8443` }, 403],
    [{ ...headers, origin: 'null' }, 403],
  ];
  for (const [requestHeaders, expected] of cases) {
    const response = await send(body, { headers: requestHeaders });
    assert.equal(response.status, expected);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  assert.equal((await send(body, { headers: { ...headers, origin: allowedOrigin } })).status, 200);
  assert.deepEqual(calls, []);
});

test('limits body size for declared and chunked requests without dispatching a job', async (t) => {
  const { send, headers, url, calls } = await fixture(t);
  const large = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'codex_start', arguments: { project: 'project-1', prompt: 'x'.repeat(140_000) } } });
  assert.equal((await send({}, { body: large })).status, 413);
  const chunkedStatus = await new Promise((resolve, reject) => {
    const outgoing = request(url, { method: 'POST', headers }, (incoming) => { incoming.resume(); incoming.on('end', () => resolve(incoming.statusCode)); });
    outgoing.on('error', reject);
    outgoing.write(large.slice(0, 70_000));
    outgoing.end(large.slice(70_000));
  });
  assert.equal(chunkedStatus, 413);
  assert.deepEqual(calls, []);
});

test('rejects invalid transport requests and keeps health response generic', async (t) => {
  const { send, headers, url } = await fixture(t);
  assert.equal((await send({}, { headers: { ...headers, 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await send({}, { headers: { ...headers, 'content-encoding': 'gzip' } })).status, 415);
  assert.equal((await send({}, { body: '{invalid' })).status, 400);
  for (const method of ['GET', 'DELETE', 'OPTIONS']) {
    const response = await httpFetch(url, { method, headers });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
  }
  assert.equal((await httpFetch(`${url}?token=${token}`, { headers: { host: allowedHost } })).status, 404);
  const health = await httpFetch(url.replace('/mcp', '/healthz'), { headers: { host: allowedHost } });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  assert.equal(health.headers.get('cache-control'), 'no-store');
});

test('tool schemas bound prompts, IDs, mode and additional properties', async (t) => {
  const { rpc, calls } = await fixture(t);
  for (const args of [
    { project: 'project-1', prompt: 'x'.repeat(32_001) },
    { project: 'project-1', prompt: '   ' },
    { project: '../private', prompt: 'hello' },
    { project: 'x'.repeat(161), prompt: 'hello' },
    { project: 'project-1', prompt: 'hello', mode: 'danger-full-access' },
    { project: 'project-1', prompt: 'hello', mode: 'workspace-write-git', requestId: '' },
    { project: 'project-1', prompt: 'hello', arbitraryCommand: 'disallowed' },
  ]) {
    const response = await rpc('tools/call', { name: 'codex_start', arguments: args });
    assert.ok(response.error || response.result?.isError);
  }
  assert.deepEqual(calls, []);
});

test('only deliberately public service errors are exposed', async (t) => {
  const { rpc } = await fixture(t, {
    getResult: async () => { throw new Error('INTERNAL_DIAGNOSTIC_NOT_FOR_CLIENTS'); },
    getStatus: async () => { throw new GatewayError('Job not found.'); },
  });
  const internal = await rpc('tools/call', { name: 'job_result', arguments: { jobId: 'job-1' } });
  assert.equal(internal.result.isError, true);
  assert.ok(!JSON.stringify(internal).includes('INTERNAL_DIAGNOSTIC_NOT_FOR_CLIENTS'));
  const safe = await rpc('tools/call', { name: 'job_status', arguments: { jobId: 'job-1' } });
  assert.equal(safe.result.structuredContent.error, 'Job not found.');
});

test('unsafe listener configuration fails closed', () => {
  const service = {};
  assert.throws(() => createHttpServer({ service, token: '', allowedHosts: [allowedHost] }));
  assert.throws(() => createHttpServer({ service, token, allowedHosts: ['*'] }));
  assert.throws(() => createHttpServer({ service, token, allowedHosts: [] }));
  assert.throws(() => createHttpServer({ service, token, allowedHosts: [allowedHost], allowedOrigins: ['https://*'] }));
});
