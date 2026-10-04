import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { GatewayError } from './jobs.mjs';

const MAX_BODY_BYTES = 128 * 1024;
const promptSchema = z.string().trim().min(1).max(32_000);
const idSchema = z.string().min(1).max(160).regex(/^[a-zA-Z0-9._:-]+$/);
const requestIdSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9._:-]+$/);
const objectSchema = z.record(z.string(), z.unknown());

function toolResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function createToolServer(service) {
  const server = new McpServer({ name: 'grok-codex-gateway', version: '0.1.0' });
  const register = (name, description, inputSchema, handler, readOnlyHint = false) => {
    server.registerTool(name, {
      description,
      inputSchema,
      outputSchema: objectSchema,
      annotations: { readOnlyHint, destructiveHint: !readOnlyHint, openWorldHint: true },
    }, async (input) => {
      try {
        return toolResult(await handler(input));
      } catch (error) {
        // Only the service's explicitly public error surface crosses the network.
        const message = error instanceof GatewayError
          ? error.message.slice(0, 500)
          : 'The operation failed. Check the local gateway for details.';
        return toolResult({ error: message }, true);
      }
    });
  };
  register('projects_list',
    'List local projects eligible for Codex through their AGENTS.md or the configured Ganglia registry. Use the returned project ID when starting work.',
    z.object({}).strict(), () => service.listProjects(), true);
  register('codex_start',
    'Start a local Codex job in a listed project. Defaults to read-only. workspace-write allows project edits. workspace-write-git additionally allows writes to that project\'s .git directory and outbound network access for git push/GitHub CLI; use only with explicit user authorization. Returns a job ID; poll job_status and read job_result.',
    z.object({ project: idSchema, prompt: promptSchema, mode: z.enum(['read-only', 'workspace-write', 'workspace-write-git']).default('read-only'), requestId: requestIdSchema }).strict(),
    (input) => service.startCodex(input));
  register('proxy_status', 'Read the Codex proxy mode and chosen project execution backend. Subscription balance is unknown; switching is manual.',
    z.object({}).strict(), () => service.proxyStatus(), true);
  register('proxy_set_enabled', 'Persist the Codex proxy mode. Disabled selects Grok approved local Shell for new project work; existing jobs remain accessible and continue.',
    z.object({ enabled: z.boolean() }).strict(), ({ enabled }) => service.setProxyEnabled(enabled));
  register('codex_followup',
    'Continue a completed Codex job with another prompt, retaining its project and sandbox mode. Returns a new job ID.',
    z.object({ jobId: idSchema, prompt: promptSchema, requestId: requestIdSchema }).strict(),
    (input) => service.followup(input));
  register('openai_start',
    'Start an OpenAI API text job. Requires the locally configured API backend; this does not control an existing ChatGPT conversation. Returns a job ID.',
    z.object({ prompt: promptSchema, requestId: requestIdSchema }).strict(),
    (input) => service.startOpenAI(input));
  register('job_status', 'Read the status of a gateway job.',
    z.object({ jobId: idSchema }).strict(), ({ jobId }) => service.getStatus(jobId), true);
  register('job_result', 'Read the result of a gateway job.',
    z.object({ jobId: idSchema }).strict(), ({ jobId }) => service.getResult(jobId), true);
  register('job_cancel', 'Cancel a running gateway job.',
    z.object({ jobId: idSchema }).strict(), ({ jobId }) => service.cancel(jobId));
  return server;
}

function reply(response, status, message, headers = {}) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify({ error: message }));
}

function countHeader(request, name) {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) count += 1;
  }
  return count;
}

function readBody(request, response) {
  const declaredLength = request.headers['content-length'];
  if (declaredLength && Number(declaredLength) > MAX_BODY_BYTES) {
    request.resume();
    reply(response, 413, 'Request body exceeds 128 KiB.');
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    let size = 0;
    let chunks = [];
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      chunks = [];
      resolve(value);
    };
    request.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reply(response, 413, 'Request body exceeds 128 KiB.');
        finish(undefined);
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (done) return;
      try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reply(response, 400, 'Invalid JSON body.'); finish(undefined); }
    });
    request.on('error', () => { reply(response, 400, 'Unable to read request.'); finish(undefined); });
    request.on('aborted', () => finish(undefined));
  });
}

/** The caller must bind this server to loopback. Host entries include the port. */
export function createHttpServer({ service, token, allowedHosts, allowedOrigins = [] }) {
  if (typeof token !== 'string' || token.length < 16 || /\s/.test(token)) {
    throw new Error('A bearer token of at least 16 non-whitespace characters is required.');
  }
  if (!Array.isArray(allowedHosts) || !allowedHosts.length || allowedHosts.some((host) => typeof host !== 'string' || !host || /[\s/*?#@]/.test(host))) {
    throw new Error('An explicit Host allowlist is required.');
  }
  if (!Array.isArray(allowedOrigins) || allowedOrigins.some((origin) => {
    try { const parsed = new URL(origin); return !['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin || origin.includes('*'); }
    catch { return true; }
  })) throw new Error('Origins must be exact HTTP(S) origins without wildcards.');
  const hosts = new Set(allowedHosts.map((host) => host.toLowerCase()));
  const origins = new Set(allowedOrigins);
  const expectedTokenHash = createHash('sha256').update(token).digest();

  return createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 30_000, headersTimeout: 15_000 }, async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    try {
      if (countHeader(request, 'host') !== 1 || !hosts.has(request.headers.host?.toLowerCase())) {
        request.resume(); return reply(response, 403, 'Host not allowed.');
      }
      const origin = request.headers.origin;
      if (countHeader(request, 'origin') > 1 || (origin !== undefined && !origins.has(origin))) {
        request.resume(); return reply(response, 403, 'Origin not allowed.');
      }
      if (request.url === '/healthz' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        return response.end(JSON.stringify({ status: 'ok' }));
      }
      // Query strings are never accepted, including credentials in the URL.
      if (request.url !== '/mcp') { request.resume(); return reply(response, 404, 'Not found.'); }
      const authorization = request.headers.authorization;
      const suppliedToken = typeof authorization === 'string' && /^Bearer [^\s]+$/i.test(authorization)
        ? authorization.slice(7) : '';
      const suppliedHash = createHash('sha256').update(suppliedToken).digest();
      if (countHeader(request, 'authorization') !== 1 || !timingSafeEqual(expectedTokenHash, suppliedHash)) {
        request.resume(); return reply(response, 401, 'Bearer authentication required.', { 'www-authenticate': 'Bearer realm="grok-codex-gateway"' });
      }
      if (request.method !== 'POST') { request.resume(); return reply(response, 405, 'Use POST for MCP requests.', { allow: 'POST' }); }
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '') || (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')) {
        request.resume(); return reply(response, 415, 'An uncompressed application/json body is required.');
      }
      const body = await readBody(request, response);
      if (body === undefined || response.writableEnded || response.destroyed) return;
      const mcp = createToolServer(service);
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      let closed = false;
      const close = () => { if (!closed) { closed = true; void mcp.close().catch(() => {}); } };
      response.once('finish', close);
      response.once('close', close);
      try {
        await mcp.connect(transport);
        await transport.handleRequest(request, response, body);
      } catch {
        reply(response, 500, 'Unable to process MCP request.');
        close();
      }
    } catch {
      reply(response, 500, 'Unable to process request.');
    }
  });
}
