import * as vscode from 'vscode';
import { lstat } from 'node:fs/promises';
import { Git, assertHash, isConflict } from './git';
import { changePaths, commitPaths, excludeScope, rollbackScope, scopeChanges, scopePaths } from './explorerGit';
import { actions, confirm, perform } from './operations';

interface Host {
  repository(uri: vscode.Uri): Promise<Git>;
  history(git: Git, scope: string): Promise<void>;
  compare(git: Git, scope: string, base: string): Promise<void>;
  run(git: Git, title: string, task: () => Promise<void>): Promise<void>;
}
type Register = (id: string, callback: (...args: unknown[]) => Promise<unknown>) => unknown;

async function targetRevision(git: Git, branchesOnly = false): Promise<string | undefined> {
  const refs = (await git.refs()).filter(ref => !branchesOnly || !ref.tag);
  const items = refs.map(ref => ({ label: ref.name, description: ref.tag ? '标签' : ref.remote ? '远端分支' : '本地分支', hash: ref.hash }));
  if (!branchesOnly) items.unshift({ label: '输入提交 SHA / 引用…', description: '指定目标版本', hash: '' });
  const pick = await vscode.window.showQuickPick(items, { title: 'Git Workbench · 选择目标版本', ignoreFocusOut: true });
  if (!pick) return undefined;
  if (pick.hash) return assertHash((await git.run(['rev-parse', '--verify', '--end-of-options', `${pick.hash}^{commit}`])).trim());
  const ref = await vscode.window.showInputBox({ prompt: '提交 SHA、分支或标签（例如 HEAD~2）', ignoreFocusOut: true });
  if (!ref?.trim()) return undefined;
  return assertHash((await git.run(['rev-parse', '--verify', '--end-of-options', `${ref.trim()}^{commit}`])).trim());
}

