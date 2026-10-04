import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverProjects } from '../src/projects.mjs';

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'gateway-projects-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'work');
  const ganglia = path.join(base, 'knowledge');
  await mkdir(root);
  await mkdir(path.join(ganglia, 'local', 'projects'), { recursive: true });
  const file = async (relative, content = '') => {
    const destination = path.join(base, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
    return destination;
  };
  return { base, root, ganglia, file, options: { roots: [root], gangliaRoot: ganglia } };
}

test('discovers own instructions and collapses nested instructions to nearest Git root', async t => {
  const f = await fixture(t);
  await f.file('work/alpha/.git/HEAD');
  await f.file('work/alpha/src/AGENTS.md');
  await f.file('work/alpha/AGENTS.md');
  await f.file('work/plain/AGENTS.md');
  await f.file('work/unrelated/README.md');
  const { projects } = await discoverProjects(f.options);
  assert.deepEqual(projects.map(project => project.name), ['alpha', 'plain']);
  assert.ok(projects.every(project => project.sources.join() === 'AGENTS.md' && project.id.length <= 20));
  assert.deepEqual((await discoverProjects(f.options)).projects, projects);
});

test('Ganglia requires actual knowledge files and ignores transcripts, checkpoints and prose paths', async t => {
  const f = await fixture(t);
  await f.file('work/alpha/.git/HEAD');
  await f.file('work/unused/.git/HEAD');
  await f.file('work/checkpoint-only/.git/HEAD');
  await f.file('work/session-only/.git/HEAD');
  await f.file('knowledge/local/projects/alpha/entry.md', 'An incidental /tmp/other-project path is not a project mapping.');
  await f.file('knowledge/local/projects/checkpoint-only/checkpoints/note.md');
  await f.file('knowledge/local/projects/session-only/sessions/note.md');
  await f.file('knowledge/local/MEMORY.local.md', '[unused](projects/unused/entry.md)');
  assert.deepEqual((await discoverProjects(f.options)).projects.map(project => project.name), ['alpha']);
});

test('unique container repository resolves; multiple repositories stay unresolved', async t => {
  const f = await fixture(t);
  await f.file('work/site/frontend/.git/HEAD');
  await f.file('knowledge/local/projects/site/entry.md');
  let result = await discoverProjects(f.options);
  assert.deepEqual(result.projects.map(project => project.name), ['frontend']);
  await f.file('work/site/backend/.git/HEAD');
  result = await discoverProjects(f.options);
  assert.deepEqual(result.projects, []);
  assert.ok(result.warnings.some(message => message.includes('ambiguous')));
});

test('same Git basename in multiple roots stays unresolved until explicitly mapped', async t => {
  const f = await fixture(t);
  await f.file('work/one/alpha/.git/HEAD');
  await f.file('work/two/alpha/.git/HEAD');
  await f.file('knowledge/local/projects/alpha/entry.md');
  assert.deepEqual((await discoverProjects(f.options)).projects, []);
  const mapped = path.join(f.root, 'one', 'alpha');
  const result = await discoverProjects({ ...f.options, gangliaMappings: { alpha: mapped } });
  assert.equal(result.projects[0].path, await realpath(mapped));
});

test('explicit mappings require knowledge, an existing directory, and root containment', async t => {
  const f = await fixture(t);
  await f.file('outside/AGENTS.md');
  await f.file('work/alpha/.git/HEAD');
  await f.file('knowledge/local/projects/alpha/entry.md');
  const result = await discoverProjects({ ...f.options, gangliaMappings: { alpha: path.join(f.base, 'outside'), unknown: path.join(f.root, 'alpha') } });
  assert.deepEqual(result.projects, []);
  assert.ok(result.warnings.some(message => message.includes('outside permitted')));
});

test('does not recurse symlinks, read symlinked instructions, or follow mapping escapes', async t => {
  const f = await fixture(t);
  await f.file('outside/AGENTS.md');
  await f.file('work/plain/README.md');
  await symlink(path.join(f.base, 'outside'), path.join(f.root, 'alias'));
  await symlink(path.join(f.base, 'outside', 'AGENTS.md'), path.join(f.root, 'plain', 'AGENTS.md'));
  await f.file('knowledge/local/projects/alias/entry.md');
  const result = await discoverProjects({ ...f.options, gangliaMappings: { alias: path.join(f.root, 'alias') } });
  assert.deepEqual(result.projects, []);
});

test('skips dependencies, hidden directories and build artifacts', async t => {
  const f = await fixture(t);
  for (const directory of ['node_modules/pkg', '.cache/pkg', 'dist/pkg', 'vendor/pkg', 'Library/pkg']) await f.file(`work/${directory}/AGENTS.md`);
  await f.file('work/alpha/AGENTS.md');
  assert.deepEqual((await discoverProjects(f.options)).projects.map(project => project.name), ['alpha']);
});

test('reports depth truncation without resolving an incompletely scanned container', async t => {
  const f = await fixture(t);
  await f.file('work/site/deep/app/.git/HEAD');
  await f.file('knowledge/local/projects/site/entry.md');
  const result = await discoverProjects({ ...f.options, maxDepth: 1 });
  assert.deepEqual(result.projects, []);
  assert.ok(result.warnings.some(message => message.includes('Depth limit')));
});

test('supports Git worktree marker files and merges evidence', async t => {
  const f = await fixture(t);
  await f.file('work/alpha/.git', 'gitdir: EXAMPLE_NOT_A_SECRET');
  await f.file('work/alpha/AGENTS.md');
  await f.file('knowledge/local/projects/alpha/entry.md');
  const result = await discoverProjects(f.options);
  assert.deepEqual(result.projects[0].sources, ['AGENTS.md', 'Ganglia']);
});

test('rejects symlinked Ganglia local directories', async t => {
  const f = await fixture(t);
  await f.file('work/alpha/.git/HEAD');
  await f.file('outside/projects/alpha/entry.md');
  await rm(path.join(f.ganglia, 'local'), { recursive: true });
  await symlink(path.join(f.base, 'outside'), path.join(f.ganglia, 'local'));
  const result = await discoverProjects(f.options);
  assert.deepEqual(result.projects, []);
  assert.ok(result.warnings.some(message => message.includes('symlinked')));
});

test('overlapping roots can deepen discovery without duplicate projects', async t => {
  const f = await fixture(t);
  await f.file('work/group/deep/project/AGENTS.md');
  const result = await discoverProjects({ roots: [f.root, path.join(f.root, 'group')], maxDepth: 2 });
  assert.deepEqual(result.projects.map(project => project.name), ['project']);
});

test('validates discovery configuration', async () => {
  await assert.rejects(discoverProjects({ roots: ['relative'] }), /absolute/);
  await assert.rejects(discoverProjects({ roots: ['/tmp'], maxDepth: -1 }), /maxDepth/);
  await assert.rejects(discoverProjects({ roots: ['/tmp'], gangliaRoot: 'relative' }), /absolute/);
});
