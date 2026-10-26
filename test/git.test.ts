import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, rename, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Git, graphRows, parseChanges, parseStatus, assertHash } from '../src/git';

async function repository(run: (git: Git, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'git-workbench-'));
  const git = new Git(root);
  try {
    await git.run(['init', '-b', 'main']);
    await git.run(['config', 'user.name', '测试 Author']);
    await git.run(['config', 'user.email', 'test@example.invalid']);
    await git.run(['config', 'commit.gpgsign', 'false']);
    await git.run(['config', 'core.autocrlf', 'false']);
    await run(git, root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function commit(git: Git, message: string): Promise<string> {
  await git.mutate(['add', '-A']);
  await git.mutate(['commit', '--file', '-'], `${message}\n`);
  return (await git.head())!;
}

test('empty repository, first commit, root diff and NUL-safe paths', async () => repository(async (git, root) => {
  assert.equal(await git.head(), undefined);
  assert.deepEqual(await git.commits(), []);
  assert.equal((await git.state()).branch, 'main');
  const file = '空 格\t换\n行.txt';
  await writeFile(path.join(root, file), 'first\n');
  assert.equal((await git.status())[0].path, file);
  const first = await commit(git, 'first | 中文 <script>alert(1)</script>');
  const log = await git.commits();
  assert.equal(log.length, 1); assert.equal(log[0].hash, first); assert.equal(log[0].author, '测试 Author');
  assert.equal(log[0].subject, 'first | 中文 <script>alert(1)</script>');
  const change = await git.changes(first);
  assert.equal(change.files[0].status, 'A'); assert.equal(change.files[0].path, file);
  assert.equal(await git.content(first, file), 'first\n');
}));

test('staging, unborn unstage, partial staging diff and tracked deletion', async () => repository(async (git, root) => {
  await writeFile(path.join(root, 'a.txt'), 'one\n');
  await git.mutate(['add', '--', 'a.txt']);
  assert.equal((await git.status())[0].index, 'A');
  await writeFile(path.join(root, 'a.txt'), 'edited after staging\n');
  await git.mutate(['rm', '--cached', '-f', '--', 'a.txt']);
  assert.equal((await git.status())[0].status, '??');
  await commit(git, 'initial');
  await writeFile(path.join(root, 'a.txt'), 'two\n');
  await git.mutate(['add', '--', 'a.txt']);
  await writeFile(path.join(root, 'a.txt'), 'three\n');
  assert.equal((await git.status())[0].status, 'MM');
  assert.equal(await git.content(':0', 'a.txt'), 'two\n');
  await git.mutate(['reset', 'HEAD', '--', 'a.txt']);
  assert.equal((await git.status())[0].status, ' M');
  await git.mutate(['restore', '--worktree', '--', 'a.txt']);
  assert.deepEqual(await git.status(), []);
  await rm(path.join(root, 'a.txt'));
  const deleted = await commit(git, 'delete');
  assert.equal((await git.changes(deleted)).files[0].status, 'D');
}));

test('rename follows file history and exposes original path in diff', async () => repository(async (git, root) => {
  await writeFile(path.join(root, 'before.txt'), 'alpha\nbeta\ngamma\n');
  const first = await commit(git, 'initial');
  await rename(path.join(root, 'before.txt'), path.join(root, 'after.txt'));
  await git.mutate(['add', '-A']);
  const status = await git.status();
  assert.equal(status[0].oldPath, 'before.txt'); assert.equal(status[0].path, 'after.txt');
  const second = await commit(git, 'rename');
  const change = (await git.changes(second)).files[0];
  assert.equal(change.status, 'R100'); assert.equal(change.oldPath, 'before.txt');
  const history = await git.fileHistory('after.txt');
  assert.deepEqual(history.map(item => item.hash), [second, first]);
  const detailed = await git.fileHistoryDetails('after.txt');
  assert.deepEqual(detailed.map(item => [item.hash, item.file]), [[second, 'after.txt'], [first, 'before.txt']]);
  assert.match(await git.filePatch(first, 'before.txt'), /\+alpha/);
}));

test('line history includes matching changes, ignores other lines and maps saved local line shifts', async () => repository(async (git, root) => {
  await writeFile(path.join(root, 'code.txt'), 'keep\nfirst\nlast\n');
  const first = await commit(git, 'initial');
  await writeFile(path.join(root, 'code.txt'), 'keep\nsecond  \nlast\n');
  const second = await commit(git, 'edit selected line');
  await writeFile(path.join(root, 'code.txt'), 'changed elsewhere\nsecond  \nlast\n');
  await commit(git, 'other line');
  const history = await git.lineHistory('code.txt', 2, 2);
  assert.deepEqual(history.map(item => item.hash), [second, first]);
  assert.match(history[0].patch, /\+second/);
  assert.match(history[0].patch, /\+second  $/m);
  assert.match(history[0].patch, /-first/);
  await writeFile(path.join(root, 'code.txt'), 'new\nchanged elsewhere\nsecond  \nlast\n');
  assert.deepEqual((await git.lineHistory('code.txt', 3, 3)).map(item => item.hash), [second, first]);
  await assert.rejects(git.lineHistory('code.txt', 0, 1), /行号/);
}));

test('blame uses unsaved contents and marks uncommitted lines', async () => repository(async (git, root) => {
  await writeFile(path.join(root, 'code.txt'), 'first\nsecond\n');
  const first = await commit(git, 'initial');
  const blame = await git.blame('code.txt', 'first\nunsaved\n');
  assert.equal(blame.length, 2);
  assert.equal(blame[0].hash, first); assert.equal(blame[0].author, '测试 Author');
  assert.match(blame[1].hash, /^0+$/); assert.equal(blame[1].content, 'unsaved');
}));

test('merge graph connects both parents and commit diffs can select either parent', async () => repository(async (git, root) => {
  await writeFile(path.join(root, 'base.txt'), 'root\n');
  const first = await commit(git, 'base');
  await git.mutate(['switch', '-c', 'feature']);
  await writeFile(path.join(root, 'feature.txt'), 'feature\n');
  const feature = await commit(git, 'feature');
  await git.mutate(['switch', '--', 'main']);
  await writeFile(path.join(root, 'main.txt'), 'main\n');
  const main = await commit(git, 'main change');
  await git.mutate(['merge', '--no-ff', '--no-edit', 'feature']);
  const merge = (await git.head())!;
  const changes = await git.changes(merge);
  assert.deepEqual(changes.commit.parents, [main, feature]);
  assert.equal(changes.files[0].path, 'feature.txt');
  assert.equal((await git.changes(merge, feature)).files[0].path, 'main.txt');
  await assert.rejects(git.changes(merge, first), /父提交/);
  const log = await git.commits(), graph = graphRows(log);
  assert.equal(log[0].hash, merge); assert.equal(graph[0].edges.length, 2);
  for (let i = 0; i < log.length; i++) {
    for (const parent of log[i].parents) assert.ok(graph[i].after.includes(parent));
    for (const edge of graph[i].edges) assert.ok(edge.to >= 0);
  }
  assert.equal(graph.at(-1)!.after.length, 0);
}));

test('conflict state, index stages, resolution and merge continue', async () => repository(async (git, root) => {
  await writeFile(path.join(root, 'code.txt'), 'base\n'); await commit(git, 'base');
  await git.mutate(['switch', '-c', 'feature']);
  await writeFile(path.join(root, 'code.txt'), 'theirs\n'); await commit(git, 'theirs');
  await git.mutate(['switch', 'main']);
  await writeFile(path.join(root, 'code.txt'), 'ours\n'); await commit(git, 'ours');
  await assert.rejects(git.mutate(['merge', '--no-edit', 'feature']));
  assert.equal((await git.state()).operation, 'merge');
  assert.equal((await git.status())[0].status, 'UU');
  assert.equal(await git.content(':2', 'code.txt'), 'ours\n');
  assert.equal(await git.content(':3', 'code.txt'), 'theirs\n');
  await writeFile(path.join(root, 'code.txt'), 'resolved\n');
  await git.mutate(['add', '--', 'code.txt']); await git.mutate(['merge', '--continue']);
  assert.equal((await git.state()).operation, undefined);
  assert.deepEqual(await git.status(), []);
}));

test('filters, detached HEAD, worktree roots and branch validation', async () => repository(async (git, root) => {
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'file.txt'), 'one\n'); const first = await commit(git, 'needle');
  await writeFile(path.join(root, 'outside.txt'), 'two\n'); await commit(git, 'another');
  assert.equal((await git.commits({ search: 'needle' })).length, 1);
  assert.equal((await git.commits({ path: 'src' })).length, 1);
  assert.equal((await git.commits({ ref: 'refs/heads/main', author: '测试' })).length, 2);
  await assert.rejects(git.commits({ ref: '--output=evil' }), /不存在/);
  await assert.rejects(git.validateBranch('-evil'), /无效/);
  await assert.rejects(git.validateBranch('bad name'));
  assert.throws(() => git.file('../escape'), /不属于/);
  assert.throws(() => assertHash('--help'), /无效/);
  assert.equal((await Git.discover(path.join(root, 'src'))).root, await import('node:fs/promises').then(fs => fs.realpath(root)));
  await git.mutate(['switch', '--detach', first]);
  assert.equal((await git.state()).branch, '(detached HEAD)');
}));

