import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const MAX_BYTES = 1024 * 1024;
const MAX_PROMPT_BYTES = 128 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const CHILD_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'CODEX_HOME'];
const PROGRESS_TYPES = new Set([
  'thread.started', 'turn.started', 'turn.completed', 'turn.failed',
  'item.started', 'item.updated', 'item.completed', 'error',
]);

export class WorkerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkerError';
    this.code = code;
  }
}

function cancelled() {
  return new WorkerError('CANCELLED', 'Task cancelled.');
}

function validatePrompt(payload) {
  if (typeof payload?.prompt !== 'string' || !payload.prompt.trim()
    || Buffer.byteLength(payload.prompt) > MAX_PROMPT_BYTES) {
    throw new WorkerError('INVALID_REQUEST', 'A non-empty prompt of at most 128 KiB is required.');
  }
}

function progress(callback, type) {
  // Never forward model-supplied event data, command output, prompts, or paths.
  if (!PROGRESS_TYPES.has(type)) return;
  try { callback?.(type); } catch { /* Observers cannot break worker cleanup. */ }
}

function childEnvironment(includeSshAgent = false) {
  const env = Object.fromEntries(CHILD_ENV
    .filter((name) => typeof process.env[name] === 'string')
    .map((name) => [name, process.env[name]]));
  if (includeSshAgent && typeof process.env.SSH_AUTH_SOCK === 'string') {
    env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
  }
  return env;
}

export function createCodexWorker({ codexBin = 'codex', model, spawnImpl = spawn } = {}) {
  if (typeof codexBin !== 'string' || !codexBin || codexBin.includes('\0')) {
    throw new WorkerError('INVALID_CONFIG', 'A valid Codex executable is required.');
  }
  if (model !== undefined && (typeof model !== 'string' || !MODEL.test(model))) {
    throw new WorkerError('INVALID_CONFIG', 'The configured Codex model is invalid.');
  }

  return async (payload, { signal, onProgress } = {}) => {
    validatePrompt(payload);
    if (typeof payload.projectPath !== 'string' || !isAbsolute(payload.projectPath) || payload.projectPath.includes('\0')
      || !['read-only', 'workspace-write', 'workspace-write-git'].includes(payload.mode)
      || (payload.threadId !== undefined && !UUID.test(payload.threadId))) {
      throw new WorkerError('INVALID_REQUEST', 'A project path, supported sandbox, and valid session ID are required.');
    }
    if (signal?.aborted) throw cancelled();

    // No shell, approval bypass, config suppression, or rule suppression.
    // `never` denies escalations; it does not grant the requested operations.
    const gitMode = payload.mode === 'workspace-write-git';
    const sandbox = gitMode ? 'workspace-write' : payload.mode;
    const args = ['exec', '--cd', payload.projectPath, '--sandbox', sandbox,
      '-c', 'approval_policy="never"'];
    if (gitMode) {
      const gitDirectory = `${payload.projectPath.replace(/\/$/, '')}/.git`;
      const tomlRoots = JSON.stringify([payload.projectPath, gitDirectory]);
      args.push('-c', `sandbox_workspace_write.writable_roots=${tomlRoots}`,
        '-c', 'sandbox_workspace_write.network_access=true');
    }
    args.push('--skip-git-repo-check', '--json', '--color', 'never');
    if (model) args.push('--model', model);
    if (payload.threadId) args.push('resume', payload.threadId, '-');
    else args.push('-');

    return new Promise((resolve, reject) => {
      let child;
      let failure;
      let closed = false;
      let stopping = false;
      let killTimer;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let pending = '';
      let text;
      let threadId = payload.threadId;
      let completed = false;
      const decoder = new StringDecoder('utf8');

      const killGroup = (killSignal) => {
        if (!child?.pid) return;
        try { process.kill(-child.pid, killSignal); }
        catch {
          // For an already-exited group there is nothing to kill. This fallback
          // also handles a spawn adapter that could not create a process group.
          try { child.kill(killSignal); } catch { /* Process has already exited. */ }
        }
      };
      const stop = () => {
        if (stopping || closed) return;
        stopping = true;
        killGroup('SIGTERM');
        killTimer = setTimeout(() => killGroup('SIGKILL'), 1000);
      };
      const fail = (error) => {
        failure ??= error;
        stop();
      };
      const abort = () => fail(cancelled());
      const parseLine = (line) => {
        if (failure || !line.trim()) return;
        let event;
        try { event = JSON.parse(line); }
        catch {
          fail(new WorkerError('CODEX_PROTOCOL', 'Codex returned an invalid event stream.'));
          return;
        }
        if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
          fail(new WorkerError('CODEX_PROTOCOL', 'Codex returned an invalid event stream.'));
          return;
        }
        progress(onProgress, event.type);
        if (event.type === 'thread.started') {
          if (typeof event.thread_id !== 'string' || !UUID.test(event.thread_id)) {
            fail(new WorkerError('CODEX_PROTOCOL', 'Codex returned an invalid session ID.'));
            return;
          }
          threadId = event.thread_id;
        }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
          if (typeof event.item.text !== 'string') {
            fail(new WorkerError('CODEX_PROTOCOL', 'Codex returned an invalid response.'));
            return;
          }
          text = event.item.text;
        }
        if (event.type === 'turn.completed') completed = true;
        if (event.type === 'turn.failed' || event.type === 'error') {
          fail(new WorkerError('CODEX_FAILED', 'Codex could not complete the task. Check the local Codex configuration and authentication.'));
        }
      };

      try {
        child = spawnImpl(codexBin, args, {
          cwd: payload.projectPath,
          env: childEnvironment(gitMode),
          shell: false,
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        reject(new WorkerError('CODEX_START_FAILED', 'The Codex process could not be started.'));
        return;
      }

      signal?.addEventListener('abort', abort, { once: true });
      child.on('error', () => {
        fail(new WorkerError('CODEX_START_FAILED', 'The Codex process could not be started.'));
      });
      child.stdout.on('data', (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_BYTES) {
          fail(new WorkerError('OUTPUT_LIMIT', 'Codex exceeded the 1 MiB output limit.'));
          return;
        }
        if (failure) return;
        pending += decoder.write(chunk);
        let newline;
        while ((newline = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          parseLine(line);
          if (failure) { pending = ''; break; }
        }
      });
      child.stderr.on('data', (chunk) => {
        // Count but never retain or return stderr, which may contain secrets.
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_BYTES) {
          fail(new WorkerError('OUTPUT_LIMIT', 'Codex exceeded the 1 MiB diagnostic limit.'));
        }
      });
      child.stdin.on('error', () => {
        fail(new WorkerError('CODEX_INPUT_FAILED', 'The Codex process could not receive the request.'));
      });
      child.on('close', (exitCode) => {
        closed = true;
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', abort);
        // A parent can exit on TERM while descendants ignore it. Kill the rest
        // of its dedicated group before allowing the job to finish.
        if (stopping) killGroup('SIGKILL');
        if (!failure) parseLine(pending + decoder.end());
        if (failure) { reject(failure); return; }
        if (exitCode !== 0) {
          reject(new WorkerError('CODEX_FAILED', 'Codex exited without completing the task.'));
        } else if (!completed || typeof text !== 'string') {
          reject(new WorkerError('CODEX_INCOMPLETE', 'Codex exited without a completed response.'));
        } else {
          resolve({ text, ...(threadId ? { threadId } : {}) });
        }
      });
      if (signal?.aborted) abort();
      if (!failure) child.stdin.end(payload.prompt);
    });
  };
}

