import { t } from './i18n';
import * as vscode from 'vscode';
import { Git, assertHash, isConflict } from './git';
import { StashEntry, StashSnapshot, restoreStash, stashSnapshot } from './stash';
export { isConflict } from './git';

export function getActions(): Record<string, string> { return {
  branchSwitch: t("切换分支"), branchCreate: t("从选中提交创建分支"), branchRename: t("重命名当前分支"), branchDelete: t("删除本地分支"),
  checkout: t("检出选中提交（分离 HEAD）"), merge: t("合并选中提交到当前分支"), rebase: t("将当前分支变基到选中提交"),
  cherryPick: t("Cherry-pick 选中提交"), revert: t("Revert 选中提交"), reset: t("Reset 当前分支到选中提交"),
  tagCreate: t("在选中提交创建标签"), tagDelete: t("删除本地标签"),
  stageAll: t("暂存全部改动"), unstageAll: t("取消全部暂存"), commit: t("提交暂存区"), amend: t("修改最后一次提交"),
  fetch: t("Fetch 全部远端"), pull: t("Pull（仅快进）"), pullRebase: t("Pull（变基）"), push: t("Push 当前分支"), forcePush: 'Push（force-with-lease）',
  stash: t("Stash（含未跟踪文件）"), stashApply: t("应用 Stash"), stashPop: t("恢复并删除 Stash"), stashDrop: t("删除 Stash"),
  continue: t("继续合并 / 变基 / Cherry-pick / Revert"), abort: t("中止正在进行的 Git 操作"),
  remoteAdd: t("添加远端"), remoteRemove: t("移除远端配置"), reflog: t("查看 Reflog"),
  scm: t("打开原生提交与冲突面板"), terminal: t("打开仓库终端")
}; }

export function getOperationGroups() { return [
  { label: t("分支"), ids: ['branchSwitch', 'branchCreate', 'branchRename', 'branchDelete', 'checkout'] },
  { label: t("提交与版本"), ids: ['cherryPick', 'revert', 'merge', 'rebase', 'reset', 'tagCreate', 'tagDelete'] },
  { label: t("工作区与提交"), ids: ['stageAll', 'unstageAll', 'commit', 'amend', 'scm'] },
  { label: t("远端同步"), ids: ['fetch', 'pull', 'pullRebase', 'push', 'forcePush', 'remoteAdd', 'remoteRemove'] },
  { label: 'Stash', ids: ['stash', 'stashApply', 'stashPop', 'stashDrop'] },
  { label: t("冲突处理"), ids: ['continue', 'abort'] },
  { label: t("工具与恢复"), ids: ['reflog', 'terminal'] },
]; }

export async function confirm(detail: string): Promise<boolean> {
  const execute = t("执行");
  return await vscode.window.showWarningMessage(detail, { modal: true }, execute) === execute;
}

async function input(prompt: string, value?: string): Promise<string | undefined> {
  const result = await vscode.window.showInputBox({ prompt, value, ignoreFocusOut: true });
  if (result === undefined) return undefined;
  if (!result.trim()) throw new Error(t("输入不能为空。"));
  return result.trim();
}

