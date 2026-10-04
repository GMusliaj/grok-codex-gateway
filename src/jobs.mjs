import { createHash, randomUUID } from 'node:crypto';

export class GatewayError extends Error {
  constructor(message) { super(message); this.name = 'GatewayError'; this.safe = true; }
}

// One trusted owner, one worker at a time. A request ID deduplicates retries
// for as long as its job is retained; it is not an authentication credential.
export function createService({ discover, codexWorker, openAIWorker = null,
  proxyState = { enabled: true, persist: async () => {} },
  maxJobs = 100, maxQueue = 10, jobTimeoutMs = 30 * 60_000 }) {
  let proxyEnabled = proxyState.enabled;
  let switchQueue = Promise.resolve();
  const proxyStatus = () => ({ enabled: proxyEnabled,
    execution: proxyEnabled ? 'codex_gateway' : 'grok_approved_local_shell',
    creditDetection: 'manual_only', subscriptionBalance: 'unknown' });
  const requireProxy = () => {
    if (!proxyEnabled) throw new GatewayError('Codex proxy is disabled. Grok approved local Shell execution is the chosen fallback for project work; retain approval and sandbox rules. Re-enable with proxy_set_enabled(enabled: true).');
  };
  const jobs = new Map();
  const requests = new Map();
  let running = null;
  let stopping = false;
  let pumpScheduled = false;
  const terminal = (job) => ['completed', 'failed', 'cancelled', 'timed_out'].includes(job.state);
  const get = (id) => {
    const job = jobs.get(id);
    if (!job) throw new GatewayError('Unknown or expired job ID.');
    return job;
  };
  const status = (job) => ({
    jobId: job.id, kind: job.kind, state: job.state, project: job.project?.id,
    mode: job.payload.mode, createdAt: job.createdAt, startedAt: job.startedAt,
    finishedAt: job.finishedAt, progress: job.progress, error: job.error,
  });
  const prune = () => {
    for (const [id, job] of jobs) {
      if (jobs.size < maxJobs) break;
      if (terminal(job)) { jobs.delete(id); requests.delete(job.requestId); }
    }
  };
  function schedule() {
    if (pumpScheduled || stopping || running) return;
    pumpScheduled = true;
    setImmediate(() => { pumpScheduled = false; pump(); });
  }
  function pump() {
    if (stopping || running) return;
    const job = [...jobs.values()].find((item) => item.state === 'queued');
    if (!job) return;
    running = job;
    job.state = 'running';
    job.startedAt = new Date().toISOString();
    job.controller = new AbortController();
    const timer = setTimeout(() => {
      job.stopReason ??= 'timed_out'; job.state = 'cancelling'; job.controller.abort();
    }, jobTimeoutMs);
    timer.unref();
    job.promise = (async () => {
      try {
        // Eligibility can disappear while a job waits in the queue.
        if (job.project) {
          const { projects } = await discover();
          if (!projects.some((item) => item.id === job.project.id && item.path === job.project.path)) {
            throw new GatewayError('Project is no longer eligible. Refresh projects_list.');
          }
        }
        job.controller.signal.throwIfAborted();
        const worker = job.kind === 'codex' ? codexWorker : openAIWorker;
        const result = await worker(job.payload, {
          signal: job.controller.signal,
          onProgress: (event) => {
            // Workers emit event names only, never commands, prompts or credentials.
            if (typeof event === 'string' && /^[a-z_.]{1,80}$/i.test(event)) job.progress = event;
          },
        });
        if (!result || typeof result.text !== 'string' || result.text.length > 1_048_576) {
          throw new Error('Invalid worker result');
        }
        if (!job.stopReason) { job.result = result; job.state = 'completed'; }
      } catch (error) {
        if (!job.stopReason) {
          job.state = 'failed';
          job.error = error instanceof GatewayError ? error.message
            : 'Worker failed. Check local login, model configuration, permissions, or output limits.';
        }
      } finally {
        clearTimeout(timer);
        if (job.stopReason) job.state = job.stopReason;
        job.finishedAt = new Date().toISOString();
        // Requests retain a digest, not the input. CLI session retention is separate.
        delete job.payload.prompt;
        running = null;
        schedule();
      }
    })();
  }
  async function resolveProject(id) {
    const { projects } = await discover();
    const project = projects.find((item) => item.id === id);
    if (!project) throw new GatewayError('Unknown or ineligible project. Use projects_list first.');
    return project;
  }
  function requestFingerprint(input) {
    return createHash('sha256').update(JSON.stringify(input)).digest('hex');
  }
  function retry(requestId, identity) {
    const previous = requests.get(requestId);
    if (!previous) return null;
    if (previous.fingerprint !== requestFingerprint(identity)) throw new GatewayError('requestId already belongs to a different request.');
    return status(get(previous.jobId));
  }
  function enqueue(kind, payload, requestId, project, identity) {
    if (stopping) throw new GatewayError('Gateway is shutting down.');
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(requestId)) {
      throw new GatewayError('Supply a requestId of 1–100 letters, digits, dots, colons, underscores or hyphens.');
    }
    if (typeof payload.prompt !== 'string' || !payload.prompt.trim() || payload.prompt.length > 32_000) {
      throw new GatewayError('Prompt must contain 1–32000 characters.');
    }
    const fingerprint = requestFingerprint(identity);
    const previous = requests.get(requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new GatewayError('requestId already belongs to a different request.');
      return status(get(previous.jobId));
    }
    if (kind === 'codex') requireProxy();
    if ([...jobs.values()].filter((job) => !terminal(job)).length >= maxQueue) {
      throw new GatewayError('Job queue is full. Wait for a task to finish.');
    }
    prune();
    if (jobs.size >= maxJobs) throw new GatewayError('Job capacity reached.');
    const job = { id: randomUUID(), kind, payload: { ...payload }, requestId, project,
      state: 'queued', createdAt: new Date().toISOString(), progress: 'queued' };
    jobs.set(job.id, job);
    requests.set(requestId, { fingerprint, jobId: job.id });
    schedule();
    return status(job);
  }
  const service = {
    proxyStatus,
    setProxyEnabled(enabled) {
      if (typeof enabled !== 'boolean') return Promise.reject(new GatewayError('enabled must be a boolean.'));
      const change = switchQueue.then(async () => {
        try { await proxyState.persist(enabled); }
        catch { throw new GatewayError('Cannot persist proxy mode in private runtime configuration. Check directory permissions; mode was not changed.'); }
        proxyEnabled = enabled;
        return proxyStatus();
      });
      switchQueue = change.catch(() => {});
      return change;
    },
    async listProjects() {
      const result = await discover();
      return { ...result, backends: { codex: proxyEnabled, openai: Boolean(openAIWorker) } };
    },
    async startCodex({ project: id, prompt, mode = 'read-only', requestId }) {
      if (!['read-only', 'workspace-write', 'workspace-write-git'].includes(mode)) throw new GatewayError('Unsupported sandbox mode.');
      const identity = { kind: 'codex', project: id, prompt, mode };
      const existing = retry(requestId, identity);
      if (existing) return existing;
      requireProxy();
      const project = await resolveProject(id);
      return enqueue('codex', { projectPath: project.path, prompt, mode }, requestId, project, identity);
    },
    async followup({ jobId, prompt, requestId }) {
      const identity = { kind: 'followup', jobId, prompt };
      const existing = retry(requestId, identity);
      if (existing) return existing;
      requireProxy();
      const previous = get(jobId);
      if (previous.kind !== 'codex' || previous.state !== 'completed' || !previous.result?.threadId) {
        throw new GatewayError('Only a completed Codex job with a session ID can be continued.');
      }
      const project = await resolveProject(previous.project.id);
      return enqueue('codex', { projectPath: project.path, prompt, mode: previous.payload.mode,
        threadId: previous.result.threadId }, requestId, project, identity);
    },
    async startOpenAI({ prompt, requestId }) {
      if (!openAIWorker) throw new GatewayError('OpenAI text backend is not configured on this computer.');
      return enqueue('openai', { prompt }, requestId, undefined, { kind: 'openai', prompt });
    },
    getStatus(id) { return status(get(id)); },
    getResult(id) {
      const job = get(id);
      return { ...status(job), result: job.state === 'completed' ? job.result.text : null };
    },
    cancel(id) {
      const job = get(id);
      if (terminal(job)) return status(job);
      job.stopReason ??= 'cancelled';
      if (job.state === 'queued') {
        job.state = 'cancelled'; job.finishedAt = new Date().toISOString(); delete job.payload.prompt;
      } else { job.state = 'cancelling'; job.controller.abort(); }
      return status(job);
    },
    async close() {
      stopping = true;
      for (const job of jobs.values()) if (!terminal(job)) service.cancel(job.id);
      if (running?.promise) await running.promise;
    },
  };
  return service;
}
