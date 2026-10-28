import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Git } from '../src/git';
import { setLocale } from '../src/i18n';

type Message = { type: string; data?: Record<string, unknown> };
const noop = () => {};
const disposable = () => ({ dispose: noop });
class Uri {
  scheme = 'file'; query = ''; path: string; fsPath: string;
  constructor(file: string) { this.path = this.fsPath = file; }
  static file(file: string) { return new Uri(file); }
  static joinPath(base: Uri, ...parts: string[]) { return new Uri(path.join(base.fsPath, ...parts)); }
  static from(value: Partial<Uri>) { return Object.assign(new Uri(value.path || ''), value); }
  toString() { return `${this.scheme}:${this.path}?${this.query}`; }
}
class TabInputTextDiff { constructor(readonly original: Uri, readonly modified: Uri) {} }
class CancellationError extends Error {}
interface TestTab { input: TabInputTextDiff; label: string; }
const tabs: TestTab[] = [];
let tabListener: ((event: { closed: TestTab[] }) => Promise<void>) | undefined;
class Panel {
  active = true; popup = false; visible = true;
  disposals = new Set<() => void>();
  visibilityListeners = new Set<() => void>();
  messages: Message[] = [];
  messageListeners = new Set<(message: Message) => void>();
  listener?: (message: unknown) => Promise<unknown>;
  webview = {
    options: {}, html: '', cspSource: 'vscode-webview:',
    asWebviewUri: (uri: Uri) => uri.toString(),
    onDidReceiveMessage: (listener: (message: unknown) => Promise<unknown>) => { this.listener = listener; return disposable(); },
    postMessage: async (message: Message) => { this.messages.push(message); this.messageListeners.forEach(listener => listener(message)); return true; },
  };
  constructor(readonly viewType: string) {}
  reveal() { this.active = true; }
  show() { this.visible = true; }
  onDidChangeVisibility(listener: () => void) { this.visibilityListeners.add(listener); return { dispose: () => this.visibilityListeners.delete(listener) }; }
  onDidDispose(listener: () => void) { this.disposals.add(listener); return disposable(); }
  dispose() { this.active = false; for (const listener of this.disposals) listener(); this.disposals.clear(); }
}

