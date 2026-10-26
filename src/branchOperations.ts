import * as vscode from 'vscode';
import { Git, Ref, assertHash } from './git';
import { confirm } from './operations';

// Targets come from the host's ref snapshot, never a client-supplied command or SHA.
export async function branchTarget(git: Git, expected: Ref): Promise<{ ref: Ref; hash: string }> {
  const ref = (await git.refs()).find(item => item.full === expected.full);
  if (!ref || ref.hash !== expected.hash) throw new Error('分支或标签已改变，请刷新后重试。');
  const hash = assertHash((await git.run(['rev-parse', '--verify', '--end-of-options', `${ref.full}^{commit}`])).trim());
  return { ref, hash };
}

export async function performBranch(git: Git, action: string, expected: Ref, expectedHead: string | undefined, expectedBranch: string): Promise<void> {
  if (!vscode.workspace.isTrusted) throw new Error('请先信任此工作区。');
  const { ref, hash } = await branchTarget(git, expected);
  const state = await git.state();
  if (!state.head || state.head !== expectedHead || state.branch !== expectedBranch) throw new Error('当前分支或 HEAD 已改变，请刷新后重试。');
  if (state.operation) throw new Error('请先完成或中止正在进行的 Git 操作。');
  const local = !ref.remote && !ref.tag;
  const current = local && ref.current;
  const write = async (args: string[], detail: string) => {
    if (!await confirm(`${detail}\n\n仓库：${git.root}\n当前分支：${state.branch}\n所选引用：${ref.full}`)) return false;
    await branchTarget(git, ref);
    const latest = await git.state();
    if (latest.head !== state.head || latest.branch !== state.branch || latest.operation) throw new Error('仓库状态已改变，请刷新后重试。');
    await git.mutate(args); return true;
  };
  const name = async (prompt: string, value?: string) => {
    const result = await vscode.window.showInputBox({ prompt, value, ignoreFocusOut: true });
    if (result === undefined) return undefined;
    const trimmed = result.trim(); await git.validateBranch(trimmed); return trimmed;
  };
  const requireLocal = () => { if (!local) throw new Error('此操作只支持本地分支。'); };
  const requireOther = () => { if (current) throw new Error('请选择当前分支之外的目标分支。'); };
  const requireAttached = () => { if (state.branch.startsWith('(')) throw new Error('请先检出本地分支。'); };
  const clean = async () => { if ((await git.status()).length) throw new Error('请先提交或 Stash 工作区改动，再执行此操作。'); };
  switch (action) {
    case 'checkout':
      requireOther();
      await write(ref.tag ? ['switch', '--detach', hash] : ref.remote ? ['switch', '--track', ref.name] : ['switch', '--', ref.name], `检出 ${ref.name}？${ref.tag ? '进入分离 HEAD 状态。' : ref.remote ? '创建本地跟踪分支。' : 'Git 将保留可保留的本地改动。'}`); break;
    case 'create': {
      const next = await name(`从 ${ref.name} 创建新分支`); if (!next) return;
      await write(['branch', next, hash], `从 ${ref.name} 创建 ${next}（不切换当前分支）？`); break;
    }
    case 'checkoutRebase':
      requireLocal(); requireOther(); requireAttached(); await clean();
      if (await write(['switch', '--', ref.name], `检出 ${ref.name}，再将它变基到当前 ${state.branch}？\n将重写 ${ref.name} 的提交；发生冲突时停留在该分支供你解决。`)) {
        const checked = await git.state();
        if (checked.branch !== ref.name || checked.head !== hash || checked.operation) throw new Error('检出后的状态已改变，未执行变基。');
        await clean(); await git.mutate(['rebase', state.head]);
      }
      break;
    case 'merge':
      requireOther(); requireAttached();
      await write(['merge', '--no-edit', hash], `将 ${ref.name} 合并到当前 ${state.branch}？`); break;
    case 'rebase':
      requireOther(); requireAttached(); await clean();
      await write(['rebase', hash], `将当前 ${state.branch} 变基到 ${ref.name}？\n将重写当前分支的提交。`); break;
    case 'rename': {
      requireLocal(); const next = await name(`重命名本地分支 ${ref.name}`, ref.name); if (!next) return;
      await write(['branch', '-m', ref.name, next], `将 ${ref.name} 重命名为 ${next}？`); break;
    }
    case 'delete':
      requireLocal(); requireOther();
      await write(['branch', '-d', '--', ref.name], `删除本地分支 ${ref.name}？只允许删除已合并分支，工作树占用的分支由 Git 拒绝。`); break;
    case 'update': {
      requireLocal();
      const [remote, source] = (await git.run(['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)', ref.full])).trimEnd().split('\0');
      if (!remote || !source?.startsWith('refs/heads/')) throw new Error('此分支没有配置上游，请先配置跟踪分支。');
      await write(current ? ['pull', '--ff-only', '--', remote, source] : ['fetch', '--', remote, `${source}:${ref.full}`], `从 ${remote}/${source.slice(11)} 仅快进更新 ${ref.name}？${current ? '' : '\n保持当前检出分支不变。'}`); break;
    }
    case 'push': {
      requireLocal();
      const remotes = (await git.run(['remote'])).trim().split('\n').filter(Boolean);
      if (!remotes.length) throw new Error('仓库尚未配置远端。');
      const remote = await vscode.window.showQuickPick(remotes, { placeHolder: `推送 ${ref.name} · 选择远端`, ignoreFocusOut: true });
      if (!remote || !remotes.includes(remote)) return;
      const [, upstream] = (await git.run(['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)', ref.full])).trimEnd().split('\0');
      const target = await name(`将 ${ref.name} 推送到 ${remote} 的哪个分支？`, upstream?.startsWith('refs/heads/') ? upstream.slice(11) : ref.name);
      if (target) await write(['push', '--set-upstream', '--', remote, `${ref.full}:refs/heads/${target}`], `推送所选分支 ${ref.name} 到 ${remote}/${target}？不会推送其他当前分支，也不会强制推送。`);
      break;
    }
    default: throw new Error('不支持的分支操作。');
  }
}
