import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Git } from '../src/git';
import { changePaths, commitPaths, excludeScope, rollbackScope, scopeChanges, workingChanges } from '../src/explorerGit';

async function fixture(task: (git: Git, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'git-workbench-directory-')), git = new Git(root);
  try {
    await git.run(['init', '-b', 'main']);
    await git.run(['config', 'user.name', 'Directory Test']); await git.run(['config', 'user.email', 'test@example.invalid']);
    await git.run(['config', 'commit.gpgsign', 'false']);
    await mkdir(path.join(root, 'inside')); await mkdir(path.join(root, 'inside-other'));
    for (const file of ['inside/a.txt', 'inside/b.txt', 'inside-other/a.txt', 'outside.txt']) await writeFile(path.join(root, file), 'base\n');
    await git.mutate(['add', '-A']); await git.mutate(['commit', '-m', 'base']);
    await task(git, root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('directory commit excludes staged outside files and unselected files in the directory', async () => fixture(async (git, root) => {
  for (const file of ['inside/a.txt', 'inside/b.txt', 'outside.txt']) await writeFile(path.join(root, file), 'changed\n');
  await git.mutate(['add', '--', 'outside.txt']);
  await commitPaths(git, 'inside', ['inside/a.txt'], 'directory only');
  assert.deepEqual((await git.changes((await git.head())!)).files.map(file => file.path), ['inside/a.txt']);
  assert.equal(await git.run(['show', ':outside.txt']), 'changed\n');
  assert.equal(await git.run(['show', ':inside/b.txt']), 'base\n');
  assert.equal((await git.status()).find(file => file.path === 'outside.txt')!.index, 'M');
}));

test('directory rollback preserves new files and outside staged content', async () => fixture(async (git, root) => {
  await writeFile(path.join(root, 'inside/a.txt'), 'changed\n'); await rm(path.join(root, 'inside/b.txt'));
  await writeFile(path.join(root, 'inside/new.txt'), 'keep staged new\n'); await writeFile(path.join(root, 'inside/untracked.txt'), 'keep untracked\n');
  await writeFile(path.join(root, 'outside.txt'), 'outside\n'); await git.mutate(['add', '-A']);
  await rollbackScope(git, 'inside');
  assert.equal(await readFile(path.join(root, 'inside/a.txt'), 'utf8'), 'base\n');
  assert.equal(await readFile(path.join(root, 'inside/b.txt'), 'utf8'), 'base\n');
  assert.equal(await readFile(path.join(root, 'inside/new.txt'), 'utf8'), 'keep staged new\n');
  assert.equal(await readFile(path.join(root, 'inside/untracked.txt'), 'utf8'), 'keep untracked\n');
  assert.equal(await git.run(['show', ':outside.txt']), 'outside\n');
  assert.equal((await git.status()).find(file => file.path === 'inside/new.txt')!.status, '??');
}));

test('directory scope treats pathspec metacharacters literally and includes new and deleted files in comparisons', async () => fixture(async (git, root) => {
  const head = (await git.head())!;
  await mkdir(path.join(root, 'literal[*]')); await writeFile(path.join(root, 'literal[*]/new.txt'), 'literal\n');
  await writeFile(path.join(root, 'inside-other/a.txt'), 'outside sibling\n');
  await rm(path.join(root, 'inside/a.txt')); await writeFile(path.join(root, 'inside/new.txt'), 'new\n');
  assert.deepEqual((await scopeChanges(git, 'inside')).map(file => file.path).sort(), ['inside/a.txt', 'inside/new.txt']);
  assert.deepEqual((await workingChanges(git, 'inside', head)).map(file => [file.status, file.path]).sort(), [['A', 'inside/new.txt'], ['D', 'inside/a.txt']]);
  await commitPaths(git, 'literal[*]', ['literal[*]/new.txt'], 'literal folder');
  assert.deepEqual((await git.changes((await git.head())!)).files.map(file => file.path), ['literal[*]/new.txt']);
}));

test('directory commit handles staged deletions and renames', async () => fixture(async git => {
  await git.mutate(['rm', '--', 'inside/a.txt']);
  await git.mutate(['mv', 'inside/b.txt', 'inside/renamed.txt']);
  const changes = await scopeChanges(git, 'inside');
  await commitPaths(git, 'inside', changePaths(changes, 'inside'), 'delete and rename');
  assert.deepEqual(await scopeChanges(git, 'inside'), []);
  assert.equal(await git.content((await git.head())!, 'inside/renamed.txt'), 'base\n');
}));

test('cross-boundary renames and paths outside the repository are rejected', async () => fixture(async (git, root) => {
  await git.mutate(['mv', 'inside/a.txt', 'moved.txt']);
  assert.throws(() => changePaths([{ status: 'R', oldPath: 'inside/a.txt', path: 'moved.txt' }], 'inside'), /跨目录/);
  await assert.rejects(rollbackScope(git, 'inside'), /跨目录/);
  await assert.rejects(commitPaths(git, 'inside', ['outside.txt'], 'invalid'), /范围/);
  await assert.rejects(commitPaths(git, '', ['../outside.txt'], 'invalid'), /不属于/);
  assert.equal(await readFile(path.join(root, 'moved.txt'), 'utf8'), 'base\n');
}));

test('local excludes escape literal folder names and resolve correctly in a worktree', async () => fixture(async (git, root) => {
  const name = 'ignore [x]*'; await mkdir(path.join(root, name)); await writeFile(path.join(root, name, 'a.txt'), 'ignored\n');
  const exclude = await excludeScope(git, name, true); await excludeScope(git, name, true);
  assert.equal((await readFile(exclude, 'utf8')).split('\n').filter(line => line.startsWith('/ignore')).length, 1);
  assert.match(await git.run(['status', '--ignored', '--porcelain', '--', `${name}/a.txt`]), /^!! /);
  const sibling = `${root}-worktree`;
  try {
    await git.mutate(['worktree', 'add', '-b', 'linked', sibling]);
    const linked = await Git.discover(sibling);
    assert.equal(await realpath(await excludeScope(linked, '', true)), await realpath(exclude));
    assert.equal(linked.relative(sibling, true), '');
  } finally { await git.mutate(['worktree', 'remove', '--force', sibling]); }
}));

test('directory commit supports an initial commit and scoped stash leaves other directories alone', async () => fixture(async (git, root) => {
  await git.mutate(['checkout', '--orphan', 'initial']);
  await git.mutate(['rm', '--cached', '-r', '--', '.']);
  await commitPaths(git, 'inside', ['inside/a.txt'], 'first directory commit');
  assert.equal((await git.commit((await git.head())!)).parents.length, 0);
  await writeFile(path.join(root, 'inside/a.txt'), 'stash me\n');
  await writeFile(path.join(root, 'outside.txt'), 'keep outside\n');
  await git.mutate(['stash', 'push', '--include-untracked', '-m', 'scope', '--', 'inside']);
  assert.equal(await readFile(path.join(root, 'inside/a.txt'), 'utf8'), 'base\n');
  assert.equal(await readFile(path.join(root, 'outside.txt'), 'utf8'), 'keep outside\n');
}));
