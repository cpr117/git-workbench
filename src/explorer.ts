import { t } from './i18n';
import { requireModule } from './modules';
import * as vscode from 'vscode';
import { lstat } from 'node:fs/promises';
import { Git, assertHash, isConflict } from './git';
import { changePaths, commitPaths, excludeScope, inScope, rollbackScope, scopeChanges, scopePaths } from './explorerGit';
import { getActions, confirm, perform } from './operations';

interface Host {
  repository(uri: vscode.Uri): Promise<Git>;
  history(git: Git, scope: string): Promise<void>;
  compare(git: Git, scope: string, base: string, directory: boolean): Promise<void>;
  run(git: Git, title: string, task: () => Promise<void>): Promise<void>;
}
type Register = (id: string, callback: (...args: unknown[]) => Promise<unknown>) => unknown;

async function targetRevision(git: Git, branchesOnly = false): Promise<string | undefined> {
  const refs = (await git.refs()).filter(ref => !branchesOnly || !ref.tag);
  const items = refs.map(ref => ({ label: ref.name, description: ref.tag ? t("标签") : ref.remote ? t("远端分支") : t("本地分支"), hash: ref.hash }));
  if (!branchesOnly) items.unshift({ label: t("输入提交 SHA / 引用…"), description: t("指定目标版本"), hash: '' });
  const pick = await vscode.window.showQuickPick(items, { title: t("Git Workbench · 选择目标版本"), ignoreFocusOut: true });
  if (!pick) return undefined;
  if (pick.hash) return assertHash((await git.run(['rev-parse', '--verify', '--end-of-options', `${pick.hash}^{commit}`])).trim());
  const ref = await vscode.window.showInputBox({ prompt: t("提交 SHA、分支或标签（例如 HEAD~2）"), ignoreFocusOut: true });
  if (!ref?.trim()) return undefined;
  return assertHash((await git.run(['rev-parse', '--verify', '--end-of-options', `${ref.trim()}^{commit}`])).trim());
}

