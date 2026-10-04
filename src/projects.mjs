import { createHash } from 'node:crypto';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const SKIP = new Set([
  'node_modules', 'vendor', 'bower_components', 'dist', 'build', 'coverage',
  'target', 'venv', 'env', '__pycache__', 'Library', 'Applications', 'System',
  'Volumes', 'Caches', 'Trash', 'proc', 'sys', 'dev', 'private', 'raw',
]);
const MAX_DIRECTORIES = 10_000;
const MAX_ENTRIES = 5_000;
const MAX_WARNINGS = 10;
const inside = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);
const excluded = name => name.startsWith('.') || SKIP.has(name);

async function stat(file) {
  try { return await lstat(file); } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

/** Discover eligibility only; never read instructions, notes, credentials, or transcripts. */
export async function discoverProjects({ roots, gangliaRoot, gangliaMappings = {}, maxDepth = 6 } = {}) {
  if (!Array.isArray(roots) || !roots.length || roots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) {
    throw new TypeError('roots must be a nonempty array of absolute directory paths');
  }
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 20) throw new TypeError('maxDepth must be an integer from 0 to 20');
  if (gangliaRoot !== undefined && (typeof gangliaRoot !== 'string' || !path.isAbsolute(gangliaRoot))) {
    throw new TypeError('gangliaRoot must be an absolute directory path');
  }
  if (!gangliaMappings || typeof gangliaMappings !== 'object' || Array.isArray(gangliaMappings)) {
    throw new TypeError('gangliaMappings must be an object');
  }

  const warnings = [];
  let suppressed = 0;
  const warn = message => warnings.length < MAX_WARNINGS ? warnings.push(message) : suppressed++;
  const canonicalRoots = [];
  const rootAliases = [];
  for (const root of roots) {
    try {
      const canonical = await realpath(root);
      if (!(await stat(canonical))?.isDirectory()) { warn(`Discovery root is not a directory: ${root}`); continue; }
      if (canonical === path.parse(canonical).root) { warn(`Filesystem-wide discovery is not allowed: ${root}`); continue; }
      rootAliases.push({ input: path.resolve(root), canonical });
      if (!canonicalRoots.includes(canonical)) canonicalRoots.push(canonical);
    } catch { warn(`Discovery root is unavailable: ${root}`); }
  }
  canonicalRoots.sort();
  const actualHome = await realpath(homedir()).catch(() => homedir());
  const eligiblePath = candidate => candidate !== actualHome && canonicalRoots.some(root =>
    inside(root, candidate) && !path.relative(root, candidate).split(path.sep).filter(Boolean).some(excluded));
  const found = new Map();
  const gitRoots = new Set();
  const instructionDirs = new Set();
  const visited = new Map();
  const incomplete = new Set();

  async function entries(directory) {
    const result = [];
    try {
      const stream = await opendir(directory);
      for await (const entry of stream) {
        if (result.length >= MAX_ENTRIES) {
          incomplete.add(directory);
          warn(`Entry limit reached; discovery is incomplete under: ${directory}`);
          return null;
        }
        result.push(entry);
      }
      return result.sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      incomplete.add(directory);
      warn(`Directory could not be inspected: ${directory}`);
      return null;
    }
  }

  const scanQueue = canonicalRoots.map(directory => ({ directory, depth: 0 }));
  async function scan(directory, depth) {
    const remaining = maxDepth - depth;
    if ((visited.get(directory) ?? -1) >= remaining) return;
    if (!visited.has(directory) && visited.size >= MAX_DIRECTORIES) {
      incomplete.add(directory);
      warn(`Directory limit reached; discovery is incomplete under: ${directory}`);
      return;
    }
    visited.set(directory, remaining);
    incomplete.delete(directory);
    const children = await entries(directory);
    if (!children) return;
    // A home-level AGENTS.md is global guidance, never project enrollment.
    if (eligiblePath(directory)) {
      if (children.some(entry => entry.name === '.git' && !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))) gitRoots.add(directory);
      if (children.some(entry => entry.name === 'AGENTS.md' && entry.isFile() && !entry.isSymbolicLink())) instructionDirs.add(directory);
    }
    for (const entry of children) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || excluded(entry.name)) continue;
      const next = path.join(directory, entry.name);
      if (depth >= maxDepth) {
        incomplete.add(next);
        warn(`Depth limit reached; discovery is incomplete under: ${next}`);
      } else scanQueue.push({ directory: next, depth: depth + 1 });
    }
  }

  // Breadth-first scanning prevents one large checkout from hiding every
  // later sibling when the global directory budget is reached.
  for (let cursor = 0; cursor < scanQueue.length; cursor++) {
    const { directory, depth } = scanQueue[cursor];
    await scan(directory, depth);
  }
  function add(directory, source) {
    if (!eligiblePath(directory)) return;
    let project = found.get(directory);
    if (!project) {
      project = { id: `p_${createHash('sha256').update(directory).digest('hex').slice(0, 18)}`, name: path.basename(directory), path: directory, sources: [] };
      found.set(directory, project);
    }
    if (!project.sources.includes(source)) project.sources.push(source);
  }
  for (const directory of instructionDirs) {
    const ancestors = [...gitRoots].filter(root => inside(root, directory)).sort((a, b) => b.length - a.length);
    add(ancestors[0] ?? directory, 'AGENTS.md');
  }

  // Reject a symlink in any project path component below an approved root.
  async function checkedDirectory(input) {
    if (typeof input !== 'string' || !path.isAbsolute(input)) return null;
    let normalized = path.resolve(input);
    const alias = rootAliases.filter(item => inside(item.input, normalized)).sort((a, b) => b.input.length - a.input.length)[0];
    if (alias) normalized = path.join(alias.canonical, path.relative(alias.input, normalized));
    const root = canonicalRoots.filter(item => inside(item, normalized)).sort((a, b) => b.length - a.length)[0];
    if (!root || !eligiblePath(normalized)) return null;
    let current = root;
    try {
      for (const part of path.relative(root, normalized).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        const info = await stat(current);
        if (!info?.isDirectory() || info.isSymbolicLink()) return null;
      }
      const canonical = await realpath(normalized);
      return canonical === normalized && eligiblePath(canonical) ? canonical : null;
    } catch { return null; }
  }

  async function hasKnowledge(directory, depth = 0, budget = { count: 0 }) {
    if (++budget.count > 500) { warn(`Ganglia entry scan limit reached: ${directory}`); return false; }
    const children = await entries(directory);
    if (!children) return false;
    if (children.some(entry => entry.isFile() && !entry.isSymbolicLink() && !entry.name.startsWith('.') && entry.name.endsWith('.md'))) return true;
    for (const entry of children) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || excluded(entry.name) || ['sessions', 'checkpoints'].includes(entry.name)) continue;
      if (depth >= maxDepth) { warn(`Ganglia entry depth limit reached: ${directory}`); continue; }
      if (await hasKnowledge(path.join(directory, entry.name), depth + 1, budget)) return true;
    }
    return false;
  }

  if (gangliaRoot) {
    let knowledgeRoot;
    try {
      const base = await realpath(gangliaRoot);
      const local = path.join(base, 'local');
      knowledgeRoot = path.join(local, 'projects');
      if ((await stat(local))?.isSymbolicLink() || (await stat(knowledgeRoot))?.isSymbolicLink()) throw new Error('symlink');
      if (!(await stat(knowledgeRoot))?.isDirectory()) throw new Error('missing');
    } catch { knowledgeRoot = null; warn('Ganglia project directory is unavailable or symlinked'); }
    if (knowledgeRoot && (await stat(knowledgeRoot))?.isDirectory() && !(await stat(knowledgeRoot))?.isSymbolicLink()) {
      const slugs = await entries(knowledgeRoot) ?? [];
      for (const slug of slugs) {
        if (!slug.isDirectory() || slug.isSymbolicLink() || excluded(slug.name) || ['sessions', 'checkpoints'].includes(slug.name)) continue;
        if (!await hasKnowledge(path.join(knowledgeRoot, slug.name))) continue;
        if (Object.hasOwn(gangliaMappings, slug.name)) {
          const mapped = await checkedDirectory(gangliaMappings[slug.name]);
          if (mapped) add(mapped, 'Ganglia');
          else warn(`Ganglia mapping is outside permitted directories, symlinked, or missing: ${slug.name}`);
          continue;
        }
        const candidates = new Set([...gitRoots].filter(directory => path.basename(directory) === slug.name));
        let ambiguous = false;
        for (const root of canonicalRoots) {
          const direct = await checkedDirectory(path.join(root, slug.name));
          if (!direct) continue;
          if (gitRoots.has(direct)) { candidates.add(direct); continue; }
          if ([...incomplete].some(directory => inside(direct, directory) || inside(directory, direct))) { ambiguous = true; continue; }
          const nested = [...gitRoots].filter(directory => directory !== direct && inside(direct, directory));
          if (nested.length > 1) ambiguous = true;
          else candidates.add(nested[0] ?? direct);
        }
        if (ambiguous || candidates.size > 1) warn(`Ganglia project mapping is ambiguous; configure an explicit mapping: ${slug.name}`);
        else if (candidates.size === 1) add([...candidates][0], 'Ganglia');
        else warn(`No existing project directory found for Ganglia entry: ${slug.name}`);
      }
    }
  }
  if (suppressed) warnings.push(`${suppressed} additional discovery warnings suppressed`);
  const projects = [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
  for (const project of projects) project.sources.sort();
  return { projects, warnings };
}