function nextMessage(view: Panel, type: string): Promise<Message> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { view.messageListeners.delete(listener); reject(new Error(`No automatic ${type} update after external Git operation`)); }, 2500);
    const listener = (message: Message) => {
      if (message.type !== type) return;
      clearTimeout(timer); view.messageListeners.delete(listener); resolve(message);
    };
    view.messageListeners.add(listener);
  });
}
const commands = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const panels: Panel[] = [];
const popups: Panel[] = [];
const logViews: Panel[] = [];
let viewProvider: { resolveWebviewView(view: Panel): void } | undefined;
let revisionProvider: { provideTextDocumentContent(uri: Uri): Promise<string> };
let presentation = 'editor';
const comparisonSettings = new Map<string, unknown>();
type ConfigurationEvent = { affectsConfiguration(key: string): boolean };
let configurationListener: ((event: ConfigurationEvent) => void) | undefined;
const configurationCallbacks = new Set<(event: ConfigurationEvent) => void>();
let themeListener: (() => void) | undefined;
const windowStateListeners = new Set<(state: { focused: boolean }) => void>();
const executed: string[] = [];
let comparisonTreeState: { message?: string; description: string };
interface FileDecoration { badge?: string; color?: { id: string }; propagate?: boolean; }
let decorationProvider: { provideFileDecoration(uri: Uri): FileDecoration | undefined; onDidChangeFileDecorations(listener: (uris: Uri[]) => void): unknown };
const treeReveals: { node?: ComparisonNode; options: unknown }[] = [];
const errors: string[] = [];
const infos: string[] = [];
const warnings: string[] = [];
const warningQueue: unknown[] = [];
const inputQueue: unknown[] = [];
const commandArgs: unknown[][] = [];
const pickQueue: unknown[] = [];
const folderQueue: unknown[] = [];
let folderPickerCalls = 0;
let nativeCommands: string[] = [];
let pickerCalls = 0;
const quickPicks: { labels: string[]; title?: string; placeHolder?: string }[] = [];
const confirmationButtons: string[][] = [];
interface ComparisonNode { name: string; path: string; file?: { path: string }; children?: ComparisonNode[]; }
let comparisonProvider: { getChildren(node?: ComparisonNode): ComparisonNode[]; getParent(node: ComparisonNode): ComparisonNode | undefined; getTreeItem(node: ComparisonNode): { collapsibleState: number; description?: string; tooltip?: string; resourceUri?: Uri; iconPath?: { id: string }; command?: { arguments?: unknown[] } } } | undefined;
const windowStub = {
  onDidChangeWindowState: (listener: (state: { focused: boolean }) => void) => { windowStateListeners.add(listener); return { dispose: () => windowStateListeners.delete(listener) }; },
  tabGroups: {
    all: [{ tabs }],
    onDidChangeTabs: (listener: typeof tabListener) => { tabListener = listener; return disposable(); },
    close: async (items: TestTab | TestTab[]) => {
      const closed = Array.isArray(items) ? items : [items];
      for (const tab of closed) { const index = tabs.indexOf(tab); if (index >= 0) tabs.splice(index, 1); }
      await tabListener?.({ closed }); return true;
    },
  },
  activeTextEditor: undefined as unknown,
  activeColorTheme: { kind: 2 },
  onDidChangeActiveColorTheme: (listener: () => void) => { themeListener = listener; return { dispose: () => { if (themeListener === listener) themeListener = undefined; } }; },
  createOutputChannel: () => ({ appendLine: noop, show: noop, dispose: noop }),
  createTextEditorDecorationType: disposable,
  registerFileDecorationProvider: (provider: typeof decorationProvider) => { decorationProvider = provider; return disposable(); },
  createStatusBarItem: () => ({ text: '', command: '', tooltip: '', show: noop, dispose: noop }),
  createWebviewPanel: (viewType: string) => { const panel = new Panel(viewType); panels.push(panel); return panel; },
  createTreeView: (id: string, options: { treeDataProvider: typeof comparisonProvider; showCollapseAll: boolean }) => { assert.equal(id, 'gitWorkbench.compareFiles'); assert.equal(options.showCollapseAll, true); comparisonProvider = options.treeDataProvider; comparisonTreeState = { message: undefined, description: '' }; return { get message() { return comparisonTreeState.message; }, set message(value: string | undefined) { comparisonTreeState.message = value; }, get description() { return comparisonTreeState.description; }, set description(value: string) { comparisonTreeState.description = value; }, dispose: noop, reveal: async (node: ComparisonNode | undefined, options: unknown) => { treeReveals.push({ node, options }); } }; },
  registerWebviewViewProvider: (id: string, provider: typeof viewProvider) => { assert.equal(id, 'gitWorkbench.log'); viewProvider = provider; return disposable(); },
  withProgress: async (_options: unknown, task: () => Promise<unknown>) => task(),
  showQuickPick: async (items: readonly (string | { label: string })[] = [], options?: { title?: string; placeHolder?: string }) => { quickPicks.push({ labels: items.map(item => typeof item === 'string' ? item : item.label), ...options }); pickerCalls++; return pickQueue.shift(); },
  showOpenDialog: async () => { folderPickerCalls++; return folderQueue.shift(); },
  showInputBox: async () => inputQueue.shift(),
  showWarningMessage: async (text: string, ...items: unknown[]) => { warnings.push(text); confirmationButtons.push(items.filter(item => typeof item === 'string') as string[]); const answer = warningQueue.shift(); return typeof answer === 'function' ? answer() : answer; },
  showInformationMessage: async (text: string) => { infos.push(text); return undefined; },
  showErrorMessage: async (text: string) => { errors.push(text); return undefined; },
  showTextDocument: async () => undefined,
};
const vscodeStub = {
  Uri, TabInputTextDiff, CancellationError, ThemeColor: class { constructor(readonly id: string) {} }, ThemeIcon: class { static File = { id: 'file' }; static Folder = { id: 'folder' }; constructor(readonly id: string) {} },
  TreeItem: class { constructor(readonly label: string, readonly collapsibleState: number) {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter: class { listeners = new Set<(value: unknown) => void>(); event = (listener: (value: unknown) => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; fire = (value: unknown) => { this.listeners.forEach(listener => listener(value)); }; dispose = () => this.listeners.clear(); },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  StatusBarAlignment: { Left: 1 }, ViewColumn: { One: 1, Active: -1, Beside: -2 }, ProgressLocation: { Window: 10 },
  window: windowStub,
  workspace: {
    getConfiguration: () => ({ get: (key: string, fallback?: unknown) => key === 'historyPresentation' ? presentation || fallback : comparisonSettings.get(key) ?? fallback, inspect: () => undefined, update: async (key: string, value: unknown) => { comparisonSettings.set(key, value); configurationListener?.({ affectsConfiguration: name => name === `gitWorkbench.${key}` }); } }),
    onDidChangeConfiguration: (listener: (event: ConfigurationEvent) => void) => { configurationCallbacks.add(listener); configurationListener = event => configurationCallbacks.forEach(callback => callback(event)); return { dispose: () => configurationCallbacks.delete(listener) }; },
    isTrusted: true, workspaceFolders: [] as { uri: Uri }[], onDidChangeTextDocument: disposable, onDidCloseTextDocument: disposable,
    registerTextDocumentContentProvider: (_scheme: string, provider: typeof revisionProvider) => { revisionProvider = provider; return disposable(); },
  },
  extensions: { getExtension: () => undefined },
  env: { language: 'zh-cn', remoteName: undefined as string | undefined, clipboard: { writeText: async () => undefined } },
  commands: {
    registerCommand: (id: string, handler: (...args: unknown[]) => Promise<unknown>) => { commands.set(id, handler); return disposable(); },
    getCommands: async () => nativeCommands,
    executeCommand: async (id: string, ...args: unknown[]) => {
      if (id === 'gitWorkbench.comparison.focus') throw new Error(`command '${id}' not found`);
      executed.push(id);
      commandArgs.push(args);
      if (id === 'vscode.diff') {
        const old = tabs.splice(0);
        tabs.push({ input: new TabInputTextDiff(args[0] as Uri, args[1] as Uri), label: args[2] as string });
        await tabListener?.({ closed: old }); return;
      }
      if (id === 'gitWorkbench.log.focus') {
        let view = logViews.at(-1);
        if (!view?.active) { view = new Panel('gitWorkbench.log'); logViews.push(view); viewProvider!.resolveWebviewView(view); }
        view.show(); return;
      }
      return commands.get(id)?.(...args);
    },
  },
};
// Exercise the actual registered editor command with a small VS Code boundary stub.
// Git history is still produced by a real temporary repository.
const loader = require('node:module') as { _load: (id: string, ...args: unknown[]) => unknown };
const originalLoad = loader._load;
let activate: (context: unknown) => void;
try {
  loader._load = (id, ...args) => id === 'vscode' ? vscodeStub : id === './historyPopup' ? { openHistoryPopup: async () => { const panel = new Panel('nativeHistoryPopup'); panel.popup = true; popups.push(panel); return panel; } } : originalLoad(id, ...args);
  activate = (require('../src/extension') as { activate: (context: unknown) => void }).activate;
} finally { loader._load = originalLoad; }

async function fixture(task: (git: Git, root: string) => Promise<void>, language = 'zh-cn'): Promise<void> {
  vscodeStub.env.language = language; quickPicks.length = 0; confirmationButtons.length = 0;
  for (const popup of popups) popup.dispose();
  popups.length = 0; presentation = 'editor'; vscodeStub.env.remoteName = undefined;
  commands.clear(); panels.length = 0; logViews.length = 0; viewProvider = undefined; executed.length = 0; errors.length = 0; infos.length = 0; pickQueue.length = 0; pickerCalls = 0;
  warnings.length = 0; warningQueue.length = 0; inputQueue.length = 0; commandArgs.length = 0;
  folderQueue.length = 0; folderPickerCalls = 0; vscodeStub.workspace.workspaceFolders = [];
  comparisonProvider = undefined; treeReveals.length = 0; tabs.length = 0; tabListener = undefined; comparisonSettings.clear(); configurationCallbacks.clear(); configurationListener = undefined; themeListener = undefined; windowStub.activeColorTheme.kind = 2;
  const root = await mkdtemp(path.join(tmpdir(), 'git-workbench-host-'));
  const git = new Git(root);
  const subscriptions: { dispose(): void }[] = [];
  try {
    await git.run(['init', '-b', 'main']);
    await git.run(['config', 'user.name', 'History Test']); await git.run(['config', 'user.email', 'test@example.invalid']);
    await git.run(['config', 'commit.gpgsign', 'false']);
    const file = path.join(root, 'code.txt');
    await writeFile(file, 'before\ncontext\n'); await git.mutate(['add', '-A']); await git.mutate(['commit', '-m', 'Initial version']);
    await writeFile(file, 'after\ncontext\n'); await git.mutate(['add', '-A']); await git.mutate(['commit', '-m', 'Edit selected line']);
    windowStub.activeTextEditor = {
      document: { uri: Uri.file(file), isDirty: false, getText: () => 'after\ncontext\n' },
      selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 }, isEmpty: false },
    };
    activate({ extensionUri: Uri.file(path.resolve(__dirname, '../..')), subscriptions });
    await task(git, root);
  } finally { subscriptions.reverse().forEach(item => item.dispose()); setLocale('zh-cn'); await rm(root, { recursive: true, force: true }); }
}

test('explicit editor preference retains a persistent comparison view without native editor migration', async () => fixture(async () => {
  nativeCommands = ['workbench.action.moveEditorToNewWindow'];
  await commands.get('gitWorkbench.selectionHistory')!();
  assert.deepEqual(errors, []);
  assert.equal(pickerCalls, 0, 'history must not be reduced to a one-shot Quick Pick');
  assert.equal(panels.length, 1, 'selection history needs its own persistent view');
  assert.equal(panels[0].viewType, 'gitWorkbench.selectionHistory');
  assert.equal(executed.includes('workbench.action.moveEditorToNewWindow'), false, 'wait for the Webview to render before moving it');
  await panels[0].listener!({ type: 'init' });
  await panels[0].listener!({ type: 'ready' });
  assert.equal(executed.includes('workbench.action.moveEditorToNewWindow'), false, 'opening history must not trigger the blank auxiliary-window path');
  const history = panels[0].messages.find(message => message.type === 'history');
  const entries = history?.data?.entries as { hash: string }[];
  assert.equal(entries.length, 2);
  const detail = panels[0].messages.find(message => message.type === 'historyDetail');
  assert.equal(detail?.data?.hash, entries[0].hash);
  await panels[0].listener!({ type: 'select', hash: entries[1].hash });
  assert.equal(panels[0].messages.at(-1)?.data?.hash, entries[1].hash);
  await panels[0].listener!({ type: 'ready' });
  assert.equal(executed.filter(id => id === 'workbench.action.moveEditorToNewWindow').length, 0, 'switching revisions must not create a floating window');
  assert.equal(panels.length, 1, 'changing revisions must reuse the same history window');
}));

test('history presentation switches preserve multi-selection while keeping popup as the default', { skip: process.platform !== 'darwin' }, async () => fixture(async () => {
  presentation = '';
  await commands.get('gitWorkbench.selectionHistory')!();
  const popup = popups[0]; await popup.listener!({ type: 'init' });
  const entries = popup.messages.find(message => message.type === 'history')!.data!.entries as { hash: string }[];
  const hashes = entries.map(entry => entry.hash);
  await popup.listener!({ type: 'selectMany', hashes });
  await popup.listener!({ type: 'presentation', presentation: 'editor', hashes });
  assert.equal(panels.length, 1); assert.equal(popup.active, false);
  const editor = panels[0]; await editor.listener!({ type: 'init' });
  assert.equal(editor.messages.find(message => message.type === 'history')!.data!.presentation, 'editor');
  assert.deepEqual(editor.messages.at(-1)!.data!.hashes, hashes);
  await editor.listener!({ type: 'presentation', presentation: 'popup', hashes });
  assert.equal(editor.active, false); assert.equal(popups.length, 2);
  await popups[1].listener!({ type: 'init' });
  assert.deepEqual(popups[1].messages.at(-1)!.data!.hashes, hashes);
  await commands.get('gitWorkbench.selectionHistory')!();
  assert.equal(popups.length, 3, 'switching one view must not change the default presentation');
  assert.equal(panels.length, 1);
}));

test('failed or invalid presentation changes preserve the existing history surface', async () => fixture(async () => {
  await commands.get('gitWorkbench.fileHistory')!(); const editor = panels[0];
  await editor.listener!({ type: 'init' });
  const entries = editor.messages.find(message => message.type === 'history')!.data!.entries as { hash: string }[];
  await editor.listener!({ type: 'presentation', presentation: 'popup', hashes: ['a'.repeat(40)] });
  assert.equal(editor.active, true); assert.equal(popups.length, 0); assert.equal(editor.messages.at(-1)!.type, 'error');
  vscodeStub.env.remoteName = 'ssh-remote';
  await editor.listener!({ type: 'presentation', presentation: 'popup', hashes: [entries[0].hash] });
  assert.equal(editor.active, true); assert.equal(popups.length, 0); assert.equal(editor.messages.at(-1)!.type, 'error');
}));

test('the single command-menu entry opens the history category before the editor action', async () => fixture(async () => {
  nativeCommands = ['workbench.action.moveEditorToNewWindow'];
  pickQueue.push({ command: 'history' }, { command: 'gitWorkbench.selectionHistory' });
  await commands.get('gitWorkbench.menu')!();
  assert.equal(pickerCalls, 2);
  assert.equal(panels.length, 1);
  assert.ok(executed.includes('gitWorkbench.selectionHistory'));
  assert.deepEqual(errors, []);
}));

test('file history uses the same persistent view with lazily loaded file differences', async () => fixture(async () => {
  nativeCommands = [];
  await commands.get('gitWorkbench.fileHistory')!();
  assert.equal(pickerCalls, 0);
  const panel = panels[0]; assert.ok(panel);
  await panel.listener!({ type: 'init' });
  const detail = panel.messages.find(message => message.type === 'historyDetail');
  assert.match(String(detail?.data?.patch), /\+after/);
  assert.deepEqual(errors, []);
}));

test('default popup opens history without creating an editor tab or moving the active editor', { skip: process.platform !== 'darwin' }, async () => fixture(async () => {
  presentation = ''; nativeCommands = ['workbench.action.moveEditorToNewWindow'];
  const originalEditor = windowStub.activeTextEditor;
  await commands.get('gitWorkbench.selectionHistory')!();
  assert.equal(panels.length, 0, 'selection history must not create a new editor tab');
  assert.equal(popups.length, 1);
  const popup = popups[0]; await popup.listener!({ type: 'init' });
  assert.match(String(popup.messages.at(-1)?.data?.patch), /\+after/);
  assert.equal(windowStub.activeTextEditor, originalEditor, 'the original code editor and its selection stay intact');
  assert.equal(executed.includes('workbench.action.moveEditorToNewWindow'), false);
  await popup.listener!({ type: 'close' }); assert.equal(popup.active, false);
}));

test('file history also uses the popup; reopening replaces the previous popup', { skip: process.platform !== 'darwin' }, async () => fixture(async () => {
  presentation = 'popup';
  await commands.get('gitWorkbench.fileHistory')!();
  const first = popups[0]; await first.listener!({ type: 'init' });
  assert.match(String(first.messages.at(-1)?.data?.patch), /\+after/);
  await commands.get('gitWorkbench.selectionHistory')!();
  assert.equal(first.active, false); assert.equal(popups.length, 2); assert.equal(panels.length, 0);
  await popups[1].listener!({ type: 'init' });
  const entries = popups[1].messages.find(message => message.type === 'history')!.data!.entries as { hash: string }[];
  await popups[1].listener!({ type: 'selectMany', hashes: entries.map(entry => entry.hash) });
  assert.equal((popups[1].messages.at(-1)!.data!.hashes as string[]).length, 2);
  popups[1].dispose();
}));

test('unsupported remote popup does not silently create a history tab', async () => fixture(async () => {
  presentation = 'popup'; vscodeStub.env.remoteName = 'ssh-remote';
  await commands.get('gitWorkbench.selectionHistory')!();
  assert.equal(panels.length, 0); assert.equal(popups.length, 0);
  assert.ok(errors.some(text => text.includes('macOS 本地工作区')));
}));

test('native history synchronizes high contrast and editor fonts live and disposes appearance subscriptions', async () => fixture(async () => {
  presentation = 'popup'; windowStub.activeColorTheme.kind = vscodeStub.ColorThemeKind.HighContrastLight;
  comparisonSettings.set('fontFamily', 'Test Mono, monospace'); comparisonSettings.set('fontSize', 19);
  await commands.get('gitWorkbench.fileHistory')!(); const popup = popups[0]; await popup.listener!({ type: 'init' });
  assert.deepEqual(popup.messages.find(message => message.type === 'appearance')!.data, { theme: 'hc-light', fontFamily: 'Test Mono, monospace', fontSize: 19 });
  windowStub.activeColorTheme.kind = vscodeStub.ColorThemeKind.HighContrast; themeListener!();
  assert.equal(popup.messages.at(-1)!.data!.theme, 'hc-dark');
  comparisonSettings.set('fontSize', 24); configurationListener!({ affectsConfiguration: key => key === 'editor.fontSize' });
  assert.equal(popup.messages.at(-1)!.data!.fontSize, 24);
  const before = popup.messages.length; popup.dispose();
  assert.equal(themeListener, undefined); configurationListener!({ affectsConfiguration: () => true });
  assert.equal(popup.messages.length, before, 'closed native windows receive no more appearance updates');
  assert.deepEqual(errors, []);
}));

test('selection history multi-select compares the inclusive endpoints within the tracked range', async () => fixture(async () => {
  await commands.get('gitWorkbench.selectionHistory')!(); const panel = panels[0];
  await panel.listener!({ type: 'init' });
  const entries = panel.messages.find(message => message.type === 'history')!.data!.entries as { hash: string }[];
  await panel.listener!({ type: 'selectMany', hashes: entries.map(entry => entry.hash) });
  const detail = panel.messages.at(-1)!;
  assert.equal(detail.type, 'historyDetail'); assert.deepEqual(detail.data!.hashes, entries.map(entry => entry.hash));
  assert.equal(detail.data!.comparison, true);
  assert.equal(detail.data!.target, entries[0].hash);
  assert.match(String(detail.data!.patch), /\+after/);
  assert.doesNotMatch(String(detail.data!.patch), /context|Initial version|Edit selected line/);
  assert.equal((detail.data!.rows as { kind: string }[]).filter(row => row.kind === 'note').length, 0);
  await panel.listener!({ type: 'init', hashes: entries.map(entry => entry.hash) });
  assert.deepEqual(panel.messages.at(-1)!.data!.hashes, entries.map(entry => entry.hash), 'moving the view must restore the multi-selection');
  await panel.listener!({ type: 'selectMany', hashes: ['a'.repeat(40)] });
  assert.equal(panel.messages.at(-1)!.type, 'error', 'unknown commits must not be loaded by the webview');
}));

test('graph multi-select opens the aggregate file using its verified diff endpoints', async () => fixture(async (git) => {
  nativeCommands = [];
  await commands.get('gitWorkbench.open')!(); const panel = logViews[0];
  assert.equal(panels.length, 0, 'the Git graph must not create an editor tab');
  await panel.listener!({ type: 'init' });
  const commits = await git.commits();
  const root = panel.messages.find(message => message.type === 'snapshot')!.data!.root;
  await panel.listener!({ type: 'selectMany', repoRoot: root, hashes: commits.map(commit => commit.hash).reverse() });
  const detail = panel.messages.at(-1)!;
  assert.equal(detail.type, 'detail'); assert.equal(detail.data!.aggregate, true); assert.equal(detail.data!.mode, 'range');
  assert.equal(detail.data!.base, await git.emptyTree()); assert.equal(detail.data!.target, commits[0].hash);
  const files = detail.data!.files as { path: string }[]; assert.equal(files[0].path, 'code.txt');
  await panel.listener!({ type: 'diff', repoRoot: root, path: files[0].path });
  assert.ok(executed.includes('vscode.diff'));
}));


test('Git log is contributed beside Terminal and reopening reuses the panel view', async () => fixture(async () => {
  const manifest = JSON.parse(await readFile(path.resolve(__dirname, '../../package.json'), 'utf8'));
  assert.ok(manifest.contributes.viewsContainers.panel.some((container: { id: string }) => container.id === 'git-workbench-panel'));
  for (const container of manifest.contributes.viewsContainers.panel) assert.match(container.id, /^[a-zA-Z0-9_-]+$/, 'container ids must satisfy the host contribution schema');
  assert.equal(manifest.contributes.views['git-workbench-panel'][0].type, 'webview');
  const originalEditor = windowStub.activeTextEditor;
  await commands.get('gitWorkbench.open')!();
  const first = logViews[0]; await first.listener!({ type: 'init' });
  assert.equal(panels.length, 0); assert.equal(windowStub.activeTextEditor, originalEditor);
  first.visible = false;
  await commands.get('gitWorkbench.open')!();
  assert.equal(logViews.length, 1); assert.equal(first.visible, true);
  first.dispose();
  await commands.get('gitWorkbench.open')!();
  assert.equal(logViews.length, 2); assert.equal(panels.length, 0);
  await logViews[1].listener!({ type: 'init' });
  assert.ok(logViews[1].messages.some(message => message.type === 'snapshot'));
  assert.deepEqual(errors, []);
}));

test('history jump reveals and selects the commit in the bottom Git panel', async () => fixture(async () => {
  await commands.get('gitWorkbench.fileHistory')!(); const history = panels[0];
  await history.listener!({ type: 'init' });
  const entries = history.messages.find(message => message.type === 'history')!.data!.entries as { hash: string }[];
  await history.listener!({ type: 'openCommit', hash: entries[1].hash });
  assert.equal(panels.length, 1, 'opening a commit must not add a graph editor tab');
  assert.equal(logViews.length, 1);
  const details = logViews[0].messages.filter(message => message.type === 'detail');
  assert.equal(details.at(-1)!.data!.target, entries[1].hash);
  assert.ok(executed.includes('gitWorkbench.log.focus'));
  assert.deepEqual(errors, []);
}));


test('sparse history selection includes the oldest edit and intermediate edits while excluding unselected code', async () => fixture(async (git, root) => {
  const file = path.join(root, 'code.txt');
  for (const [text, subject] of [['middle\ncontext\nchanged outside range\n', 'Intermediate edit'], ['latest\ncontext\nchanged again outside range\n', 'Latest edit']]) {
    await writeFile(file, text); await git.mutate(['add', '-A']); await git.mutate(['commit', '-m', subject]);
  }
  await commands.get('gitWorkbench.selectionHistory')!(); const panel = panels[0];
  await panel.listener!({ type: 'init' });
  const entries = panel.messages.find(message => message.type === 'history')!.data!.entries as { hash: string }[];
  assert.equal(entries.length, 4);
  await panel.listener!({ type: 'selectMany', hashes: [entries[2].hash, entries[0].hash] });
  const sparse = panel.messages.at(-1)!;
  assert.equal(sparse.type, 'historyDetail'); assert.equal(sparse.data!.base, entries[3].hash);
  assert.match(String(sparse.data!.patch), /-before\n\+latest/);
  assert.doesNotMatch(String(sparse.data!.patch), /after|middle|outside|context/);
  await panel.listener!({ type: 'selectMany', hashes: entries.slice(0, 3).map(entry => entry.hash) });
  assert.equal(panel.messages.at(-1)!.data!.patch, sparse.data!.patch, 'Shift and sparse selection must have identical endpoint diffs');
  assert.deepEqual(errors, []);
}));

test('file history endpoint comparison follows a rename at the oldest selected commit', async () => fixture(async (git, root) => {
  const renamed = path.join(root, 'renamed.txt');
  await git.mutate(['mv', 'code.txt', 'renamed.txt']); await git.mutate(['commit', '-m', 'Rename file']);
  const rename = await git.head();
  await writeFile(renamed, 'latest\ncontext\n'); await git.mutate(['add', '-A']); await git.mutate(['commit', '-m', 'Edit renamed file']);
  (windowStub.activeTextEditor as { document: { uri: Uri } }).document.uri = Uri.file(renamed);
  await commands.get('gitWorkbench.fileHistory')!(); const panel = panels[0];
  await panel.listener!({ type: 'init' });
  const entries = panel.messages.find(message => message.type === 'history')!.data!.entries as { hash: string }[];
  assert.ok(entries.some(entry => entry.hash === rename));
  await panel.listener!({ type: 'selectMany', hashes: [rename, entries[0].hash] });
  const detail = panel.messages.at(-1)!; assert.equal(detail.type, 'historyDetail');
  assert.match(String(detail.data!.patch), /-after\n\+latest/); assert.deepEqual(errors, []);
}));


test('selection history accepts unsaved editor contents and preserves the mapping through view migration', { skip: process.platform !== 'darwin' }, async () => fixture(async (git, root) => {
  presentation = 'popup';
  const active = windowStub.activeTextEditor as { document: { isDirty: boolean; getText: () => string }; selection: { start: { line: number; character: number }; end: { line: number; character: number }; isEmpty: boolean } };
  active.document.isDirty = true;
  active.document.getText = () => 'prefix\nafter unsaved\ncontext\n';
  active.selection = { start: { line: 1, character: 0 }, end: { line: 1, character: 13 }, isEmpty: false };
  const head = await git.head(), index = await git.run(['show', ':code.txt']);
  await commands.get('gitWorkbench.selectionHistory')!(); assert.deepEqual(errors, []);
  assert.equal(popups.length, 1); assert.equal(panels.length, 0);
  const popup = popups[0]; await popup.listener!({ type: 'init' });
  const data = popup.messages.find(message => message.type === 'history')!.data!;
  const entries = data.entries as { hash: string }[];
  assert.equal(entries.length, 2); assert.equal(entries[0].hash, head);
  assert.match((data.range as { notice: string }).notice, /HEAD .*1–1/);
  await popup.listener!({ type: 'presentation', presentation: 'editor', hashes: entries.map(entry => entry.hash) });
  await panels[0].listener!({ type: 'init' });
  const tabData = panels[0].messages.find(message => message.type === 'history')!.data!;
  assert.deepEqual(tabData.range, data.range);
  assert.equal(await readFile(path.join(root, 'code.txt'), 'utf8'), 'after\ncontext\n');
  assert.equal(await git.run(['show', ':code.txt']), index); assert.equal(await git.head(), head);
}));

test('a purely new unsaved line reports missing history without opening an empty popup', async () => fixture(async () => {
  const active = windowStub.activeTextEditor as { document: { isDirty: boolean; getText: () => string } };
  active.document.isDirty = true; active.document.getText = () => 'new\nafter\ncontext\n';
  await commands.get('gitWorkbench.selectionHistory')!();
  assert.equal(panels.length, 0); assert.equal(popups.length, 0); assert.ok(errors.some(message => message.includes('新增内容')));
}));

test('folder and project menus expose grouped Git operations without flattening the palette', async () => fixture(async () => {
  const manifest = JSON.parse(await readFile(path.resolve(__dirname, '../../package.json'), 'utf8'));
  const contribution = manifest.contributes.menus['explorer/context'].find((item: { submenu: string }) => item.submenu === 'gitWorkbench.directoryMenu');
  assert.match(contribution.when, /explorerResourceIsFolder/);
  assert.match(contribution.when, /isWorkspaceTrusted/);
  const menu = manifest.contributes.menus['gitWorkbench.directoryMenu'];
  assert.equal(menu.length, 21);
  for (const item of menu) {
    assert.ok(commands.has(item.command), `${item.command} must be executable`);
    assert.ok(manifest.contributes.menus.commandPalette.some((entry: { command: string; when: string }) => entry.command === item.command && entry.when === 'false'));
  }
}));

test('project root history discovers the selected repository and folder history limits commit files', async () => fixture(async (git, root) => {
  await mkdir(path.join(root, 'folder'));
  await writeFile(path.join(root, 'folder/a.txt'), 'folder\n');
  await writeFile(path.join(root, 'outside.txt'), 'outside\n');
  await git.mutate(['add', '-A']); await git.mutate(['commit', '-m', 'Two scopes']);
  await commands.get('gitWorkbench.explorer.history')!(Uri.file(root));
  const view = logViews[0]; await view.listener!({ type: 'init' });
  assert.equal(view.messages.filter(message => message.type === 'snapshot').at(-1)!.data!.root, (await Git.discover(root)).root);
  await commands.get('gitWorkbench.explorer.history')!(Uri.file(path.join(root, 'folder')));
  const snapshot = view.messages.filter(message => message.type === 'snapshot').at(-1)!.data!;
  assert.equal((snapshot.filters as { path: string }).path, 'folder');
  await view.listener!({ type: 'select', repoRoot: snapshot.root, hash: await git.head() });
  assert.deepEqual((view.messages.at(-1)!.data!.files as { path: string }[]).map(file => file.path), ['folder/a.txt']);
  assert.deepEqual(errors, []);
}));

test('directory comparison opens the SCM tree and a tracked native comparison tab', async () => fixture(async (git, root) => {
  await mkdir(path.join(root, 'folder')); await mkdir(path.join(root, 'folder/nested'));
  await writeFile(path.join(root, 'folder/nested/a.txt'), 'base\n');
  await git.mutate(['add', '-A']); await git.mutate(['commit', '-m', 'Folder']);
  await writeFile(path.join(root, 'folder/nested/a.txt'), 'modified\n'); await writeFile(path.join(root, 'code.txt'), 'outside\n');
  const head = await git.head(), status = await git.status();
  nativeCommands = ['gitWorkbench.compareFiles.focus', 'views.moveViewUp', 'workbench.scm.toggleVisibility', 'workbench.scm.history.toggleVisibility', 'gitWorkbench.compareFiles.toggleVisibility'];
  await commands.get('gitWorkbench.explorer.diff')!(Uri.file(path.join(root, 'folder')));
  assert.equal(errors.length, 0, 'missing generated focus commands must not block opening the tree');
  assert.equal(logViews.length, 0, 'directory comparison must not replace the terminal-side commit tree');
  assert.equal(panels.length, 0, 'comparison must not create a custom diff webview');
  assert.ok(executed.includes('workbench.view.scm'));
  assert.equal(executed.includes('vscode.diff'), true, 'open the initial native comparison tab');
  assert.match(tabs[0].label, /^对比 · /);
  const nodes = comparisonProvider!.getChildren();
  assert.equal(comparisonTreeState.message, undefined, 'loaded trees have no fixed message row covering their scroll area');
  assert.equal(executed.filter(command => command === 'views.moveViewUp').length, 3);
  assert.ok(executed.indexOf('gitWorkbench.compareFiles.focus') < executed.indexOf('views.moveViewUp'));
  assert.equal(executed.includes('workbench.scm.toggleVisibility'), false, 'keep changes and graph visible');
  assert.equal(nodes[0].name, 'folder');
  const nestedNode = comparisonProvider!.getChildren(nodes[0])[0];
  assert.equal(nestedNode.name, 'nested');
  assert.equal(comparisonProvider!.getTreeItem(nestedNode).collapsibleState, 1, 'deep folders start collapsed to limit initial scroll rows');
  const fileNode = comparisonProvider!.getChildren(nestedNode)[0];
  assert.equal(fileNode.file!.path, 'folder/nested/a.txt');
  assert.deepEqual(comparisonProvider!.getTreeItem(fileNode).command!.arguments, ['folder/nested/a.txt']);
  assert.deepEqual(comparisonProvider!.getChildren(fileNode), []);
  assert.equal(comparisonProvider!.getParent(fileNode), nestedNode);
  assert.equal(comparisonProvider!.getParent(nestedNode), nodes[0]);
  assert.equal(comparisonProvider!.getParent(nodes[0]), undefined);
  assert.equal(treeReveals.at(-1)!.node, nodes[0]);
  assert.deepEqual(treeReveals.at(-1)!.options, { focus: true, select: false, expand: true });
  const manifest = JSON.parse(await readFile(path.resolve(__dirname, '../../package.json'), 'utf8'));
  assert.equal(manifest.contributes.views.scm[0].id, 'gitWorkbench.compareFiles');
  const strings = JSON.parse(await readFile(path.resolve(__dirname, '../../package.nls.zh-cn.json'), 'utf8'));
  assert.equal(strings[manifest.contributes.views.scm[0].name.slice(1, -1)], '对比');
  assert.equal(manifest.contributes.views.scm[0].when, 'gitWorkbench.comparisonActive');
  assert.equal(manifest.contributes.views.scm[0].visibility, 'collapsed');
  assert.equal(comparisonProvider!.getTreeItem(nodes[0]).description, undefined);
  assert.equal(comparisonProvider!.getTreeItem(fileNode).tooltip, '');
  assert.match(comparisonTreeState.description, /↔ 工作区/);
  assert.equal(manifest.contributes.viewsContainers.activitybar, undefined);
  await commands.get('gitWorkbench.compare.select')!('folder/nested/a.txt');
  assert.equal(executed.at(-1), 'vscode.diff');
  const [left, right, , options] = commandArgs.at(-1)! as [Uri, Uri, string, unknown];
  assert.equal(await revisionProvider.provideTextDocumentContent(left), 'base\n');
  assert.equal(right.fsPath, path.join((await Git.discover(root)).root, 'folder/nested/a.txt'));
  assert.deepEqual(options, { preview: true, preserveFocus: true });
  await commands.get('gitWorkbench.compare.select')!('code.txt');
  assert.ok(errors.some(error => error.includes('目录树'))); errors.length = 0;
  await commands.get('gitWorkbench.compare.select')!('../outside.txt');
  assert.ok(errors.some(error => error.includes('目录树'))); errors.length = 0;
  assert.equal(await git.head(), head); assert.deepEqual(await git.status(), status);
}));

test('SCM comparison delegates additions, deletion, rename and binary files to the native editor and refreshes its scope', async () => fixture(async (git, root) => {
  await mkdir(path.join(root, 'folder')); await writeFile(path.join(root, 'folder/deleted.txt'), 'old\n');
  await writeFile(path.join(root, 'folder/old.txt'), 'rename\n');
  await git.mutate(['add', '-A']); await git.mutate(['commit', '-m', 'Directory baseline']);
  await git.mutate(['mv', 'folder/old.txt', 'folder/renamed.txt']);
  await rm(path.join(root, 'folder/deleted.txt')); await writeFile(path.join(root, 'folder/new.txt'), '<script>literal text</script>\n');
  await writeFile(path.join(root, 'folder/binary.dat'), Buffer.from([0, 1, 2]));
  await commands.get('gitWorkbench.explorer.diff')!(Uri.file(path.join(root, 'folder')));
  await commands.get('gitWorkbench.compare.select')!('folder/new.txt');
  assert.equal(await revisionProvider.provideTextDocumentContent(commandArgs.at(-1)![0] as Uri), '');
  await commands.get('gitWorkbench.compare.select')!('folder/deleted.txt');
  assert.equal(await revisionProvider.provideTextDocumentContent(commandArgs.at(-1)![1] as Uri), '');
  await commands.get('gitWorkbench.compare.select')!('folder/renamed.txt');
  assert.equal(await revisionProvider.provideTextDocumentContent(commandArgs.at(-1)![0] as Uri), 'rename\n');
  await commands.get('gitWorkbench.compare.select')!('folder/binary.dat');
  assert.equal(executed.at(-1), 'vscode.diff', 'native editor handles unsupported text previews');
  await rm(path.join(root, 'folder/new.txt')); await commands.get('gitWorkbench.compare.refresh')!();
  assert.equal(comparisonProvider!.getChildren(comparisonProvider!.getChildren()[0]).some(file => file.file?.path === 'folder/new.txt'), false);
  inputQueue.push('renamed'); await commands.get('gitWorkbench.compare.search')!();
  assert.deepEqual(comparisonProvider!.getChildren(comparisonProvider!.getChildren()[0]).map(file => file.file?.path), ['folder/renamed.txt']);
  assert.equal(panels.length, 0);
  assert.equal(await readFile(path.join(root, 'folder/binary.dat')).then(buffer => buffer[0]), 0);
  assert.deepEqual(errors, []);
}));

test('comparison view and sort preferences rebuild the same SCM tree, retain paths and survive reactivation', async () => fixture(async (git, root) => {
  await mkdir(path.join(root, 'folder/a'), { recursive: true }); await mkdir(path.join(root, 'folder/z'));
  await writeFile(path.join(root, 'folder/a/z.txt'), 'old\n');
  await git.mutate(['add', '-A']); await git.mutate(['commit', '-m', 'Nested baseline']);
  await writeFile(path.join(root, 'folder/a/z.txt'), 'changed\n');
  await writeFile(path.join(root, 'folder/z/a.txt'), 'new\n');
  await commands.get('gitWorkbench.explorer.diff')!(Uri.file(path.join(root, 'folder')));
  let roots = comparisonProvider!.getChildren();
  assert.equal(roots[0].name, 'folder');
  assert.equal(comparisonProvider!.getTreeItem(roots[0]).collapsibleState, 2);
  assert.deepEqual(comparisonProvider!.getChildren(roots[0]).map(node => node.name), ['a', 'z']);
  await commands.get('gitWorkbench.compare.viewList')!();
  roots = comparisonProvider!.getChildren();
  assert.deepEqual(roots.map(node => node.file!.path), ['folder/a/z.txt', 'folder/z/a.txt']);
  assert.match(comparisonProvider!.getTreeItem(roots[0]).description!, /folder\/a/);
  assert.equal(comparisonProvider!.getParent(roots[0]), undefined);
  await commands.get('gitWorkbench.compare.sort.name')!();
  assert.deepEqual(comparisonProvider!.getChildren().map(node => node.name), ['a.txt', 'z.txt']);
  await commands.get('gitWorkbench.compare.sort.status')!();
  assert.deepEqual(comparisonProvider!.getChildren().map(node => node.name), ['a.txt', 'z.txt']);
  assert.equal(comparisonSettings.get('comparisonViewMode'), 'list');
  assert.equal(comparisonSettings.get('comparisonSortOrder'), 'status');
  activate({ extensionUri: Uri.file(path.resolve(__dirname, '../..')), subscriptions: [] });
  await commands.get('gitWorkbench.explorer.diff')!(Uri.file(path.join(root, 'folder')));
  assert.deepEqual(comparisonProvider!.getChildren().map(node => node.name), ['a.txt', 'z.txt']);
  // Settings edited outside the view menu take effect immediately too.
  comparisonSettings.set('comparisonViewMode', 'tree');
  configurationListener!({ affectsConfiguration: key => key === 'gitWorkbench.comparisonViewMode' });
  assert.equal(comparisonProvider!.getChildren()[0].name, 'folder');
  assert.equal(comparisonTreeState.message, undefined);
  assert.equal(panels.length, 0); assert.deepEqual(errors, []);
  const manifest = JSON.parse(await readFile(path.resolve(__dirname, '../../package.json'), 'utf8'));
  const menu = manifest.contributes.menus['view/title'] as { command: string; group: string; when: string }[];
  assert.equal(menu.filter(item => item.command.includes('compare.view') || item.command.includes('compare.sort')).length, 5);
  assert.ok(menu.filter(item => item.command.includes('compare.view') || item.command.includes('compare.sort')).every(item => item.when === 'view == gitWorkbench.compareFiles' && !item.group.startsWith('navigation')));
}));

test('comparison file icons use comparison statuses independently of working-tree files and clear decorations on close', async () => fixture(async (git, root) => {
  await mkdir(path.join(root, 'folder'));
  await writeFile(path.join(root, 'folder/deleted.md'), 'deleted\n');
  await writeFile(path.join(root, 'folder/old.go'), 'package old\n');
  await git.mutate(['add', '-A']); await git.mutate(['commit', '-m', 'Icon baseline']);
  await git.mutate(['branch', 'icon-baseline']);
  await git.mutate(['mv', 'folder/old.go', 'folder/重命名.go']);
  await rm(path.join(root, 'folder/deleted.md'));
  await writeFile(path.join(root, 'folder/新增 file.ts'), 'export const amount = 1;\n');
  await writeFile(path.join(root, 'code.txt'), 'committed change\n');
  await git.mutate(['add', '-A']); await git.mutate(['commit', '-m', 'Icon changes']);
  // This file exists again locally, but the selected snapshots still describe a deletion.
  await writeFile(path.join(root, 'folder/deleted.md'), 'local recreation\n');
  const { send } = await branchView(); await send('compare', 'refs/heads/icon-baseline');
  assert.deepEqual(errors, []);
  const leaves = (nodes: ComparisonNode[]): ComparisonNode[] => nodes.flatMap(node => node.file ? [node] : leaves(node.children || []));
  const items = leaves(comparisonProvider!.getChildren()).map(node => comparisonProvider!.getTreeItem(node));
  const statuses = new Map(items.map(item => [path.basename(item.resourceUri!.path), decorationProvider.provideFileDecoration(item.resourceUri!)!.badge]));
  assert.deepEqual(Object.fromEntries(statuses), { 'code.txt': 'M', 'deleted.md': 'D', '新增 file.ts': 'A', '重命名.go': 'R' });
  assert.equal(comparisonProvider!.getTreeItem(comparisonProvider!.getChildren()[0]).iconPath!.id, 'folder');
  for (const item of items) {
    assert.equal(item.iconPath!.id, 'file'); assert.equal(item.description, undefined);
    assert.equal(item.resourceUri!.scheme, 'git-workbench-comparison');
    assert.equal(decorationProvider.provideFileDecoration(Uri.file(item.resourceUri!.path)), undefined, 'never decorate Explorer or live Git resources');
    assert.equal(decorationProvider.provideFileDecoration(item.resourceUri!)!.propagate, true);
    assert.ok(decorationProvider.provideFileDecoration(item.resourceUri!)!.color!.id.startsWith('gitDecoration.'));
  }
  const affected: Uri[] = []; decorationProvider.onDidChangeFileDecorations(uris => affected.push(...uris));
  await commands.get('gitWorkbench.compare.close')!();
  for (const item of items) {
    assert.equal(decorationProvider.provideFileDecoration(item.resourceUri!), undefined);
    assert.ok(affected.some(uri => uri.toString() === item.resourceUri!.toString()));
  }
}));

test('comparison icon styles switch live, persist and retain list paths and native diff selection', async () => fixture(async (git, root) => {
  await mkdir(path.join(root, 'folder')); await writeFile(path.join(root, 'folder/code.ts'), 'before\n');
  await git.mutate(['add', '-A']); await git.mutate(['commit', '-m', 'Icon baseline']);
  await writeFile(path.join(root, 'folder/code.ts'), 'after\n');
  const open = () => commands.get('gitWorkbench.explorer.diff')!(Uri.file(path.join(root, 'folder')));
  await open();
  let node = comparisonProvider!.getChildren()[0].children![0];
  const uri = comparisonProvider!.getTreeItem(node).resourceUri!;
  await commands.get('gitWorkbench.compare.icons.status')!();
  assert.equal(comparisonSettings.get('comparisonIconStyle'), 'status');
  let item = comparisonProvider!.getTreeItem(node);
  assert.equal(item.iconPath!.id, 'diff-modified'); assert.equal(item.resourceUri, undefined);
  assert.equal(item.description, '修改'); assert.equal(decorationProvider.provideFileDecoration(uri), undefined);
  activate({ extensionUri: Uri.file(path.resolve(__dirname, '../..')), subscriptions: [] }); await open();
  node = comparisonProvider!.getChildren()[0].children![0];
  assert.equal(comparisonProvider!.getTreeItem(node).iconPath!.id, 'diff-modified', 'saved choice survives reactivation');
  await commands.get('gitWorkbench.compare.viewList')!();
  await commands.get('gitWorkbench.compare.icons.file')!();
  node = comparisonProvider!.getChildren()[0]; item = comparisonProvider!.getTreeItem(node);
  assert.equal(item.iconPath!.id, 'file'); assert.equal(item.description, 'folder');
  assert.equal(decorationProvider.provideFileDecoration(item.resourceUri!)!.badge, 'M');
  await commands.get('gitWorkbench.compare.select')!(node.file!.path);
  assert.equal(await revisionProvider.provideTextDocumentContent(tabs[0].input.original), 'before\n');
  assert.equal(await realpath(tabs[0].input.modified.fsPath), await realpath(path.join(root, 'folder/code.ts')));
  comparisonSettings.set('comparisonIconStyle', 'status');
  configurationListener!({ affectsConfiguration: key => key === 'gitWorkbench.comparisonIconStyle' });
  assert.equal(comparisonProvider!.getTreeItem(node).description, 'folder · 修改');
  const manifest = JSON.parse(await readFile(path.resolve(__dirname, '../../package.json'), 'utf8'));
  assert.equal(manifest.contributes.configuration.properties['gitWorkbench.comparisonIconStyle'].default, 'file');
  const entries = manifest.contributes.menus['view/title'].filter((entry: { command: string }) => entry.command.includes('compare.icons.'));
  assert.equal(entries.length, 2); assert.ok(entries.every((entry: { when: string; group: string }) => entry.when === 'view == gitWorkbench.compareFiles' && !entry.group.startsWith('navigation')));
  assert.deepEqual(errors, []);
}));

test('comparison starts inactive, opens only on request and can close then reopen without changing SCM sections', async () => fixture(async (_git, root) => {
  const activeValues = () => executed.flatMap((command, index) => command === 'setContext' && commandArgs[index][0] === 'gitWorkbench.comparisonActive' ? [commandArgs[index][1]] : []);
  assert.deepEqual(activeValues(), [false]);
  await writeFile(path.join(root, 'code.txt'), 'working\n');
  await commands.get('gitWorkbench.explorer.diff')!(Uri.file(root));
  assert.deepEqual(activeValues(), [false, true]);
  await commands.get('gitWorkbench.compare.close')!();
  assert.deepEqual(activeValues(), [false, true, false]);
  assert.deepEqual(comparisonProvider!.getChildren(), []);
  await commands.get('gitWorkbench.explorer.diff')!(Uri.file(root));
  assert.deepEqual(activeValues(), [false, true, false, true]);
  assert.equal(executed.some(command => command.endsWith('.toggleVisibility')), false);
  assert.equal(panels.length, 0); assert.deepEqual(errors, []);
}));

test('closing the current native comparison tab hides its tree, while replacing it or closing unrelated tabs does not', async () => fixture(async (_git, root) => {
  await writeFile(path.join(root, 'code.txt'), 'working\n');
  await writeFile(path.join(root, 'other.txt'), 'new\n');
  const activeValues = () => executed.flatMap((command, index) => command === 'setContext' && commandArgs[index][0] === 'gitWorkbench.comparisonActive' ? [commandArgs[index][1]] : []);
  await commands.get('gitWorkbench.explorer.diff')!(Uri.file(root));
  assert.equal(tabs.length, 1);
  await commands.get('gitWorkbench.compare.select')!('other.txt');
  assert.equal(tabs.length, 1, 'file changes replace the comparison preview');
  assert.deepEqual(activeValues(), [false, true], 'replacement tab close must not hide the tree');
  await tabListener!({ closed: [{ input: new TabInputTextDiff(Uri.file('unrelated-left'), Uri.file('unrelated-right')), label: 'Unrelated' }] });
  assert.deepEqual(activeValues(), [false, true]);
  await windowStub.tabGroups.close(tabs[0]);
  assert.deepEqual(activeValues(), [false, true, false]);
  assert.deepEqual(comparisonProvider!.getChildren(), []);
  await commands.get('gitWorkbench.explorer.diff')!(Uri.file(root));
  await commands.get('gitWorkbench.compare.close')!();
  assert.equal(tabs.length, 0, 'the close menu also closes the owned comparison tab');
  assert.deepEqual(errors, []);
}));

test('empty directory comparisons open an empty tracked native comparison tab', async () => fixture(async (_git, root) => {
  nativeCommands = [];
  await commands.get('gitWorkbench.explorer.diff')!(Uri.file(root));
  assert.deepEqual(comparisonProvider!.getChildren(), []);
  assert.equal(treeReveals.at(-1)!.node, undefined);
  assert.equal(comparisonTreeState.message, '所选范围没有差异。');
  assert.ok(executed.includes('workbench.view.scm'));
  assert.equal(executed.includes('vscode.diff'), true);
  assert.equal(await revisionProvider.provideTextDocumentContent(tabs[0].input.original), '');
  assert.equal(await revisionProvider.provideTextDocumentContent(tabs[0].input.modified), '');
  assert.match(tabs[0].label, /对比 · 无变更/);
  assert.equal(panels.length, 0);
  assert.deepEqual(errors, []);
}));

test('nested project root uses its own repository instead of its parent or the active editor', async () => fixture(async (_git, root) => {
  const nested = path.join(root, 'nested'); await mkdir(nested); const git = new Git(nested);
  await git.run(['init', '-b', 'nested']);
  await commands.get('gitWorkbench.explorer.history')!(Uri.file(nested));
  const view = logViews[0]; await view.listener!({ type: 'init' });
  assert.equal(view.messages.filter(message => message.type === 'snapshot').at(-1)!.data!.root, (await Git.discover(nested)).root);
  assert.deepEqual(errors, []);
}));

test('cancelled directory writes and untrusted command invocation do not mutate the repository', async () => fixture(async (git, root) => {
  await writeFile(path.join(root, 'code.txt'), 'modified\n'); const before = await git.status();
  await commands.get('gitWorkbench.explorer.add')!(Uri.file(root));
  assert.equal(warnings.length, 1); assert.deepEqual(await git.status(), before);
  vscodeStub.workspace.isTrusted = false;
  try { await commands.get('gitWorkbench.explorer.rollback')!(Uri.file(root)); }
  finally { vscodeStub.workspace.isTrusted = true; }
  assert.ok(errors.some(error => error.includes('信任'))); assert.deepEqual(await git.status(), before);
  assert.equal(await readFile(path.join(root, 'code.txt'), 'utf8'), 'modified\n');
}));

async function branchView() {
  await commands.get('gitWorkbench.open')!(); const view = logViews[0];
  await view.listener!({ type: 'init' });
  const snapshot = view.messages.filter(message => message.type === 'snapshot').at(-1)!.data!;
  return { view, send: (action: string, ref: string) => view.listener!({ type: 'branchAction', repoRoot: snapshot.root, action, ref }) };
}
function comparisonFiles(nodes = comparisonProvider!.getChildren()): string[] {
  return nodes.flatMap(node => node.file ? [node.file.path] : comparisonFiles(node.children || []));
}

test('branch comparisons cover the whole project despite path filters and distinguish snapshots from working files', async () => fixture(async (git, root) => {
  await git.mutate(['branch', 'old', 'HEAD~1']);
  await mkdir(path.join(root, 'folder')); await writeFile(path.join(root, 'folder/only-working.txt'), 'new file\n');
  await writeFile(path.join(root, 'code.txt'), 'uncommitted\n');
  const { view, send } = await branchView();
  const repoRoot = view.messages.find(message => message.type === 'snapshot')!.data!.root;
  await view.listener!({ type: 'filters', repoRoot, filters: { path: 'folder' } });
  const status = await git.status(), head = await git.head();
  await send('compare', 'refs/heads/old');
  assert.deepEqual(errors, []);
  assert.deepEqual(comparisonFiles(), ['code.txt']);
  assert.equal(await revisionProvider.provideTextDocumentContent(tabs[0].input.original), 'before\ncontext\n');
  assert.equal(await revisionProvider.provideTextDocumentContent(tabs[0].input.modified), 'after\ncontext\n');
  assert.match(comparisonTreeState.description, /old ↔ HEAD/);
  await send('workingDiff', 'refs/heads/old');
  assert.deepEqual(comparisonFiles().sort(), ['code.txt', 'folder/only-working.txt']);
  await commands.get('gitWorkbench.compare.select')!('code.txt');
  assert.equal(tabs[0].input.modified.scheme, 'file');
  assert.equal(await readFile(tabs[0].input.modified.fsPath, 'utf8'), 'uncommitted\n');
  assert.equal(await git.head(), head); assert.deepEqual(await git.status(), status);
  await windowStub.tabGroups.close(tabs[0]); assert.deepEqual(comparisonFiles(), []);
}));

test('branch menu writes target the selected local branch for create rename delete and checkout', async () => fixture(async (git) => {
  await git.mutate(['branch', 'old', 'HEAD~1']);
  const { send } = await branchView(), head = await git.head();
  inputQueue.push('created'); warningQueue.push('执行'); await send('create', 'refs/heads/old');
  assert.equal((await git.run(['rev-parse', 'created'])).trim(), (await git.run(['rev-parse', 'old'])).trim());
  inputQueue.push('renamed'); warningQueue.push('执行'); await send('rename', 'refs/heads/created');
  assert.equal((await git.state()).branch, 'main');
  warningQueue.push('执行'); await send('delete', 'refs/heads/renamed');
  assert.equal((await git.refs()).some(ref => ref.name === 'renamed'), false);
  warningQueue.push('执行'); await send('checkout', 'refs/heads/old');
  assert.equal((await git.state()).branch, 'old'); assert.notEqual(await git.head(), head);
  assert.deepEqual(errors, []);
}));

async function divergentBranch(git: Git, root: string) {
  await git.mutate(['switch', '-c', 'feature', 'HEAD~1']);
  await writeFile(path.join(root, 'feature.txt'), 'feature\n');
  await git.mutate(['add', '-A']); await git.mutate(['commit', '-m', 'Feature change']);
  const feature = (await git.head())!; await git.mutate(['switch', 'main']); return feature;
}
for (const action of ['merge', 'rebase', 'checkoutRebase']) test(`branch ${action} uses the displayed direction`, async () => fixture(async (git, root) => {
  const feature = await divergentBranch(git, root), main = (await git.head())!;
  const { send } = await branchView(); warningQueue.push('执行'); await send(action, 'refs/heads/feature');
  assert.deepEqual(errors, []);
  assert.equal((await git.state()).branch, action === 'checkoutRebase' ? 'feature' : 'main');
  if (action === 'checkoutRebase') {
    assert.equal((await git.run(['merge-base', 'HEAD', main])).trim(), main);
    assert.equal((await git.run(['rev-parse', 'main'])).trim(), main);
  } else {
    assert.equal((await git.run(['merge-base', 'HEAD', feature])).trim(), feature);
    assert.equal((await git.run(['rev-parse', 'feature'])).trim(), feature);
  }
  assert.equal(await readFile(path.join(root, 'feature.txt'), 'utf8'), 'feature\n');
  assert.equal(await readFile(path.join(root, 'code.txt'), 'utf8'), 'after\ncontext\n');
}));

test('branch push uses the selected source and update fast-forwards a non-current branch without checkout', async () => fixture(async (git) => {
  const remoteRoot = await mkdtemp(path.join(tmpdir(), 'git-workbench-remote-'));
  try {
    const remote = new Git(remoteRoot); await remote.run(['init', '--bare']);
    await git.mutate(['branch', 'old', 'HEAD~1']); await git.mutate(['remote', 'add', 'origin', remoteRoot]);
    const { send } = await branchView();
    pickQueue.push('origin'); inputQueue.push('published'); warningQueue.push('执行'); await send('push', 'refs/heads/old');
    assert.equal((await remote.run(['rev-parse', 'refs/heads/published'])).trim(), (await git.run(['rev-parse', 'old'])).trim());
    assert.notEqual((await remote.run(['rev-parse', 'refs/heads/published'])).trim(), await git.head());
    await git.mutate(['push', 'origin', 'HEAD:refs/heads/published']);
    const head = await git.head(); warningQueue.push('执行'); await send('update', 'refs/heads/old');
    assert.equal((await git.run(['rev-parse', 'old'])).trim(), head);
    assert.equal((await git.state()).branch, 'main'); assert.equal(await git.head(), head);
    assert.deepEqual(errors, []);
  } finally { await rm(remoteRoot, { recursive: true, force: true }); }
}));

test('branch operations reject stale or forged refs, respect cancellation and block dirty checkout-rebase', async () => fixture(async (git, root) => {
  await git.mutate(['branch', 'old', 'HEAD~1']);
  const { view, send } = await branchView(), head = await git.head();
  await send('merge', 'refs/heads/old'); assert.equal(await git.head(), head, 'cancel is read-only');
  assert.match(warnings.at(-1)!, /old.*main/);
  await writeFile(path.join(root, 'code.txt'), 'dirty\n');
  await send('checkoutRebase', 'refs/heads/old'); assert.match(errors.at(-1)!, /提交或 Stash/);
  const count = errors.length;
  await view.listener!({ type: 'branchAction', repoRoot: 'other-repository', action: 'delete', ref: 'refs/heads/old' });
  assert.equal(errors.length, count);
  await send('compare', 'refs/heads/missing'); assert.match(errors.at(-1)!, /存在/);
  await git.mutate(['branch', '-f', 'old', 'HEAD']);
  await send('workingDiff', 'refs/heads/old'); assert.match(errors.at(-1)!, /已改变/);
  assert.equal(tabs.length, 0); assert.equal((await git.state()).branch, 'main');
  assert.equal(await readFile(path.join(root, 'code.txt'), 'utf8'), 'dirty\n');
}));

test('branch writes reject an external checkout even when both branches point to the same HEAD', async () => fixture(async (git) => {
  await git.mutate(['branch', 'other']); const { send } = await branchView();
  await git.mutate(['switch', 'other']); inputQueue.push('unexpected'); warningQueue.push('执行');
  await send('rename', 'refs/heads/main');
  assert.match(errors.at(-1)!, /当前分支或 HEAD 已改变/);
  assert.equal(warnings.length, 0); assert.equal((await git.state()).branch, 'other');
  assert.equal((await git.refs()).some(ref => ref.name === 'main'), true);
  assert.equal((await git.refs()).some(ref => ref.name === 'unexpected'), false);
}));

async function multipleRepositories(root: string) {
  const other = path.join(root, 'other-repository'); await mkdir(other); await new Git(other).run(['init', '-b', 'other']);
  vscodeStub.workspace.workspaceFolders = [{ uri: Uri.file(root) }, { uri: Uri.file(other) }];
}

test('cancelling repository selection from registered commands exits without error', async () => fixture(async (_git, root) => {
  await multipleRepositories(root);
  await commands.get('gitWorkbench.open')!();
  await commands.get('gitWorkbench.operations')!();
  assert.equal(pickerCalls, 2); assert.equal(logViews.length, 0);
  assert.deepEqual(errors, []); assert.deepEqual(warnings, []);
}));

test('cancelling a repository switch preserves current graph and can be retried', async () => fixture(async (git, root) => {
  const { view } = await branchView(); await multipleRepositories(root);
  const before = [...view.messages], head = await git.head();
  await view.listener!({ type: 'repo' });
  assert.deepEqual(errors, []); assert.deepEqual(view.messages, before, 'no error banner, reset or loading changes on cancel');
  assert.equal(await git.head(), head);
  pickQueue.push({ git }); await view.listener!({ type: 'repo' });
  assert.ok(view.messages.length > before.length); assert.equal(view.messages.some(message => message.type === 'error'), false);
  assert.equal(view.messages.filter(message => message.type === 'snapshot').at(-1)!.data!.root, git.root);
}));

test('cancelling folder selection is silent in commands and initial log loading', async () => fixture(async () => {
  windowStub.activeTextEditor = undefined;
  await commands.get('gitWorkbench.open')!();
  await commands.get('gitWorkbench.operations')!();
  await vscodeStub.commands.executeCommand('gitWorkbench.log.focus');
  await logViews[0].listener!({ type: 'init' });
  assert.equal(folderPickerCalls, 3); assert.deepEqual(errors, []);
  assert.equal(logViews[0].messages.some(message => message.type === 'error'), false);
}));

test('invalid folder selection still reports real Git discovery errors', async () => fixture(async () => {
  windowStub.activeTextEditor = undefined;
  const nonRepository = await mkdtemp(path.join(tmpdir(), 'git-workbench-not-repo-'));
  try {
    folderQueue.push([Uri.file(nonRepository)]); await commands.get('gitWorkbench.open')!();
    assert.equal(errors.length, 1); assert.match(errors[0], /Git Workbench:/);
  } finally { await rm(nonRepository, { recursive: true, force: true }); }
}));


test('English application locale localizes menus and confirmations without changing branch names', async () => fixture(async git => {
  await commands.get('gitWorkbench.menu')!();
  assert.ok(quickPicks[0].labels.includes('$(history) History and blame'));
  pickQueue.push({ label: 'Branches', ids: ['branchCreate'] }, { id: 'branchCreate' });
  inputQueue.push('功能/支付'); warningQueue.push('Run');
  await commands.get('gitWorkbench.operations')!();
  assert.deepEqual(errors, []);
  assert.match(warnings[0], /Create branch 功能\/支付 from [a-f0-9]+/);
  assert.deepEqual(confirmationButtons[0], ['Run']);
  assert.equal((await git.refs()).some(ref => ref.name === '功能/支付'), true);
  assert.equal(quickPicks.at(-2)?.title, 'Git Workbench · Repository Git operations');
}, 'en-US'));

test('English graph and history bootstrap preserve repository text and localized dirty-selection notices', async () => fixture(async (git, root) => {
  await writeFile(path.join(root, 'code.txt'), '中文代码\ncontext\n'); await git.mutate(['commit', '-am', '修复配置']);
  await commands.get('gitWorkbench.open')!();
  assert.match(logViews[0].webview.html, /lang="en"/);
  assert.match(logViews[0].webview.html, /window.gitWorkbenchLanguage="en"/);
  assert.ok(logViews[0].webview.html.indexOf('i18n.js') < logViews[0].webview.html.indexOf('workbench.js'));
  await commands.get('gitWorkbench.fileHistory')!(); await panels[0].listener!({ type: 'init' });
  assert.match(panels[0].webview.html, /lang="en"/);
  const entries = panels[0].messages.find(message => message.type === 'history')!.data!.entries as { subject: string }[];
  assert.equal(entries[0].subject, '修复配置');
  const details = await git.lineHistoryDetails('code.txt', 1, 1, '本地改动\ncontext\n');
  assert.match(details.notice!, /^Selection lines 1–1 map to/);
  assert.ok(details.entries.some(entry => entry.subject === '修复配置'));
}, 'en'));

test('unsupported UI languages fall back to English host errors', async () => fixture(async () => {
  windowStub.activeTextEditor = undefined;
  await commands.get('gitWorkbench.fileHistory')!();
  assert.deepEqual(errors, ['Git Workbench: Open a repository file in the editor first.']);
}, 'fr'));

async function stashView() {
  await commands.get('gitWorkbench.open')!();
  const view = logViews[0]; await view.listener!({ type: 'init' });
  const snapshot = view.messages.filter(message => message.type === 'snapshot').at(-1)!.data!;
  const entries = snapshot.stashes as { ref: string; hash: string; subject: string }[];
  const entry = entries[0];
  const send = (type: string, extra: Record<string, unknown> = {}) => view.listener!({ type, repoRoot: snapshot.root, token: snapshot.stashToken, ...entry, ...extra });
  return { view, snapshot, entry, send };
}

test('stash panel selects its file tree and opens immutable native preview and pinned diffs', async () => fixture(async (git, root) => {
  await writeFile(path.join(root, 'code.txt'), 'stashed\ncontext\n');
  await mkdir(path.join(root, 'nested')); await writeFile(path.join(root, 'nested/new.txt'), 'new stash file\n');
  await git.mutate(['stash', 'push', '-u', '-m', 'Stash <script> 中文']);
  const before = await git.status(), { view, send } = await stashView();
  assert.match(view.webview.html, /comparisonTree.js/);
  await send('stashSelect');
  const detail = view.messages.filter(message => message.type === 'stashDetail').at(-1)!.data!;
  assert.deepEqual((detail.files as { path: string }[]).map(file => file.path).sort(), ['code.txt', 'nested/new.txt']);
  const files = detail.files as { id: string; path: string }[];
  await send('stashDiff', { fileId: files.find(file => file.path === 'nested/new.txt')!.id });
  let args = commandArgs.at(-1)!;
  assert.equal(args[3] && (args[3] as { preview: boolean }).preview, true);
  assert.equal(await revisionProvider.provideTextDocumentContent(args[0] as Uri), '');
  assert.equal(await revisionProvider.provideTextDocumentContent(args[1] as Uri), 'new stash file\n');
  await send('stashDiff', { fileId: files.find(file => file.path === 'code.txt')!.id, newTab: true }); args = commandArgs.at(-1)!;
  assert.deepEqual(args[3], { preview: false });
  assert.equal(await revisionProvider.provideTextDocumentContent(args[0] as Uri), 'after\ncontext\n');
  assert.equal(await revisionProvider.provideTextDocumentContent(args[1] as Uri), 'stashed\ncontext\n');
  const count = executed.length;
  await send('stashDiff', { fileId: '../../outside' });
  await send('stashAction', { action: 'drop', token: 'stale-token' });
  await send('stashAction', { action: 'drop', repoRoot: 'other-repository' });
  assert.equal(executed.length, count); assert.equal(warnings.length, 0);
  assert.deepEqual(await git.status(), before); assert.deepEqual(errors, []);
}));

test('stash actions respect cancellation and reject list changes during confirmation', async () => fixture(async (git, root) => {
  await writeFile(path.join(root, 'code.txt'), 'stashed\n'); await git.mutate(['stash', 'push', '-m', 'original']);
  const { send } = await stashView();
  await send('stashAction', { action: 'drop' });
  assert.equal((await git.run(['stash', 'list'])).trim().split('\n').length, 1);
  // Refresh issues a fresh token, so reacquire the current view snapshot.
  const snapshot = logViews[0].messages.filter(message => message.type === 'snapshot').at(-1)!.data!;
  warningQueue.push(async () => { await writeFile(path.join(root, 'code.txt'), 'external stash\n'); await git.mutate(['stash', 'push', '-m', 'external']); return '执行'; });
  await logViews[0].listener!({ type: 'stashAction', repoRoot: snapshot.root, token: snapshot.stashToken, ...(snapshot.stashes as object[])[0], action: 'drop' });
  assert.match(errors.at(-1)!, /列表已改变/);
  assert.equal((await git.run(['stash', 'list'])).trim().split('\n').length, 2);
  assert.deepEqual(await git.status(), []);
}));

test('Unstash restores the index through explicit options and retains the stash', async () => fixture(async (git, root) => {
  await writeFile(path.join(root, 'code.txt'), 'staged stash\n'); await git.mutate(['add', '-A']);
  await git.mutate(['stash', 'push', '-m', 'staged']);
  const { send } = await stashView();
  pickQueue.push({ label: '恢复暂存状态并保留 Stash', mode: 'apply', index: true }); warningQueue.push('执行');
  await send('stashAction', { action: 'unstash' });
  assert.equal((await git.status())[0].index, 'M');
  assert.ok((await git.run(['stash', 'list'])).includes('staged'));
  assert.deepEqual(errors, []);
}));

test('Unstash new-branch recovery confirms its original-base direction and refuses a dirty working tree', async () => fixture(async (git, root) => {
  await writeFile(path.join(root, 'code.txt'), 'saved branch content\n'); await git.mutate(['add', '-A']);
  await git.mutate(['stash', 'push', '-m', 'branch recovery']);
  const { send, snapshot } = await stashView();
  await writeFile(path.join(root, 'code.txt'), 'local work\n');
  pickQueue.push({ label: '恢复到新分支', mode: 'apply', index: true, branch: true }); inputQueue.push('rescue'); warningQueue.push('执行');
  await send('stashAction', { action: 'unstash' });
  assert.match(errors.at(-1)!, /当前工作区的改动/);
  assert.equal((await git.refs()).some(ref => ref.name === 'rescue'), false);
  assert.equal(await readFile(path.join(root, 'code.txt'), 'utf8'), 'local work\n');
  await git.mutate(['restore', '--worktree', '--', 'code.txt']);
  const fresh = logViews[0].messages.filter(message => message.type === 'snapshot').at(-1)!.data!;
  pickQueue.push({ label: '恢复到新分支', mode: 'apply', index: true, branch: true }); inputQueue.push('rescue'); warningQueue.push('执行');
  await logViews[0].listener!({ type: 'stashAction', repoRoot: snapshot.root, token: fresh.stashToken, ...(fresh.stashes as object[])[0], action: 'unstash' });
  assert.equal((await git.state()).branch, 'rescue'); assert.equal((await git.status())[0].index, 'M');
  assert.match(warnings.at(-1)!, /原始基线.*rescue/);
  assert.ok((await git.run(['stash', 'list'])).includes('branch recovery'));
}));

test('Changes opens native Source Control without repository selection or a custom working-tree action', async () => fixture(async (git, root) => {
  const view = new Panel('gitWorkbench.log');
  viewProvider!.resolveWebviewView(view);
  await view.listener!({ type: 'scm' });
  assert.equal(executed.at(-1), 'workbench.view.scm');
  assert.equal(pickerCalls, 0); assert.equal(folderPickerCalls, 0);
  assert.equal(view.messages.length, 0, 'opening native Changes does not load or refresh a repository');

  await view.listener!({ type: 'init' });
  const snapshot = view.messages.find(message => message.type === 'snapshot')!.data!;
  await writeFile(path.join(root, 'code.txt'), 'local work to preserve\n');
  const before = await git.status(), index = await git.run(['ls-files', '--stage', '-z']);
  for (const action of ['stage', 'unstage', 'discard', 'diff']) {
    await view.listener!({ type: 'working', repoRoot: snapshot.root, action, path: 'code.txt', area: 'worktree' });
  }
  assert.deepEqual(await git.status(), before);
  assert.equal(await git.run(['ls-files', '--stage', '-z']), index);
  assert.equal(await readFile(path.join(root, 'code.txt'), 'utf8'), 'local work to preserve\n');
  assert.equal(executed.filter(id => id === 'vscode.diff').length, 0);
  assert.equal(warnings.length, 0); assert.deepEqual(errors, []);
}));

test('external stash creation automatically updates an already visible Stash list', async () => fixture(async (git, root) => {
  await commands.get('gitWorkbench.open')!();
  const view = logViews[0];
  await view.listener!({ type: 'init' });
  const update = nextMessage(view, 'stashes');
  await writeFile(path.join(root, 'code.txt'), 'created through native Source Control\n');
  await git.mutate(['stash', 'push', '-m', 'Native SCM stash']);
  const message = await update;
  assert.equal(message.data!.root, await realpath(git.root));
  assert.match((message.data!.entries as { subject: string }[])[0].subject, /Native SCM stash/);
}));

test('external stash drop, pop, clear and creation after clear refresh without rebuilding the commit graph', async () => fixture(async (git, root) => {
  await writeFile(path.join(root, 'code.txt'), 'first stash\n');
  await git.mutate(['stash', 'push', '-m', 'first']);
  await writeFile(path.join(root, 'code.txt'), 'second stash\n');
  await git.mutate(['stash', 'push', '-m', 'second']);
  const { view } = await stashView();
  const snapshots = view.messages.filter(message => message.type === 'snapshot').length;
  const head = await git.run(['rev-parse', 'refs/stash']);
  let update = nextMessage(view, 'stashes');
  await git.mutate(['stash', 'drop', 'stash@{1}']); // Only the reflog changes; refs/stash stays identical.
  assert.equal((await update).data!.entries instanceof Array, true);
  assert.equal(await git.run(['rev-parse', 'refs/stash']), head);
  update = nextMessage(view, 'stashes');
  await git.mutate(['stash', 'pop']);
  assert.deepEqual((await update).data!.entries, []);
  update = nextMessage(view, 'stashes');
  await git.mutate(['stash', 'push', '-m', 'recreated']);
  assert.equal(((await update).data!.entries as unknown[]).length, 1);
  update = nextMessage(view, 'stashes');
  await git.mutate(['stash', 'clear']);
  assert.deepEqual((await update).data!.entries, []);
  update = nextMessage(view, 'stashes');
  await writeFile(path.join(root, 'code.txt'), 'after clear\n');
  await git.mutate(['stash', 'push', '-m', 'after clear']);
  assert.match(((await update).data!.entries as { subject: string }[])[0].subject, /after clear/);
  assert.equal(view.messages.filter(message => message.type === 'snapshot').length, snapshots);
  assert.deepEqual(errors, []);
}));

test('linked worktree observes Stashes created from the shared main repository', async () => fixture(async (git, root) => {
  const linked = path.join(root, 'linked-worktree');
  await git.mutate(['worktree', 'add', '-b', 'linked', linked]);
  windowStub.activeTextEditor = { document: { uri: Uri.file(path.join(linked, 'code.txt')) } };
  await commands.get('gitWorkbench.open')!();
  const view = logViews[0];
  const update = nextMessage(view, 'stashes');
  await writeFile(path.join(root, 'code.txt'), 'main repository stash\n');
  await git.mutate(['stash', 'push', '-m', 'shared stash']);
  const data = (await update).data!;
  assert.equal(data.root, await realpath(linked));
  assert.match((data.entries as { subject: string }[])[0].subject, /shared stash/);
}));

test('hidden Stash panel catches up when shown and unchanged focus or tab checks preserve its detail token', async () => fixture(async (git, root) => {
  await commands.get('gitWorkbench.open')!();
  const view = logViews[0];
  view.visible = false;
  await writeFile(path.join(root, 'code.txt'), 'stash while hidden\n');
  await git.mutate(['stash', 'push', '-m', 'hidden stash']);
  await new Promise(resolve => setTimeout(resolve, 240));
  assert.equal(view.messages.some(message => message.type === 'stashes'), false);
  const update = nextMessage(view, 'stashes');
  view.visible = true; view.visibilityListeners.forEach(listener => listener());
  const data = (await update).data!;
  const entry = (data.entries as Record<string, unknown>[])[0];
  await view.listener!({ type: 'stashSelect', repoRoot: data.root, token: data.token, ...entry });
  assert.ok(view.messages.some(message => message.type === 'stashDetail'));
  const count = view.messages.length;
  windowStateListeners.forEach(listener => listener({ focused: true }));
  await view.listener!({ type: 'stashRefresh', repoRoot: data.root });
  await new Promise(resolve => setTimeout(resolve, 280));
  assert.equal(view.messages.length, count, 'unchanged list must keep the current token and selected file detail');
  await view.listener!({ type: 'stashDiff', repoRoot: data.root, token: data.token, ...entry, fileId: 'worktree:code.txt' });
  assert.equal(executed.at(-1), 'vscode.diff');
}));

test('disposed Git panel stops Stash notifications and a reopened panel resumes monitoring', async () => fixture(async (git, root) => {
  await commands.get('gitWorkbench.open')!();
  const old = logViews[0]; old.dispose();
  await writeFile(path.join(root, 'code.txt'), 'after disposal\n');
  await git.mutate(['stash', 'push', '-m', 'after disposal']);
  await commands.get('gitWorkbench.open')!();
  const view = logViews[1];
  assert.ok(view.messages.some(message => message.type === 'snapshot' && (message.data!.stashes as unknown[]).length === 1));
  const update = nextMessage(view, 'stashes');
  await git.mutate(['stash', 'clear']);
  assert.deepEqual((await update).data!.entries, []);
  assert.equal(old.messages.some(message => message.type === 'stashes'), false);
}));
