import { t } from './i18n';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { realpathSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { mapLineRange } from './lineMapping';

export interface Commit { hash: string; parents: string[]; author: string; date: string; subject: string; refs: string; }
export interface Change { status: string; path: string; oldPath?: string; index?: string; worktree?: string; }
export interface SelectedChange extends Change { base: string; target: string; commitHash?: string; }
export interface CommitSelection { mode: 'range'; commits: Commit[]; files: SelectedChange[]; base: string; target: string; }
export interface Ref { name: string; full: string; hash: string; current: boolean; remote: boolean; tag: boolean; }
export interface Filters { ref?: string; search?: string; author?: string; since?: string; until?: string; path?: string; limit?: number; }
export interface HistoryEntry extends Commit { patch: string; }
export interface BlameLine { hash: string; original: number; line: number; author: string; summary: string; content: string; }
export interface GraphRow { lane: number; color: number; beforeColors: number[]; before: string[]; after: string[]; hiddenParents: number; edges: { from: number; to: number; color: number }[]; }
export function isConflict(status: string): boolean { return ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(status); }
const format = '%H%x00%P%x00%an%x00%aI%x00%s%x00%D';
const safeDiff = ['--no-ext-diff', '--no-textconv'];
export class GitError extends Error {
  constructor(message: string, readonly exitCode?: string | number) { super(message); }
}

export function assertHash(hash: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash)) throw new Error(t("无效的提交 ID。请刷新提交图。"));
  return hash;
}

export function parseCommits(raw: string): Commit[] {
  const fields = raw.split('\0');
  const result: Commit[] = [];
  for (let i = 0; i + 5 < fields.length; i += 6) {
    const hash = fields[i].trim();
    if (!hash) continue;
    result.push({ hash: assertHash(hash), parents: fields[i + 1].split(' ').filter(Boolean), author: fields[i + 2], date: fields[i + 3], subject: fields[i + 4], refs: fields[i + 5] });
  }
  return result;
}

export function parseChanges(raw: string): Change[] {
  const parts = raw.split('\0');
  const changes: Change[] = [];
  for (let i = 0; i < parts.length - 1;) {
    const status = parts[i++].trim();
    const first = parts[i++];
    if (!status || first === undefined) break;
    if (/^[RC]/.test(status)) changes.push({ status, oldPath: first, path: parts[i++] });
    else changes.push({ status, path: first });
  }
  return changes;
}

export function parseStatus(raw: string): Change[] {
  const parts = raw.split('\0');
  const changes: Change[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const index = entry[0], worktree = entry[1];
    const item: Change = { status: entry.slice(0, 2), index, worktree, path: entry.slice(3) };
    if (/[RC]/.test(index + worktree)) item.oldPath = parts[++i];
    changes.push(item);
  }
  return changes;
}

// Maintain frontier lanes in topological order. Each edge connects this row to the next.
export function graphRows(commits: Commit[]): GraphRow[] {
  let lanes: string[] = [];
  const visible = new Set(commits.map(commit => commit.hash));
  const colors = new Map<string, number>();
  let nextColor = 0;
  return commits.map(commit => {
    if (!colors.has(commit.hash)) colors.set(commit.hash, nextColor++);
    const color = colors.get(commit.hash)!;
    const parents = commit.parents.filter(parent => visible.has(parent));
    let lane = lanes.indexOf(commit.hash);
    if (lane < 0) { lane = lanes.length; lanes.push(commit.hash); }
    const before = [...lanes];
    lanes.splice(lane, 1);
    let insert = lane;
    for (const [index, parent] of parents.entries()) {
      if (!colors.has(parent)) colors.set(parent, index === 0 ? color : nextColor++);
      if (!lanes.includes(parent)) lanes.splice(insert++, 0, parent);
    }
    const after = [...lanes];
    const edges = before.flatMap((hash, from) => hash === commit.hash
      ? parents.map(parent => ({ from, to: after.indexOf(parent), color: colors.get(parent)! }))
      : [{ from, to: after.indexOf(hash), color: colors.get(hash)! }]);
    return { lane, color, beforeColors: before.map(hash => colors.get(hash)!), before, after, hiddenParents: commit.parents.length - parents.length, edges };
  });
}

export class Git {
  constructor(readonly root: string, private readonly log: (text: string) => void = () => {}, private readonly beforeMutation?: (args: readonly string[]) => void) {}

