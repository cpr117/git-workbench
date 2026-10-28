import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Git } from '../src/git';
import { stashSnapshot, stashDetail, restoreStash } from '../src/stash';

async function fixture(run: (git: Git, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'gwb-stash-')), git = new Git(root);
  try {
    await git.run(['init', '-b', 'main']);
    await git.run(['config', 'user.name', 'Stash Test']); await git.run(['config', 'user.email', 'test@example.invalid']);
    await git.run(['config', 'commit.gpgsign', 'false']);
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'nested/old.txt'), 'original\n'.repeat(12));
    await writeFile(path.join(root, 'delete.txt'), 'remove me\n');
    await writeFile(path.join(root, '.gitignore'), '*.ignored\n');
    await git.mutate(['add', '-A']); await git.mutate(['commit', '-m', 'Baseline']);
    await run(git, root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function save(git: Git, root: string, text = 'changed\n'): Promise<void> {
  await writeFile(path.join(root, 'nested/old.txt'), text);
  await git.mutate(['stash', 'push', '--include-untracked', '-m', '中文 <script> & stash']);
}

test('stash file details include tracked, renamed, deleted, staged and untracked files without phantom deletions', async () => fixture(async (git, root) => {
  assert.equal((await stashSnapshot(git)).entries.length, 0);
  await git.mutate(['mv', 'nested/old.txt', 'nested/renamed.txt']);
  await rm(path.join(root, 'delete.txt'));
  await writeFile(path.join(root, 'staged.txt'), 'index\n'); await git.mutate(['add', '--', 'staged.txt']);
  await writeFile(path.join(root, 'staged.txt'), 'worktree\n');
  const untracked = 'nested/空 格\nnew.txt'; await writeFile(path.join(root, untracked), 'untracked\n');
  await writeFile(path.join(root, 'skip.ignored'), 'ignored\n');
  await git.mutate(['stash', 'push', '-u', '-m', '中文 <script> & stash']);
  const snapshot = await stashSnapshot(git), entry = snapshot.entries[0];
  assert.equal(entry.ref, 'stash@{0}'); assert.match(entry.subject, /中文 <script> & stash/);
  const before = await git.run(['status', '--porcelain=v1', '-z']);
  const detail = await stashDetail(git, entry);
  assert.deepEqual(detail.files.map(file => file.path).sort(), ['delete.txt', 'nested/renamed.txt', untracked, 'staged.txt'].sort());
  const rename = detail.files.find(file => file.oldPath === 'nested/old.txt')!; assert.equal(rename.path, 'nested/renamed.txt');
  const newFile = detail.files.find(file => file.path === untracked)!;
  assert.equal(newFile.status, 'A'); assert.equal(await git.content(newFile.target, newFile.path), 'untracked\n');
  assert.notEqual(newFile.target, entry.hash);
  assert.equal(await git.run(['status', '--porcelain=v1', '-z']), before);
  assert.equal((await stashSnapshot(git)).fingerprint, snapshot.fingerprint);
}));

test('untracked-only stashes show just additions and two-parent stashes stay readable', async () => fixture(async (git, root) => {
  await writeFile(path.join(root, 'only-new.txt'), 'new\n'); await git.mutate(['stash', 'push', '-u', '-m', 'new only']);
  let snapshot = await stashSnapshot(git);
  assert.deepEqual((await stashDetail(git, snapshot.entries[0])).files.map(file => [file.path, file.status]), [['only-new.txt', 'A']]);
  await writeFile(path.join(root, 'nested/old.txt'), 'tracked\n'); await git.mutate(['stash', 'push', '-m', 'tracked only']);
  snapshot = await stashSnapshot(git);
  assert.equal((await git.commit(snapshot.entries[0].hash)).parents.length, 2);
  assert.deepEqual((await stashDetail(git, snapshot.entries[0])).files.map(file => file.path), ['nested/old.txt']);
}));

test('apply keeps the entry; pop removes only its selected entry and restores index when requested', async () => fixture(async (git, root) => {
  await save(git, root, 'older\n');
  await writeFile(path.join(root, 'nested/old.txt'), 'newer\n'); await git.mutate(['add', '-A']);
  await git.mutate(['stash', 'push', '-m', 'staged newer']);
  let snapshot = await stashSnapshot(git), entry = snapshot.entries[0];
  await restoreStash(git, snapshot, entry, 'apply', true);
  assert.equal((await stashSnapshot(git)).entries.length, 2);
  assert.equal((await git.status())[0].index, 'M');
  await git.mutate(['reset', '--hard', 'HEAD']);
  snapshot = await stashSnapshot(git); entry = snapshot.entries[0];
  await restoreStash(git, snapshot, entry, 'pop');
  assert.equal((await stashSnapshot(git)).entries.length, 1);
  assert.equal((await stashSnapshot(git)).entries[0].hash, snapshot.entries[1].hash);
}));

test('stale lists and duplicate hashes cannot delete the wrong stash', async () => fixture(async (git, root) => {
  await save(git, root); const snapshot = await stashSnapshot(git), entry = snapshot.entries[0];
  await save(git, root, 'another stash\n');
  await git.mutate(['stash', 'store', '-m', 'duplicate', entry.hash]);
  await assert.rejects(() => restoreStash(git, snapshot, entry, 'drop'), /列表已改变/);
  assert.equal((await stashSnapshot(git)).entries.length, 3);
  const current = await stashSnapshot(git);
  await restoreStash(git, current, current.entries[2], 'drop');
  assert.equal((await stashSnapshot(git)).entries.length, 2);
  assert.match((await stashSnapshot(git)).entries[0].subject, /duplicate/);
}));

test('pop conflicts preserve the stash and its recoverable content', async () => fixture(async (git, root) => {
  await save(git, root, 'stashed\n'); const snapshot = await stashSnapshot(git);
  await writeFile(path.join(root, 'nested/old.txt'), 'conflicting commit\n');
  await git.mutate(['commit', '-am', 'Conflict']);
  await assert.rejects(() => restoreStash(git, snapshot, snapshot.entries[0], 'pop'));
  assert.equal((await stashSnapshot(git)).fingerprint, snapshot.fingerprint);
  assert.ok((await git.status()).some(file => file.status === 'UU'));
}));

test('index-only changes remain visible when an unstaged edit cancels the staged content', async () => fixture(async (git, root) => {
  await writeFile(path.join(root, 'nested/old.txt'), 'index only\n'); await git.mutate(['add', '-A']);
  await writeFile(path.join(root, 'nested/old.txt'), 'original\n'.repeat(12));
  await git.mutate(['stash', 'push', '-m', 'Cancelled working edit']);
  const snapshot = await stashSnapshot(git), detail = await stashDetail(git, snapshot.entries[0]);
  assert.equal(detail.files.length, 1); assert.equal(detail.files[0].source, 'index');
  assert.equal(await git.content(detail.files[0].target, detail.files[0].path), 'index only\n');
}));

test('a tracked change and an untracked replacement at the same path have distinct native diff identities', async () => fixture(async (git, root) => {
  await git.mutate(['rm', 'delete.txt']); await writeFile(path.join(root, 'delete.txt'), 'replacement\n');
  await git.mutate(['stash', 'push', '-u', '-m', 'Same path']);
  const snapshot = await stashSnapshot(git), detail = await stashDetail(git, snapshot.entries[0]);
  assert.equal(detail.files.length, 2);
  const [deleted, added] = detail.files;
  assert.equal(deleted.status, 'M'); assert.equal(added.status, 'A');
  assert.equal(deleted.path, added.path); assert.notEqual(deleted.id, added.id);
  assert.equal(await git.content(added.target, added.path), 'replacement\n');
}));

test('all-branches log excludes stash implementation commits while the stash list remains available', async () => fixture(async (git, root) => {
  const head = await git.head(); await save(git, root);
  const snapshot = await stashSnapshot(git), log = await git.commits();
  assert.equal(snapshot.entries.length, 1);
  assert.deepEqual(log.map(commit => commit.hash), [head]);
  assert.equal(log.some(commit => commit.hash === snapshot.entries[0].hash), false);
}));

test('pop explains partial success and retains entries if the list changes after apply', async () => fixture(async (git, root) => {
  await save(git, root, 'older stash\n'); await save(git, root, 'selected stash\n');
  const snapshot = await stashSnapshot(git), mutate = git.mutate.bind(git);
  git.mutate = async (args, input) => {
    const result = await mutate(args, input);
    if (args[0] === 'stash' && args[1] === 'apply') await mutate(['stash', 'store', '-m', 'external entry', snapshot.entries[1].hash]);
    return result;
  };
  await assert.rejects(() => restoreStash(git, snapshot, snapshot.entries[0], 'pop'), /已恢复.*未删除/);
  assert.equal((await stashSnapshot(git)).entries.length, 3);
  assert.ok((await git.status()).length > 0);
}));

test('restoring on a new branch uses the original base and index and honors keep or drop', async () => fixture(async (git, root) => {
  const base = await git.head();
  await writeFile(path.join(root, 'nested/old.txt'), 'branch stash\n'); await git.mutate(['add', '-A']);
  await git.mutate(['stash', 'push', '-m', 'new branch recovery']);
  await writeFile(path.join(root, 'later.txt'), 'later commit\n'); await git.mutate(['add', '-A']); await git.mutate(['commit', '-m', 'Advance main']);
  const main = await git.head(), snapshot = await stashSnapshot(git), entry = snapshot.entries[0];
  await restoreStash(git, snapshot, entry, 'apply', true, 'rescue');
  assert.equal((await git.state()).branch, 'rescue'); assert.equal(await git.head(), base);
  assert.equal((await git.status())[0].index, 'M'); assert.equal((await stashSnapshot(git)).entries.length, 1);
  await git.mutate(['reset', '--hard', 'HEAD']); await git.mutate(['switch', 'main']);
  await restoreStash(git, snapshot, entry, 'pop', true, 'rescue-drop');
  assert.equal((await git.state()).branch, 'rescue-drop'); assert.equal(await git.head(), base);
  assert.equal((await stashSnapshot(git)).entries.length, 0);
  assert.equal((await git.run(['rev-parse', 'main'])).trim(), main);
}));
