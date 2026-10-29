import { t, setLocale, getLocale } from './i18n';
import { readModules, moduleLabel, requireModule, requirePanel, commandModules, configureModules, migrateModuleSettings } from './modules';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { lstat } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { Change, Commit, Filters, Git, Ref, SelectedChange, graphRows, assertHash } from './git';
import { getActions, confirm, getOperationGroups, perform, performStash } from './operations';
import { StashSnapshot, StashDetail, stashSnapshot, stashDetail } from './stash';
import { watchStashes } from './stashMonitor';
import { closeDisabledHistoryViews, openHistoryView } from './historyView';
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

async function openDiff(git: Git, base: string, target: string, file: Change, preview = true): Promise<void> {
  const left = revisionUri({ git, ref: base, file: file.oldPath || file.path, empty: file.status[0] === 'A' });
  const right = revisionUri({ git, ref: target, file: file.path, empty: file.status[0] === 'D' });
  await vscode.commands.executeCommand('vscode.diff', left, right, `${file.path} · ${base.slice(0, 8)} ↔ ${target.slice(0, 8)}`, { preview });
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
  private stashGeneration = 0;
  private stashes?: StashSnapshot;
  private stashToken = '';
  private stashFiles?: StashDetail;
  private stashMonitor?: { dispose(): void };
  private stashMonitorReady?: Promise<void>;
  private stashMonitorVersion = 0;
  private stashRefreshTimer?: ReturnType<typeof setTimeout>;
  private stashRefreshPending = false;
  private stashListGeneration = 0;
  private refreshing = 0;
  private busy = false;
  private branchHead?: string;
  private branchName = '';
  private pendingHash?: string;
  private subscriptions: vscode.Disposable[] = [];

  constructor(private context: vscode.ExtensionContext, private comparison: DirectoryComparison) {
    this.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('gitWorkbench.modules')) return;
      this.send('modules', readModules());
      if (!event.affectsConfiguration('gitWorkbench.modules.graph') && !event.affectsConfiguration('gitWorkbench.modules.stash')) return;
      this.generation++; this.detailGeneration++; this.stashGeneration++;
      if (!readModules().stash) { this.stopStashMonitor(); this.stashes = undefined; this.stashFiles = undefined; this.stashToken = ''; }
      if (!readModules().graph) { this.detail = undefined; this.visibleCommits = []; this.refs = []; this.pendingHash = undefined; }
      void this.refresh().catch(error => this.error(error));
    }));
    this.subscriptions.push(vscode.window.onDidChangeWindowState(state => { if (state.focused) this.queueStashRefresh(); }));
  }
  dispose(): void { this.stopStashMonitor(); this.subscriptions.forEach(item => item.dispose()); this.panel = undefined; this.generation++; }

  private stopStashMonitor(): void {
    this.stashMonitorVersion++; this.stashListGeneration++;
    this.stashMonitor?.dispose(); this.stashMonitor = undefined; this.stashMonitorReady = undefined;
    clearTimeout(this.stashRefreshTimer); this.stashRefreshTimer = undefined; this.stashRefreshPending = false;
  }

  private ensureStashMonitor(git: Git): Promise<void> {
    if (!readModules().stash) return Promise.resolve();
    if (!this.stashMonitorReady) {
      const version = this.stashMonitorVersion;
      this.stashMonitorReady = watchStashes(git, () => this.queueStashRefresh(), error => output.appendLine(`Stash monitor: ${String(error)}`))
        .then(monitor => { if (version === this.stashMonitorVersion) this.stashMonitor = monitor; else monitor.dispose(); })
        .catch(error => { output.appendLine(`Stash monitor: ${String(error)}`); });
    }
    return this.stashMonitorReady;
  }

  private queueStashRefresh(): void {
    if (!readModules().stash || !this.git || !this.panel) return;
    this.stashRefreshPending = true;
    clearTimeout(this.stashRefreshTimer);
    if (!this.panel.visible || this.busy || this.refreshing) return;
    this.stashRefreshTimer = setTimeout(() => {
      this.stashRefreshTimer = undefined;
      void this.refreshStashes().catch(error => output.appendLine(`Stash refresh: ${String(error)}`));
    }, 180);
  }

  private async refreshStashes(): Promise<void> {
    if (!readModules().stash || !this.git || !this.panel?.visible || this.busy || this.refreshing) return;
    this.stashRefreshPending = false;
    const git = this.git, generation = ++this.stashListGeneration;
    const snapshot = await stashSnapshot(git);
    if (generation !== this.stashListGeneration || git !== this.git || !this.panel || this.busy || this.refreshing) return;
    if (snapshot.fingerprint === this.stashes?.fingerprint) return;
    this.stashes = snapshot; this.stashToken = randomUUID(); this.stashFiles = undefined; this.stashGeneration++;
    this.send('stashes', { root: git.root, entries: snapshot.entries, token: this.stashToken });
  }

  private setRepository(git: Git): void {
    if (this.git?.root !== git.root) {
      if (this.busy) throw new Error(t("请等待当前 Git 操作完成再切换仓库。"));
      this.stopStashMonitor();
      this.filters = { limit: 200 }; this.detail = undefined; this.refs = []; this.visibleCommits = [];
      this.pendingHash = undefined;
      this.stashes = undefined; this.stashFiles = undefined; this.stashToken = ''; this.stashGeneration++;
      this.generation++; this.detailGeneration++; this.send('reset', null);
    }
    this.git = git;
  }

  async repository(uri?: vscode.Uri): Promise<Git> {
    if (!vscode.workspace.isTrusted) throw new Error(t("请先信任此工作区。"));
    const directories = new Set<string>();
    if (uri?.scheme === 'file') directories.add(path.dirname(uri.fsPath));
    if (!uri && vscode.window.activeTextEditor?.document.uri.scheme === 'file') directories.add(path.dirname(vscode.window.activeTextEditor.document.uri.fsPath));
    if (uri) {
      if (uri.scheme !== 'file') throw new Error(t("请选择本地工作区中的文件或目录。"));
      const found = await Git.discover((await lstat(uri.fsPath)).isDirectory() ? uri.fsPath : path.dirname(uri.fsPath));
      return new Git(found.root, text => output.appendLine(text), args => { requireModule('operations'); if (args[0] === 'stash') requireModule('stash'); });
    }
    const builtin = vscode.extensions.getExtension<{ getAPI(version: number): { repositories: { rootUri: vscode.Uri }[] } }>('vscode.git');
    if (builtin) {
      try { const api = (await builtin.activate()).getAPI(1); api.repositories.forEach(repo => directories.add(repo.rootUri.fsPath)); } catch { /* Workspace folders remain available. */ }
    }
    vscode.workspace.workspaceFolders?.forEach(folder => directories.add(folder.uri.fsPath));
    const repositories = new Map<string, Git>();
    for (const directory of directories) {
      try { const git = await Git.discover(directory); repositories.set(git.root, new Git(git.root, text => output.appendLine(text), args => { requireModule('operations'); if (args[0] === 'stash') requireModule('stash'); })); } catch { /* Non-repository folders are ignored. */ }
    }
    if (repositories.size === 1) return [...repositories.values()][0];
    if (repositories.size > 1) {
      const pick = await vscode.window.showQuickPick([...repositories].map(([root, git]) => ({ label: path.basename(root), description: root, git })), { placeHolder: t("选择 Git 仓库") });
      if (pick) return pick.git;
      throw new vscode.CancellationError();
    }
    const folders = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: t("打开 Git 仓库") });
    if (!folders?.[0]) throw new vscode.CancellationError();
    const found = await Git.discover(folders[0].fsPath);
    return new Git(found.root, text => output.appendLine(text), args => { requireModule('operations'); if (args[0] === 'stash') requireModule('stash'); });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.panel = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    this.subscriptions.push(
      view.onDidDispose(() => { if (this.panel === view) { this.stopStashMonitor(); this.panel = undefined; this.generation++; this.detailGeneration++; this.stashGeneration++; } }),
      view.onDidChangeVisibility(() => { if (view.visible && this.panel === view) this.queueStashRefresh(); }),
      view.webview.onDidReceiveMessage(message => this.receive(message).catch(error => this.error(error))),
    );
    view.webview.html = this.html(view.webview);
  }

  async open(git?: Git, hash?: string, scope?: string): Promise<void> {
    requirePanel();
    if (hash || scope !== undefined) requireModule('graph');
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
    return `<!doctype html><html lang="${getLocale()}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${media('workbench.css')}"><title>Git Workbench</title></head><body><div id="app"></div><script nonce="${nonce}">window.gitWorkbenchLanguage=${JSON.stringify(getLocale())};window.gitWorkbenchModules=${JSON.stringify(readModules())};</script><script nonce="${nonce}" src="${media('i18n.js')}"></script><script nonce="${nonce}" src="${media('selection.js')}"></script><script nonce="${nonce}" src="${media('logModel.js')}"></script><script nonce="${nonce}" src="${media('comparisonTree.js')}"></script><script nonce="${nonce}" src="${media('workbench.js')}"></script></body></html>`;
  }

  private send(type: string, data: unknown): void { void this.panel?.webview.postMessage({ type, data }); }
  private error(error: unknown): void {
    if (error instanceof vscode.CancellationError) return;
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(message); this.send('error', message);
    void vscode.window.showErrorMessage(`Git Workbench: ${message}`, t("查看日志")).then(choice => { if (choice) output.show(); });
  }

  async refresh(): Promise<void> {
    if (!this.git || !this.panel || (!readModules().graph && !readModules().stash)) return;
    const enabled = readModules();
    const generation = ++this.generation, git = this.git;
    this.refreshing++; this.stashListGeneration++;
    clearTimeout(this.stashRefreshTimer); this.stashRefreshPending = false;
    this.send('loading', true);
    try {
      await this.ensureStashMonitor(git);
      if (generation !== this.generation) return;
      const refs = enabled.graph ? await git.refs() : [];
      if (generation !== this.generation) return;
      if (this.filters.ref && this.filters.ref !== 'HEAD' && !refs.some(ref => ref.full === this.filters.ref)) this.filters = { ...this.filters, ref: undefined };
      const filters = { ...this.filters };
      const [state, commits, stashes] = await Promise.all([git.state(), enabled.graph ? git.commits(filters) : [], enabled.stash ? stashSnapshot(git) : undefined]);
      if (generation !== this.generation) return;
      this.refs = refs; this.visibleCommits = commits; this.branchHead = state.head; this.branchName = state.branch;
      this.stashes = stashes; this.stashToken = randomUUID(); this.stashFiles = undefined; this.stashGeneration++;
      this.send('snapshot', { root: git.root, state, refs, commits, graph: graphRows(commits), filters, stashes: stashes?.entries || [], stashToken: this.stashToken });
    } finally {
      this.refreshing--;
      if (generation === this.generation) this.send('loading', false);
      if (!this.refreshing && this.stashRefreshPending) this.queueStashRefresh();
    }
  }

  async select(hash: string, parent?: string): Promise<void> {
    requireModule('graph');
    const git = this.git; if (!git) return;
   
    const generation = ++this.detailGeneration;
    const [details, message] = await Promise.all([git.changes(assertHash(hash), parent), git.message(hash)]);
    if (generation !== this.detailGeneration || git !== this.git) return;
    if (this.filters.path) details.files = details.files.filter(file => inScope(file.path, this.filters.path!) || !!file.oldPath && inScope(file.oldPath, this.filters.path!));
    this.detail = { base: details.base, target: hash, files: details.files };
    this.send('detail', { ...details, message, target: hash });
  }

  private async operation(action: string, hash?: string): Promise<void> {
    requireModule('operations');
    if (action.startsWith('stash')) requireModule('stash');
    if (!this.git) return;
    const git = this.git;
    await this.runTask(git, getActions()[action] || action, () => perform(git, action, hash));
  }

  async runTask(git: Git, title: string, task: () => Promise<void>): Promise<void> {
    requireModule('operations');
    if (this.busy) throw new Error(t("请等待当前 Git 操作完成。"));
    this.setRepository(git);
    this.busy = true; this.send('operating', true);
    try { await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, task); }
    finally { this.busy = false; this.send('operating', false); await this.refresh(); }
  }

  async menu(git?: Git, hash?: string): Promise<void> {
    requireModule('operations');
    if (git) { this.setRepository(git); await this.refresh(); }
    if (!this.git) this.setRepository(await this.repository());
    const source = this.git;
    for (;;) {
      const group = await vscode.window.showQuickPick(getOperationGroups().map(group => ({ ...group, ids: group.ids.filter(id => readModules().stash || !id.startsWith('stash')) })).filter(group => group.ids.length), { title: `Git Workbench · ${t("仓库 Git 操作")}`, placeHolder: hash ? t("提交 {0} · 选择功能分类", hash.slice(0, 8)) : t("选择功能分类；提交操作默认以 HEAD 为目标") });
      if (!group) return;
      const pick = await vscode.window.showQuickPick([{ label: t("$(arrow-left) 返回功能分类"), id: 'back' }, ...group.ids.map(id => ({ label: getActions()[id], id }))], { title: `Git Workbench · ${group.label}`, placeHolder: t("选择操作") });
      if (!pick) return;
      if (pick.id === 'back') continue;
      if (source !== this.git) throw new Error(t("仓库已切换，请重新选择操作。"));
      await this.operation(pick.id, hash); return;
    }
  }

  private async receive(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') return;
    const msg = message as Record<string, unknown>;
    const type = msg.type;
    if (type === 'modules') { await configureModules(); return; }
    if (['filters', 'select', 'diff', 'selectMany', 'compare', 'branchAction', 'restore', 'copy'].includes(String(type))) requireModule('graph');
    if (['stashRefresh', 'stashSelect', 'stashAction', 'stashDiff'].includes(String(type))) requireModule('stash');
    if (['action', 'menu', 'restore', 'stashAction'].includes(String(type))) requireModule('operations');
    if (type === 'scm') { await vscode.commands.executeCommand('workbench.view.scm'); return; }
    if (type === 'init' || type === 'refresh') {
      this.send('modules', readModules());
      if (!readModules().graph && !readModules().stash) return;
      if (!this.git) this.setRepository(await this.repository());
      await this.refresh();
      if (type === 'init' && this.pendingHash) { const hash = this.pendingHash; this.pendingHash = undefined; await this.select(hash); }
      return;
    }
    if (type === 'repo') { if (this.busy) return; await this.open(await this.repository()); return; }
    if (!this.git) return;
    if (msg.repoRoot !== this.git.root) return;
    switch (type) {
      case 'stashRefresh': this.queueStashRefresh(); break;
      case 'stashSelect':
      case 'stashAction':
      case 'stashDiff': {
        if (!this.stashes || msg.token !== this.stashToken) return;
        const entry = this.stashes.entries.find(item => item.ref === msg.ref && item.hash === msg.hash);
        if (!entry) throw new Error(t("无效的 Stash 记录，请刷新。"));
        const git = this.git;
        if (type === 'stashSelect') {
          const generation = ++this.stashGeneration;
          this.stashFiles = undefined;
          const detail = await stashDetail(git, entry);
          if (generation !== this.stashGeneration || git !== this.git) return;
          this.stashFiles = detail;
          this.send('stashDetail', { ...detail, token: this.stashToken });
        } else if (type === 'stashDiff') {
          if (this.stashFiles?.stash.ref !== entry.ref || this.stashFiles.stash.hash !== entry.hash) return;
          const file = this.stashFiles.files.find(item => item.id === msg.fileId);
          if (file) await openDiff(git, file.base, file.target, file, msg.newTab !== true);
        } else if (typeof msg.action === 'string') {
          const snapshot = this.stashes, action = msg.action;
          await this.runTask(git, 'Stash', () => performStash(git, action, snapshot, entry));
        }
        break;
      }
      case 'branchAction': {
        if (typeof msg.ref !== 'string' || typeof msg.action !== 'string') return;
        const expected = this.refs.find(ref => ref.full === msg.ref);
        if (!expected) throw new Error(t("请选择分支树中存在的分支或标签。"));
        if (this.busy) throw new Error(t("请等待当前 Git 操作完成。"));
        const git = this.git, head = this.branchHead, branch = this.branchName;
        if (msg.action === 'compare' || msg.action === 'workingDiff') {
          requireModule('comparison');
          const { ref, hash } = await branchTarget(git, expected);
          const current = await git.head();
          if (!current || current !== head) throw new Error(t("当前 HEAD 已改变，请刷新后重试。"));
          if (git !== this.git) return;
          // Branch-tree comparisons always cover the repository, ignoring log path filters.
          await this.comparison.open(git, '', hash, {
            target: msg.action === 'compare' ? current : undefined,
            baseLabel: ref.name, targetLabel: msg.action === 'compare' ? 'HEAD' : t("工作区"),
          });
        } else await this.runTask(git, t("Git 分支操作"), () => performBranch(git, msg.action as string, expected, head, branch));
        break;
      }
      case 'filters': {
        const value = msg.filters as Record<string, unknown> | undefined;
        if (!value || typeof value !== 'object') return;
        const next: Filters = { limit: typeof value.limit === 'number' ? value.limit : 200 };
        for (const key of ['ref', 'search', 'author', 'path', 'since', 'until'] as const) {
          if (typeof value[key] === 'string') next[key] = value[key].slice(0, 1000);
        }
        if (next.ref && next.ref !== 'HEAD' && !this.refs.some(ref => ref.full === next.ref)) throw new Error(t("请选择存在的分支。"));
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
        if (!hashes.size || hashes.size > 300 || ordered.length !== hashes.size) throw new Error(t("请选中当前提交列表中的 1–300 个版本。"));
        const details = await git.commitSelection(ordered.map(commit => commit.hash));
        if (generation !== this.detailGeneration || git !== this.git) return;
        if (this.filters.path) details.files = details.files.filter(file => inScope(file.path, this.filters.path!) || !!file.oldPath && inScope(file.oldPath, this.filters.path!));
        this.detail = details;
        this.send('detail', { ...details, aggregate: true, compare: true, message: t("所选 {0} 个提交 · 区间累计差异（含最旧提交）", details.commits.length) }); break;
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
      case 'restore': {
        if (this.busy) throw new Error(t("请等待当前 Git 操作完成。"));
        const file = this.detail?.files.find(item => item.path === msg.path);
        if (!file || !this.detail || 'commitHash' in file) return;
        const target = this.detail.target, git = this.git;
        this.busy = true; this.send('operating', true);
        try {
          if (await confirm(t("将 {0} 中的 {1} 恢复到 {2}？现有文件内容会被覆盖，暂存区不变。", git.root, file.path, target.slice(0, 8)))) await git.mutate(['restore', `--source=${target}`, '--worktree', '--', file.path]);
        } finally { this.busy = false; this.send('operating', false); await this.refresh(); }
        break;
      }
    }
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await migrateModuleSettings();
  setLocale(vscode.env.language);
  output = vscode.window.createOutputChannel('Git Workbench');
  const blameDecoration = vscode.window.createTextEditorDecorationType({ before: { color: new vscode.ThemeColor('editorLineNumber.foreground'), margin: '0 2em 0 0', fontStyle: 'normal' } });
  const decorated = new Set<string>();
  const register = (id: string, callback: (...args: unknown[]) => Promise<unknown>) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try {
        for (const feature of commandModules(id)) requireModule(feature);
        if (id === 'gitWorkbench.open') requirePanel();
        return await callback(...args);
      } catch (error) {
        if (error instanceof vscode.CancellationError) return;
        output.appendLine(String(error));
        void vscode.window.showErrorMessage(`Git Workbench: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
  };
  const comparison = new DirectoryComparison(async (repo, revision, file, target) => {
    const left = revisionUri({ git: repo, ref: revision, file: file?.oldPath || file?.path || t("对比"), empty: !file || file.status[0] === 'A' });
    const right = !file || file.status[0] === 'D' ? revisionUri({ git: repo, ref: '', file: file?.path || t("对比"), empty: true })
      : target ? revisionUri({ git: repo, ref: target, file: file.path }) : vscode.Uri.file(repo.file(file.path));
    await vscode.commands.executeCommand('vscode.diff', left, right, t("对比 · {0} · {1} ↔ {2}", file?.path || t("无变更"), revision.slice(0, 8), target?.slice(0, 8) || t("工作区")), { preview: true, preserveFocus: true });
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
  register('gitWorkbench.compare.icons.file', async () => comparison.configure('comparisonIconStyle', 'file'));
  register('gitWorkbench.compare.icons.status', async () => comparison.configure('comparisonIconStyle', 'status'));
  for (const order of ['path', 'name', 'status'] as const) {
    register(`gitWorkbench.compare.sort.${order}`, async () => comparison.configure('comparisonSortOrder', order));
  }
  registerExplorerCommands(register, {
    repository: uri => workbench.repository(uri),
    history: (git, scope) => workbench.open(git, undefined, scope),
    compare: (git, scope, base, directory) => comparison.open(git, scope, base, { fileScope: !directory }),
    run: (git, title, task) => workbench.runTask(git, title, task),
  });
  const editor = () => {
    const active = vscode.window.activeTextEditor;
    if (!active || active.document.uri.scheme !== 'file') throw new Error(t("请先在编辑器中打开仓库内的文件。"));
    return active;
  };
  register('gitWorkbench.menu', async () => {
    for (;;) {
      const group = await vscode.window.showQuickPick([
        ...(readModules().graph || readModules().stash ? [{ label: readModules().graph && readModules().stash ? t("$(git-merge) 提交图与 Stash") : readModules().stash ? 'Stash' : `$(git-merge) ${moduleLabel('graph')}`, command: 'gitWorkbench.open' }] : []),
        ...(['selectionHistory', 'fileHistory', 'blame'].some(name => readModules()[name as 'selectionHistory' | 'fileHistory' | 'blame']) ? [{ label: t("$(history) 历史与追溯"), command: 'history' }] : []),
        ...(readModules().operations ? [{ label: `$(tools) ${t("仓库 Git 操作")}`, command: 'gitWorkbench.operations' }] : []),
        { label: `$(settings-gear) ${t('功能开关')}`, command: 'gitWorkbench.modules' },
      ], { title: 'Git Workbench', placeHolder: t("选择功能分类") });
      if (!group) return;
      if (group.command !== 'history') { await vscode.commands.executeCommand(group.command); return; }
      const choice = await vscode.window.showQuickPick([
        { label: t("$(arrow-left) 返回功能分类"), command: 'back' },
        ...(readModules().selectionHistory ? [{ label: t("查看选区 / 当前行历史"), command: 'gitWorkbench.selectionHistory' }] : []),
        ...(readModules().fileHistory ? [{ label: t("查看文件历史"), command: 'gitWorkbench.fileHistory' }] : []),
        ...(readModules().blame ? [{ label: t("查看当前行提交"), command: 'gitWorkbench.blame' }] : []),
        ...(readModules().blame ? [{ label: t("切换逐行作者标注"), command: 'gitWorkbench.toggleBlame' }] : []),
      ], { title: t("Git Workbench · 历史与追溯"), placeHolder: t("选择历史功能") });
      if (!choice) return;
      if (choice.command === 'back') continue;
      await vscode.commands.executeCommand(choice.command); return;
    }
  });
  register('gitWorkbench.modules', configureModules);
  register('gitWorkbench.open', async value => workbench.open(value instanceof vscode.Uri ? await workbench.repository(value) : undefined));
  register('gitWorkbench.operations', async value => workbench.menu(await workbench.repository(value instanceof vscode.Uri ? value : undefined)));
  register('gitWorkbench.fileHistory', async (value) => {
    const uri = value instanceof vscode.Uri ? value : editor().document.uri;
    const git = await workbench.repository(uri), file = git.relative(uri.fsPath);
    const history = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: t("读取文件历史") }, () => git.fileHistoryDetails(file));
    await openHistoryView(context, git, history, file, undefined, (repo, hash) => workbench.open(repo, hash));
  });
  register('gitWorkbench.selectionHistory', async () => {
    const active = editor();
    const uri = active.document.uri, contents = active.document.getText(), selection = active.selection;
    const git = await workbench.repository(uri), file = git.relative(uri.fsPath);
    const start = selection.start.line + 1;
    const end = !selection.isEmpty && selection.end.character === 0 ? selection.end.line : selection.end.line + 1;
    const history = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: t("追溯选区历史") }, () => git.lineHistoryDetails(file, start, Math.max(start, end), contents));
    await openHistoryView(context, git, history.entries, file, { start, end: Math.max(start, end), notice: history.notice }, (repo, hash) => workbench.open(repo, hash));
  });
  register('gitWorkbench.blame', async () => {
    const active = editor(), git = await workbench.repository(active.document.uri);
    const lines = await git.blame(git.relative(active.document.uri.fsPath), active.document.getText());
    requireModule('blame');
    const line = lines.find(item => item.line === active.selection.active.line + 1);
    if (!line) throw new Error(t("当前行没有可追溯的内容。"));
    if (/^0+$/.test(line.hash)) { void vscode.window.showInformationMessage(t("当前行尚未提交。")); return; }
    const choice = await vscode.window.showInformationMessage(`${line.author} · ${line.hash.slice(0, 8)} · ${line.summary}`, ...(readModules().graph ? [t("查看提交")] : []));
    if (choice && readModules().graph) await workbench.open(git, line.hash);
  });
  register('gitWorkbench.toggleBlame', async () => {
    const active = editor(), key = active.document.uri.toString();
    if (decorated.delete(key)) { active.setDecorations(blameDecoration, []); return; }
    if (active.document.lineCount > 10000) throw new Error(t("大于 10,000 行的文件请使用“查看当前行提交”。"));
    const git = await workbench.repository(active.document.uri);
    const lines = await git.blame(git.relative(active.document.uri.fsPath), active.document.getText());
    requireModule('blame');
    active.setDecorations(blameDecoration, lines.map(line => ({ range: new vscode.Range(line.line - 1, 0, line.line - 1, 0), renderOptions: { before: { contentText: /^0+$/.test(line.hash) ? t("未提交") : `${line.hash.slice(0, 7)} ${line.author}` } }, hoverMessage: line.summary })));
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
      if (!revision) throw new Error(t("版本视图已失效，请重新打开。"));
      if (revision.text !== undefined) return revision.text;
      if (revision.empty) return '';
      const content = await revision.git.content(revision.ref, revision.file);
      if (content.includes('\0')) throw new Error(t("此文件是二进制内容，请使用原生 Git / 专用查看器。"));
      return content;
    },
  }));
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.text = '$(git-merge) Git Workbench'; status.command = 'gitWorkbench.open'; status.tooltip = t("打开提交图与 Git 操作"); status.show();
  const updateModules = () => {
    closeDisabledHistoryViews();
    if (!readModules().blame) { for (const visible of vscode.window.visibleTextEditors) visible.setDecorations(blameDecoration, []); decorated.clear(); }
    if (!readModules().comparison) void comparison.close().catch(error => output.appendLine(String(error)));
    if (readModules().statusBar) status.show(); else status.hide();
    status.command = readModules().graph || readModules().stash ? 'gitWorkbench.open' : 'gitWorkbench.menu';
    status.tooltip = readModules().graph || readModules().stash ? t('打开 Git 面板') : t('功能开关');
  };
  updateModules();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('gitWorkbench.modules')) updateModules(); }));
  context.subscriptions.push(status, blameDecoration, output, workbench);
}

export function deactivate(): void { revisions.clear(); }
