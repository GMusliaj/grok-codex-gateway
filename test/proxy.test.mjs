import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configDirectory } from '../src/config.mjs';
import { loadProxyState } from '../src/proxy.mjs';
import { createService } from '../src/jobs.mjs';

test('private config override persists mode across service recreation without rewriting config', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gateway-proxy-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const override = configDirectory({ GATEWAY_CONFIG_DIR: directory });
  const state = await loadProxyState(override);
  assert.equal(state.enabled, true);
  const options = { discover: async () => ({ projects: [] }), codexWorker: async () => assert.fail('no inference') };
  const first = createService({ ...options, proxyState: state });
  await first.setProxyEnabled(false);
  await first.close();
  assert.equal((await stat(path.join(directory, 'proxy-state.json'))).mode & 0o777, 0o600);
  const second = createService({ ...options, proxyState: await loadProxyState(override) });
  assert.equal(second.proxyStatus().enabled, false);
  await assert.rejects(second.startCodex({ project: 'example', prompt: 'Run', requestId: 'new' }), /proxy is disabled/);
  await second.setProxyEnabled(true);
  await second.close();
  assert.equal((await loadProxyState(override)).enabled, true);
  await writeFile(path.join(directory, 'proxy-state.json'), '{"enabled":"false"}');
  await assert.rejects(loadProxyState(override), /Cannot read proxy state/);
});

test('proxy runtime state refuses the source checkout', async () => {
  await assert.rejects(loadProxyState(process.cwd()), /outside the source checkout/);
});
