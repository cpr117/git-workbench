import { t } from './i18n';
import * as path from 'node:path';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { Change, Git, assertHash, parseChanges, isConflict } from './git';

export function inScope(file: string, scope: string): boolean {
  return !scope || file === scope || file.startsWith(`${scope}/`);
}

export function scopePaths(git: Git, scope: string): string[] {
  if (scope) git.file(scope);
  return [scope || '.'];
}

export async function scopeChanges(git: Git, scope: string): Promise<Change[]> {
  scopePaths(git, scope);
  return (await git.status()).filter(change => inScope(change.path, scope) || !!change.oldPath && inScope(change.oldPath, scope));
}

export function changePaths(changes: Change[], scope: string): string[] {
  const paths = [...new Set(changes.flatMap(change => change.oldPath ? [change.oldPath, change.path] : [change.path]))];
  if (paths.some(file => !inScope(file, scope))) throw new Error(t("存在跨目录重命名，请在共同父目录操作，避免影响所选目录之外的文件。"));
  return paths;
}

export async function commitPaths(git: Git, scope: string, files: string[], message: string): Promise<void> {
  if (!files.length || files.some(file => !file || !inScope(file, scope))) throw new Error(t("请选择范围内的改动文件。"));
  for (const file of files) git.file(file);
  const state = await git.state();
  if (state.operation) throw new Error(t("请先完成或中止正在进行的 Git 操作，不能在此时提交部分目录。"));
  const changes = await git.status();
  if (changes.some(change => isConflict(change.status))) throw new Error(t("请先解决仓库中的冲突。"));
  // Explicit paths plus --only keep staged changes outside this selection out of the commit.
  // Staged deletions (including the old side of staged renames) no longer exist
  // in the index, so passing them to add would fail before commit --only.
  const stageable = new Set((await git.run(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...files])).split('\0').filter(Boolean));
  const stage = files.filter(file => stageable.has(file));
  if (stage.length) await git.mutate(['add', '-A', '--', ...stage]);
  await git.mutate(['commit', '--only', '--file', '-', '--', ...files], `${message}\n`);
}

export async function rollbackScope(git: Git, scope: string): Promise<void> {
  if (!await git.head()) throw new Error(t("仓库尚无提交，无法回滚到 HEAD。"));
  if ((await git.state()).operation) throw new Error(t("Git 操作进行中，请先解决冲突或中止操作。"));
  const paths = scopePaths(git, scope), changes = await scopeChanges(git, scope);
  changePaths(changes, scope);
  if (changes.some(change => isConflict(change.status))) throw new Error(t("冲突文件请先解决或中止操作。"));
  await git.mutate(['reset', 'HEAD', '--', ...paths]);
  // Reset first: staged new files become untracked and are never deleted by restore.
  const tracked = await git.run(['ls-files', '-z', '--', ...paths]);
  if (tracked) await git.mutate(['restore', '--worktree', '--', ...paths]);
}

export async function workingChanges(git: Git, scope: string, base: string): Promise<Change[]> {
  const files = parseChanges(await git.run(['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '-M', assertHash(base), '--', ...scopePaths(git, scope)]));
  for (const file of await scopeChanges(git, scope)) {
    if (file.status === '??' && !files.some(change => change.path === file.path)) files.push({ status: 'A', path: file.path });
  }
  return files;
}

export async function excludeScope(git: Git, scope: string, directory: boolean): Promise<string> {
  if (scope) git.file(scope);
  const location = path.resolve(git.root, (await git.run(['rev-parse', '--git-path', 'info/exclude'])).trim());
  await mkdir(path.dirname(location), { recursive: true });
  let existing = '';
  try { existing = await readFile(location, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!scope) { if (!existing) await appendFile(location, ''); return location; }
  if (/[\r\n]/.test(scope)) throw new Error(t("包含换行的路径不能写为 Git 忽略规则。"));
  const pattern = `/${scope.replace(/[\\*?\[\] ]/g, '\\$&')}${directory ? '/' : ''}`;
  if (!existing.split(/\r?\n/).includes(pattern)) await appendFile(location, `${existing && !existing.endsWith('\n') ? '\n' : ''}${pattern}\n`);
  return location;
}
