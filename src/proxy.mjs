import { readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { configDirectory } from './config.mjs';

// Separate from config.json: switching modes never rewrites private settings.
export async function loadProxyState(directory = configDirectory()) {
  const resolved = await realpath(directory);
  const source = fileURLToPath(new URL('../', import.meta.url));
  const relative = path.relative(source, resolved);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Proxy state directory must be outside the source checkout.');
  }
  const file = path.join(resolved, 'proxy-state.json');
  let enabled = true;
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (typeof value.enabled !== 'boolean' || Object.keys(value).length !== 1) throw new Error('Invalid proxy state');
    enabled = value.enabled;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Cannot read proxy state. Check private runtime configuration.');
  }
  return {
    enabled,
    async persist(next) {
      const temporary = path.join(resolved, `.proxy-state-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, `${JSON.stringify({ enabled: next })}\n`, { flag: 'wx', mode: 0o600 });
        await rename(temporary, file);
      } finally { await rm(temporary, { force: true }); }
    },
  };
}
