import * as vscode from 'vscode';
import { t } from './i18n';

export const moduleNames = ['graph', 'selectionHistory', 'fileHistory', 'blame', 'comparison', 'stash', 'operations', 'explorerMenu', 'editorMenu', 'statusBar'] as const;
export type ModuleName = typeof moduleNames[number];
export type Modules = Record<ModuleName, boolean>;
export function readModules(): Modules {
  const settings = vscode.workspace.getConfiguration('gitWorkbench');
  const values = settings.get<Partial<Modules>>('modules', {});
  return Object.fromEntries(moduleNames.map(name => [name, values[name] !== false])) as Modules;
}
export function moduleLabel(name: ModuleName): string {
  return {
    graph: t('提交树与分支'), selectionHistory: t('选区与当前行历史'), fileHistory: t('文件历史'), blame: t('作者标注与当前行提交'),
    comparison: t('文件与目录对比'), stash: 'Stash', operations: t('Git 写操作'), explorerMenu: t('资源管理器右键菜单'),
    editorMenu: t('编辑器右键菜单'), statusBar: t('状态栏入口'),
  }[name];
}
export function requireModule(name: ModuleName): void {
  if (!readModules()[name]) throw new Error(t('“{0}”已停用，请在 Git Workbench → 功能开关中启用。', moduleLabel(name)));
}
export function requirePanel(): void {
  if (!readModules().graph && !readModules().stash) throw new Error(t('提交树和 Stash 均已停用，请在 Git Workbench → 功能开关中启用。'));
}
export function commandModules(id: string): ModuleName[] {
  if (id === 'gitWorkbench.compare.close') return [];
  if (id.startsWith('gitWorkbench.compare.')) return ['comparison'];
  if (id === 'gitWorkbench.selectionHistory') return ['selectionHistory'];
  if (id === 'gitWorkbench.fileHistory') return ['fileHistory'];
  if (['gitWorkbench.blame', 'gitWorkbench.toggleBlame'].includes(id)) return ['blame'];
  if (['gitWorkbench.operations', 'gitWorkbench.stageSelection'].includes(id)) return ['operations'];
  if (id.startsWith('gitWorkbench.explorer.')) {
    const action = id.slice('gitWorkbench.explorer.'.length).replace(/^file\./, '');
    if (action === 'history') return ['explorerMenu', 'graph'];
    if (['diff', 'compareBranch', 'compareRevision'].includes(action)) return ['explorerMenu', 'comparison'];
    return ['explorerMenu', 'operations', ...(['stash', 'unstash'].includes(action) ? ['stash' as const] : [])];
  }
  return [];
}

// Consolidate the earlier per-module and six-switch preview preferences into
// the single object setting, preserving explicit values and configuration scopes.
export async function migrateModuleSettings(): Promise<void> {
  const settings = vscode.workspace.getConfiguration('gitWorkbench');
  const legacy: Record<string, ModuleName[]> = {
    log: ['graph'], history: ['selectionHistory', 'fileHistory', 'blame'], stash: ['stash'],
    comparison: ['comparison'], explorerMenu: ['explorerMenu'], operations: ['operations'],
  };
  for (const [field, scope] of [['globalValue', vscode.ConfigurationTarget.Global], ['workspaceValue', vscode.ConfigurationTarget.Workspace]] as const) {
    const current = settings.inspect<Partial<Modules>>('modules')?.[field];
    const values: Partial<Modules> = { ...current };
    const obsolete: string[] = [];
    for (const name of moduleNames) {
      const key = `modules.${name}`, value = settings.inspect<boolean>(key)?.[field];
      if (typeof value !== 'boolean') continue;
      if (values[name] === undefined) values[name] = value;
      obsolete.push(key);
    }
    for (const [name, targets] of Object.entries(legacy)) {
      const key = `features.${name}`, value = settings.inspect<boolean>(key)?.[field];
      if (typeof value !== 'boolean') continue;
      for (const target of targets) if (values[target] === undefined) values[target] = value;
      obsolete.push(key);
    }
    if (!obsolete.length) continue;
    // Persist the destination before removing any old entry.
    await settings.update('modules', values, scope);
    for (const key of obsolete) await settings.update(key, undefined, scope);
  }
}

export async function configureModules(): Promise<void> {
  const current = readModules();
  const descriptions: Record<ModuleName, string> = {
    graph: t('提交图、分支导航与提交详情'), selectionHistory: t('追溯所选代码或当前行的历史'), fileHistory: t('文件历史与重命名追踪'),
    blame: t('查看当前行提交与逐行作者标注'), comparison: t('分支、版本与工作区的文件树对比'), stash: t('Stash 列表、文件树与差异查看'),
    operations: t('插件内的提交、暂存、推拉、分支及 Stash 写操作；不影响编辑器原生 Git'), explorerMenu: t('文件、文件夹与项目的右键 Git 菜单'),
    editorMenu: t('编辑器内的右键 Git 菜单；命令入口仍可使用'), statusBar: t('状态栏 Git Workbench 按钮；功能菜单仍可使用'),
  };
  const picked = await vscode.window.showQuickPick(moduleNames.map(name => ({ name, label: moduleLabel(name), description: descriptions[name], picked: current[name] })), {
    title: t('Git Workbench · 功能开关'), placeHolder: t('勾选启用的模块；取消勾选即停用，按 Enter 保存'), canPickMany: true, ignoreFocusOut: true,
  });
  if (!picked) return;
  const enabled = new Set(picked.map(item => item.name));
  const settings = vscode.workspace.getConfiguration('gitWorkbench');
  const global = { ...settings.inspect<Partial<Modules>>('modules')?.globalValue };
  const workspace = { ...settings.inspect<Partial<Modules>>('modules')?.workspaceValue };
  let globalChanged = false, workspaceChanged = false;
  for (const name of moduleNames) {
    const value = enabled.has(name);
    if (value === current[name]) continue;
    if (workspace[name] !== undefined) { workspace[name] = value; workspaceChanged = true; }
    else { global[name] = value; globalChanged = true; }
  }
  if (globalChanged) await settings.update('modules', global, vscode.ConfigurationTarget.Global);
  if (workspaceChanged) await settings.update('modules', workspace, vscode.ConfigurationTarget.Workspace);
}