export function createOpenAIWorker({ apiKey, model, client } = {}) {
  let sdkClient = client;
  return async (payload, { signal, onProgress } = {}) => {
    validatePrompt(payload);
    if (typeof apiKey !== 'string' || !apiKey.trim()
      || typeof model !== 'string' || !MODEL.test(model)) {
      throw new WorkerError('OPENAI_NOT_CONFIGURED', 'OpenAI text requests require a configured API key and model.');
    }
    if (signal?.aborted) throw cancelled();
    try {
      if (!sdkClient) {
        const { default: OpenAI } = await import('openai');
        sdkClient = new OpenAI({ apiKey, maxRetries: 0 });
      }
      progress(onProgress, 'turn.started');
      const response = await sdkClient.responses.create({
        model, input: payload.prompt, store: false, max_output_tokens: 4096,
      }, { signal });
      if (signal?.aborted) throw cancelled();
      if (response.status !== 'completed' || typeof response.output_text !== 'string'
        || !response.output_text.trim()) {
        throw new WorkerError('OPENAI_INCOMPLETE', 'OpenAI did not return a completed text response.');
      }
      if (Buffer.byteLength(response.output_text) > MAX_BYTES) {
        throw new WorkerError('OUTPUT_LIMIT', 'OpenAI exceeded the 1 MiB output limit.');
      }
      progress(onProgress, 'turn.completed');
      return { text: response.output_text };
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      if (error instanceof WorkerError) throw error;
      // SDK messages can contain response bodies or request details. Keep them local.
      throw new WorkerError('OPENAI_FAILED', 'OpenAI could not complete the text request. Check the local API configuration.');
    }
  };
}