export async function performStash(git: Git, action: string, snapshot: StashSnapshot, entry: StashEntry): Promise<void> {
  if (!vscode.workspace.isTrusted) throw new Error(t("请先信任此工作区。"));
  if (!['apply', 'pop', 'drop', 'unstash'].includes(action)) throw new Error(t("不支持的操作。"));
  const before = await git.state();
  let mode: 'apply' | 'pop' | 'drop' = 'apply';
  if (action === 'pop' || action === 'drop') mode = action;
  let reinstateIndex = false;
  let newBranch: string | undefined;
  if (action === 'unstash') {
    const options = [
      { label: t("恢复并保留 Stash"), mode: 'apply', index: false },
      { label: t("恢复并删除 Stash"), mode: 'pop', index: false },
      { label: t("恢复暂存状态并保留 Stash"), mode: 'apply', index: true },
      { label: t("恢复暂存状态并删除 Stash"), mode: 'pop', index: true },
      { label: t("恢复到新分支并保留 Stash…"), mode: 'apply', index: true, branch: true },
      { label: t("恢复到新分支并删除 Stash…"), mode: 'pop', index: true, branch: true },
    ] as const;
    const pick = await vscode.window.showQuickPick(options, { title: `Unstash · ${entry.ref}`, placeHolder: t("选择恢复方式（恢复暂存状态对应 --index）") });
    if (!pick) return;
    mode = pick.mode; reinstateIndex = pick.index;
    if ('branch' in pick && pick.branch) {
      newBranch = await input(t("新分支名称")); if (!newBranch) return;
      await git.validateBranch(newBranch);
    }
  }
  const label = { apply: t("恢复并保留 Stash"), pop: t("恢复并删除 Stash"), drop: t("删除 Stash") }[mode];
  const branchDetail = newBranch ? t("\n从 Stash 原始基线创建并切换到分支 {0}，同时恢复暂存状态。", newBranch) : '';
  if (!await confirm(t("{0}？\n{1} · {2}\n{3}\n仓库：{4}\n分支：{5}", label, entry.ref, entry.hash.slice(0, 8), entry.subject, git.root, before.branch) + branchDetail)) return;
  if (!vscode.workspace.isTrusted) throw new Error(t("请先信任此工作区。"));
  const current = await git.state();
  if (current.head !== before.head || current.branch !== before.branch) throw new Error(t("当前 HEAD 已改变，请刷新后重试。"));
  if (mode !== 'drop' && (current.operation || (await git.status()).some(file => isConflict(file.status)))) throw new Error(t("请先完成或中止正在进行的 Git 操作并解决冲突。"));
  if (newBranch && (await git.status()).length) throw new Error(t("恢复到新分支前，请先提交或 Stash 当前工作区的改动。"));
  await restoreStash(git, snapshot, entry, mode, reinstateIndex, newBranch);
}