test('push, fetch and fast-forward pull work against a local bare remote', async () => repository(async (git, root) => {
  await writeFile(path.join(root, 'file.txt'), 'base\n'); await commit(git, 'base');
  const bare = await mkdtemp(path.join(tmpdir(), 'git-workbench-remote-'));
  try {
    await new Git(bare).run(['init', '--bare']);
    await git.run(['remote', 'add', 'origin', bare]);
    await git.mutate(['push', '--set-upstream', '--', 'origin', 'HEAD:refs/heads/main']);
    await git.mutate(['fetch', '--all', '--prune']);
    await git.mutate(['pull', '--ff-only', '--', 'origin', 'main']);
    assert.ok((await git.refs()).some(ref => ref.full === 'refs/remotes/origin/main'));
    await git.mutate(['push', '--set-upstream', '--force-with-lease', '--', 'origin', 'HEAD:refs/heads/main']);
    await git.mutate(['push', '--set-upstream', '--', 'origin', 'HEAD:refs/heads/shared']);
    const state = await git.state();
    assert.equal(state.upstreamRemote, 'origin'); assert.equal(state.upstreamRef, 'refs/heads/shared');
    await git.mutate(['pull', '--ff-only', '--', 'origin', 'shared']);
  } finally { await rm(bare, { recursive: true, force: true }); }
}));

