# Kivo Git

[English](README.md) · **简体中文**

> 一个以提交图为核心的 Visual Studio Code Git 工作台。

[![CI](https://github.com/KeatonLi/kivo-git/actions/workflows/ci.yml/badge.svg)](https://github.com/KeatonLi/kivo-git/actions/workflows/ci.yml)
[![最新版本](https://img.shields.io/github/v/release/KeatonLi/kivo-git?include_prereleases&label=latest%20release)](https://github.com/KeatonLi/kivo-git/releases)
[![许可证：MIT](https://img.shields.io/github/license/KeatonLi/kivo-git)](LICENSE)

用左侧活动栏的 **Commit** 管理文件变更和提交，用底部面板的 **Kivo Git History** 浏览分支、提交图和文件历史。Kivo Git 调用本机 Git，并沿用 VS Code 的差异编辑器、文件图标、主题和键盘操作。

## 功能

### 提交工作区

- 查看 Git 工作区状态，将变更拖入自定义变更列表（changelist），按文件选择本次提交的内容。
- 单击文件预览差异，双击固定差异编辑器。支持方向键浏览、空格切换选择、Shift 范围选择。文件图标跟随当前 VS Code 图标主题。
- 最近提交默认显示 3 条，可切换至 5 条，支持按日期分组并展开查看变更文件。最近提交和历史视图都会标出尚未推送的提交。
- 从分支弹窗切换本地或远程分支，也可从本地分支、远程引用或标签创建并切换到新分支。
- 通过 **Review Commit…** 核对仓库、分支、所选文件及其差异。**Commit Locally** 保存本地提交，**Commit & Review Push…** 保存后打开推送审核，推送需单独确认。

提交按所选文件的完整内容进行，包含工作区中的修改。即使启用了 **Staged** 筛选，也会提交所选文件的工作区修改，其他文件的暂存内容会保留。筛选隐藏的选中项会保留在选择中，提交前需清除筛选以复核，或用 **Remove hidden** 取消这些选择。列表复选框作用于匹配的文件，键盘全选和范围选择作用于当前展开并可见的行。

点击 **Message** 可折叠或展开提交说明，草稿和提交操作会保留。提交表单旁会显示已选和隐藏的文件数量。没有打开 Git 仓库时，可用 **Open Folder**、**Clone Repository** 或 **Initialize Repository** 开始工作。

变更列表保存在当前工作树的 Git 目录下的 `ideagit/changelists.json`。写入采用原子操作并在多个窗口间串行执行，已跟踪文件重命名后仍保留原分组。数据无效时会报错并保留原文件。Kivo Git 会自动回收已终止的本地进程留下的锁。如果旧的或无法读取的 `changelists.json.lock` 仍存在，先关闭所有 Kivo Git 窗口并确认没有相关操作在运行，再移除该锁文件，保留 JSON 文件。

### 历史工作区

- 底部面板内显示分支和标签树、多轨提交图（Graph）、提交说明、作者及日期。选中提交可查看变更文件及其差异。
- 历史支持增量加载，可按分支、作者、时间范围和文本筛选。当前检出的分支始终显示在分支搜索框上方。
- 可拖动或用键盘调整分支树与提交列表之间的分隔线，宽度会按视图保存。
- 支持键盘导航和按需加载提交详情。可用 Ctrl/Cmd 单击、Shift 单击、Shift 加方向键或右键拖动多选提交。
- 专注模式可扩展提交图的显示空间，并记住上次设置。从行级 Blame 跳转时会自动恢复详情区域。

### 工作树（Worktree）

在 History 中打开 **Worktrees**，查看和打开已登记的工作树，使用尚未被占用的本地分支创建工作树，或通过 **New Branch Worktree from Current…** 从当前提交创建新分支及工作树。也可右键单个历史提交，选择 **New Branch in Worktree…** 从该提交开始。

确认前可核对分支、提交和目标目录。创建带新分支的工作树会在单独的 VS Code 窗口中打开，当前检出状态保持原样。如果 Git 在登记后报错，Kivo Git 会显示实际状态供检查。可查看[操作动效与预览](docs/interaction-motion.md)。

**Remove Worktree…** 会检查所选关联工作树是否干净，包括未跟踪和被忽略的文件，再显示目录、检出状态和提交供确认。移除操作只删除工作树目录，保留分支。移除前请保存编辑并关闭其他正在使用该目录的窗口。扩展没有提供强制移除操作。

切换失败时会保留失败原因、Git 详情和恢复入口。若分支已被另一个工作树检出，可直接打开对应目录。选择暂存后切换时，扩展会先检查已知阻碍。详见[切换分支与工作树恢复](docs/checkout-reliability.md)。

### 行级 Blame

在已保存文件的当前行末尾显示作者、相对时间和提交摘要。光标停稳后才查询 Git，近期结果会复用。文件有未保存修改时会隐藏标注。悬停可查看完整提交信息，通过 **Open commit in History** 跳转到历史。编辑器右键菜单中的 **Kivo Git: Show Line Blame** 也提供相关操作。

行级 Blame 默认启用。可通过命令面板中的 **Kivo Git: Toggle Inline Blame** 或设置项 `ideaGit.inlineBlame.enabled` 切换。

### 分支比较、Stash 与冲突处理

- 在 History 选中提交后右键选择 **Cherry-pick…**，确认目标检出状态和所选提交后，按父提交在前的顺序应用。开始前请提交或暂存未完成的工作。每批最多 200 个普通提交，合并提交需要指定主线父提交，当前暂未支持。
- Cherry-pick 出现冲突时，解决并暂存文件后用 **Continue** 继续，或通过 **Abort** 回到整批操作开始前的状态。如果当前提交变为空且无暂存改动，可用 **Skip empty commit**。
- 右键其他本地或远程分支，选择 **Compare with Current**，无需切换分支即可比较。文件差异按两侧分支尖端计算，两个提交标签页分别显示各自独有的提交，每侧最多 80 条。打开差异后仍可回到比较视图。
- 从 History 的操作栏或 Commit 的 **More actions** 菜单打开 **Stashes**，保存已暂存、未暂存及未跟踪的变更。可预览保存的文件，并将它们恢复到干净的工作树，同时恢复原有暂存状态。恢复后仍保留 Stash 条目，删除需单独确认。被忽略的文件留在原处。
- 工作区有未完成的变更时，可选择 **Stash and Switch** 或 **Switch with Changes**。切换失败后，已保存的 Stash 仍可用于恢复。
- Merge、Rebase、Cherry-pick 和 Revert 进行中时，Commit 和 History 会列出未解决的文件，并提供 **Open Merge Editor**、**Mark resolved**、**Continue** 和需确认的 **Abort**。继续前需暂存所有冲突文件。恢复 Stash 时产生的冲突也能在此处理，原 Stash 会保留。

合并编辑器依赖 VS Code 内置的 Git 扩展。编辑并保存解决结果后，如果文件仍在冲突列表中，可点 **Mark resolved** 暂存整个文件。Git 操作进行中，请通过 **Continue** 完成操作，普通提交此时不可用。

### 同步

- 查看领先与落后提交数，执行 Fetch、Pull 和 Push。后台自动 Fetch 会更新待拉取和待推送的提交数。
- Pull 支持仅快进（fast-forward only）、Rebase 和 Merge。
- 推送前核对目标、待推送提交和变更文件数。可展开提交查看带颜色的文件名和目录，并打开对应差异。推送被拒绝时，可用 **Fetch and Review** 重新获取远程引用并审核。
- 同步与历史视图提供加载、重试和错误反馈。动效适配主题，并支持减少动态效果的辅助功能设置。

## 安装

需要 VS Code 1.95.0 或更新版本，以及可用的 Git 命令行。可从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=KeatonLi.kivo-git) 安装，或运行：

```bash
code --install-extension KeatonLi.kivo-git
```

也可以从 [GitHub Releases](https://github.com/KeatonLi/kivo-git/releases) 下载 `.vsix`，在扩展视图的 **⋯ → Install from VSIX…** 中选取文件，或运行：

```bash
code --install-extension kivo-git-<version>.vsix
```

遇到问题可在 [GitHub Issues](https://github.com/KeatonLi/kivo-git/issues) 反馈。命令面板中的 **Kivo Git: Review Diagnostic Summary** 可预览并复制扩展、VS Code 和 Git 的版本，以及扩展宿主的系统和架构信息。摘要不含仓库内容、路径、远程地址或日志，Kivo Git 不会上传这份摘要。

## 本地开发

```bash
npm install
npm run compile
```

在 VS Code 中打开项目文件夹，按 `F5` 启动扩展开发宿主。在新窗口打开一个 Git 仓库，点击左侧活动栏的 **Kivo Git** 进入 **Commit**。用 `Ctrl/Cmd+J` 打开底部面板，再选择 **Kivo Git History** 查看历史与提交图。命令面板也提供 **Kivo Git: Show Changes** 和 **Kivo Git: Show History**。

视图可见时，Kivo Git 默认每分钟后台获取一次远程引用。手动刷新也会检查远程引用，VS Code Git 的变动会及时刷新分支列表。可通过 `ideaGit.autoFetch` 和 `ideaGit.autoFetchInterval` 调整后台获取设置。扩展激活后会提前准备所选仓库的本地状态和历史快照，并在视图隐藏时保持本地快照更新。

在 Commit 中选中文件后，可用 **Rollback…** 预览并确认丢弃范围。已跟踪文件及其暂存修改会还原至 `HEAD`，新文件会移至系统回收站。未选中的文件和提交说明会保留。

本地检查、测试和打包命令如下：

```bash
npm run check
npm test
npm run package
```

## 发布测试版本

在干净的 `main` 分支上运行：

```bash
npm run release -- <version>
```

发布脚本会校验仓库和版本，更新变更日志中的 Unreleased 部分，执行检查、测试和 VSIX 打包，并推送版本提交。该提交在 `main` 上通过 CI 后，GitHub Actions 会创建对应标签，并发布 VSIX 与 SHA-256 校验和。预发布版本号会作为 GitHub 预发布版本发布。

已发布版本保持不变。如果现有标签或发布附件不完整或不一致，请排查后发布新版本。工作流会在打包前和创建标签前确认已测试的提交仍位于 `main` 顶端。如果 `main` 已有更新，旧运行会跳过发布，需等待新提交的 CI。维护者可通过分支保护规则协调发布期间的推送。

## 设计与项目状态

Kivo Git 借鉴 IDE 中的变更列表和历史浏览方式。图标将字母 K 和提交图结合，便于在面板和扩展列表的较小尺寸下识别。Git 操作沿用本机 `git`，可连接 GitHub、GitLab、Gitee、Bitbucket 和内部远程仓库，扩展本身无需保存凭据。

项目处于开源 MVP 阶段，核心工作流可供试用，交互细节和 Git 功能覆盖仍在迭代。产品设计与路线图见 [DESIGN.md](docs/DESIGN.md)，任务列表、发布阶段和完成标准见 [TODO.md](docs/TODO.md)。

## 许可证

[MIT](LICENSE)
