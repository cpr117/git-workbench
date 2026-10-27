# Git Workbench

为 VS Code、Cursor 和 Qoder 提供接近 GoLand 的 Git 工作流：**分支 → 提交 → 文件 → Diff**。

[下载插件与源码](https://github.com/cpr117/git-workbench/releases/latest) · [问题反馈](https://github.com/cpr117/git-workbench/issues) · [MIT License](LICENSE)

## 安装与打开

需要桌面版 VS Code 1.95+ 或兼容编辑器、本地 Git 2.28+，以及受信任的 Git 工作区。

1. 在 [Releases](https://github.com/cpr117/git-workbench/releases/latest) 下载 `.vsix`。
2. 在扩展面板的 `…` 中选择 **从 VSIX 安装**，安装后重新加载编辑器。
3. 打开 Git 项目，点击状态栏 **Git Workbench**，或运行命令 **Git Workbench: 打开功能菜单**。

打开提交图的快捷键：macOS `Cmd+Alt+G`，Windows / Linux `Ctrl+Alt+G`。

历史默认使用 macOS 12+ 原生小窗。Windows、Linux 和远程工作区请在设置中切换为标签页：

```json
"gitWorkbench.historyPresentation": "editor"
```

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
| 目录比较 | 资源管理器右键文件夹 / 项目 → **Git** → **显示差异 / 与指定版本比较 / 与分支比较** |
| 选区历史 | 选中代码后右键 → **Git Workbench** → **查看选区 / 当前行历史**；不选代码则追溯当前行 |
| 文件历史与作者 | 编辑器右键 → **Git Workbench** → **查看文件历史 / 查看当前行提交 / 切换逐行作者标注** |
| 工作区操作 | 底部 Git 的 **工作区** 页支持查看改动、暂存、取消暂存、Commit 和 Amend |
| 其他 Git 操作 | **打开功能菜单 → Git 操作**，或右键提交、分支、项目选择对应操作 |

### 比较方式

- **多选提交**：从“最旧所选提交的父版本”比较到“最新所选提交”，包含最旧那次提交及区间内的中间修改。恰好选择两个提交时，也可点击 **仅比两个快照**。
- **分支与当前分支比较**：比较两个已提交快照，不包含本地改动。
- **分支与工作区比较**：包含已暂存、未暂存和未跟踪文件，范围为所选 Git 仓库。
- **目录比较**：左侧源代码管理顶部显示 **对比** 文件树，右侧使用编辑器原生 Diff。关闭对比标签页后，文件树自动隐藏。

对比树的 `…` 菜单支持树形 / 列表切换、按名称 / 路径 / 状态排序；工具栏支持搜索、刷新和全部折叠。

### 历史小窗

小窗展示提交列表和左右代码差异，支持多选、差异导航、同步滚动、仅显示改动和原始补丁。右上角可切换到标签页；切换应用时，小窗随所属编辑器隐藏或恢复。

选区历史支持已保存、已暂存及未保存的本地修改：先将代码范围映射回 HEAD，再追溯已提交历史。纯新增代码没有对应历史；复杂移动、重命名和合并受 Git 追踪能力限制。

### Git 操作

支持分支 / 标签管理、Checkout、Cherry-pick、Revert、Merge、Rebase、Reset、Fetch / Pull / Push、Stash、冲突继续 / 中止、远端配置与 Reflog 恢复。

资源管理器中的 **Git** 菜单还提供目录范围的提交、暂存、回滚、Stash 和本地排除规则。同步、合并等仓库级操作作用于该目录所属的整个仓库。

写操作会提示目标与影响。远端认证沿用 Git 凭据助手或 SSH Agent；需要交互认证时，请先在终端完成登录。发生冲突后保留现场，解决并暂存后继续，或选择中止。

## 设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `gitWorkbench.historyPresentation` | `popup` | `popup` 原生小窗；`editor` 编辑器标签页 |
| `gitWorkbench.comparisonViewMode` | `tree` | `tree` 树形；`list` 列表 |
| `gitWorkbench.comparisonSortOrder` | `path` | `path` 路径；`name` 名称；`status` 状态 |

## 开发

需要 Node.js 22+ 与 Git。构建 macOS 原生小窗还需要 Xcode Command Line Tools。

```sh
git clone https://github.com/cpr117/git-workbench.git
cd git-workbench
npm ci
npm run compile
npm test
npm run package # 包含 macOS 原生组件构建，在 macOS 执行
```

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
- 原生小窗仅支持 macOS 12+ 本地工作区，采用 ad-hoc 签名，尚未完成 Apple 公证；其他平台需显式选择 `editor` 模式。
- 尚未覆盖 GoLand 全部功能，例如图形化交互式 Rebase、三栏冲突合并、Shelf / Changelists；历史小窗尚无语法高亮。
- 二进制、LFS、子模块专用查看器和 worktree 创建 / 删除尚未实现。

在其他工具修改仓库后，点击刷新。出错时打开 **输出 → Git Workbench** 查看日志；大型仓库或慢速网络超时后，请在终端检查 Git 状态。

插件没有遥测、在线服务或运行时 npm 依赖；Git 命令在扩展宿主所在机器执行。
