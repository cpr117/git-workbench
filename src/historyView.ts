import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Commit, Git, assertHash } from './git';
import { historySnapshot, offsetPatch, selectionDiff } from './historyDiff';
import { HistorySurface, openHistoryPopup } from './historyPopup';

let activePopup: HistorySurface | undefined;

export interface HistoryItem extends Commit { patch?: string; file?: string; }

export async function openHistoryView(
  context: vscode.ExtensionContext, git: Git, entries: HistoryItem[], file: string,
  range: { start: number; end: number; notice?: string } | undefined,
  openCommit: (git: Git, hash: string) => Promise<void>,
  options: { presentation?: 'popup' | 'editor'; hashes?: string[] } = {},
): Promise<void> {
  if (!entries.length) { void vscode.window.showInformationMessage('没有找到历史记录。'); return; }
  const title = range ? `选区历史 · ${path.basename(file)}:${range.start}–${range.end}` : `文件历史 · ${path.basename(file)}`;
  const presentation = options.presentation ?? vscode.workspace.getConfiguration('gitWorkbench').get<string>('historyPresentation', 'popup');
  let panel: HistorySurface;
  if (presentation === 'popup') {
    if (process.platform !== 'darwin' || vscode.env.remoteName) throw new Error('原生历史小窗当前支持 macOS 本地工作区。需要标签页时可显式设置 gitWorkbench.historyPresentation 为 editor。');
    panel = await openHistoryPopup(context.extensionUri.fsPath, title, vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight, message => { void vscode.window.showErrorMessage(`Git Workbench: ${message}`); });
    activePopup?.dispose();
    activePopup = panel;
    panel.onDidDispose(() => { if (activePopup === panel) activePopup = undefined; });
  } else {
    const editor = vscode.window.createWebviewPanel('gitWorkbench.selectionHistory', title, vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    const nonce = randomBytes(18).toString('hex');
    const resource = (name: string) => editor.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', name));
    editor.webview.html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${editor.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${resource('history.css')}"><title>Git History</title></head><body><div id="app"></div><script nonce="${nonce}" src="${resource('selection.js')}"></script><script nonce="${nonce}" src="${resource('history.js')}"></script></body></html>`;
    panel = { popup: false, webview: editor.webview, onDidDispose: listener => editor.onDidDispose(listener), dispose: () => editor.dispose() };
  }
  context.subscriptions.push(panel);
  let generation = 0, disposed = false, switching = false;
  const send = async (type: string, data: unknown) => { if (!disposed) await panel.webview.postMessage({ type, data }); };
  const show = async (hash: string) => {
    const ticket = ++generation;
    const entry = entries.find(item => item.hash === assertHash(hash));
    if (!entry) throw new Error('请选择列表中的提交。');
    await send('loading', { hash });
    const patch = entry.patch ?? await git.filePatch(entry.hash, entry.file || file);
    if (ticket !== generation || disposed) return;
    await send('historyDetail', { hash, subject: entry.subject, author: entry.author, date: entry.date, parent: entry.parents[0], patch, rows: selectionDiff(patch) });
  };
  const showMany = async (values: unknown) => {
    if (!Array.isArray(values) || !values.length || values.length > 300) throw new Error('请选中 1–300 个历史版本。');
    const hashes = new Set(values.map(hash => assertHash(String(hash))));
    const chosen = entries.filter(entry => hashes.has(entry.hash));
    if (chosen.length !== hashes.size) throw new Error('请选择列表中的提交。');
    if (chosen.length === 1) { await show(chosen[0].hash); return; }
    const ticket = ++generation;
    await send('loading', {});
    const newest = chosen[0], oldest = chosen.at(-1)!;
    let before: { text: string; offset: number }, after: { text: string; offset: number };
    const base = oldest.parents[0] || await git.emptyTree();
    if (range) {
      before = historySnapshot(oldest.patch ?? await git.filePatch(oldest.hash, oldest.file || file), 'left');
      after = historySnapshot(newest.patch ?? await git.filePatch(newest.hash, newest.file || file), 'right');
    } else {
      const oldFile = oldest.file || file, newFile = newest.file || file;
      const oldChanges = await git.changes(oldest.hash), newChanges = await git.changes(newest.hash);
      const oldChange = oldChanges.files.find(item => item.path === oldFile || item.oldPath === oldFile);
      const newChange = newChanges.files.find(item => item.path === newFile || item.oldPath === newFile);
      before = { text: !oldest.parents.length || oldChange?.status[0] === 'A' ? '' : await git.content(base, oldChange?.oldPath || oldFile), offset: 0 };
      after = { text: newChange?.status[0] === 'D' ? '' : await git.content(newest.hash, newFile), offset: 0 };
    }
    const patch = offsetPatch(await git.textPatch(before.text, after.text), before.offset, after.offset);
    if (ticket !== generation || disposed) return;
    await send('historyDetail', { hash: newest.hash, hashes: chosen.map(entry => entry.hash), comparison: true, base, target: newest.hash, subject: `所选 ${chosen.length} 个提交的区间累计差异（含最旧提交）`, author: '版本区间', date: '', patch, rows: selectionDiff(patch) });
  };
  panel.onDidDispose(() => { disposed = true; generation++; });
  panel.webview.onDidReceiveMessage(async (message: unknown) => {
    if (!message || typeof message !== 'object' || disposed) return;
    const msg = message as Record<string, unknown>;
    try {
      switch (msg.type) {
        case 'init':
          await send('history', { file, root: git.root, range, presentation, entries: entries.map(({ patch: _patch, file: _file, ...commit }) => commit) });
          if (options.hashes?.length) { await showMany(options.hashes); options = { ...options, hashes: undefined }; break; }
          if (Array.isArray(msg.hashes) && msg.hashes.length > 1) { await showMany(msg.hashes); break; }
          await show(typeof msg.hash === 'string' && entries.some(entry => entry.hash === msg.hash) ? msg.hash : entries[0].hash); break;
        case 'select': if (typeof msg.hash === 'string') await show(msg.hash); break;
        case 'presentation': {
          if (switching || (msg.presentation !== 'popup' && msg.presentation !== 'editor') || msg.presentation === presentation) break;
          if (!Array.isArray(msg.hashes) || !msg.hashes.length || msg.hashes.length > 300) throw new Error('请选中 1–300 个历史版本。');
          const hashes = [...new Set(msg.hashes.map(hash => assertHash(String(hash))))];
          if (hashes.some(hash => !entries.some(entry => entry.hash === hash))) throw new Error('请选择列表中的提交。');
          switching = true;
          try {
            await openHistoryView(context, git, entries, file, range, openCommit, { presentation: msg.presentation, hashes });
            panel.dispose();
          } finally { switching = false; }
          break;
        }
        case 'selectMany': {
          await showMany(msg.hashes);
          break;
        }
        case 'openCommit':
          if (typeof msg.hash === 'string' && entries.some(entry => entry.hash === msg.hash)) { await openCommit(git, assertHash(msg.hash)); if (panel.popup) panel.dispose(); }
          break;
        case 'copy': if (typeof msg.hash === 'string' && entries.some(entry => entry.hash === msg.hash)) await vscode.env.clipboard.writeText(assertHash(msg.hash)); break;
        case 'close': panel.dispose(); break;
      }
    } catch (error) { await send('error', error instanceof Error ? error.message : String(error)); }
  });
}
