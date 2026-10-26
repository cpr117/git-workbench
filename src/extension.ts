import * as vscode from 'vscode';
import * as path from 'node:path';
import { lstat } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { Change, Commit, Filters, Git, Ref, SelectedChange, graphRows, assertHash } from './git';
import { actions, confirm, isConflict, operationGroups, perform } from './operations';
import { openHistoryView } from './historyView';
import { inScope } from './explorerGit';
import { DirectoryComparison } from './directoryCompare';
import { registerExplorerCommands } from './explorer';
import { branchTarget, performBranch } from './branchOperations';

interface Revision { git: Git; ref: string; file: string; empty?: boolean; text?: string; }
const revisions = new Map<string, Revision>();
let output: vscode.OutputChannel;

function revisionUri(revision: Revision, label?: string): vscode.Uri {
  const uri = vscode.Uri.from({ scheme: 'git-workbench', path: `/${label || path.basename(revision.file)}`, query: randomUUID() });
  revisions.set(uri.toString(), revision);
  return uri;
}

async function openDiff(git: Git, base: string, target: string, file: Change): Promise<void> {
  const left = revisionUri({ git, ref: base, file: file.oldPath || file.path, empty: file.status[0] === 'A' });
  const right = revisionUri({ git, ref: target, file: file.path, empty: file.status[0] === 'D' });
  await vscode.commands.executeCommand('vscode.diff', left, right, `${file.path} · ${base.slice(0, 8)} ↔ ${target.slice(0, 8)}`);
}

class Workbench implements vscode.Disposable, vscode.WebviewViewProvider {
  private panel?: vscode.WebviewView;
  private git?: Git;
  private refs: Ref[] = [];
  private visibleCommits: Commit[] = [];
  private filters: Filters = { limit: 200 };
  private detail?: { base: string; target: string; files: (Change | SelectedChange)[] };
  private generation = 0;
  private detailGeneration = 0;
  private busy = false;
  private branchHead?: string;
  private branchName = '';
  private pendingHash?: string;
  private subscriptions: vscode.Disposable[] = [];

  constructor(private context: vscode.ExtensionContext, private comparison: DirectoryComparison) {}
  dispose(): void { this.subscriptions.forEach(item => item.dispose()); this.panel = undefined; }

  private setRepository(git: Git): void {
    if (this.git?.root !== git.root) {
      if (this.busy) throw new Error('请等待当前 Git 操作完成再切换仓库。');
      this.filters = { limit: 200 }; this.detail = undefined; this.refs = []; this.visibleCommits = [];
      this.pendingHash = undefined;
      this.generation++; this.detailGeneration++; this.send('reset', null);
    }
    this.git = git;
  }