  run(args: string[], input?: string, mutation = false, acceptedExitCodes: readonly number[] = []): Promise<string> {
    return new Promise((resolve, reject) => {
      if (mutation) this.beforeMutation?.(args);
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' };
      for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete (env as NodeJS.ProcessEnv)[key];
      const child = execFile('git', ['--no-pager', '--literal-pathspecs', '-c', 'color.ui=false', '-c', 'core.quotepath=false', ...args], {
        cwd: this.root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
        timeout: mutation ? 120_000 : 30_000,
        env,
      }, (error, stdout, stderr) => {
        if (error && !(typeof error.code === 'number' && acceptedExitCodes.includes(error.code))) {
          this.log(`git ${args[0]} → failed`);
          reject(new GitError(([stderr, stdout].filter(text => text.trim()).join('\n') || error.message).trim(), error.code ?? undefined));
        } else { this.log(`git ${args[0]} → OK`); resolve(stdout); }
      });
      child.stdin?.on('error', () => { /* An early Git failure can close stdin. The callback reports it. */ });
      if (input !== undefined) child.stdin?.end(input);
      else child.stdin?.end();
    });
  }

  static async discover(directory: string): Promise<Git> {
    const git = new Git(directory);
    const root = (await git.run(['rev-parse', '--show-toplevel'])).trim();
    return new Git(root);
  }