test('parsers preserve whitespace and rename path ordering', () => {
  assert.deepEqual(parseChanges('R100\0 before\t.txt\0 after\n.txt\0'), [{ status: 'R100', oldPath: ' before\t.txt', path: ' after\n.txt' }]);
  assert.deepEqual(parseStatus('R  new name\0old name\0?? -flag\0').map(item => [item.path, item.oldPath]), [['new name', 'old name'], ['-flag', undefined]]);
});

test('orphan branch remains usable when other branches have commits', async () => repository(async (git, root) => {
  await writeFile(path.join(root, 'main.txt'), 'main\n'); await commit(git, 'main');
  await git.mutate(['switch', '--orphan', 'new-history']);
  assert.equal(await git.head(), undefined);
  assert.deepEqual(await git.commits(), []);
  assert.equal((await git.state()).branch, 'new-history');
  await writeFile(path.join(root, 'new.txt'), 'new\n'); await commit(git, 'new root');
  assert.equal((await git.commits()).length, 2);
}));

test('editor paths through a symlinked workspace map to the canonical Git root', async () => repository(async (git, root) => {
  await writeFile(path.join(root, 'file.txt'), 'tracked\n'); await commit(git, 'initial');
  const container = await mkdtemp(path.join(tmpdir(), 'git-workbench-alias-'));
  try {
    const alias = path.join(container, 'alias'); await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const discovered = await Git.discover(alias);
    assert.equal(discovered.relative(path.join(alias, 'file.txt')), 'file.txt');
    assert.equal((await discovered.lineHistory(discovered.relative(path.join(alias, 'file.txt')), 1, 1)).length, 1);
    assert.throws(() => discovered.file('../outside.txt'), /不属于/);
  } finally { await rm(container, { recursive: true, force: true }); }
}));

test('filtered history terminates hidden parents without accumulating phantom lanes', () => {
  const commits = Array.from({ length: 200 }, (_, index) => ({ hash: String(index).padStart(40, '0'), parents: [`a${String(index).padStart(39, '0')}`], author: 'author', date: '', subject: '', refs: '' }));
  const graph = graphRows(commits);
  assert.ok(graph.every(row => row.before.length === 1 && row.after.length === 0 && row.hiddenParents === 1));
});

test('repository-scoped environment cannot redirect commands to another Git directory', async () => repository(async (git, root) => {
  await writeFile(path.join(root, 'file.txt'), 'local\n'); const hash = await commit(git, 'local');
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(root, 'does-not-exist');
  try { assert.equal(await git.head(), hash); }
  finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; }
}));

test('multiple commits include the oldest commit and intermediate changes for both sparse and continuous selection', async () => repository(async (git, root) => {
  await writeFile(path.join(root, 'file.txt'), 'initial\n'); const initial = await commit(git, 'initial');
  await writeFile(path.join(root, 'file.txt'), 'first edit\n'); const first = await commit(git, 'first edit');
  await writeFile(path.join(root, 'other.txt'), 'intermediate\n'); const middle = await commit(git, 'intermediate');
  await writeFile(path.join(root, 'file.txt'), 'initial\n'); const last = await commit(git, 'undo edit');
  const range = await git.commitSelection([last, middle, first]);
  assert.equal(range.mode, 'range'); assert.equal(range.base, initial); assert.equal(range.target, last);
  assert.deepEqual(range.commits.map(item => item.hash), [last, middle, first]);
  assert.deepEqual(range.files.map(file => file.path), ['other.txt'], 'edits to file.txt cancel in the net change');
  const sparse = await git.commitSelection([last, first]);
  assert.equal(sparse.mode, 'range');
  assert.equal(sparse.base, initial); assert.equal(sparse.target, last);
  assert.deepEqual(sparse.files.map(file => file.path), ['other.txt'], 'intermediate changes are included and cancelling changes disappear');
  assert.equal((await git.commitSelection([last, middle, first, initial])).base, await git.emptyTree());
  assert.equal((await git.commitSelection([first, first])).commits.length, 1);
  await assert.rejects(git.commitSelection([]), /1–300/);
  await assert.rejects(git.commitSelection(['--all']), /提交 ID/);
}));

