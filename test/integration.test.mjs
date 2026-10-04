import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createService } from '../src/jobs.mjs';
import { createHttpServer } from '../src/http.mjs';

test('HTTP tool schemas and the real job service agree on modes, errors and retries', async (t) => {
  let executions = 0;
  const service = createService({
    discover: async () => ({ projects: [{ id: 'example', path: '/example', name: 'Example', sources: ['AGENTS.md'] }], warnings: [] }),
    codexWorker: async (payload) => {
      executions++;
      assert.equal(payload.mode, 'read-only');
      return { text: 'Gateway integration verified' };
    },
  });
  const server = createHttpServer({ service, token: 'EXAMPLE_NOT_A_SECRET', allowedHosts: ['gateway.example.test'] });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { await service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const call = (name, args) => new Promise((resolve, reject) => {
    const outgoing = request(`http://127.0.0.1:${server.address().port}/mcp`, {
      method: 'POST', headers: { host: 'gateway.example.test', authorization: 'Bearer EXAMPLE_NOT_A_SECRET',
        accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    }, (incoming) => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', chunk => { body += chunk; });
      incoming.on('end', () => { try { resolve(JSON.parse(body).result); } catch (error) { reject(error); } });
    });
    outgoing.on('error', reject);
    outgoing.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }));
  });
  const input = { project: 'example', prompt: 'Inspect', requestId: 'one' };
  assert.equal((await call('proxy_status', {})).structuredContent.enabled, true);
  assert.equal((await call('proxy_set_enabled', { enabled: false })).structuredContent.enabled, false);
  assert.equal((await call('projects_list', {})).structuredContent.backends.codex, false);
  assert.equal((await call('codex_start', input)).isError, true);
  assert.equal((await call('proxy_set_enabled', { enabled: 'true' })).isError, true);
  await call('proxy_set_enabled', { enabled: true });
  const start = await call('codex_start', input);
  assert.ok(!start.isError);
  const id = start.structuredContent.jobId;
  assert.equal((await call('codex_start', input)).structuredContent.jobId, id);
  let result;
  for (let n = 0; n < 100; n++) {
    result = await call('job_result', { jobId: id });
    if (result.structuredContent.state === 'completed') break;
    await delay(5);
  }
  assert.equal(result.structuredContent.result, 'Gateway integration verified');
  assert.equal(executions, 1);
  const failed = await call('codex_start', { ...input, project: 'unlisted', requestId: 'two' });
  assert.equal(failed.isError, true);
  assert.match(failed.structuredContent.error, /ineligible/);
});