export async function perform(git: Git, action: string, hash?: string): Promise<void> {
  const actions = getActions();
  if (!Object.hasOwn(actions, action)) throw new Error(t("不支持的操作。"));
  const target = hash ? assertHash(hash) : await git.head();
  const requireTarget = () => { if (!target) throw new Error(t("仓库还没有提交。")); return target; };
  const state = await git.state();
  const label = `${state.branch} · ${git.root}`;
  const write = async (args: string[], detail?: string, body?: string) => {
    if (!detail || await confirm(t("{0}\n\n仓库：{1}", detail, label))) await git.mutate(args, body);
  };
  const chooseRemote = async () => {
    const remotes = (await git.run(['remote'])).trim().split('\n').filter(Boolean);
    if (!remotes.length) throw new Error(t("仓库尚未配置远端，请先添加远端。"));
    return vscode.window.showQuickPick(remotes, { placeHolder: t("选择远端"), ignoreFocusOut: true });
  };
  switch (action) {
    case 'branchSwitch': {
      const refs = (await git.refs()).filter(ref => !ref.tag && !ref.current);
      const pick = await vscode.window.showQuickPick(refs.map(ref => ({ label: ref.name, description: ref.remote ? t("远端分支（创建跟踪分支）") : t("本地分支"), ref })), { placeHolder: t("切换分支") });
      if (pick) await write(pick.ref.remote ? ['switch', '--track', pick.ref.name] : ['switch', '--', pick.ref.name], t("切换到 {0}？Git 将保留可保留的工作区改动。", pick.ref.name));
      break;
    }
    case 'branchCreate': {
      const name = await input(t("新分支名称")); if (!name) return;
      await git.validateBranch(name);
      if (target) await write(['branch', name, target], t("从 {0} 创建分支 {1}？", target.slice(0, 8), name));
      else throw new Error(t("请先创建首次提交。"));
      break;
    }
    case 'branchRename': {
      if (!state.branch || state.branch.startsWith('(')) throw new Error(t("分离 HEAD 状态下不能重命名当前分支。"));
      const name = await input(t("新的分支名称"), state.branch); if (!name) return;
      await git.validateBranch(name);
      await write(['branch', '-m', name], t("将 {0} 重命名为 {1}？", state.branch, name)); break;
    }
    case 'branchDelete': {
      const refs = (await git.refs()).filter(ref => !ref.tag && !ref.remote && !ref.current);
      const name = await vscode.window.showQuickPick(refs.map(ref => ref.name), { placeHolder: t("删除本地分支（只允许已合并分支）") });
      if (name) await write(['branch', '-d', '--', name], t("删除本地分支 {0}？", name)); break;
    }
    case 'checkout': await write(['switch', '--detach', requireTarget()], t("检出 {0}，进入分离 HEAD 状态？", requireTarget().slice(0, 8))); break;
    case 'merge': await write(['merge', '--no-edit', requireTarget()], t("将 {0} 合并到 {1}？", requireTarget().slice(0, 8), state.branch)); break;
    case 'rebase': await write(['rebase', requireTarget()], t("将 {0} 变基到 {1}？这将重写当前分支的提交。", state.branch, requireTarget().slice(0, 8))); break;
    case 'cherryPick':
    case 'revert': {
      const commit = await git.commit(requireTarget());
      const args = [action === 'cherryPick' ? 'cherry-pick' : 'revert', '--no-edit'];
      if (commit.parents.length > 1) {
        const mainline = await vscode.window.showQuickPick(commit.parents.map((parent, i) => ({ label: t("父提交 {0} · {1}", i + 1, parent.slice(0, 8)), value: i + 1 })), { placeHolder: t("合并提交：选择 mainline 父提交") });
        if (!mainline) return; args.push('-m', String(mainline.value));
      }
      args.push(commit.hash);
      await write(args, t("{0} {1} 到 {2}？", actions[action], commit.hash.slice(0, 8), state.branch)); break;
    }
    case 'reset': {
      const mode = await vscode.window.showQuickPick([
        { label: 'Soft', description: t("移动分支，保留暂存区与工作区"), value: '--soft' },
        { label: 'Mixed', description: t("移动分支、重置暂存区，保留工作区"), value: '--mixed' },
        { label: 'Hard', description: t("丢弃已跟踪文件的未提交改动；可能删除阻挡检出的未跟踪文件"), value: '--hard' },
      ], { placeHolder: t("Reset 到 {0}", requireTarget().slice(0, 8)) });
      if (mode) await write(['reset', mode.value, requireTarget()], t("{0} Reset {1} 到 {2}？\n{3}", mode.label, state.branch, requireTarget().slice(0, 8), mode.description)); break;
    }
    case 'tagCreate': {
      const name = await input(t("新标签名称")); if (!name) return;
      if (name.startsWith('-')) throw new Error(t("无效的标签名称。"));
      await git.run(['check-ref-format', `refs/tags/${name}`]);
      await write(['tag', name, requireTarget()], t("在 {0} 创建标签 {1}？", requireTarget().slice(0, 8), name)); break;
    }
    case 'tagDelete': {
      const name = await vscode.window.showQuickPick((await git.refs()).filter(ref => ref.tag).map(ref => ref.name), { placeHolder: t("删除本地标签") });
      if (name) await write(['tag', '-d', '--', name], t("删除本地标签 {0}？", name)); break;
    }
    case 'stageAll': await write(['add', '-A'], t("暂存全部文件，包括新文件和删除？")); break;
    case 'unstageAll':
      if (state.head) await write(['reset', '--mixed', 'HEAD']);
      else await write(['rm', '--cached', '-r', '-f', '--ignore-unmatch', '--', '.']);
      break;
    case 'commit':
    case 'amend': {
      if ((await git.status()).some(change => isConflict(change.status))) throw new Error(t("请先解决冲突并暂存文件。"));
      if (action === 'amend' && !state.head) throw new Error(t("仓库还没有提交。"));
      const message = await input(action === 'amend' ? t("修改最后一次提交的信息") : t("提交信息（提交已暂存的内容）"), action === 'amend' ? (await git.message(state.head!)).trim() : undefined);
      if (!message) return;
      await write(['commit', ...(action === 'amend' ? ['--amend'] : []), '--file', '-'], action === 'amend' ? t("Amend 将重写 HEAD，并包含当前暂存区内容。继续？") : undefined, `${message}\n`); break;
    }
    case 'fetch': await write(['fetch', '--all', '--prune'], t("获取全部远端并清理已删除的远端跟踪分支？")); break;
    case 'pull':
    case 'pullRebase': {
      const remote = await chooseRemote(); if (!remote) return;
      if (state.branch.startsWith('(')) throw new Error(t("请先切换到本地分支。"));
      const remoteBranch = await input(t("拉取哪个远端分支？"), state.upstreamRemote === remote && state.upstreamRef?.startsWith('refs/heads/') ? state.upstreamRef.slice(11) : state.branch);
      if (!remoteBranch) return; await git.validateBranch(remoteBranch);
      await write(['pull', action === 'pull' ? '--ff-only' : '--rebase', '--', remote, remoteBranch], t("从 {0}/{1} 拉取到 {2}（{3}）？", remote, remoteBranch, state.branch, action === 'pull' ? t("仅快进") : t("变基"))); break;
    }
    case 'push':
    case 'forcePush': {
      const remote = await chooseRemote(); if (!remote) return;
      if (state.branch.startsWith('(')) throw new Error(t("请先切换到本地分支。"));
      const remoteBranch = await input(t("推送到哪个远端分支？"), state.upstreamRemote === remote && state.upstreamRef?.startsWith('refs/heads/') ? state.upstreamRef.slice(11) : state.branch);
      if (!remoteBranch) return; await git.validateBranch(remoteBranch);
      await write(['push', '--set-upstream', ...(action === 'forcePush' ? ['--force-with-lease'] : []), '--', remote, `HEAD:refs/heads/${remoteBranch}`], t("推送 {0} 到 {1}/{2}？{3}", state.branch, remote, remoteBranch, action === 'forcePush' ? t("\n此操作会使用 force-with-lease 重写远端历史。") : '')); break;
    }
    case 'stash': {
      const message = await input(t("Stash 说明"), 'Orbit Git stash');
      if (message) await write(['stash', 'push', '--include-untracked', '-m', message], t("保存已跟踪及未跟踪文件到 Stash？忽略文件不包括在内。")); break;
    }
    case 'stashApply':
    case 'stashPop':
    case 'stashDrop': {
      const snapshot = await stashSnapshot(git);
      const items = snapshot.entries.map(entry => ({ label: entry.ref, description: entry.subject, entry }));
      if (!items.length) throw new Error(t("没有 Stash。"));
      const pick = await vscode.window.showQuickPick(items, { placeHolder: actions[action] });
      if (pick) {
        const modes: Record<string, string> = { stashApply: 'apply', stashPop: 'pop', stashDrop: 'drop' };
        await performStash(git, modes[action], snapshot, pick.entry);
      }
      break;
    }
    case 'continue':
    case 'abort': {
      if (!state.operation) throw new Error(t("没有正在进行的合并、变基、Cherry-pick 或 Revert。"));
      await write([state.operation, action === 'continue' ? '--continue' : '--abort'], `${action === 'continue' ? t("继续") : t("中止")} ${state.operation}？`); break;
    }
    case 'remoteAdd': {
      const name = await input(t("远端名称，例如 origin")); if (!name) return;
      if (!/^[\w.-]+$/.test(name) || name.startsWith('-')) throw new Error(t("无效的远端名称。"));
      const url = await input(t("远端 URL（HTTPS 或 SSH）")); if (!url) return;
      if (url.startsWith('-') || /[\r\n\0]/.test(url)) throw new Error(t("无效的远端 URL。"));
      await write(['remote', 'add', name, url], t("添加远端 {0}？", name)); break;
    }
    case 'remoteRemove': {
      const remote = await chooseRemote(); if (remote) await write(['remote', 'remove', remote], t("移除远端 {0} 的本地配置及跟踪引用？", remote)); break;
    }
    case 'reflog': {
      const raw = await git.run(['reflog', '--max-count=200', '--format=%H%x00%gd%x00%gs']);
      const pick = await vscode.window.showQuickPick(raw.trimEnd().split('\n').filter(Boolean).map(line => { const [sha, ref, subject] = line.split('\0'); return { label: `${ref} · ${sha.slice(0, 8)}`, description: subject, hash: sha }; }), { placeHolder: t("选择 Reflog 记录，查看可执行操作") });
      if (pick) {
        const choice = await vscode.window.showQuickPick(['checkout', 'branchCreate', 'reset'].map(id => ({ label: actions[id], id })), { placeHolder: pick.label });
        if (choice) await perform(git, choice.id, pick.hash);
      } break;
    }
    case 'scm': await vscode.commands.executeCommand('workbench.view.scm'); break;
    case 'terminal': { const terminal = vscode.window.createTerminal({ name: 'Orbit Git', cwd: git.root }); terminal.show(); break; }
  }
}

