# WorkTrees Lite

一个本地 Git Worktree 桌面管理器，支持创建、目录/命名配置、列表/搜索/筛选、异常识别、重建与安全删除。交互参考本机 Kepler，代码独立实现。

当前正式版本为 **v1.2.1**。参见 [发布记录](CHANGELOG.md)。

## 下载

从 [v1.2.1 发布页](https://github.com/leekiara1215/WorkTrees/releases/tag/v1.2.1) 下载 macOS Apple Silicon（arm64）DMG，打开后把 `WorkTrees Lite.app` 拖入「应用程序」。[v1.0.0 应用压缩包](https://github.com/leekiara1215/WorkTrees/releases/tag/v1.0.0) 仍可下载。使用应用需要本机已安装 Git。

v1.1.1 起的 macOS 内部测试构建使用完整 ad-hoc 签名并校验嵌套代码及资源完整性；没有 Developer ID 身份签名或 Apple 公证，不保证下载后自动通过 Gatekeeper。接收人首次打开时，确认来源可信后可按 [Apple 官方说明](https://support.apple.com/zh-cn/102445)，在“系统设置 → 隐私与安全性”中选择“仍要打开”。旧 v1.1.0 包存在 Electron 残留签名无效的问题，请改发新版内部测试包。Windows、Linux、Intel Mac 暂未验收。

## 运行

需要 Node.js 22.12+ 和可用的 Git；开发环境已使用 Node.js 26 验证。

```sh
npm install
npm run dev
```

构建后启动：

```sh
npm run build
npm start
```

生成当前平台的独立桌面应用（macOS 为 `.app`）：

```sh
npm run package
```

生成「星际投递」主题的 macOS 内部测试 DMG，并放入下载目录。打开后，沿星光航线将 WorkTrees Lite 从发射台拖到右侧的 Applications 停靠舱。[内部测试安装说明](resources/INSTALL-internal.zh-CN.txt) 单独保留，不占用安装窗口。打包须在已登录的 macOS 桌面中运行，需要 Xcode 命令行工具，首次提示时允许终端控制 Finder：

```sh
npm run package:dmg -- ~/Downloads
```

文件名包含 `internal` 和架构；打包会验证签名、DMG 校验和、挂载后应用的签名及资源一致性，并生成 `.sha256` 文件。ad-hoc 签名只校验完整性，不等于 Apple 已认可开发者或通过公证。分发给普通用户且希望通过系统分发检查时，需要另行配置 Developer ID 签名和 Apple 公证。

产物在 `release/v<版本号>/`，可直接打开，不需要开发服务器。首次打开应用无需导入任何真实仓库。

v1.0.0 的 macOS Apple Silicon 应用路径：`release/v1.0.0/WorkTrees Lite-darwin-arm64/WorkTrees Lite.app`。当前构建使用 Electron 45.3.3；无需安装或启动 Kepler。

## 使用

1. 导入一个已有的本地 Git 仓库。
2. 点击新建 Worktree，选基准分支、填写分支名；也可点击“自动生成”获取名称。
3. 查看完整分支名和目录预览，确认创建。
4. 在列表中按仓库、分支/路径文字、状态筛选，随时刷新磁盘状态。
5. 在「偏好设置」中调整 Worktree 根目录、全局前缀和闲置阈值，修改会自动保存。每个仓库有独立一行，可选择继承全局、不使用前缀或自定义前缀，也可从列表移除。重新导入同一路径会恢复已保存的仓库设置和 Worktree 记录。
6. 应用创建的 Worktree 如果目录丢失，可查看重建预览，再确认恢复到记录中的路径。分支不存在时会明确显示从基准重建。
7. 在「偏好设置 → 主题色」点选配色，界面立即换色并自动保存选择。
8. 创建失败后可在创建预览中重试同名 Worktree。缺失条目在目录和 Git 注册均已移除时可单独移除应用记录。创建和重建等待超过 30 秒时可选择下次提醒时间、等到完成或取消任务。

默认根目录为 `~/WorktreesLite`，分支前缀为 `wt/`。根目录支持 `<REPOSITORY_NAME>`、`<REPOSITORY_PATH>` 变量。例如 `/path/to/worktrees/<REPOSITORY_NAME>`。名称和目录以创建预览为准。用户数据只保存在应用的本地 userData 目录。

重建不会覆盖现有目录，也无法找回已经丢失的未提交修改。主仓库 checkout 与外部 Worktree 会被标记。v1.1.0 为非主 Worktree 提供安全删除入口，默认保留分支，锁定条目需要先自行检查锁定原因。

删除含子模块的 Worktree 时，会逐个展示子模块的当前分支/游离 HEAD、提交及本地文件状态。比较基准为创建 Worktree 时记录的基准分支当前提交；外部 Worktree 使用仓库配置的默认分支，不会自动拉取远程。与基准提交相同的子模块不提供放弃分支选项；存在差异或无法确认提交关系的子模块默认保留，可逐项勾选不保留当前分支或游离提交。未提交、未跟踪及忽略文件需要对每个子模块单独确认丢弃，保留分支不能恢复这些文件。

保留会先把子模块的 Git 数据写入应用 userData 目录下的 `submodule-backups/<操作 ID>/*.git` 独立裸仓库，校验引用和对象连通性后再删除目录。其他分支、标签及 stash 历史会保留，备份不依赖原仓库的对象目录；确认放弃的仅是该子模块的当前分支或游离提交，其他引用仍可能保留相同提交。删除结果提供备份路径、查看及复制入口；可使用 `git clone <备份路径> <恢复目录>` 恢复保留的当前提交和本地分支，其他引用及 stash 历史仍可在备份仓库内通过 `git show`、`git reflog show refs/stash` 读取。备份会持续保留，需要时由用户自行清理。

支持递归子模块、未初始化或工作目录缺失的子模块，以及整个 Worktree 目录缺失后的子模块数据保留。未登记的嵌套仓库、无法确认身份的 Git 链接、遗留但未登记的子模块管理数据、锁定或正在合并/变基的子模块会阻止删除。保留失败不会开始删除；执行前会重新校验文件、索引、引用及基准状态，发生变化时需要重新预览和确认。

重建针对本应用创建并保留记录的 Worktree；外部 Worktree 目前只发现和展示。闲置标签根据目录、`.git` 的修改时间与最近提交时间估算，不保证识别所有文件内的原地编辑。

## 首版范围

- 已包含：导入仓库、Git Worktree 创建、命名与路径设置、持久登记、发现外部 Worktree、分组与筛选、缺失识别、重建预览与执行、可重试错误。
- v1.1.0：安全删除 Worktree、可选删除分支，以及偏好设置中的系统目录选择器。
- 后续版本：代码 diff、同步/Rebase/Merge/Push、自动初始化命令和批量清理。没有 agent/session 或聊天能力。
- 当前筛选聚焦全部、闲置、缺失、锁定与异常。同步冲突判断随对应后续功能加入。

## 验证

```sh
npm run typecheck
npm test
npm run build
```

集成测试在临时 Git 仓库和临时数据目录执行，不写入用户实际项目。验收情况见 `docs/QA.md`。

## 开发结构

- `src/main/`：桌面壳、受限 IPC、Git 调用和本地数据。
- `src/renderer/`：React 界面。
- `src/shared/types.ts`：前后端接口。
- `docs/ARCHITECTURE.md`：实现结构与数据边界。
- `docs/QA.md`：测试范围与验收记录。

应用无账户、云服务或遥测。renderer 不开放通用 shell/文件系统权限，Git 命令通过参数数组调用。