export function registerExplorerCommands(register: Register, host: Host): void {
  const registerPath = (id: string, task: (git: Git, scope: string, directory: boolean) => Promise<void>) => {
    const handler = (fileOnly = false) => async (value: unknown, selected?: unknown) => {
      if (!vscode.workspace.isTrusted) throw new Error(t("请先信任此工作区。"));
      if (!(value instanceof vscode.Uri) || value.scheme !== 'file') throw new Error(t("请在资源管理器中右键文件、文件夹或项目根目录。"));
      const directory = (await lstat(value.fsPath)).isDirectory();
      if ((fileOnly && directory) || (!directory && Array.isArray(selected) && selected.length > 1)) throw new Error(t("请在资源管理器中选择单个文件。"));
      const git = await host.repository(value), scope = git.relative(value.fsPath, true);
      await task(git, scope, directory);
    };
    register(`gitWorkbench.explorer.${id}`, handler());
    if (['commit', 'rollback', 'stash'].includes(id)) register(`gitWorkbench.explorer.file.${id}`, handler(true));
  };
  const runAction = (id: string, action: string) => registerPath(id, git => host.run(git, getActions()[action], () => perform(git, action)));
  registerPath('history', (git, scope) => host.history(git, scope));
  registerPath('diff', async (git, scope, directory) => {
    const head = await git.head();
    if (!head) throw new Error(t("仓库尚无提交，请先暂存或提交新文件。"));
    await host.compare(git, scope, head, directory);
  });
  registerPath('compareRevision', async (git, scope, directory) => {
    const target = await targetRevision(git); if (target) await host.compare(git, scope, target, directory);
  });
  registerPath('compareBranch', async (git, scope, directory) => {
    const target = await targetRevision(git, true); if (target) await host.compare(git, scope, target, directory);
  });
  registerPath('add', (git, scope, directory) => host.run(git, directory ? t("暂存所选目录") : t("暂存所选文件"), async () => {
    const changes = await scopeChanges(git, scope); changePaths(changes, scope);
    if (!changes.length) { void vscode.window.showInformationMessage(t("所选范围没有改动。")); return; }
    if (await confirm(t("暂存 {0} 的全部改动（含新文件和删除）？\n仓库：{1}", scope || t("整个仓库"), git.root))) await git.mutate(['add', '-A', '--', ...scopePaths(git, scope)]);
  }));
  registerPath('commit', (git, scope, directory) => host.run(git, directory ? t("提交所选目录") : t("提交所选文件"), async () => {
    const changes = await scopeChanges(git, scope);
    if (!changes.length) { void vscode.window.showInformationMessage(t("所选范围没有可提交的改动。")); return; }
    if (changes.some(change => isConflict(change.status))) throw new Error(t("请先解决冲突。"));
    if (!directory) changePaths(changes, scope);
    const items = changes.map(change => ({ label: change.path, description: `${change.status}${change.oldPath ? ` · ${change.oldPath} → ${change.path}` : ''}`, picked: true, change }));
    const picked = directory ? await vscode.window.showQuickPick(items, {
      title: t("提交目录：{0}", scope || t("整个仓库")), placeHolder: t("选择要提交的文件；使用文件当前已保存的完整内容，包含未暂存改动"), canPickMany: true, ignoreFocusOut: true,
    }) : items;
    if (!picked?.length) return;
    const files = changePaths(picked.map(item => item.change), scope);
    const message = await vscode.window.showInputBox({ prompt: t("提交信息"), ignoreFocusOut: true }); if (!message?.trim()) return;
    const notice = directory
      ? t("提交 {0} 中选中的 {1} 个文件？\n将暂存并提交这些文件当前已保存的全部改动，所选范围外已暂存内容不纳入提交。未保存内容请先保存。\n仓库：{2}\n\n{3}\n\n{4}", scope || t("整个仓库"), picked.length, git.root, picked.map(item => item.label).join('\n'), message.trim())
      : t("提交文件 {0}？\n将暂存并提交该文件当前已保存的全部改动，其他文件不纳入。未保存内容请先保存。\n仓库：{1}\n\n{2}", scope, git.root, message.trim());
    if (await confirm(notice)) await commitPaths(git, scope, files, message.trim());
  }));
  registerPath('rollback', (git, scope, directory) => host.run(git, directory ? t("回滚所选目录") : t("回滚所选文件"), async () => {
    const changes = await scopeChanges(git, scope); changePaths(changes, scope);
    if (!changes.length) { void vscode.window.showInformationMessage(t("所选范围没有改动。")); return; }
    if (await confirm(t("将 {0} 回滚到 HEAD？\n所选范围内已跟踪文件的暂存和未暂存改动将丢失。新增文件保留，但会取消暂存；范围外不受影响。\n仓库：{1}\n\n{2}", scope || t("整个仓库"), git.root, changes.map(change => change.path).join('\n')))) await rollbackScope(git, scope);
  }));
  registerPath('exclude', (git, scope, directory) => host.run(git, t("本地排除规则"), async () => {
    if (scope && !await confirm(t("将 {0} 加入 .git/info/exclude？\n仅此本地仓库生效，不会忽略已跟踪文件，也不修改 .gitignore。\n仓库：{1}", scope, git.root))) return;
    requireModule('operations');
    const file = await excludeScope(git, scope, directory, () => requireModule('operations'));
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  }));
  for (const [id, action] of [['push', 'push'], ['pull', 'pull'], ['fetch', 'fetch'], ['newBranch', 'branchCreate'], ['newTag', 'tagCreate']]) runAction(id, action);
  for (const action of ['merge', 'rebase', 'reset']) registerPath(action, async git => {
    const hash = await targetRevision(git, action !== 'reset');
    if (hash) await host.run(git, getActions()[action], () => perform(git, action, hash));
  });
  registerPath('branches', async git => {
    const pick = await vscode.window.showQuickPick(['branchSwitch', 'branchCreate', 'branchRename', 'branchDelete'].map(id => ({ label: getActions()[id], id })), { title: t("分支 · {0}", git.root) });
    if (pick) await host.run(git, getActions()[pick.id], () => perform(git, pick.id));
  });
  registerPath('stash', (git, scope, directory) => host.run(git, directory ? t("暂存所选目录到 Stash") : t("暂存所选文件到 Stash"), async () => {
    const changes = await scopeChanges(git, scope); changePaths(changes, scope);
    if (!changes.length) { void vscode.window.showInformationMessage(t("所选范围没有改动。")); return; }
    if ((await git.state()).operation || changes.some(change => isConflict(change.status))) throw new Error(t("请先完成或中止正在进行的 Git 操作并解决冲突。"));
    const message = await vscode.window.showInputBox({ prompt: t("Stash 说明"), value: `Git Workbench · ${scope || t("整个仓库")}`, ignoreFocusOut: true });
    if (!message?.trim()) return;
    if (await confirm(t("将 {0} 的已跟踪及未跟踪改动保存到 Stash？\n范围外的改动不纳入。忽略文件不包括在内。\n仓库：{1}", scope || t("整个仓库"), git.root))) {
      // Git's path-limited stash still records unrelated staged entries in its index parent.
      if (scope && (await git.status()).some(change => change.index !== ' ' && change.index !== '?' && (!inScope(change.path, scope) || !!change.oldPath && !inScope(change.oldPath, scope)))) {
        throw new Error(t("所选范围之外存在已暂存改动，Git 的范围 Stash 会一并保存这些内容。请先取消这些文件的暂存，或从仓库入口保存全部改动。"));
      }
      await git.mutate(['stash', 'push', '--include-untracked', '-m', message.trim(), '--', ...scopePaths(git, scope)]);
    }
  }));
  registerPath('unstash', async git => {
    const pick = await vscode.window.showQuickPick(['stashApply', 'stashPop', 'stashDrop'].map(id => ({ label: getActions()[id], id })), { title: t("所属仓库的 Stash（可能包含其他目录）· {0}", git.root) });
    if (pick) await host.run(git, getActions()[pick.id], () => perform(git, pick.id));
  });
  registerPath('remotes', async git => {
    const pick = await vscode.window.showQuickPick([
      { label: t("查看远端"), id: 'list' }, { label: t("添加远端"), id: 'remoteAdd' }, { label: t("修改远端 URL"), id: 'edit' }, { label: t("移除远端配置"), id: 'remoteRemove' },
    ], { title: t("管理远端 · {0}", git.root) });
    if (!pick) return;
    if (pick.id === 'list') { const remotes = (await git.run(['remote', '-v'])).trim().split('\n').filter(Boolean); await vscode.window.showQuickPick(remotes, { title: t("远端配置") }); return; }
    if (pick.id !== 'edit') { await host.run(git, getActions()[pick.id], () => perform(git, pick.id)); return; }
    const remote = await vscode.window.showQuickPick((await git.run(['remote'])).trim().split('\n').filter(Boolean), { title: t("选择要修改的远端") }); if (!remote) return;
    const url = await vscode.window.showInputBox({ prompt: t("{0} 的新 URL（HTTPS 或 SSH）", remote), ignoreFocusOut: true }); if (!url?.trim()) return;
    if (url.startsWith('-') || /[\r\n\0]/.test(url)) throw new Error(t("无效的远端 URL。"));
    await host.run(git, t("修改远端 URL"), async () => { if (await confirm(t("修改 {0} 的远端 URL？\n仓库：{1}", remote, git.root))) await git.mutate(['remote', 'set-url', remote, url.trim()]); });
  });
  register('gitWorkbench.explorer.clone', async () => {
    if (!vscode.workspace.isTrusted) throw new Error(t("请先信任此工作区。"));
    if (!(await vscode.commands.getCommands(true)).includes('git.clone')) throw new Error(t("当前编辑器未提供 Git Clone，请启用内置 Git 扩展。"));
    await vscode.commands.executeCommand('git.clone');
  });
}