export function registerExplorerCommands(register: Register, host: Host): void {
  const registerPath = (id: string, task: (git: Git, scope: string, directory: boolean) => Promise<void>) => register(`gitWorkbench.explorer.${id}`, async value => {
    if (!vscode.workspace.isTrusted) throw new Error('请先信任此工作区。');
    if (!(value instanceof vscode.Uri) || value.scheme !== 'file') throw new Error('请在资源管理器中右键文件夹或项目根目录。');
    const directory = (await lstat(value.fsPath)).isDirectory();
    const git = await host.repository(value), scope = git.relative(value.fsPath, true);
    await task(git, scope, directory);
  });
  const runAction = (id: string, action: string) => registerPath(id, git => host.run(git, actions[action], () => perform(git, action)));
  registerPath('history', (git, scope) => host.history(git, scope));
  registerPath('diff', async (git, scope) => {
    const head = await git.head();
    if (!head) throw new Error('仓库尚无提交，请先暂存或提交新文件。');
    await host.compare(git, scope, head);
  });
  registerPath('compareRevision', async (git, scope) => {
    const target = await targetRevision(git); if (target) await host.compare(git, scope, target);
  });
  registerPath('compareBranch', async (git, scope) => {
    const target = await targetRevision(git, true); if (target) await host.compare(git, scope, target);
  });
  registerPath('add', (git, scope) => host.run(git, '暂存所选目录', async () => {
    const changes = await scopeChanges(git, scope); changePaths(changes, scope);
    if (!changes.length) { void vscode.window.showInformationMessage('所选范围没有改动。'); return; }
    if (await confirm(`暂存 ${scope || '整个仓库'} 的全部改动（含新文件和删除）？\n仓库：${git.root}`)) await git.mutate(['add', '-A', '--', ...scopePaths(git, scope)]);
  }));
  registerPath('commit', (git, scope) => host.run(git, '提交所选目录', async () => {
    const changes = await scopeChanges(git, scope);
    if (!changes.length) { void vscode.window.showInformationMessage('所选范围没有可提交的改动。'); return; }
    if (changes.some(change => isConflict(change.status))) throw new Error('请先解决冲突。');
    const picked = await vscode.window.showQuickPick(changes.map(change => ({ label: change.path, description: `${change.status}${change.oldPath ? ` · ${change.oldPath} → ${change.path}` : ''}`, picked: true, change })), {
      title: `提交目录：${scope || '整个仓库'}`, placeHolder: '选择要提交的文件；使用文件当前已保存的完整内容，包含未暂存改动', canPickMany: true, ignoreFocusOut: true,
    });
    if (!picked?.length) return;
    const files = changePaths(picked.map(item => item.change), scope);
    const message = await vscode.window.showInputBox({ prompt: '提交信息', ignoreFocusOut: true }); if (!message?.trim()) return;
    if (await confirm(`提交 ${scope || '整个仓库'} 中选中的 ${picked.length} 个文件？\n将暂存并提交这些文件当前已保存的全部改动，目录外已暂存内容不纳入提交。未保存内容请先保存。\n仓库：${git.root}\n\n${picked.map(item => item.label).join('\n')}\n\n${message.trim()}`)) await commitPaths(git, scope, files, message.trim());
  }));
  registerPath('rollback', (git, scope) => host.run(git, '回滚所选目录', async () => {
    const changes = await scopeChanges(git, scope); changePaths(changes, scope);
    if (!changes.length) { void vscode.window.showInformationMessage('所选范围没有改动。'); return; }
    if (await confirm(`将 ${scope || '整个仓库'} 回滚到 HEAD？\n所选范围内已跟踪文件的暂存和未暂存改动将丢失。新增文件保留，但会取消暂存；目录外不受影响。\n仓库：${git.root}\n\n${changes.map(change => change.path).join('\n')}`)) await rollbackScope(git, scope);
  }));
  registerPath('exclude', (git, scope, directory) => host.run(git, '本地排除规则', async () => {
    if (scope && !await confirm(`将 ${scope} 加入 .git/info/exclude？\n仅此本地仓库生效，不会忽略已跟踪文件，也不修改 .gitignore。\n仓库：${git.root}`)) return;
    const file = await excludeScope(git, scope, directory);
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  }));
  for (const [id, action] of [['push', 'push'], ['pull', 'pull'], ['fetch', 'fetch'], ['newBranch', 'branchCreate'], ['newTag', 'tagCreate']]) runAction(id, action);
  for (const action of ['merge', 'rebase', 'reset']) registerPath(action, async git => {
    const hash = await targetRevision(git, action !== 'reset');
    if (hash) await host.run(git, actions[action], () => perform(git, action, hash));
  });
  registerPath('branches', async git => {
    const pick = await vscode.window.showQuickPick(['branchSwitch', 'branchCreate', 'branchRename', 'branchDelete'].map(id => ({ label: actions[id], id })), { title: `分支 · ${git.root}` });
    if (pick) await host.run(git, actions[pick.id], () => perform(git, pick.id));
  });
  registerPath('stash', (git, scope) => host.run(git, '暂存所选目录到 Stash', async () => {
    const changes = await scopeChanges(git, scope); changePaths(changes, scope);
    if (!changes.length) { void vscode.window.showInformationMessage('所选范围没有改动。'); return; }
    if ((await git.state()).operation || changes.some(change => isConflict(change.status))) throw new Error('请先完成或中止正在进行的 Git 操作并解决冲突。');
    const message = await vscode.window.showInputBox({ prompt: 'Stash 说明', value: `Git Workbench · ${scope || '整个仓库'}`, ignoreFocusOut: true });
    if (!message?.trim()) return;
    if (await confirm(`将 ${scope || '整个仓库'} 的已跟踪及未跟踪改动保存到 Stash？\n目录外的改动不纳入。忽略文件不包括在内。\n仓库：${git.root}`)) await git.mutate(['stash', 'push', '--include-untracked', '-m', message.trim(), '--', ...scopePaths(git, scope)]);
  }));
  registerPath('unstash', async git => {
    const pick = await vscode.window.showQuickPick(['stashApply', 'stashPop', 'stashDrop'].map(id => ({ label: actions[id], id })), { title: `所属仓库的 Stash（可能包含其他目录）· ${git.root}` });
    if (pick) await host.run(git, actions[pick.id], () => perform(git, pick.id));
  });
  registerPath('remotes', async git => {
    const pick = await vscode.window.showQuickPick([
      { label: '查看远端', id: 'list' }, { label: '添加远端', id: 'remoteAdd' }, { label: '修改远端 URL', id: 'edit' }, { label: '移除远端配置', id: 'remoteRemove' },
    ], { title: `管理远端 · ${git.root}` });
    if (!pick) return;
    if (pick.id === 'list') { const remotes = (await git.run(['remote', '-v'])).trim().split('\n').filter(Boolean); await vscode.window.showQuickPick(remotes, { title: '远端配置' }); return; }
    if (pick.id !== 'edit') { await host.run(git, actions[pick.id], () => perform(git, pick.id)); return; }
    const remote = await vscode.window.showQuickPick((await git.run(['remote'])).trim().split('\n').filter(Boolean), { title: '选择要修改的远端' }); if (!remote) return;
    const url = await vscode.window.showInputBox({ prompt: `${remote} 的新 URL（HTTPS 或 SSH）`, ignoreFocusOut: true }); if (!url?.trim()) return;
    if (url.startsWith('-') || /[\r\n\0]/.test(url)) throw new Error('无效的远端 URL。');
    await host.run(git, '修改远端 URL', async () => { if (await confirm(`修改 ${remote} 的远端 URL？\n仓库：${git.root}`)) await git.mutate(['remote', 'set-url', remote, url.trim()]); });
  });
  register('gitWorkbench.explorer.clone', async () => {
    if (!vscode.workspace.isTrusted) throw new Error('请先信任此工作区。');
    if (!(await vscode.commands.getCommands(true)).includes('git.clone')) throw new Error('当前编辑器未提供 Git Clone，请启用内置 Git 扩展。');
    await vscode.commands.executeCommand('git.clone');
  });
}
