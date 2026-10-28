import { Git, SelectedChange, assertHash } from './git';
import { t } from './i18n';

export interface StashEntry { ref: string; hash: string; subject: string; date: string; }
export interface StashSnapshot { entries: StashEntry[]; fingerprint: string; }
export interface StashFile extends SelectedChange { id: string; source: 'worktree' | 'index' | 'untracked'; }
export interface StashDetail { stash: StashEntry; files: StashFile[]; }

export async function stashSnapshot(git: Git): Promise<StashSnapshot> {
  const raw = await git.run(['stash', 'list', '-z', '--format=%H%x00%gs%x00%aI']);
  const fields = raw.split('\0'), entries: StashEntry[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const hash = fields[i].trim();
    if (hash) entries.push({ ref: `stash@{${entries.length}}`, hash: assertHash(hash), subject: fields[i + 1], date: fields[i + 2] });
  }
  return { entries, fingerprint: raw };
}

export async function stashDetail(git: Git, stash: StashEntry): Promise<StashDetail> {
  const commit = await git.commit(stash.hash);
  if (commit.parents.length < 2) throw new Error(t("无效的 Stash 记录，请刷新。"));
  const base = commit.parents[0], target = stash.hash;
  const files: StashFile[] = (await git.compare(base, target)).map(file => ({ ...file, base, target, id: `worktree:${file.path}`, source: 'worktree' }));
  // An index edit can be cancelled by an unstaged edit, leaving H and W equal.
  // Keep these otherwise invisible changes available for --index restoration.
  const index = commit.parents[1];
  const represented = new Set(files.map(file => file.path));
  for (const file of await git.compare(base, index)) {
    if (!represented.has(file.path)) files.push({ ...file, base, target: index, id: `index:${file.path}`, source: 'index' });
  }
  if (commit.parents[2]) {
    const empty = await git.emptyTree(), untracked = commit.parents[2];
    files.push(...(await git.compare(empty, untracked)).map(file => ({ ...file, base: empty, target: untracked, id: `untracked:${file.path}`, source: 'untracked' as const })));
  }
  return { stash, files };
}

export async function assertStashSnapshot(git: Git, expected: StashSnapshot, entry: StashEntry): Promise<void> {
  const current = await stashSnapshot(git);
  if (current.fingerprint !== expected.fingerprint || !current.entries.some(item => item.ref === entry.ref && item.hash === entry.hash)) {
    throw new Error(t("Stash 列表已改变，请刷新并重新选择。"));
  }
}

// Apply immutable objects; remove a reflog entry only after rechecking the entire list.
// Git has no compare-and-delete operation for one stash reflog entry across external processes.
export async function restoreStash(git: Git, snapshot: StashSnapshot, entry: StashEntry, action: 'apply' | 'pop' | 'drop', reinstateIndex = false, newBranch?: string): Promise<void> {
  await assertStashSnapshot(git, snapshot, entry);
  if (action !== 'drop') {
    if (newBranch) await git.mutate(['stash', 'branch', newBranch, entry.hash]);
    else await git.mutate(['stash', 'apply', ...(reinstateIndex ? ['--index'] : []), entry.hash]);
  }
  if (action !== 'apply') {
    try { await assertStashSnapshot(git, snapshot, entry); }
    catch (error) {
      if (action === 'pop') throw new Error(t("Stash 已恢复，但无法确认列表状态，未删除记录。请刷新检查。"), { cause: error });
      throw error;
    }
    await git.mutate(['stash', 'drop', entry.ref]);
  }
}
