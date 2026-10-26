import * as vscode from 'vscode';
import { Git, assertHash, isConflict } from './git';
export { isConflict } from './git';

export const actions: Record<string, string> = {
  branchSwitch: '切换分支', branchCreate: '从选中提交创建分支', branchRename: '重命名当前分支', branchDelete: '删除本地分支',
  checkout: '检出选中提交（分离 HEAD）', merge: '合并选中提交到当前分支', rebase: '将当前分支变基到选中提交',
  cherryPick: 'Cherry-pick 选中提交', revert: 'Revert 选中提交', reset: 'Reset 当前分支到选中提交',
  tagCreate: '在选中提交创建标签', tagDelete: '删除本地标签',
  stageAll: '暂存全部改动', unstageAll: '取消全部暂存', commit: '提交暂存区', amend: '修改最后一次提交',
  fetch: 'Fetch 全部远端', pull: 'Pull（仅快进）', pullRebase: 'Pull（变基）', push: 'Push 当前分支', forcePush: 'Push（force-with-lease）',
  stash: 'Stash（含未跟踪文件）', stashApply: '应用 Stash', stashPop: '恢复并删除 Stash', stashDrop: '删除 Stash',
  continue: '继续合并 / 变基 / Cherry-pick / Revert', abort: '中止正在进行的 Git 操作',
  remoteAdd: '添加远端', remoteRemove: '移除远端配置', reflog: '查看 Reflog',
  scm: '打开原生提交与冲突面板', terminal: '打开仓库终端'
};

export const operationGroups = [
  { label: '分支', ids: ['branchSwitch', 'branchCreate', 'branchRename', 'branchDelete', 'checkout'] },
  { label: '提交与版本', ids: ['cherryPick', 'revert', 'merge', 'rebase', 'reset', 'tagCreate', 'tagDelete'] },
  { label: '工作区与提交', ids: ['stageAll', 'unstageAll', 'commit', 'amend', 'scm'] },
  { label: '远端同步', ids: ['fetch', 'pull', 'pullRebase', 'push', 'forcePush', 'remoteAdd', 'remoteRemove'] },
  { label: 'Stash', ids: ['stash', 'stashApply', 'stashPop', 'stashDrop'] },
  { label: '冲突处理', ids: ['continue', 'abort'] },
  { label: '工具与恢复', ids: ['reflog', 'terminal'] },
];

export async function confirm(detail: string): Promise<boolean> {
  return await vscode.window.showWarningMessage(detail, { modal: true }, '执行') === '执行';
}

async function input(prompt: string, value?: string): Promise<string | undefined> {
  const result = await vscode.window.showInputBox({ prompt, value, ignoreFocusOut: true });
  if (result === undefined) return undefined;
  if (!result.trim()) throw new Error('输入不能为空。');
  return result.trim();
}