test('selection across branches compares the displayed endpoints using the oldest first parent', async () => repository(async (git, root) => {
  await writeFile(path.join(root, 'root.txt'), 'root\n'); const base = await commit(git, 'root');
  await git.mutate(['checkout', '-b', 'side']); await writeFile(path.join(root, 'side.txt'), 'side\n'); const side = await commit(git, 'side');
  await git.mutate(['checkout', 'main']); await writeFile(path.join(root, 'main.txt'), 'main\n'); const main = await commit(git, 'main');
  const selection = await git.commitSelection([side, main]);
  assert.equal(selection.mode, 'range');
  assert.equal(selection.base, base); assert.equal(selection.target, side);
  assert.deepEqual(selection.files.map(file => [file.path, file.base, file.target]), [['side.txt', base, side]]);
}));


test('snapshot comparison preserves whitespace and missing final newline without changing the repository', async () => repository(async (git, root) => {
  await writeFile(path.join(root, 'file.txt'), 'committed\n'); const head = await commit(git, 'initial');
  const patch = await git.textPatch('before  \nlast', 'after\t\nlast');
  assert.match(patch, /-before  \n\+after\t/);
  assert.match(patch, /\\ No newline at end of file/);
  assert.match(patch, /--- a\/selection\n\+\+\+ b\/selection/);
  assert.equal(await git.textPatch('unchanged\n', 'unchanged\n'), '');
  assert.equal(await git.head(), head); assert.deepEqual(await git.status(), []);
  await assert.rejects(git.textPatch('binary\0', 'text'), /二进制/);
}));


test('dirty selection history maps saved, staged and unsaved edits to HEAD without writing user data', async () => repository(async (git, root) => {
  const file = path.join(root, 'code.txt');
  await writeFile(file, 'guard\nfirst\nseparator\ntail\n'); const first = await commit(git, 'initial');
  await writeFile(file, 'guard\nsecond\nseparator\ntail\n'); const second = await commit(git, 'selected edit');
  const saved = 'prefix\nguard\nsecond\nseparator\ntail\n';
  await writeFile(file, saved); await git.mutate(['add', '--', 'code.txt']);
  const status = await git.status(), index = await git.run(['show', ':code.txt']);
  const shifted = await git.lineHistoryDetails('code.txt', 3, 3);
  assert.deepEqual(shifted.entries.map(item => item.hash), [second, first]);
  assert.match(shifted.notice!, /3–3.*2–2/);
  const unsaved = saved.replace('second', 'rewritten\nextra');
  const rewritten = await git.lineHistoryDetails('code.txt', 4, 4, unsaved);
  assert.deepEqual(rewritten.entries.map(item => item.hash), [second, first]);
  assert.match(rewritten.notice!, /修改前的整个代码块/);
  await assert.rejects(git.lineHistoryDetails('code.txt', 1, 1, unsaved), /新增内容/);
  const mixed = await git.lineHistoryDetails('code.txt', 1, 4, unsaved);
  assert.match(mixed.notice!, /纯新增行暂无历史/);
  assert.equal(await readFile(file, 'utf8'), saved);
  assert.equal(await git.run(['show', ':code.txt']), index); assert.deepEqual(await git.status(), status);
  assert.equal(await git.head(), second);
}));

test('dirty history handles deletions, CRLF, staged renames and files with no committed history', async () => repository(async (git, root) => {
  await writeFile(path.join(root, 'code.txt'), 'prefix\nguard\nfirst\nseparator\ntail\n'); const initial = await commit(git, 'initial');
  const removedPrefix = await git.lineHistoryDetails('code.txt', 2, 2, 'guard\r\nrewritten\r\nseparator\r\ntail\r\n');
  assert.equal(removedPrefix.entries[0].hash, initial); assert.match(removedPrefix.notice!, /2–2.*3–3/);
  await git.mutate(['mv', 'code.txt', 'renamed.txt']);
  const rename = await git.lineHistoryDetails('renamed.txt', 3, 3);
  assert.equal(rename.entries[0].hash, initial); assert.match(rename.notice!, /重命名前路径 code.txt/);
  await writeFile(path.join(root, 'new.txt'), 'new\n');
  await assert.rejects(git.lineHistoryDetails('new.txt', 1, 1), /新增文件/);
  await assert.rejects(git.lineHistoryDetails('code.txt', 1, 1, 'new\0'), /二进制/);
}));
