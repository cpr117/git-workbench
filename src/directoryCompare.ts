import { t } from './i18n';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { Change, Git, assertHash } from './git';
import { inScope, workingChanges } from './explorerGit';

interface ComparisonNode { name: string; path: string; file?: Change; children?: ComparisonNode[]; }
type ViewMode = 'tree' | 'list';
type SortOrder = 'path' | 'name' | 'status';
type IconStyle = 'file' | 'status';
interface ComparisonPreview { original: vscode.Uri; modified: vscode.Uri; }
const model = require('../../media/comparisonTree.js') as { build(files: Change[], scope: string, query: string, options: { mode: ViewMode; sort: SortOrder }): ComparisonNode };

export class DirectoryComparison implements vscode.TreeDataProvider<ComparisonNode>, vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<ComparisonNode | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly decorationsChanged = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.decorationsChanged.event;
  private readonly decorations = new Map<string, { uri: vscode.Uri; decoration: vscode.FileDecoration }>();
  private readonly decorationRegistration: vscode.Disposable;
  private readonly tree: vscode.TreeView<ComparisonNode>;
  private git?: Git;
  private scope = '';
  private base = '';
  private target?: string;
  private baseLabel = '';
  private targetLabel = t("工作区");
  private files: Change[] = [];
  private nodes: ComparisonNode[] = [];
  private query = '';
  private listGeneration = 0;
  private mode: ViewMode = 'tree';
  private sort: SortOrder = 'path';
  private iconStyle: IconStyle = 'file';
  private readonly configurationListener: vscode.Disposable;
  private readonly tabListener: vscode.Disposable;
  private preview?: ComparisonPreview;
  private previewGeneration = 0;
  private openingPreviews = 0;

  constructor(private readonly openNative: (git: Git, base: string, file?: Change, target?: string) => Promise<ComparisonPreview>) {
    void vscode.commands.executeCommand('setContext', 'gitWorkbench.comparisonActive', false);
    this.tree = vscode.window.createTreeView('gitWorkbench.compareFiles', { treeDataProvider: this, showCollapseAll: true });
    this.decorationRegistration = vscode.window.registerFileDecorationProvider(this);
    this.readSettings();
    this.configurationListener = vscode.workspace.onDidChangeConfiguration(event => {
      if (['comparisonViewMode', 'comparisonSortOrder', 'comparisonIconStyle'].some(key => event.affectsConfiguration(`gitWorkbench.${key}`))) this.readSettings();
    });
    this.tabListener = vscode.window.tabGroups.onDidChangeTabs(async event => {
      if (!this.openingPreviews && event.closed.some(tab => this.isPreview(tab))) await this.close(false);
    });
  }

  dispose(): void { this.listGeneration++; this.previewGeneration++; this.tabListener.dispose(); this.configurationListener.dispose(); this.decorationRegistration.dispose(); this.decorationsChanged.dispose(); this.tree.dispose(); this.changed.dispose(); }
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined { return this.decorations.get(uri.toString())?.decoration; }
  private resource(file: string): vscode.Uri {
    // A separate scheme keeps comparison statuses out of Explorer and working-tree Git decorations.
    return vscode.Uri.from({ scheme: 'git-workbench-comparison', path: vscode.Uri.file(path.join(this.repository().root, file)).path });
  }
  getChildren(element?: ComparisonNode): ComparisonNode[] { return element ? element.children || [] : this.nodes; }
  getParent(element: ComparisonNode): ComparisonNode | undefined {
    const find = (nodes: ComparisonNode[]): ComparisonNode | undefined => {
      for (const node of nodes) {
        if (node.children?.includes(element)) return node;
        const parent = node.children && find(node.children); if (parent) return parent;
      }
      return undefined;
    };
    return find(this.nodes);
  }
  getTreeItem(node: ComparisonNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.name, node.file ? vscode.TreeItemCollapsibleState.None
      : node.path === '' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    item.id = JSON.stringify([this.git?.root, this.scope, this.base, this.target, node.file ? 'file' : 'folder', node.path]);
    if (node.file) {
      const file = node.file, status = file.status[0];
      const statusLabel = ({ A: t("新增"), M: t("修改"), D: t("删除"), R: t("重命名"), C: t("复制"), T: t("类型改变") } as Record<string, string>)[status] || status;
      const directory = path.posix.dirname(file.path);
      item.description = this.iconStyle === 'status' ? (this.mode === 'list' && directory !== '.' ? `${directory} · ${statusLabel}` : statusLabel)
        : this.mode === 'list' && directory !== '.' ? directory : undefined;
      item.tooltip = '';
      item.iconPath = this.iconStyle === 'file' ? vscode.ThemeIcon.File
        : new vscode.ThemeIcon(status === 'A' ? 'diff-added' : status === 'D' ? 'diff-removed' : status === 'R' ? 'diff-renamed' : 'diff-modified', this.statusColor(status));
      item.command = { command: 'gitWorkbench.compare.select', title: t("查看文件差异"), arguments: [file.path] };
    } else {
      item.iconPath = this.iconStyle === 'file' ? vscode.ThemeIcon.Folder : new vscode.ThemeIcon('folder');
      item.tooltip = '';
    }
    if (this.iconStyle === 'file') item.resourceUri = this.resource(node.path);
    return item;
  }

  private statusColor(status: string): vscode.ThemeColor {
    return new vscode.ThemeColor(`gitDecoration.${status === 'A' ? 'added' : status === 'D' ? 'deleted' : status === 'R' ? 'renamed' : 'modified'}ResourceForeground`);
  }

  private updateDecorations(): void {
    const affected = [...this.decorations.values()].map(value => value.uri);
    this.decorations.clear();
    if (this.git && this.iconStyle === 'file') {
      for (const file of this.files) {
        const uri = this.resource(file.path), status = file.status[0];
        this.decorations.set(uri.toString(), { uri, decoration: { badge: status, color: this.statusColor(status), propagate: true } });
        affected.push(uri);
      }
    }
    if (affected.length) this.decorationsChanged.fire(affected);
  }

  private repository(): Git {
    if (!vscode.workspace.isTrusted) throw new Error(t("请先信任此工作区。"));
    if (!this.git) throw new Error(t("请先右键文件夹或项目，选择 Git Workbench → 显示差异。"));
    return this.git;
  }

  async open(git: Git, scope: string, revision: string, options: { target?: string; baseLabel?: string; targetLabel?: string } = {}): Promise<void> {
    if (!vscode.workspace.isTrusted) throw new Error(t("请先信任此工作区。"));
    const ticket = ++this.listGeneration;
    const base = assertHash(revision), target = options.target ? assertHash(options.target) : undefined;
    this.git = git; this.scope = scope; this.base = base; this.target = target; this.query = '';
    this.baseLabel = options.baseLabel || base.slice(0, 8); this.targetLabel = options.targetLabel || target?.slice(0, 8) || t("工作区");
    this.files = []; this.nodes = []; this.changed.fire();
    await this.refresh();
    if (this.listGeneration !== ticket + 1 || this.git !== git) return;
    await vscode.commands.executeCommand('setContext', 'gitWorkbench.comparisonActive', true);
    await this.focus();
    if (this.git === git) await this.openPreview(this.files[0]);
  }

  private isPreview(tab: vscode.Tab, preview = this.preview): boolean {
    return !!preview && tab.input instanceof vscode.TabInputTextDiff
      && tab.input.original.toString() === preview.original.toString() && tab.input.modified.toString() === preview.modified.toString();
  }

  async close(closeEditor = true): Promise<void> {
    const tabs = closeEditor ? vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => this.isPreview(tab)) : [];
    this.preview = undefined; this.previewGeneration++;
    this.listGeneration++;
    this.git = undefined; this.target = undefined; this.files = []; this.nodes = []; this.query = '';
    this.updateDecorations();
    this.tree.message = undefined; this.tree.description = '';
    this.changed.fire();
    await vscode.commands.executeCommand('setContext', 'gitWorkbench.comparisonActive', false);
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
  }

  async focus(): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.scm');
    // reveal is the public TreeView API: it opens and expands this view without
    // depending on a generated <viewId>.focus command in the host editor.
    await this.tree.reveal(this.nodes[0], { focus: true, select: false, expand: true });
    const commands = await vscode.commands.getCommands(true);
    if (commands.includes('views.moveViewUp')) {
      // reveal can focus the tree before the pane's focused-view context settles.
      // The native move action reads that context, so focus the initialized pane first.
      if (commands.includes('gitWorkbench.compareFiles.focus')) await vscode.commands.executeCommand('gitWorkbench.compareFiles.focus');
      // Each visible view has a toggleVisibility command. The total across the
      // workbench bounds the number of upward moves; moving past the top is a no-op.
      const count = Math.max(3, commands.filter(command => command.endsWith('.toggleVisibility')).length);
      for (let index = 0; index < count && this.git; index++) await vscode.commands.executeCommand('views.moveViewUp');
    }
  }

  private updateTree(): void {
    this.updateDecorations();
    const root = model.build(this.files, this.scope, this.query, { mode: this.mode, sort: this.sort });
    root.name = path.posix.basename(this.scope) || path.basename(this.repository().root);
    this.nodes = this.mode === 'tree' && root.children?.length ? [root] : root.children || [];
    this.tree.description = t("{0} · {1} 个文件 · {2} ↔ {3}{4}", path.posix.basename(this.scope) || path.basename(this.repository().root), this.files.length, this.baseLabel, this.targetLabel, this.query ? t(" · 筛选：{0}", this.query) : '');
    // A persistent message takes height away from the native scrolling tree,
    // particularly when SCM's other sections leave only a few visible rows.
    this.tree.message = this.nodes.length ? undefined : this.query ? t("没有匹配的变更文件。") : t("所选范围没有差异。");
    this.changed.fire();
  }

  private readSettings(): void {
    const config = vscode.workspace.getConfiguration('gitWorkbench');
    this.mode = config.get('comparisonViewMode') === 'list' ? 'list' : 'tree';
    const sort = config.get('comparisonSortOrder');
    this.sort = sort === 'name' || sort === 'status' ? sort : 'path';
    this.iconStyle = config.get('comparisonIconStyle') === 'status' ? 'status' : 'file';
    void vscode.commands.executeCommand('setContext', 'gitWorkbench.comparisonViewMode', this.mode);
    void vscode.commands.executeCommand('setContext', 'gitWorkbench.comparisonSortOrder', this.sort);
    void vscode.commands.executeCommand('setContext', 'gitWorkbench.comparisonIconStyle', this.iconStyle);
    if (this.git) this.updateTree();
  }

  async configure(key: 'comparisonViewMode' | 'comparisonSortOrder' | 'comparisonIconStyle', value: ViewMode | SortOrder | IconStyle): Promise<void> {
    const config = vscode.workspace.getConfiguration('gitWorkbench');
    const current = config.inspect(key);
    const target = current?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
      : current?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await config.update(key, value, target);
    this.readSettings();
  }

  async search(): Promise<void> {
    this.repository();
    const query = await vscode.window.showInputBox({ prompt: t("筛选变更路径（清空显示全部）"), value: this.query, ignoreFocusOut: true });
    if (query === undefined) return;
    this.query = query.trim(); this.updateTree();
  }

  async refresh(): Promise<void> {
    const git = this.repository(), scope = this.scope, base = this.base, target = this.target, ticket = ++this.listGeneration;
    const files = target ? (await git.compare(base, target)).filter(file => inScope(file.path, scope) || !!file.oldPath && inScope(file.oldPath, scope)) : await workingChanges(git, scope, base);
    if (ticket !== this.listGeneration || git !== this.git) return;
    this.files = files;
    this.updateTree();
  }

  async select(filePath: string): Promise<void> {
    this.repository();
    const file = this.files.find(file => file.path === filePath);
    if (!file) throw new Error(t("请选择当前对比目录树中的文件。"));
    await this.openPreview(file);
  }

  private async openPreview(file?: Change): Promise<void> {
    const ticket = ++this.previewGeneration;
    this.openingPreviews++;
    try {
      const preview = await this.openNative(this.repository(), this.base, file, this.target);
      if (ticket === this.previewGeneration) this.preview = preview;
    } finally { this.openingPreviews--; }
  }
}
