import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createService } from '../src/jobs.mjs';

const project = { id: 'example', name: 'Example', path: '/example', sources: ['AGENTS.md'] };
async function settled(service, id) {
  for (let n = 0; n < 100; n++) {
    const job = service.getStatus(id);
    if (['completed','failed','cancelled','timed_out'].includes(job.state)) return job;
    await delay(5);
  }
  assert.fail('Job did not settle');
}
function setup(worker, extra = {}) {
  return createService({ discover: async () => ({ projects: [project], warnings: [] }), codexWorker: worker, ...extra });
}
test('retry deduplication, result and followup preserve the selected workspace and mode', async (t) => {
  const received = [];
  const service = setup(async (payload) => { received.push({ ...payload }); return { text: 'Done', threadId: 'session' }; });
  t.after(() => service.close());
  const input = { project: project.id, prompt: 'Do a review', requestId: 'request-one' };
  const job = await service.startCodex(input);
  assert.equal((await service.startCodex(input)).jobId, job.jobId);
  await settled(service, job.jobId);
  assert.equal(service.getResult(job.jobId).result, 'Done');
  assert.equal(received.length, 1);
  await assert.rejects(service.startCodex({ ...input, prompt: 'Different' }), /different request/);
  const next = await service.followup({ jobId: job.jobId, prompt: 'Explain', requestId: 'request-two' });
  await settled(service, next.jobId);
  assert.deepEqual(received[1], { prompt: 'Explain', projectPath: '/example', mode: 'read-only', threadId: 'session' });
});
test('git-enabled mode is accepted, retained by followup and remains request-deduplicated', async (t) => {
  const received = [];
  const service = setup(async (payload) => { received.push({ ...payload }); return { text: 'Done', threadId: 'session' }; });
  t.after(() => service.close());
  const input = { project: project.id, prompt: 'Commit', mode: 'workspace-write-git', requestId: 'git-one' };
  const first = await service.startCodex(input);
  assert.equal((await service.startCodex(input)).jobId, first.jobId);
  await settled(service, first.jobId);
  const next = await service.followup({ jobId: first.jobId, prompt: 'Push', requestId: 'git-two' });
  await settled(service, next.jobId);
  assert.equal(received[0].mode, 'workspace-write-git');
  assert.equal(received[1].mode, 'workspace-write-git');
});
test('serial queue, cancellation and timeout propagate AbortSignal', async (t) => {
  let starts = 0;
  const service = setup(async (_, { signal }) => { starts++; await delay(1000, undefined, { signal }); }, { jobTimeoutMs: 40 });
  t.after(() => service.close());
  const first = await service.startCodex({ project: project.id, prompt: 'Wait', requestId: 'one' });
  const second = await service.startCodex({ project: project.id, prompt: 'Wait', requestId: 'two' });
  assert.equal(service.cancel(second.jobId).state, 'cancelled');
  assert.equal((await settled(service, first.jobId)).state, 'timed_out');
  assert.equal(starts, 1);
});
test('unknown project, disabled OpenAI and disallowed sandbox fail before execution', async (t) => {
  const service = setup(async () => assert.fail('must not run'));
  t.after(() => service.close());
  await assert.rejects(service.startCodex({ project: '/tmp/injected', prompt: 'Run', requestId: 'one' }), /ineligible/);
  await assert.rejects(service.startCodex({ project: project.id, prompt: 'Run', requestId: 'two', mode: 'danger-full-access' }), /sandbox/);
  await assert.rejects(service.startOpenAI({ prompt: 'Hi', requestId: 'three' }), /not configured/);
});
test('queued eligibility is revalidated and worker errors are not exposed', async (t) => {
  let eligible = true;
  const service = setup(async () => { throw new Error('EXAMPLE_NOT_A_SECRET_PRIVATE_FAILURE'); }, {
    discover: async () => ({ projects: eligible ? [project] : [], warnings: [] }),
  });
  t.after(() => service.close());
  const job = await service.startCodex({ project: project.id, prompt: 'Run', requestId: 'one' });
  eligible = false;
  const result = await settled(service, job.jobId);
  assert.equal(result.state, 'failed');
  assert.match(result.error, /no longer eligible/);
  eligible = true;
  const other = await service.startCodex({ project: project.id, prompt: 'Run', requestId: 'two' });
  assert.doesNotMatch((await settled(service, other.jobId)).error, /PRIVATE_FAILURE/);
});
test('bounded queue and retention evict only completed jobs', async (t) => {
  const service = setup(async () => ({ text: 'OK' }), { maxJobs: 2, maxQueue: 1 });
  t.after(() => service.close());
  const input = { project: project.id, prompt: 'Run' };
  const first = await service.startCodex({ ...input, requestId: 'one' });
  await assert.rejects(service.startCodex({ ...input, requestId: 'two' }), /queue is full/);
  await settled(service, first.jobId);
  const second = await service.startCodex({ ...input, requestId: 'two' });
  await settled(service, second.jobId);
  const third = await service.startCodex({ ...input, requestId: 'three' });
  await settled(service, third.jobId);
  assert.throws(() => service.getStatus(first.jobId), /expired/);
});

