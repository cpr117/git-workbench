# Orbit Git

为 VS Code、Cursor 和 Qoder 提供接近 GoLand 的 Git 工作流：**分支 → 提交 → 文件 → Diff**。

[下载插件与源码](https://github.com/cpr117/git-workbench/releases/latest) · [问题反馈](https://github.com/cpr117/git-workbench/issues) · [MIT License](LICENSE)

## 安装与打开

需要桌面版 VS Code 1.95+ 或兼容编辑器、本地 Git 2.28+，以及受信任的 Git 工作区。

1. 在 [Releases](https://github.com/cpr117/git-workbench/releases/latest) 下载 `.vsix`。
2. 在扩展面板的 `…` 中选择 **从 VSIX 安装**，安装后重新加载编辑器。
3. 打开 Git 项目，点击状态栏 **Orbit Git**，或运行命令 **Orbit Git: 打开功能菜单**。

打开提交图的快捷键：macOS `Cmd+Alt+G`，Windows / Linux `Ctrl+Alt+G`。

macOS 12+ 本地工作区默认使用原生小窗；Windows、Linux 和远程工作区自动使用标签页。首次打开小窗失败时也会使用标签页，并提示原因。需要始终使用标签页时可设置：

```json
"gitWorkbench.historyPresentation": "editor"
```

## 扩展标识与菜单名称

插件显示名为 **Orbit Git**，Marketplace 发布者标识为 `PRCooper`，扩展 ID 为 `PRCooper.orbit-git`。GitHub 源码仓库仍为 `cpr117/git-workbench`，两个身份不需要同名。右键菜单、命令分类和状态栏统一显示 **Orbit Git**，原有 `gitWorkbench.*` 设置继续使用。

从旧版 `local-tools.git-workbench` 或本地预览版 `cpr117.orbit-git` 切换时，请先卸载旧扩展再安装新版本，避免出现重复菜单。

## 界面语言

插件跟随编辑器的显示语言：中文环境使用简体中文，英文环境使用英文，其他语言暂回退到英文。通过编辑器的 **Configure Display Language / 配置显示语言** 切换并重新加载后生效，无需另设插件语言。

命令、设置说明、Git 面板、对比树及历史小窗使用同一语言。分支名、路径、作者、提交信息、代码和 Git 原始输出保持原样。这里跟随的是应用显示语言，与当前文件的编程语言无关。

## 常用功能

| 功能 | 使用方法 |
| --- | --- |
| 提交树 | 打开底部 **Git** 面板，与终端并列；左侧选分支，中间选提交，右侧选文件查看原生 Diff |
| 筛选历史 | 按分支、提交信息、作者、日期或路径筛选；列表底部可继续加载 |
| 多提交比较 | `Shift` 连续多选，`Cmd / Ctrl` 点击增减；选中文件查看累计改动 |
| 整个项目比较 | 右键 Git 面板左侧分支 → **与当前分支比较** 或 **与工作区比较（整个仓库）** |
| 文件 / 目录比较 | 资源管理器右键文件 / 文件夹 / 项目 → **Orbit Git** → **显示差异 / 与指定版本比较 / 与分支比较** |
| 选区历史 | 选中代码后右键 → **Orbit Git** → **查看选区 / 当前行历史**；不选代码则追溯当前行 |
| 文件历史与作者 | 编辑器右键 → **Orbit Git** → **查看文件历史 / 查看当前行提交 / 切换逐行作者标注** |
| Stash | 底部 **Git → Stash**：左侧选记录，右侧按目录选文件打开原生 Diff；右键提供恢复、删除和在新标签页查看差异 |
| 更改与提交 | 点击底部 Git 的 **更改 ↗**，打开原生源代码管理；文件树、Diff、暂存、提交及 Amend 均使用编辑器原生界面 |
| 其他 Git 操作 | **打开功能菜单 → 仓库 Git 操作**，或右键提交、分支、项目选择对应操作 |

### 比较方式

- **多选提交**：从“最旧所选提交的父版本”比较到“最新所选提交”，包含最旧那次提交及区间内的中间修改。恰好选择两个提交时，也可点击 **仅比两个快照**。
- **分支与当前分支比较**：比较两个已提交快照，不包含本地改动。
- **分支与工作区比较**：包含已暂存、未暂存和未跟踪文件，范围为所选 Git 仓库。
- **目录比较**：左侧源代码管理顶部显示 **对比** 文件树，右侧使用编辑器原生 Diff。关闭对比标签页后，文件树自动隐藏。

对比树的 `…` 菜单支持树形 / 列表切换、按名称 / 路径 / 状态排序；工具栏支持搜索、刷新和全部折叠。

### 历史小窗

小窗展示提交列表和左右代码差异，支持多选、差异导航、同步滚动、仅显示改动和原始补丁。不支持小窗的环境会隐藏小窗切换按钮；手动切换小窗失败时，保留原标签页与所选版本。右上角可切换到标签页；切换应用时，小窗随所属编辑器隐藏或恢复。

选区历史支持已保存、已暂存及未保存的本地修改：先将代码范围映射回 HEAD，再追溯已提交历史。纯新增代码没有对应历史；复杂移动、重命名和合并受 Git 追踪能力限制。

### Stash

**Apply** 恢复并保留记录，**Pop** 恢复成功后删除记录；发生冲突时保留 Stash。**Unstash…** 可选择是否恢复原暂存状态（`--index`）、是否删除记录，也可从原始基线恢复到新分支。同路径的未跟踪文件和暂存区独有改动会单独标明来源。

从原生“更改”、终端或其他工具创建、恢复或删除 Stash 后，列表自动更新；切入 Stash、面板重新显示或返回编辑器时也会补查。列表未变化时保留当前详情。

### Git 操作

支持分支 / 标签管理、Checkout、Cherry-pick、Revert、Merge、Rebase、Reset、Fetch / Pull / Push、Stash、冲突继续 / 中止、远端配置与 Reflog 恢复。

资源管理器右键单个文件、文件夹或项目，**Orbit Git** 菜单提供对应范围的提交、暂存、回滚、Stash 和本地排除规则；单文件可直接比较指定版本 / 分支并查看文件历史。提交文件只包含该文件当前已保存的内容，其他已暂存文件不纳入。同步、合并及 Unstash 等仓库级操作作用于所选资源所属的整个仓库。范围 Stash 前，其他文件若有已暂存改动，会提示先取消这些文件的暂存，避免误带入记录。重命名涉及范围外路径时，请在共同父目录执行写操作。

写操作会提示目标与影响。远端认证沿用 Git 凭据助手或 SSH Agent；需要交互认证时，请先在终端完成登录。发生冲突后保留现场，解决并暂存后继续，或选择中止。

## 设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `gitWorkbench.historyPresentation` | `popup` | macOS 本地优先小窗；不支持的环境或首次小窗启动失败时自动使用标签页。`editor` 始终使用标签页 |
| `gitWorkbench.comparisonViewMode` | `tree` | `tree` 树形；`list` 列表 |
| `gitWorkbench.comparisonIconStyle` | `file` | `file` 文件图标（与更改一致）；`status` 变更状态图标。在“对比”的 **…** 菜单中切换并保存 |
| `gitWorkbench.comparisonSortOrder` | `path` | `path` 路径；`name` 名称；`status` 状态 |

## 开发

需要 Node.js 22+ 与 Git。构建 macOS 原生小窗还需要 Xcode Command Line Tools。

构建工具的认证依赖通过 `overrides` 临时固定为已检查的版本，发布使用独立的 OIDC 路径。该覆盖低于新版打包工具声明的 Azure Identity 范围；更新依赖或使用 Azure 凭据登录前，应重新检查兼容性与 `npm audit`。这些开发依赖不包含在 VSIX 中。

```sh
git clone https://github.com/cpr117/git-workbench.git
cd git-workbench
npm ci
npm run compile
npm test
npm run package # 包含 macOS 原生组件构建，在 macOS 执行
```

### GitHub Actions 发布

在个人仓库的 **Actions → Package and publish Orbit Git → Run workflow** 中选择 `main`。默认只验证并生成 VSIX 与 SHA256 校验值，产物保留 14 天；勾选 `publish` 才上传 Marketplace，`pre_release` 默认开启。发布使用同次构建并校验后的安装包，不会再次打包。

Marketplace 的 `PRCooper` 发布者需将 Trusted Publishing 绑定到 `cpr117/git-workbench` 的 `publish.yml`，Environment 留空。仅发布任务拥有 OIDC 临时令牌权限，不需要保存 PAT。正式版与已上架的预发布版必须使用不同版本号。

通过编辑器的 Extension Development Host 加载本项目进行调试。源码 ZIP 包含实现、测试和构建脚本；发行附件提供 VSIX、源码及 SHA256SUMS。

## 指南网站

[guide/](guide/) 包含功能介绍、交互演示和使用指南，与插件一起按 MIT 开源，打包 VSIX 时排除该目录。

```sh
npm --prefix guide run build
python3 guide/tools/preview.py
```

打开 `http://127.0.0.1:4199/`。更多说明见 [网站 README](guide/README.md)。

## 已知限制与排错

- 已在 macOS Cursor / Qoder 验证部分交互；Windows、Linux、Remote SSH 和 Dev Container 尚未独立实机验收。详见 [验证范围](docs/validation.md)。
- 原生小窗仅支持 macOS 12+ 本地工作区，采用 ad-hoc 签名，尚未完成 Apple 公证；其他平台自动使用标签页。
- 尚未覆盖 GoLand 全部功能，例如图形化交互式 Rebase、三栏冲突合并、Shelf / Changelists；历史小窗尚无语法高亮。
- 二进制、LFS、子模块专用查看器和 worktree 创建 / 删除尚未实现。

Stash 会自动同步外部变化；其他仓库信息需要时点击刷新。出错时打开 **输出 → Orbit Git** 查看日志；大型仓库或慢速网络超时后，请在终端检查 Git 状态。

插件没有遥测、在线服务或运行时 npm 依赖；Git 命令在扩展宿主所在机器执行。

## 功能开关

命令面板打开 **Orbit Git → 功能开关**，或点击 Git 面板的齿轮。全部默认启用，修改立即生效，无需重载；也可在编辑器设置中搜索 `gitWorkbench.modules`，在同一个列表里勾选模块。

| 开关后缀 | 控制内容 |
| --- | --- |
| `graph` | 提交树、分支导航和提交详情 |
| `selectionHistory` | 选区与当前行历史 |
| `fileHistory` | 文件历史与重命名追踪 |
| `blame` | 当前行提交与逐行作者标注 |
| `comparison` | 文件、目录、分支对比与对比文件树 |
| `stash` | Stash 浏览、操作与自动刷新 |
| `operations` | 插件内所有 Git 写操作，包含 Stash 写入 |
| `explorerMenu` | 文件、文件夹与项目右键菜单 |
| `editorMenu` | 编辑器右键菜单 |
| `statusBar` | 状态栏 Orbit Git 入口 |

关闭菜单或状态栏入口仍可通过命令面板管理模块。关闭历史或对比时，相应的已打开视图会关闭；关闭作者标注会清除现有标注。关闭 Git 写操作不影响编辑器原生 Git，已经启动的 Git 进程会继续完成。

模块统一保存在 `gitWorkbench.modules` 对象中。升级时自动合并旧版逐项开关，保留勾选状态与用户／工作区作用域，并删除旧键。