  async repository(uri?: vscode.Uri): Promise<Git> {
    if (!vscode.workspace.isTrusted) throw new Error('请先信任此工作区。');
    const directories = new Set<string>();
    if (uri?.scheme === 'file') directories.add(path.dirname(uri.fsPath));
    if (!uri && vscode.window.activeTextEditor?.document.uri.scheme === 'file') directories.add(path.dirname(vscode.window.activeTextEditor.document.uri.fsPath));
    if (uri) {
      if (uri.scheme !== 'file') throw new Error('请选择本地工作区中的文件或目录。');
      const found = await Git.discover((await lstat(uri.fsPath)).isDirectory() ? uri.fsPath : path.dirname(uri.fsPath));
      return new Git(found.root, text => output.appendLine(text));
    }
    const builtin = vscode.extensions.getExtension<{ getAPI(version: number): { repositories: { rootUri: vscode.Uri }[] } }>('vscode.git');
    if (builtin) {
      try { const api = (await builtin.activate()).getAPI(1); api.repositories.forEach(repo => directories.add(repo.rootUri.fsPath)); } catch { /* Workspace folders remain available. */ }
    }
    vscode.workspace.workspaceFolders?.forEach(folder => directories.add(folder.uri.fsPath));
    const repositories = new Map<string, Git>();
    for (const directory of directories) {
      try { const git = await Git.discover(directory); repositories.set(git.root, new Git(git.root, text => output.appendLine(text))); } catch { /* Non-repository folders are ignored. */ }
    }
    if (repositories.size === 1) return [...repositories.values()][0];
    if (repositories.size > 1) {
      const pick = await vscode.window.showQuickPick([...repositories].map(([root, git]) => ({ label: path.basename(root), description: root, git })), { placeHolder: '选择 Git 仓库' });
      if (pick) return pick.git;
      throw new Error('已取消选择仓库。');
    }
    const folders = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: '打开 Git 仓库' });
    if (!folders?.[0]) throw new Error('已取消选择仓库。');
    const found = await Git.discover(folders[0].fsPath);
    return new Git(found.root, text => output.appendLine(text));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.panel = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    this.subscriptions.push(
      view.onDidDispose(() => { if (this.panel === view) { this.panel = undefined; this.generation++; this.detailGeneration++; } }),
      view.webview.onDidReceiveMessage(message => this.receive(message).catch(error => this.error(error))),
    );
    view.webview.html = this.html(view.webview);
  }

  async open(git?: Git, hash?: string, scope?: string): Promise<void> {
    const next = git || this.git || await this.repository();
    this.setRepository(next);
    if (scope !== undefined) this.filters = { limit: 200, ref: 'HEAD', path: scope || undefined };
    this.pendingHash = hash;
    await vscode.commands.executeCommand('gitWorkbench.log.focus');
    this.panel?.show(false);
    await this.refresh();
    if (hash && this.pendingHash === hash) { this.pendingHash = undefined; await this.select(hash); }
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(18).toString('hex');
    const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));
    return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${media('workbench.css')}"><title>Git Workbench</title></head><body><div id="app"></div><script nonce="${nonce}" src="${media('selection.js')}"></script><script nonce="${nonce}" src="${media('logModel.js')}"></script><script nonce="${nonce}" src="${media('workbench.js')}"></script></body></html>`;
  }

  private send(type: string, data: unknown): void { void this.panel?.webview.postMessage({ type, data }); }
  private error(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(message); this.send('error', message);
    void vscode.window.showErrorMessage(`Git Workbench: ${message}`, '查看日志').then(choice => { if (choice) output.show(); });
  }

  async refresh(): Promise<void> {
    if (!this.git || !this.panel) return;
    const generation = ++this.generation, git = this.git;
    this.send('loading', true);
    try {
      const refs = await git.refs();
      if (generation !== this.generation) return;
      if (this.filters.ref && this.filters.ref !== 'HEAD' && !refs.some(ref => ref.full === this.filters.ref)) this.filters = { ...this.filters, ref: undefined };
      const filters = { ...this.filters };
      const [state, commits, status] = await Promise.all([git.state(), git.commits(filters), git.status()]);
      if (generation !== this.generation) return;
      this.refs = refs; this.visibleCommits = commits; this.branchHead = state.head; this.branchName = state.branch;
      this.send('snapshot', { root: git.root, state, refs, commits, graph: graphRows(commits), status, filters });
    } finally { if (generation === this.generation) this.send('loading', false); }
  }

  async select(hash: string, parent?: string): Promise<void> {
    const git = this.git; if (!git) return;
   
    const generation = ++this.detailGeneration;
    const [details, message] = await Promise.all([git.changes(assertHash(hash), parent), git.message(hash)]);
    if (generation !== this.detailGeneration || git !== this.git) return;
    if (this.filters.path) details.files = details.files.filter(file => inScope(file.path, this.filters.path!) || !!file.oldPath && inScope(file.oldPath, this.filters.path!));
    this.detail = { base: details.base, target: hash, files: details.files };
    this.send('detail', { ...details, message, target: hash });
  }

  private async operation(action: string, hash?: string): Promise<void> {
    if (!this.git) return;
    const git = this.git;
    await this.runTask(git, actions[action] || action, () => perform(git, action, hash));
  }

  async runTask(git: Git, title: string, task: () => Promise<void>): Promise<void> {
    if (this.busy) throw new Error('请等待当前 Git 操作完成。');
    this.setRepository(git);
    this.busy = true; this.send('operating', true);
    try { await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, task); }
    finally { this.busy = false; this.send('operating', false); await this.refresh(); }
  }

  async menu(git?: Git, hash?: string): Promise<void> {
    if (git) { this.setRepository(git); await this.refresh(); }
    if (!this.git) this.setRepository(await this.repository());
    const source = this.git;
    for (;;) {
      const group = await vscode.window.showQuickPick(operationGroups, { title: 'Git Workbench · Git 操作', placeHolder: hash ? `提交 ${hash.slice(0, 8)} · 选择功能分类` : '选择功能分类；提交操作默认以 HEAD 为目标' });
      if (!group) return;
      const pick = await vscode.window.showQuickPick([{ label: '$(arrow-left) 返回功能分类', id: 'back' }, ...group.ids.map(id => ({ label: actions[id], id }))], { title: `Git Workbench · ${group.label}`, placeHolder: '选择操作' });
      if (!pick) return;
      if (pick.id === 'back') continue;
      if (source !== this.git) throw new Error('仓库已切换，请重新选择操作。');
      await this.operation(pick.id, hash); return;
    }
  }

  private async working(action: string, relative: string, area?: string): Promise<void> {
    const git = this.git; if (!git) return;
    git.file(relative);
    const file = (await git.status()).find(change => change.path === relative);
    if (git !== this.git) throw new Error('仓库已切换，请刷新后重试。');
    if (!file) throw new Error('文件状态已改变，请刷新。');
    if (action === 'open') { await vscode.window.showTextDocument(vscode.Uri.file(git.file(relative))); return; }
    if (action === 'diff') {
      if (isConflict(file.status)) {
        const unmerged = await git.run(['ls-files', '--unmerged', '-z', '--', relative]);
        const stages = unmerged.split('\0').filter(Boolean).map(entry => entry.split('\t')[0].split(' ')[2]);
        const left = revisionUri({ git, ref: ':2', file: relative, empty: !stages.includes('2') });
        const right = revisionUri({ git, ref: ':3', file: relative, empty: !stages.includes('3') });
        await vscode.commands.executeCommand('vscode.diff', left, right, `${relative} · Ours ↔ Theirs（在工作区文件中解决后暂存）`);
      } else if (area === 'index') {
        const head = await git.head();
        const left = revisionUri({ git, ref: head || '', file: file.oldPath || relative, empty: !head || file.index === 'A' });
        const right = revisionUri({ git, ref: ':0', file: relative, empty: file.index === 'D' });
        await vscode.commands.executeCommand('vscode.diff', left, right, `${relative} · HEAD ↔ 暂存区`);
      } else {
        const left = revisionUri({ git, ref: ':0', file: relative, empty: file.index === '?' });
        const right = file.worktree === 'D' ? revisionUri({ git, ref: '', file: relative, empty: true }) : vscode.Uri.file(git.file(relative));
        await vscode.commands.executeCommand('vscode.diff', left, right, `${relative} · 暂存区 ↔ 工作区`);
      }
      return;
    }
    if (this.busy) throw new Error('请等待当前 Git 操作完成。');
    this.busy = true; this.send('operating', true);
    try {
      switch (action) {
        case 'stage': await git.mutate(['add', '--', ...(file.worktree === 'R' && file.oldPath ? [file.oldPath] : []), relative]); break;
        case 'unstage':
          if (await git.head()) await git.mutate(['reset', 'HEAD', '--', ...(file.oldPath ? [file.oldPath] : []), relative]);
          else await git.mutate(['rm', '--cached', '-f', '--', relative]);
          break;
        case 'discard':
          if (file.index === '?') throw new Error('未跟踪文件请在资源管理器中删除；此处不会永久删除新文件。');
          if (isConflict(file.status)) throw new Error('冲突文件请在编辑器解决，或使用“中止”操作。');
          if (await confirm(`丢弃 ${relative} 的未暂存改动，恢复为暂存区版本？`)) await git.mutate(['restore', '--worktree', '--', relative]);
          break;
        default: throw new Error('无效的文件操作。');
      }
    } finally { this.busy = false; this.send('operating', false); await this.refresh(); }
  }

  private async receive(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') return;
    const msg = message as Record<string, unknown>;
    const type = msg.type;
    if (type === 'init' || type === 'refresh') {
      if (!this.git) this.setRepository(await this.repository());
      await this.refresh();
      if (type === 'init' && this.pendingHash) { const hash = this.pendingHash; this.pendingHash = undefined; await this.select(hash); }
      return;
    }
    if (type === 'repo') { if (this.busy) return; await this.open(await this.repository()); return; }
    if (!this.git) return;
    if (msg.repoRoot !== this.git.root) return;
    switch (type) {
      case 'branchAction': {
        if (typeof msg.ref !== 'string' || typeof msg.action !== 'string') return;
        const expected = this.refs.find(ref => ref.full === msg.ref);
        if (!expected) throw new Error('请选择分支树中存在的分支或标签。');
        if (this.busy) throw new Error('请等待当前 Git 操作完成。');
        const git = this.git, head = this.branchHead, branch = this.branchName;
        if (msg.action === 'compare' || msg.action === 'workingDiff') {
          const { ref, hash } = await branchTarget(git, expected);
          const current = await git.head();
          if (!current || current !== head) throw new Error('当前 HEAD 已改变，请刷新后重试。');
          if (git !== this.git) return;
          // Branch-tree comparisons always cover the repository, ignoring log path filters.
          await this.comparison.open(git, '', hash, {
            target: msg.action === 'compare' ? current : undefined,
            baseLabel: ref.name, targetLabel: msg.action === 'compare' ? 'HEAD' : '工作区',
          });
        } else await this.runTask(git, 'Git 分支操作', () => performBranch(git, msg.action as string, expected, head, branch));
        break;
      }
      case 'filters': {
        const value = msg.filters as Record<string, unknown> | undefined;
        if (!value || typeof value !== 'object') return;
        const next: Filters = { limit: typeof value.limit === 'number' ? value.limit : 200 };
        for (const key of ['ref', 'search', 'author', 'path', 'since', 'until'] as const) {
          if (typeof value[key] === 'string') next[key] = value[key].slice(0, 1000);
        }
        if (next.ref && next.ref !== 'HEAD' && !this.refs.some(ref => ref.full === next.ref)) throw new Error('请选择存在的分支。');
        this.filters = next; await this.refresh(); break;
      }
      case 'select': if (typeof msg.hash === 'string') await this.select(msg.hash, typeof msg.parent === 'string' ? msg.parent : undefined); break;
      case 'diff': {
        const file = this.detail?.files.find(item => item.path === msg.path && (!('commitHash' in item) || item.commitHash === msg.commitHash));
        if (file && this.detail) await openDiff(this.git, 'base' in file ? file.base : this.detail.base, 'target' in file ? file.target : this.detail.target, file); break;
      }
      case 'selectMany': {
        if (!Array.isArray(msg.hashes) || !msg.hashes.every(hash => typeof hash === 'string')) return;
        const generation = ++this.detailGeneration, git = this.git;
        const hashes = new Set(msg.hashes as string[]);
        const ordered = this.visibleCommits.filter(commit => hashes.has(commit.hash));
        if (!hashes.size || hashes.size > 300 || ordered.length !== hashes.size) throw new Error('请选中当前提交列表中的 1–300 个版本。');
        const details = await git.commitSelection(ordered.map(commit => commit.hash));
        if (generation !== this.detailGeneration || git !== this.git) return;
        if (this.filters.path) details.files = details.files.filter(file => inScope(file.path, this.filters.path!) || !!file.oldPath && inScope(file.oldPath, this.filters.path!));
        this.detail = details;
        this.send('detail', { ...details, aggregate: true, compare: true, message: `所选 ${details.commits.length} 个提交 · 区间累计差异（含最旧提交）` }); break;
      }
      case 'compare': {
        if (typeof msg.base !== 'string' || typeof msg.target !== 'string') return;
        const generation = ++this.detailGeneration, git = this.git;
        const base = assertHash(msg.base), target = assertHash(msg.target);
        let files = await git.compare(base, target);
        if (this.filters.path) files = files.filter(file => inScope(file.path, this.filters.path!) || !!file.oldPath && inScope(file.oldPath, this.filters.path!));
        if (generation !== this.detailGeneration || git !== this.git) return;
        this.detail = { base, target, files };
        this.send('detail', { base, target, files, message: `${base.slice(0, 8)} ↔ ${target.slice(0, 8)}`, compare: true }); break;
      }
      case 'action': if (typeof msg.action === 'string') await this.operation(msg.action, typeof msg.hash === 'string' ? msg.hash : undefined); break;
      case 'menu': await this.menu(undefined, typeof msg.hash === 'string' ? msg.hash : undefined); break;
      case 'copy': if (typeof msg.hash === 'string') await vscode.env.clipboard.writeText(assertHash(msg.hash)); break;
      case 'working': if (typeof msg.action === 'string' && typeof msg.path === 'string') await this.working(msg.action, msg.path, typeof msg.area === 'string' ? msg.area : undefined); break;
      case 'restore': {
        if (this.busy) throw new Error('请等待当前 Git 操作完成。');
        const file = this.detail?.files.find(item => item.path === msg.path);
        if (!file || !this.detail || 'commitHash' in file) return;
        const target = this.detail.target, git = this.git;
        this.busy = true; this.send('operating', true);
        try {
          if (await confirm(`将 ${git.root} 中的 ${file.path} 恢复到 ${target.slice(0, 8)}？现有文件内容会被覆盖，暂存区不变。`)) await git.mutate(['restore', `--source=${target}`, '--worktree', '--', file.path]);
        } finally { this.busy = false; this.send('operating', false); await this.refresh(); }
        break;
      }
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Git Workbench');
  const blameDecoration = vscode.window.createTextEditorDecorationType({ before: { color: new vscode.ThemeColor('editorLineNumber.foreground'), margin: '0 2em 0 0', fontStyle: 'normal' } });
  const decorated = new Set<string>();
  const register = (id: string, callback: (...args: unknown[]) => Promise<unknown>) => context.subscriptions.push(vscode.commands.registerCommand(id, (...args: unknown[]) => callback(...args).catch(error => { output.appendLine(String(error)); void vscode.window.showErrorMessage(`Git Workbench: ${error instanceof Error ? error.message : String(error)}`); })));
  const comparison = new DirectoryComparison(async (repo, revision, file, target) => {
    const left = revisionUri({ git: repo, ref: revision, file: file?.oldPath || file?.path || '对比', empty: !file || file.status[0] === 'A' });
    const right = !file || file.status[0] === 'D' ? revisionUri({ git: repo, ref: '', file: file?.path || '对比', empty: true })
      : target ? revisionUri({ git: repo, ref: target, file: file.path }) : vscode.Uri.file(repo.file(file.path));
    await vscode.commands.executeCommand('vscode.diff', left, right, `对比 · ${file?.path || '无变更'} · ${revision.slice(0, 8)} ↔ ${target?.slice(0, 8) || '工作区'}`, { preview: true, preserveFocus: true });
    return { original: left, modified: right };
  });
  const workbench = new Workbench(context, comparison);
  context.subscriptions.push(workbench, vscode.window.registerWebviewViewProvider('gitWorkbench.log', workbench, { webviewOptions: { retainContextWhenHidden: true } }));
  context.subscriptions.push(comparison);
  register('gitWorkbench.compare.select', async file => { if (typeof file === 'string') await comparison.select(file); });
  register('gitWorkbench.compare.refresh', async () => comparison.refresh());
  register('gitWorkbench.compare.search', async () => comparison.search());
  register('gitWorkbench.compare.close', async () => comparison.close());
  register('gitWorkbench.compare.viewTree', async () => comparison.configure('comparisonViewMode', 'tree'));
  register('gitWorkbench.compare.viewList', async () => comparison.configure('comparisonViewMode', 'list'));
  for (const order of ['path', 'name', 'status'] as const) {
    register(`gitWorkbench.compare.sort.${order}`, async () => comparison.configure('comparisonSortOrder', order));
  }
  registerExplorerCommands(register, {
    repository: uri => workbench.repository(uri),
    history: (git, scope) => workbench.open(git, undefined, scope),
    compare: (git, scope, base) => comparison.open(git, scope, base),
    run: (git, title, task) => workbench.runTask(git, title, task),
  });
  const editor = () => {
    const active = vscode.window.activeTextEditor;
    if (!active || active.document.uri.scheme !== 'file') throw new Error('请先在编辑器中打开仓库内的文件。');
    return active;
  };
  register('gitWorkbench.menu', async () => {
    for (;;) {
      const group = await vscode.window.showQuickPick([
        { label: '$(git-merge) 提交图与工作区', command: 'gitWorkbench.open' },
        { label: '$(history) 历史与追溯', command: 'history' },
        { label: '$(tools) Git 操作', command: 'gitWorkbench.operations' },
      ], { title: 'Git Workbench', placeHolder: '选择功能分类' });
      if (!group) return;
      if (group.command !== 'history') { await vscode.commands.executeCommand(group.command); return; }
      const choice = await vscode.window.showQuickPick([
        { label: '$(arrow-left) 返回功能分类', command: 'back' },
        { label: '查看选区 / 当前行历史', command: 'gitWorkbench.selectionHistory' },
        { label: '查看文件历史', command: 'gitWorkbench.fileHistory' },
        { label: '查看当前行提交', command: 'gitWorkbench.blame' },
        { label: '切换逐行作者标注', command: 'gitWorkbench.toggleBlame' },
      ], { title: 'Git Workbench · 历史与追溯', placeHolder: '选择历史功能' });
      if (!choice) return;
      if (choice.command === 'back') continue;
      await vscode.commands.executeCommand(choice.command); return;
    }
  });
  register('gitWorkbench.open', async value => workbench.open(value instanceof vscode.Uri ? await workbench.repository(value) : undefined));
  register('gitWorkbench.operations', async value => workbench.menu(await workbench.repository(value instanceof vscode.Uri ? value : undefined)));
  register('gitWorkbench.fileHistory', async (value) => {
    const uri = value instanceof vscode.Uri ? value : editor().document.uri;
    const git = await workbench.repository(uri), file = git.relative(uri.fsPath);
    const history = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: '读取文件历史' }, () => git.fileHistoryDetails(file));
    await openHistoryView(context, git, history, file, undefined, (repo, hash) => workbench.open(repo, hash));
  });
  register('gitWorkbench.selectionHistory', async () => {
    const active = editor();
    const uri = active.document.uri, contents = active.document.getText(), selection = active.selection;
    const git = await workbench.repository(uri), file = git.relative(uri.fsPath);
    const start = selection.start.line + 1;
    const end = !selection.isEmpty && selection.end.character === 0 ? selection.end.line : selection.end.line + 1;
    const history = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: '追溯选区历史' }, () => git.lineHistoryDetails(file, start, Math.max(start, end), contents));
    await openHistoryView(context, git, history.entries, file, { start, end: Math.max(start, end), notice: history.notice }, (repo, hash) => workbench.open(repo, hash));
  });
  register('gitWorkbench.blame', async () => {
    const active = editor(), git = await workbench.repository(active.document.uri);
    const lines = await git.blame(git.relative(active.document.uri.fsPath), active.document.getText());
    const line = lines.find(item => item.line === active.selection.active.line + 1);
    if (!line) throw new Error('当前行没有可追溯的内容。');
    if (/^0+$/.test(line.hash)) { void vscode.window.showInformationMessage('当前行尚未提交。'); return; }
    const choice = await vscode.window.showInformationMessage(`${line.author} · ${line.hash.slice(0, 8)} · ${line.summary}`, '查看提交');
    if (choice) await workbench.open(git, line.hash);
  });
  register('gitWorkbench.toggleBlame', async () => {
    const active = editor(), key = active.document.uri.toString();
    if (decorated.delete(key)) { active.setDecorations(blameDecoration, []); return; }
    if (active.document.lineCount > 10000) throw new Error('大于 10,000 行的文件请使用“查看当前行提交”。');
    const git = await workbench.repository(active.document.uri);
    const lines = await git.blame(git.relative(active.document.uri.fsPath), active.document.getText());
    active.setDecorations(blameDecoration, lines.map(line => ({ range: new vscode.Range(line.line - 1, 0, line.line - 1, 0), renderOptions: { before: { contentText: /^0+$/.test(line.hash) ? '未提交' : `${line.hash.slice(0, 7)} ${line.author}` } }, hoverMessage: line.summary })));
    decorated.add(key);
  });
  register('gitWorkbench.stageSelection', async () => { editor(); await vscode.commands.executeCommand('git.stageSelectedRanges'); });
  const clearBlame = (document: vscode.TextDocument) => {
    if (!decorated.delete(document.uri.toString())) return;
    for (const visible of vscode.window.visibleTextEditors) if (visible.document === document) visible.setDecorations(blameDecoration, []);
  };
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => clearBlame(event.document)));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => { revisions.delete(document.uri.toString()); decorated.delete(document.uri.toString()); }));
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('git-workbench', {
    provideTextDocumentContent: async uri => {
      const revision = revisions.get(uri.toString());
      if (!revision) throw new Error('版本视图已失效，请重新打开。');
      if (revision.text !== undefined) return revision.text;
      if (revision.empty) return '';
      const content = await revision.git.content(revision.ref, revision.file);
      if (content.includes('\0')) throw new Error('此文件是二进制内容，请使用原生 Git / 专用查看器。');
      return content;
    },
  }));
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.text = '$(git-merge) Git Workbench'; status.command = 'gitWorkbench.open'; status.tooltip = '打开提交图与 Git 操作'; status.show();
  context.subscriptions.push(status, blameDecoration, output, workbench);
}

export function deactivate(): void { revisions.clear(); }