  relative(file: string, allowRoot = false): string {
    // macOS /var and /private/var (or a symlinked workspace) may identify the same root.
    // Resolve parent directories, preserving a leaf symlink as a Git-tracked path.
    let parent = path.dirname(path.resolve(file));
    const suffix = [path.basename(file)];
    for (;;) {
      try { parent = realpathSync(parent); break; }
      catch (error) {
        const next = path.dirname(parent);
        if (next === parent) throw error;
        suffix.unshift(path.basename(parent)); parent = next;
      }
    }
    const relative = path.relative(realpathSync(this.root), path.join(parent, ...suffix));
    if ((!relative && !allowRoot) || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(t("文件不属于当前仓库。"));
    return relative.split(path.sep).join('/');
  }

  file(relative: string): string {
    if (typeof relative !== 'string' || relative.includes('\0')) throw new Error(t("无效的文件路径。"));
    const file = path.resolve(this.root, relative);
    this.relative(file);
    return file;
  }

  async head(): Promise<string | undefined> {
    try { return assertHash((await this.run(['rev-parse', '--verify', '--quiet', 'HEAD'])).trim()); }
    catch (error) {
      if (!(error instanceof GitError) || error.exitCode !== 1) throw error;
      const branch = (await this.run(['symbolic-ref', '--quiet', 'HEAD'])).trim();
      try { await this.run(['show-ref', '--verify', '--quiet', branch]); }
      catch (missing) { if (missing instanceof GitError && missing.exitCode === 1) return undefined; throw missing; }
      throw error;
    }
  }

  async refs(): Promise<Ref[]> {
    const raw = await this.run(['for-each-ref', '--sort=refname', '--format=%(refname)%00%(objectname)%00%(HEAD)%00%(symref)', 'refs/heads', 'refs/remotes', 'refs/tags']);
    return raw.trimEnd().split('\n').filter(Boolean).flatMap(line => {
      const [full, hash, current, symbolic] = line.split('\0');
      if (symbolic) return [];
      return [{ name: full.replace(/^refs\/(heads|remotes|tags)\//, ''), full, hash, current: current === '*', remote: full.startsWith('refs/remotes/'), tag: full.startsWith('refs/tags/') }];
    });
  }

  async commits(filters: Filters = {}): Promise<Commit[]> {
    if (!await this.head()) return [];
    const args = ['log', '--topo-order', '-z', `--format=${format}`, `--max-count=${Math.max(1, Math.min(5000, filters.limit || 200))}`];
    if (filters.search) args.push('--fixed-strings', `--grep=${filters.search}`);
    if (filters.author) args.push(`--author=${filters.author}`);
    if (filters.since) args.push(`--since=${filters.since}`);
    if (filters.until) args.push(`--until=${filters.until}`);
    if (filters.ref) {
      if (filters.ref !== 'HEAD' && !(await this.refs()).some(ref => ref.full === filters.ref)) throw new Error(t("分支已不存在，请刷新。"));
      args.push(filters.ref);
    } else args.push('--branches', '--remotes', '--tags', 'HEAD');
    args.push('--');
    if (filters.path) { this.file(filters.path); args.push(filters.path); }
    return parseCommits(await this.run(args));
  }

  async commit(hash: string): Promise<Commit> {
    const commits = parseCommits(await this.run(['show', '-s', '-z', `--format=${format}`, assertHash(hash), '--']));
    if (!commits[0]) throw new Error(t("找不到提交。"));
    return commits[0];
  }

  async message(hash: string): Promise<string> { return this.run(['show', '-s', '--format=%B', assertHash(hash), '--']); }

  async emptyTree(): Promise<string> { return (await this.run(['hash-object', '-t', 'tree', '--stdin'], '')).trim(); }

  async changes(hash: string, parent?: string): Promise<{ base: string; files: Change[]; commit: Commit }> {
    const commit = await this.commit(hash);
    if (parent && !commit.parents.includes(parent)) throw new Error(t("请选择该合并提交的父提交。"));
    const base = parent || commit.parents[0] || await this.emptyTree();
    const files = await this.compare(base, hash);
    return { base, files, commit };
  }

  async compare(base: string, target: string): Promise<Change[]> {
    return parseChanges(await this.run(['diff', ...safeDiff, '--name-status', '-z', '-M', assertHash(base), assertHash(target), '--']));
  }

  // Callers pass selected commits in the displayed newest-first log order.
  // Include the oldest selected commit itself by starting at its first parent.
  async commitSelection(hashes: string[]): Promise<CommitSelection> {
    if (!hashes.length || hashes.length > 300) throw new Error(t("请选中 1–300 个提交。"));
    const commits: Commit[] = [];
    for (const hash of new Set(hashes)) commits.push(await this.commit(assertHash(hash)));
    const target = commits[0].hash, base = commits.at(-1)!.parents[0] || await this.emptyTree();
    const files = (await this.compare(base, target)).map(file => ({ ...file, base, target }));
    return { mode: 'range', commits, files, base, target };
  }

  async textPatch(before: string, after: string, context = 5): Promise<string> {
    if (before.includes('\0') || after.includes('\0')) throw new Error(t("二进制内容无法显示为文本历史差异。"));
    const directory = await mkdtemp(path.join(tmpdir(), 'git-workbench-compare-'));
    try {
      const left = path.join(directory, 'before'), right = path.join(directory, 'after');
      await writeFile(left, before, { mode: 0o600 }); await writeFile(right, after, { mode: 0o600 });
      // --no-index returns 1 for an ordinary difference, and still preserves stdout.
      const patch = await this.run(['-c', 'core.autocrlf=false', 'diff', '--no-index', ...safeDiff, '--text', `--unified=${context}`, '--', left, right], undefined, false, [1]);
      return patch.replace(/^diff --git .+$/m, 'diff --git a/selection b/selection').replace(/^--- .+$/m, '--- a/selection').replace(/^\+\+\+ .+$/m, '+++ b/selection');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  async content(ref: string, relative: string): Promise<string> {
    this.file(relative);
    if (ref !== ':0' && ref !== ':1' && ref !== ':2' && ref !== ':3') assertHash(ref);
    const spec = ref.startsWith(':') ? `${ref}:${relative}` : `${ref}:${relative}`;
    return this.run(['show', spec]);
  }

  async status(): Promise<Change[]> { return parseStatus(await this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'])); }

  async state(): Promise<{ branch: string; head?: string; operation?: string; upstreamRemote?: string; upstreamRef?: string }> {
    const head = await this.head();
    let branch = '(detached HEAD)';
    try { branch = (await this.run(['symbolic-ref', '--short', 'HEAD'])).trim(); } catch { /* Detached HEAD. */ }
    const fs = await import('node:fs/promises');
    let operation: string | undefined;
    for (const [marker, name] of [['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']]) {
      const location = (await this.run(['rev-parse', '--git-path', marker])).trim();
      try { await fs.access(path.resolve(this.root, location)); operation = name; break; } catch { /* No operation marker. */ }
    }
    let upstreamRemote: string | undefined, upstreamRef: string | undefined;
    if (head && !branch.startsWith('(')) {
      [upstreamRemote, upstreamRef] = (await this.run(['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)', `refs/heads/${branch}`])).trimEnd().split('\0');
    }
    return { branch, head, operation, upstreamRemote, upstreamRef };
  }

  async fileHistory(relative: string): Promise<Commit[]> {
    this.file(relative);
    return parseCommits(await this.run(['log', '--follow', '-z', '--max-count=300', `--format=${format}`, 'HEAD', '--', relative]));
  }

  async fileHistoryDetails(relative: string): Promise<(Commit & { file: string })[]> {
    this.file(relative);
    const raw = await this.run(['log', '--follow', '--name-status', '-z', '--max-count=300', `--format=%x1e${format}%x00`, 'HEAD', '--', relative]);
    let tracked = relative;
    return raw.split('\x1e').filter(Boolean).map(chunk => {
      const fields = chunk.split('\0');
      const commit = parseCommits(fields.slice(0, 6).join('\0'))[0];
      const change = parseChanges(fields.slice(6).join('\0').replace(/^[\0\r\n]+/, '')).find(item => item.path === tracked || item.oldPath === tracked);
      const file = change?.path || tracked;
      if (change?.oldPath) tracked = change.oldPath;
      return { ...commit, file };
    });
  }

  async filePatch(hash: string, relative: string): Promise<string> {
    this.file(relative);
    const { base, files } = await this.changes(assertHash(hash));
    const file = files.find(item => item.path === relative || item.oldPath === relative);
    if (!file) return '';
    return this.run(['diff', ...safeDiff, '--unified=5', '-M', base, hash, '--', ...(file.oldPath ? [file.oldPath] : []), file.path]);
  }

  async lineHistory(relative: string, start: number, end: number, contents?: string): Promise<HistoryEntry[]> {
    return (await this.lineHistoryDetails(relative, start, end, contents)).entries;
  }

  async lineHistoryDetails(relative: string, start: number, end: number, contents?: string): Promise<{ entries: HistoryEntry[]; notice?: string }> {
    this.file(relative);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) throw new Error(t("无效的选区行号。"));
    const head = await this.head();
    if (!head) throw new Error(t("仓库尚无提交，所选代码暂无提交历史。"));
    let headFile = relative;
    const exists = async (file: string) => !!(await this.run(['ls-tree', '--name-only', '-z', head, '--', file])).trim();
    if (!await exists(headFile)) {
      const staged = parseChanges(await this.run(['diff', ...safeDiff, '--cached', '--name-status', '-z', '-M', head, '--']));
      headFile = staged.find(change => change.path === relative && change.status.startsWith('R'))?.oldPath || relative;
      if (!await exists(headFile)) throw new Error(t("该文件尚无对应的 HEAD 版本，新增文件暂无提交历史。"));
    }
    const before = (await this.content(head, headFile)).replace(/\r\n/g, '\n');
    const current = (contents ?? await readFile(this.file(relative), 'utf8')).replace(/\r\n/g, '\n');
    const patch = await this.textPatch(before, current, 0);
    const currentLines = current ? current.split('\n').length - (current.endsWith('\n') ? 1 : 0) : 0;
    const mapped = mapLineRange(patch, start, end, currentLines);
    let notice: string | undefined;
    if (before !== current || headFile !== relative) {
      notice = t("当前选区 {0}–{1} 行已映射到 HEAD {2} 的 {3}–{4} 行，显示已提交历史；本次查看不会保存、暂存或提交本地修改。", start, end, head.slice(0, 8), mapped.start, mapped.end);
      if (mapped.expanded) notice += t(" 改写部分按修改前的整个代码块追溯。");
      if (mapped.added) notice += t(" 纯新增行暂无历史，未纳入追溯。");
      if (headFile !== relative) notice += t(" 沿重命名前路径 {0} 追溯。", headFile);
    }
    const raw = await this.run(['log', '--max-count=300', `--format=%x1e${format}%x00`, ...safeDiff, `-L${mapped.start},${mapped.end}:${headFile}`, head, '--']);
    const entries = raw.split('\x1e').filter(Boolean).map(chunk => {
      const parts = chunk.split('\0');
      const commit = parseCommits(parts.slice(0, 6).join('\0'))[0];
      return { ...commit, patch: parts.slice(6).join('\0').replace(/^\n+|\n+$/g, '') };
    });
    return { entries, notice };
  }

  async blame(relative: string, contents?: string): Promise<BlameLine[]> {
    this.file(relative);
    const args = ['blame', '--line-porcelain'];
    if (contents !== undefined) args.push('--contents', '-');
    args.push('--', relative);
    const raw = await this.run(args, contents);
    const lines: BlameLine[] = [];
    let current: Partial<BlameLine> = {};
    for (const line of raw.split('\n')) {
      const header = /^([a-f0-9]{40,64}) (\d+) (\d+)(?: \d+)?$/.exec(line);
      if (header) current = { hash: header[1], original: Number(header[2]), line: Number(header[3]) };
      else if (line.startsWith('author ')) current.author = line.slice(7);
      else if (line.startsWith('summary ')) current.summary = line.slice(8);
      else if (line.startsWith('\t')) lines.push({ ...current, content: line.slice(1) } as BlameLine);
    }
    return lines;
  }

  async validateBranch(name: string): Promise<void> {
    if (!name || name.startsWith('-') || name.includes('@{') || /[\r\n\0]/.test(name)) throw new Error(t("无效的分支名称。"));
    await this.run(['check-ref-format', '--branch', name]);
  }

  async mutate(args: string[], input?: string): Promise<string> { return this.run(args, input, true); }
}
