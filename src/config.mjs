import { constants } from 'node:fs';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const configSchema = z.object({
  roots: z.array(z.string().min(1)).min(1).max(30).default(['~']),
  gangliaRoot: z.string().min(1).default('~/ganglia'),
  gangliaMappings: z.record(z.string(), z.string()).default({}),
  maxDepth: z.number().int().min(0).max(20).default(6),
  port: z.number().int().min(1024).max(65535).default(8765),
  allowedHosts: z.array(z.string().min(1)).max(30).default([]),
  allowedOrigins: z.array(z.string().url()).max(30).default([]),
  codexBin: z.string().min(1).default('codex'),
  codexModel: z.string().min(1).optional(),
  openaiModel: z.string().min(1).optional(),
  jobTimeoutMinutes: z.number().int().min(1).max(120).default(30),
}).strict();

export function configDirectory(env = process.env) {
  return env.GATEWAY_CONFIG_DIR ? path.resolve(env.GATEWAY_CONFIG_DIR)
    : path.join(homedir(), '.config', 'grok-codex-gateway');
}
const expand = (input) => input === '~' ? homedir() : input.startsWith('~/') ? path.join(homedir(), input.slice(2)) : input;

export async function loadConfig(directory = configDirectory()) {
  let value;
  try { value = JSON.parse(await readFile(path.join(directory, 'config.json'), 'utf8')); }
  catch { throw new Error('Cannot read gateway config.json. Run npm run setup first.'); }
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid gateway config.json. Check the documented keys and value types.');
  const config = parsed.data;
  config.roots = config.roots.map(expand);
  config.gangliaRoot = expand(config.gangliaRoot);
  config.gangliaMappings = Object.fromEntries(Object.entries(config.gangliaMappings).map(([key, location]) => [key, expand(location)]));
  if (![...config.roots, config.gangliaRoot, ...Object.values(config.gangliaMappings)].every(path.isAbsolute)) {
    throw new Error('Project roots, Ganglia path and mappings must be absolute paths or start with ~/');
  }
  config.allowedHosts = [...new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`, ...config.allowedHosts])];
  return config;
}

export async function readToken(directory = configDirectory()) {
  const file = await open(path.join(directory, 'mcp.token'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid() || stat.size > 4096) {
      throw new Error('Token file must belong to the current user and have mode 0600.');
    }
    const value = (await file.readFile('utf8')).trim();
    if (value.length < 32 || /\s/.test(value) || value.includes('EXAMPLE')) {
      throw new Error('Invalid gateway token. Use a locally generated token, not a documentation placeholder.');
    }
    return value;
  } finally { await file.close(); }
}

export async function initialize(directory = configDirectory()) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const defaults = { roots: ['~'], gangliaRoot: '~/ganglia', gangliaMappings: {}, port: 8765,
    allowedHosts: [], allowedOrigins: [], jobTimeoutMinutes: 30 };
  try { await writeFile(path.join(directory, 'config.json'), `${JSON.stringify(defaults, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  // Runtime credential is written only to the user's private config directory,
  // never printed or stored in the source checkout.
  try { await writeFile(path.join(directory, 'mcp.token'), `${randomBytes(32).toString('base64url')}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
