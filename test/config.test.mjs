import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { loadConfig, readToken } from '../src/config.mjs';

async function fixture(t, config = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'gateway-config-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'config.json'), JSON.stringify(config));
  return directory;
}
test('configuration expands home paths and always restricts the local listener', async (t) => {
  const directory = await fixture(t, { allowedHosts: ['gateway.example.test'], gangliaMappings: { example: '~/example' } });
  const config = await loadConfig(directory);
  assert.deepEqual(config.roots, [homedir()]);
  assert.equal(config.gangliaMappings.example, path.join(homedir(), 'example'));
  assert.deepEqual(config.allowedHosts, ['127.0.0.1:8765', 'localhost:8765', 'gateway.example.test']);
});
test('unknown configuration and relative roots fail closed', async (t) => {
  await assert.rejects(loadConfig(await fixture(t, { disableAuthentication: true })), /Invalid gateway/);
  await assert.rejects(loadConfig(await fixture(t, { roots: ['relative'] })), /absolute paths/);
});
test('token files reject insecure modes, symlinks and documentation placeholders', async (t) => {
  const directory = await fixture(t);
  const token = path.join(directory, 'mcp.token');
  await writeFile(token, 'EXAMPLE_NOT_A_SECRET_DO_NOT_USE_IN_PRODUCTION', { mode: 0o644 });
  await assert.rejects(readToken(directory), /mode 0600/);
  await chmod(token, 0o600);
  await assert.rejects(readToken(directory), /placeholder/);
  const other = await fixture(t);
  await symlink(token, path.join(other, 'mcp.token'));
  await assert.rejects(readToken(other));
});