test('followup retries survive original job eviction, and removed eligibility does not hide retained requests', async (t) => {
  let eligible = true;
  const service = setup(async () => ({ text: 'OK', threadId: 'session' }), {
    maxJobs: 1,
    discover: async () => ({ projects: eligible ? [project] : [], warnings: [] }),
  });
  t.after(() => service.close());
  const first = await service.startCodex({ project: project.id, prompt: 'Run', requestId: 'one' });
  await settled(service, first.jobId);
  const input = { jobId: first.jobId, prompt: 'Continue', requestId: 'two' };
  const next = await service.followup(input);
  await settled(service, next.jobId);
  assert.throws(() => service.getStatus(first.jobId), /expired/);
  eligible = false;
  assert.equal((await service.followup(input)).jobId, next.jobId);
});

test('cancellation reason survives timeout while worker cleanup is in progress', async (t) => {
  const service = setup(async (_, { signal }) => {
    await new Promise(resolve => signal.addEventListener('abort', () => setTimeout(resolve, 50), { once: true }));
    return { text: 'Stopped' };
  }, { jobTimeoutMs: 20 });
  t.after(() => service.close());
  const job = await service.startCodex({ project: project.id, prompt: 'Wait', requestId: 'one' });
  await delay(5);
  service.cancel(job.jobId);
  assert.equal((await settled(service, job.jobId)).state, 'cancelled');
});

test('proxy switching preserves accepted work, retries, results and cancellation', async (t) => {
  let release;
  const started = new Promise(resolve => { release = resolve; });
  let unblock;
  const blocked = new Promise(resolve => { unblock = resolve; });
  let executions = 0;
  const service = setup(async () => {
    executions++;
    if (executions === 1) { release(); await blocked; }
    return { text: 'Done', threadId: 'session' };
  });
  t.after(() => { unblock(); return service.close(); });
  const input = { project: project.id, prompt: 'Run', requestId: 'one' };
  const first = await service.startCodex(input);
  await started;
  const queued = await service.startCodex({ ...input, requestId: 'two' });
  const cancelled = await service.startCodex({ ...input, requestId: 'three' });
  await service.setProxyEnabled(false);
  assert.equal(service.proxyStatus().execution, 'grok_approved_local_shell');
  assert.equal((await service.listProjects()).backends.codex, false);
  assert.equal(service.getStatus(first.jobId).state, 'running');
  assert.equal((await service.startCodex(input)).jobId, first.jobId);
  await assert.rejects(service.startCodex({ ...input, requestId: 'four' }), /Grok approved local Shell/);
  assert.equal(service.cancel(cancelled.jobId).state, 'cancelled');
  unblock();
  await settled(service, first.jobId);
  await settled(service, queued.jobId);
  assert.equal(service.getResult(first.jobId).result, 'Done');
  const followup = { jobId: first.jobId, prompt: 'Continue', requestId: 'next' };
  await assert.rejects(service.followup(followup), /proxy is disabled/);
  await service.setProxyEnabled(true);
  assert.equal((await service.listProjects()).backends.codex, true);
  const next = await service.followup(followup);
  await settled(service, next.jobId);
  const last = await service.startCodex({ ...input, requestId: 'four' });
  await settled(service, last.jobId);
  assert.equal(executions, 4);
});

test('disable during eligibility lookup rejects the new job, and failed persistence leaves mode unchanged', async (t) => {
  let finish;
  const service = setup(async () => assert.fail('must not execute'), {
    discover: () => new Promise(resolve => { finish = () => resolve({ projects: [project] }); }),
  });
  t.after(() => service.close());
  const pending = service.startCodex({ project: project.id, prompt: 'Run', requestId: 'race' });
  await service.setProxyEnabled(false);
  finish();
  await assert.rejects(pending, /proxy is disabled/);
  const failing = setup(async () => ({}), { proxyState: { enabled: true, persist: async () => { throw new Error('EXAMPLE_NOT_A_SECRET'); } } });
  t.after(() => failing.close());
  await assert.rejects(failing.setProxyEnabled(false), /mode was not changed/);
  assert.equal(failing.proxyStatus().enabled, true);
});