export async function perform(git: Git, action: string, hash?: string): Promise<void> {
  if (!Object.hasOwn(actions, action)) throw new Error('不支持的操作。');
  const target = hash ? assertHash(hash) : await git.head();
  const requireTarget = () => { if (!target) throw new Error('仓库还没有提交。'); return target; };
  const state = await git.state();
  const label = `${state.branch} · ${git.root}`;
  const write = async (args: string[], detail?: string, body?: string) => {
    if (!detail || await confirm(`${detail}\n\n仓库：${label}`)) await git.mutate(args, body);
  };
  const chooseRemote = async () => {
    const remotes = (await git.run(['remote'])).trim().split('\n').filter(Boolean);
    if (!remotes.length) throw new Error('仓库尚未配置远端，请先添加远端。');
    return vscode.window.showQuickPick(remotes, { placeHolder: '选择远端', ignoreFocusOut: true });
  };
  switch (action) {
    case 'branchSwitch': {
      const refs = (await git.refs()).filter(ref => !ref.tag && !ref.current);
      const pick = await vscode.window.showQuickPick(refs.map(ref => ({ label: ref.name, description: ref.remote ? '远端分支（创建跟踪分支）' : '本地分支', ref })), { placeHolder: '切换分支' });
      if (pick) await write(pick.ref.remote ? ['switch', '--track', pick.ref.name] : ['switch', '--', pick.ref.name], `切换到 ${pick.ref.name}？Git 将保留可保留的工作区改动。`);
      break;
    }
    case 'branchCreate': {
      const name = await input('新分支名称'); if (!name) return;
      await git.validateBranch(name);
      if (target) await write(['branch', name, target], `从 ${target.slice(0, 8)} 创建分支 ${name}？`);
      else throw new Error('请先创建首次提交。');
      break;
    }
    case 'branchRename': {
      if (!state.branch || state.branch.startsWith('(')) throw new Error('分离 HEAD 状态下不能重命名当前分支。');
      const name = await input('新的分支名称', state.branch); if (!name) return;
      await git.validateBranch(name);
      await write(['branch', '-m', name], `将 ${state.branch} 重命名为 ${name}？`); break;
    }
    case 'branchDelete': {
      const refs = (await git.refs()).filter(ref => !ref.tag && !ref.remote && !ref.current);
      const name = await vscode.window.showQuickPick(refs.map(ref => ref.name), { placeHolder: '删除本地分支（只允许已合并分支）' });
      if (name) await write(['branch', '-d', '--', name], `删除本地分支 ${name}？`); break;
    }
    case 'checkout': await write(['switch', '--detach', requireTarget()], `检出 ${requireTarget().slice(0, 8)}，进入分离 HEAD 状态？`); break;
    case 'merge': await write(['merge', '--no-edit', requireTarget()], `将 ${requireTarget().slice(0, 8)} 合并到 ${state.branch}？`); break;
    case 'rebase': await write(['rebase', requireTarget()], `将 ${state.branch} 变基到 ${requireTarget().slice(0, 8)}？这将重写当前分支的提交。`); break;
    case 'cherryPick':
    case 'revert': {
      const commit = await git.commit(requireTarget());
      const args = [action === 'cherryPick' ? 'cherry-pick' : 'revert', '--no-edit'];
      if (commit.parents.length > 1) {
        const mainline = await vscode.window.showQuickPick(commit.parents.map((parent, i) => ({ label: `父提交 ${i + 1} · ${parent.slice(0, 8)}`, value: i + 1 })), { placeHolder: '合并提交：选择 mainline 父提交' });
        if (!mainline) return; args.push('-m', String(mainline.value));
      }
      args.push(commit.hash);
      await write(args, `${actions[action]} ${commit.hash.slice(0, 8)} 到 ${state.branch}？`); break;
    }
    case 'reset': {
      const mode = await vscode.window.showQuickPick([
        { label: 'Soft', description: '移动分支，保留暂存区与工作区', value: '--soft' },
        { label: 'Mixed', description: '移动分支、重置暂存区，保留工作区', value: '--mixed' },
        { label: 'Hard', description: '丢弃已跟踪文件的未提交改动；可能删除阻挡检出的未跟踪文件', value: '--hard' },
      ], { placeHolder: `Reset 到 ${requireTarget().slice(0, 8)}` });
      if (mode) await write(['reset', mode.value, requireTarget()], `${mode.label} Reset ${state.branch} 到 ${requireTarget().slice(0, 8)}？\n${mode.description}`); break;
    }
    case 'tagCreate': {
      const name = await input('新标签名称'); if (!name) return;
      if (name.startsWith('-')) throw new Error('无效的标签名称。');
      await git.run(['check-ref-format', `refs/tags/${name}`]);
      await write(['tag', name, requireTarget()], `在 ${requireTarget().slice(0, 8)} 创建标签 ${name}？`); break;
    }
    case 'tagDelete': {
      const name = await vscode.window.showQuickPick((await git.refs()).filter(ref => ref.tag).map(ref => ref.name), { placeHolder: '删除本地标签' });
      if (name) await write(['tag', '-d', '--', name], `删除本地标签 ${name}？`); break;
    }
    case 'stageAll': await write(['add', '-A'], '暂存全部文件，包括新文件和删除？'); break;
    case 'unstageAll':
      if (state.head) await write(['reset', '--mixed', 'HEAD']);
      else await write(['rm', '--cached', '-r', '-f', '--ignore-unmatch', '--', '.']);
      break;
    case 'commit':
    case 'amend': {
      if ((await git.status()).some(change => isConflict(change.status))) throw new Error('请先解决冲突并暂存文件。');
      if (action === 'amend' && !state.head) throw new Error('仓库还没有提交。');
      const message = await input(action === 'amend' ? '修改最后一次提交的信息' : '提交信息（提交已暂存的内容）', action === 'amend' ? (await git.message(state.head!)).trim() : undefined);
      if (!message) return;
      await write(['commit', ...(action === 'amend' ? ['--amend'] : []), '--file', '-'], action === 'amend' ? 'Amend 将重写 HEAD，并包含当前暂存区内容。继续？' : undefined, `${message}\n`); break;
    }
    case 'fetch': await write(['fetch', '--all', '--prune'], '获取全部远端并清理已删除的远端跟踪分支？'); break;
    case 'pull':
    case 'pullRebase': {
      const remote = await chooseRemote(); if (!remote) return;
      if (state.branch.startsWith('(')) throw new Error('请先切换到本地分支。');
      const remoteBranch = await input('拉取哪个远端分支？', state.upstreamRemote === remote && state.upstreamRef?.startsWith('refs/heads/') ? state.upstreamRef.slice(11) : state.branch);
      if (!remoteBranch) return; await git.validateBranch(remoteBranch);
      await write(['pull', action === 'pull' ? '--ff-only' : '--rebase', '--', remote, remoteBranch], `从 ${remote}/${remoteBranch} 拉取到 ${state.branch}（${action === 'pull' ? '仅快进' : '变基'}）？`); break;
    }
    case 'push':
    case 'forcePush': {
      const remote = await chooseRemote(); if (!remote) return;
      if (state.branch.startsWith('(')) throw new Error('请先切换到本地分支。');
      const remoteBranch = await input('推送到哪个远端分支？', state.upstreamRemote === remote && state.upstreamRef?.startsWith('refs/heads/') ? state.upstreamRef.slice(11) : state.branch);
      if (!remoteBranch) return; await git.validateBranch(remoteBranch);
      await write(['push', '--set-upstream', ...(action === 'forcePush' ? ['--force-with-lease'] : []), '--', remote, `HEAD:refs/heads/${remoteBranch}`], `推送 ${state.branch} 到 ${remote}/${remoteBranch}？${action === 'forcePush' ? '\n此操作会使用 force-with-lease 重写远端历史。' : ''}`); break;
    }
    case 'stash': {
      const message = await input('Stash 说明', 'Git Workbench stash');
      if (message) await write(['stash', 'push', '--include-untracked', '-m', message], '保存已跟踪及未跟踪文件到 Stash？忽略文件不包括在内。'); break;
    }
    case 'stashApply':
    case 'stashPop':
    case 'stashDrop': {
      const raw = await git.run(['stash', 'list', '--format=%gd%x00%s']);
      const items = raw.trimEnd().split('\n').filter(Boolean).map(line => { const [ref, message] = line.split('\0'); return { label: ref, description: message }; });
      if (!items.length) throw new Error('没有 Stash。');
      const pick = await vscode.window.showQuickPick(items, { placeHolder: actions[action] });
      if (pick) await write(['stash', action === 'stashApply' ? 'apply' : action === 'stashPop' ? 'pop' : 'drop', pick.label], `${actions[action]} ${pick.label}？`); break;
    }
    case 'continue':
    case 'abort': {
      if (!state.operation) throw new Error('没有正在进行的合并、变基、Cherry-pick 或 Revert。');
      await write([state.operation, action === 'continue' ? '--continue' : '--abort'], `${action === 'continue' ? '继续' : '中止'} ${state.operation}？`); break;
    }
    case 'remoteAdd': {
      const name = await input('远端名称，例如 origin'); if (!name) return;
      if (!/^[\w.-]+$/.test(name) || name.startsWith('-')) throw new Error('无效的远端名称。');
      const url = await input('远端 URL（HTTPS 或 SSH）'); if (!url) return;
      if (url.startsWith('-') || /[\r\n\0]/.test(url)) throw new Error('无效的远端 URL。');
      await write(['remote', 'add', name, url], `添加远端 ${name}？`); break;
    }
    case 'remoteRemove': {
      const remote = await chooseRemote(); if (remote) await write(['remote', 'remove', remote], `移除远端 ${remote} 的本地配置及跟踪引用？`); break;
    }
    case 'reflog': {
      const raw = await git.run(['reflog', '--max-count=200', '--format=%H%x00%gd%x00%gs']);
      const pick = await vscode.window.showQuickPick(raw.trimEnd().split('\n').filter(Boolean).map(line => { const [sha, ref, subject] = line.split('\0'); return { label: `${ref} · ${sha.slice(0, 8)}`, description: subject, hash: sha }; }), { placeHolder: '选择 Reflog 记录，查看可执行操作' });
      if (pick) {
        const choice = await vscode.window.showQuickPick(['checkout', 'branchCreate', 'reset'].map(id => ({ label: actions[id], id })), { placeHolder: pick.label });
        if (choice) await perform(git, choice.id, pick.hash);
      } break;
    }
    case 'scm': await vscode.commands.executeCommand('workbench.view.scm'); break;
    case 'terminal': { const terminal = vscode.window.createTerminal({ name: 'Git Workbench', cwd: git.root }); terminal.show(); break; }
  }
}

