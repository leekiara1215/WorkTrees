# WorkTrees Lite

一个本地 Git Worktree 桌面管理器，支持创建、目录/命名配置、列表/搜索/筛选、异常识别、重建与安全删除。交互参考本机 Kepler，代码独立实现。

当前正式版本：**v1.0.0**；当前源码开发版本：**v1.1.0**。发布说明见 [CHANGELOG.md](CHANGELOG.md)。

## 下载

从 [GitHub Releases](https://github.com/leekiara1215/WorkTrees/releases) 下载 macOS Apple Silicon（arm64）应用压缩包，解压后打开 `WorkTrees Lite.app`。使用应用需要本机已安装 Git，无需 Node.js 或 Kepler。

当前应用未签名、未公证，适合本机使用；从互联网下载时 macOS 可能提示无法验证开发者。Windows、Linux、Intel Mac 暂未验收。

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

产物在 `release/v<版本号>/`，可直接打开，不需要开发服务器。首次打开应用无需导入任何真实仓库。

v1.0.0 的 macOS Apple Silicon 应用路径：`release/v1.0.0/WorkTrees Lite-darwin-arm64/WorkTrees Lite.app`。当前构建使用 Electron 45.3.3；无需安装或启动 Kepler。

## 使用

1. 导入一个已有的本地 Git 仓库。
2. 点击新建 Worktree，选基准分支、填写分支名；也可点击“自动生成”获取名称。
3. 查看完整分支名和目录预览，确认创建。
4. 在列表中按仓库、分支/路径文字、状态筛选，随时刷新磁盘状态。
5. 在设置中调整 Worktree 根目录、全局前缀、闲置阈值；仓库可以继承或覆盖分支前缀。
6. 应用创建的 Worktree 如果目录丢失，可查看重建预览，再确认恢复到记录中的路径。分支不存在时会明确显示从基准重建。

默认根目录为 `~/WorktreesLite`，分支前缀为 `wt/`。根目录支持 `<REPOSITORY_NAME>`、`<REPOSITORY_PATH>` 变量。例如 `/path/to/worktrees/<REPOSITORY_NAME>`。名称和目录以创建预览为准。用户数据只保存在应用的本地 userData 目录。

重建不会覆盖现有目录，也无法找回已经丢失的未提交修改。主仓库 checkout 与外部 Worktree 会被标记。v1.1.0 为非主 Worktree 提供安全删除入口，默认保留分支，锁定条目需要先自行检查锁定原因。

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
