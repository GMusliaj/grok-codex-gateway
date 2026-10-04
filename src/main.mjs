import { initialize, configDirectory, loadConfig, readToken } from './config.mjs';
import { discoverProjects } from './projects.mjs';
import { createCodexWorker, createOpenAIWorker } from './workers.mjs';
import { createService } from './jobs.mjs';
import { createHttpServer } from './http.mjs';
import { loadProxyState } from './proxy.mjs';

async function main() {
  const command = process.argv[2] ?? 'serve';
  if (command === 'setup') {
    await initialize();
    console.log(`Private configuration is ready in ${configDirectory()}. The token was not printed.`);
    return;
  }
  if (!['serve', 'projects'].includes(command)) throw new Error('Use: node src/main.mjs [setup|projects|serve]');
  const config = await loadConfig();
  const discover = () => discoverProjects(config);
  if (command === 'projects') {
    console.log(JSON.stringify(await discover(), null, 2));
    return;
  }
  const token = await readToken();
  const openAIWorker = process.env.OPENAI_API_KEY && config.openaiModel
    ? createOpenAIWorker({ apiKey: process.env.OPENAI_API_KEY, model: config.openaiModel }) : null;
  const proxyState = await loadProxyState();
  const service = createService({ discover, openAIWorker, proxyState,
    codexWorker: createCodexWorker({ codexBin: config.codexBin, model: config.codexModel }),
    jobTimeoutMs: config.jobTimeoutMinutes * 60_000,
  });
  const server = createHttpServer({ service, token, allowedHosts: config.allowedHosts, allowedOrigins: config.allowedOrigins });
  server.on('error', () => { console.error('Gateway listener failed. Check whether its local port is already in use.'); process.exitCode = 1; });
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    server.close();
    server.closeAllConnections();
    await service.close();
  };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`MCP gateway listening on http://127.0.0.1:${config.port}/mcp (bearer authentication required).`);
    console.log(`Codex: local CLI. OpenAI text: ${openAIWorker ? 'configured' : 'not configured'}.`);
  });
}
main().catch((error) => {
  // Config errors contain no credentials; filesystem/SDK error objects are never serialized.
  console.error(error.code ? 'Cannot access gateway configuration. Check local paths and permissions.' : error.message);
  process.exitCode = 1;
});
