import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexWorker, createOpenAIWorker } from '../src/workers.mjs';

const THREAD_ID = '00000000-0000-0000-0000-000000000001';
const request = { prompt: 'Review this project.', projectPath: tmpdir(), mode: 'read-only' };
const emit = `const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');`;
const success = `${emit}
  emit({type:'thread.started',thread_id:'${THREAD_ID}'});
  emit({type:'item.completed',item:{type:'agent_message',text:'Completed safely.'}});
  emit({type:'turn.completed'});`;

function fixture(code, capture = () => {}) {
  return (bin, args, options) => {
    capture({ bin, args, options });
    return spawn(process.execPath, ['-e', code], options);
  };
}

test('Codex uses an argument array, stdin, bounded sandbox, and a credential-free child environment', async () => {
  let invocation;
  const progress = [];
  const prompt = 'Literal `command` $(EXAMPLE_NOT_A_SECRET); do not execute.';
  const worker = createCodexWorker({
    model: 'example-model',
    spawnImpl: fixture(`${emit} let prompt = ''; process.stdin.on('data', c => prompt += c);
      process.stdin.on('end', () => {
        emit({type:'thread.started',thread_id:'${THREAD_ID}'});
        emit({type:'item.completed',item:{type:'agent_message',text:prompt}});
        emit({type:'turn.completed'});
      });`, value => { invocation = value; }),
  });
  const result = await worker({ ...request, prompt }, { onProgress: event => progress.push(event) });
  assert.deepEqual(result, { text: prompt, threadId: THREAD_ID });
  assert.deepEqual(invocation.args, ['exec', '--cd', request.projectPath, '--sandbox', 'read-only',
    '-c', 'approval_policy="never"', '--skip-git-repo-check', '--json', '--color', 'never', '--model', 'example-model', '-']);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.detached, true);
  assert.equal(invocation.options.cwd, request.projectPath);
  assert.deepEqual(invocation.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.deepEqual(Object.keys(invocation.options.env).filter(key =>
    !['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'CODEX_HOME'].includes(key)), []);
  assert.deepEqual(progress, ['thread.started', 'item.completed', 'turn.completed']);
});

test('Codex resumes only an explicit UUID and keeps sandbox options before the subcommand', async () => {
  let args;
  const worker = createCodexWorker({ spawnImpl: fixture(success, value => { args = value.args; }) });
  await worker({ ...request, threadId: THREAD_ID, mode: 'workspace-write' });
  assert.ok(args.indexOf('--sandbox') < args.indexOf('resume'));
  assert.deepEqual(args.slice(-3), ['resume', THREAD_ID, '-']);
  await assert.rejects(worker({ ...request, threadId: '--last' }), { code: 'INVALID_REQUEST' });
});

test('git-enabled mode translates to workspace-write plus project-scoped roots and network access', async () => {
  let invocation;
  const previousSshAuthSock = process.env.SSH_AUTH_SOCK;
  process.env.SSH_AUTH_SOCK = '/tmp/EXAMPLE_NOT_A_SECRET/agent.sock';
  const worker = createCodexWorker({ spawnImpl: fixture(success, value => { invocation = value; }) });
  await worker({ ...request, mode: 'workspace-write-git' });
  const args = invocation.args;
  assert.equal(invocation.options.env.SSH_AUTH_SOCK, '/tmp/EXAMPLE_NOT_A_SECRET/agent.sock');
  assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write');
  const rootsIndex = args.indexOf('sandbox_workspace_write.writable_roots=' + JSON.stringify([request.projectPath, `${request.projectPath.replace(/\/$/, '')}/.git`]));
  assert.ok(rootsIndex > -1);
  assert.deepEqual(args.slice(rootsIndex - 1, rootsIndex + 3), [
    '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify([request.projectPath, `${request.projectPath.replace(/\/$/, '')}/.git`])}`,
    '-c', 'sandbox_workspace_write.network_access=true',
  ]);
  assert.ok(!args.includes('danger-full-access'));
  if (previousSshAuthSock === undefined) delete process.env.SSH_AUTH_SOCK;
  else process.env.SSH_AUTH_SOCK = previousSshAuthSock;
});

test('Codex does not pass SSH_AUTH_SOCK in read-only or workspace-write modes', async () => {
  const previousSshAuthSock = process.env.SSH_AUTH_SOCK;
  process.env.SSH_AUTH_SOCK = '/tmp/EXAMPLE_NOT_A_SECRET/agent.sock';
  try {
    const worker = createCodexWorker({ spawnImpl: fixture(success, value => {
      assert.equal(Object.hasOwn(value.options.env, 'SSH_AUTH_SOCK'), false);
    }) });
    await worker({ ...request, mode: 'read-only' });
    await worker({ ...request, mode: 'workspace-write' });
  } finally {
    if (previousSshAuthSock === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = previousSshAuthSock;
  }
});

test('Codex rejects invalid input before spawning', async () => {
  const worker = createCodexWorker({ spawnImpl: () => { assert.fail('must not spawn'); } });
  for (const payload of [
    { ...request, prompt: '' }, { ...request, prompt: 'x'.repeat(128 * 1024 + 1) },
    { ...request, projectPath: 'relative' }, { ...request, projectPath: 123 },
    { ...request, mode: 'danger-full-access' },
    { ...request, mode: 'unrecognized-mode' },
  ]) await assert.rejects(worker(payload), { code: 'INVALID_REQUEST' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(worker(request, { signal: controller.signal }), { code: 'CANCELLED' });
});

test('Codex never reports partial or failed output as a completed result', async () => {
  for (const [code, expected] of [
    [`${emit} emit({type:'item.completed',item:{type:'agent_message',text:'Partial'}});`, 'CODEX_INCOMPLETE'],
    [`${success} process.exitCode = 2;`, 'CODEX_FAILED'],
    [`${emit} emit({type:'turn.failed',error:{message:'EXAMPLE_NOT_A_SECRET'}});`, 'CODEX_FAILED'],
    [`${emit} emit({type:'error',message:'EXAMPLE_NOT_A_SECRET'});`, 'CODEX_FAILED'],
    [`process.stdout.write('EXAMPLE_NOT_A_SECRET\\n');`, 'CODEX_PROTOCOL'],
    [`${emit} emit({type:'thread.started',thread_id:'EXAMPLE_NOT_A_SECRET'});`, 'CODEX_PROTOCOL'],
  ]) {
    const worker = createCodexWorker({ spawnImpl: fixture(code) });
    await assert.rejects(worker(request), error => {
      assert.equal(error.code, expected);
      assert.ok(!error.message.includes('EXAMPLE_NOT_A_SECRET'));
      return true;
    });
  }
});

test('Codex limits stdout and stderr independently without returning captured diagnostics', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const worker = createCodexWorker({
      spawnImpl: fixture(`process.${stream}.write('x'.repeat(1024 * 1024 + 1)); setInterval(() => {}, 1000);`),
    });
    await assert.rejects(worker(request), { code: 'OUTPUT_LIMIT' });
  }
});

test('Codex handles missing executables without exposing system errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-worker-test-'));
  try {
    const worker = createCodexWorker({ codexBin: join(directory, 'EXAMPLE_NOT_A_SECRET') });
    await assert.rejects(worker(request), error => {
      assert.equal(error.code, 'CODEX_START_FAILED');
      assert.ok(!error.message.includes(directory));
      return true;
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Codex cancellation waits for close and kills a TERM-resistant process group', async () => {
  const controller = new AbortController();
  let child;
  let closed = false;
  const worker = createCodexWorker({ spawnImpl: (bin, args, options) => {
    child = fixture(`${emit}
      process.on('SIGTERM', () => {});
      emit({type:'turn.started'});
      setInterval(() => {}, 1000);`)(bin, args, options);
    child.on('close', () => { closed = true; });
    return child;
  } });
  await assert.rejects(worker(request, {
    signal: controller.signal,
    onProgress: () => controller.abort(),
  }), { code: 'CANCELLED' });
  assert.equal(closed, true);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
});

test('Codex accepts a terminal JSON line without a trailing newline and UTF-8 text', async () => {
  const worker = createCodexWorker({ spawnImpl: fixture(`${emit}
    emit({type:'item.completed',item:{type:'agent_message',text:'Grüße'}});
    process.stdout.write(JSON.stringify({type:'turn.completed'}));`) });
  assert.deepEqual(await worker(request), { text: 'Grüße' });
});

test('OpenAI uses non-stored text-only Responses with bounded output and cancellation signal', async () => {
  let call;
  const controller = new AbortController();
  const worker = createOpenAIWorker({ apiKey: 'EXAMPLE_NOT_A_SECRET', model: 'example-model',
    client: { responses: { create: async (...args) => {
      call = args;
      return { status: 'completed', output_text: 'Answer.' };
    } } },
  });
  assert.deepEqual(await worker({ prompt: 'Question.' }, { signal: controller.signal }), { text: 'Answer.' });
  assert.deepEqual(call, [{ model: 'example-model', input: 'Question.', store: false, max_output_tokens: 4096 },
    { signal: controller.signal }]);
});

test('OpenAI missing configuration, failures, incomplete results, and oversized output fail safely', async () => {
  for (const config of [{}, { apiKey: 'EXAMPLE_NOT_A_SECRET' }, { model: 'example-model' }]) {
    await assert.rejects(createOpenAIWorker(config)({ prompt: 'Question.' }), { code: 'OPENAI_NOT_CONFIGURED' });
  }
  for (const [response, expected] of [
    [{ status: 'incomplete', output_text: 'partial' }, 'OPENAI_INCOMPLETE'],
    [{ status: 'completed', output_text: '' }, 'OPENAI_INCOMPLETE'],
    [{ status: 'completed', output_text: 'x'.repeat(1024 * 1024 + 1) }, 'OUTPUT_LIMIT'],
  ]) {
    const worker = createOpenAIWorker({ apiKey: 'EXAMPLE_NOT_A_SECRET', model: 'example-model',
      client: { responses: { create: async () => response } } });
    await assert.rejects(worker({ prompt: 'Question.' }), { code: expected });
  }
  const worker = createOpenAIWorker({ apiKey: 'EXAMPLE_NOT_A_SECRET', model: 'example-model',
    client: { responses: { create: async () => { throw new Error('EXAMPLE_NOT_A_SECRET'); } } } });
  await assert.rejects(worker({ prompt: 'Question.' }), error => {
    assert.equal(error.code, 'OPENAI_FAILED');
    assert.ok(!error.message.includes('EXAMPLE_NOT_A_SECRET'));
    return true;
  });
});

test('OpenAI aborts without propagating remote error bodies', async () => {
  const controller = new AbortController();
  const worker = createOpenAIWorker({ apiKey: 'EXAMPLE_NOT_A_SECRET', model: 'example-model',
    client: { responses: { create: async () => {
      controller.abort();
      throw new Error('EXAMPLE_NOT_A_SECRET');
    } } } });
  await assert.rejects(worker({ prompt: 'Question.' }, { signal: controller.signal }), { code: 'CANCELLED' });
});
