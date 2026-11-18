# WorkTrees Lite 集成验证

## v1.1.1 内部测试分发验收

- 复现旧 v1.1.0 应用签名验证失败：`code has no resources but signature indicates they must be present`。旧签名标识仍为 Electron，Info.plist 未绑定且没有完整资源封装。
- macOS 打包显式使用 `@electron/osx-sign` 完成 ad-hoc 签名，随后严格验证整个应用及嵌套组件，检查应用标识与资源封装；签名失败不会产出成功结果。
- 新增四项真实 macOS 签名测试：完整应用及嵌套 helper 可通过校验；顶层资源篡改、嵌套资源篡改、替换成未完整封装的二进制均被拒绝。完整回归 78 项通过、0 失败。TypeScript、脚本语法检查和生产构建通过。
- 内部测试 DMG 校验和正确；只读挂载后再次通过应用签名校验，app.asar 和 CodeResources 与源构建一致。安装窗口仅显示应用和带自定义图标的 Applications 替身；首次打开说明见 README，校验文件随包输出。
- 对打包后的 v1.1.1 应用使用临时 profile 和真实临时仓库完成启动、子模块删除确认与备份结果展示验证。
- 从只读挂载的 DMG 启动应用，使用临时配置和 Git 仓库验证六种配色、全局即时换色、重启恢复、保存失败回退，以及最小窗口下的偏好设置布局。切换期间保留搜索内容和设置草稿。
- 本构建无 Developer ID 身份签名和 Apple 公证，`spctl --assess` 仍为 rejected；完整性验证成功不代表 Gatekeeper 自动接受。接收人首次打开可能需要按 Apple 的“仍要打开”流程手动允许，未声称已完成其他电脑的实机验收。

## 子模块安全删除增量验收

- 最终完整回归：73 项通过、0 失败、0 跳过；应用及测试的 TypeScript 检查、生产构建、macOS arm64 打包均通过。
- 打包应用使用独立临时 profile 和真实临时仓库完成界面验证：相同模块隐藏放弃选项，差异模块独立勾选，脏文件未确认时删除禁用；切换分支删除选项后确认被清空；实际删除后分支可从备份读取，结果显示三个模块的备份路径及查看/复制入口。
- `tests/submodule-delete.test.ts` 使用独立临时 Git 仓库验证相同子模块无额外提交确认即可删除；差异分支及游离 HEAD 默认保留；多个子模块可分别放弃当前分支，其他分支、标签和完整 stash 历史仍被保留。
- 验证相同提交但存在已跟踪、未跟踪或忽略文件时仍需要逐模块确认；伪造、重复或对相同模块提交的放弃选择被后端拒绝。
- 验证 HEAD、引用、本地文件变化会使预览失效；已暂存的 gitlink 修改计入父仓库的未提交风险。
- 覆盖未初始化、子模块目录缺失、整个 Worktree 目录缺失、递归子模块、旧式内嵌 `.git`、关联 Worktree 子模块的注册清理与锁定保护。
- 删除原始数据后检查备份仍可读取对象、通过 fsck 并克隆出保留的当前提交；备份没有 alternates，不依赖原仓库的对象数据。
- 人为阻塞备份路径验证保留失败不会删除目录；未登记嵌套仓库和已移除模块残留的 Git 管理数据仍被拦截。
- 验证 SHA-256 仓库备份保留对象格式；放弃分支后其他符号引用仍能保留其提交；管理目录被重定向到无关共享仓库时拒绝操作。

## v1.1.0 增量验收

- 最终完整回归：53 项通过、0 失败；TypeScript 检查、生产构建与 macOS arm64 打包通过。
- 新增 `tests/worktree-delete.test.ts`：26 项真实临时 Git 仓库测试，覆盖主 checkout、锁定保护、外部 Worktree、默认保留分支、可选删除分支、独有提交、其他本地/远程/标签引用保留提交、游离 HEAD、未提交/未跟踪/忽略文件、预览失效、目录替换、符号链接、嵌套仓库、索引隐藏标记与子模块、缺失注册清理、并发双删及部分成功反馈。
- 部分成功测试分别使用分支 ref 锁文件和应用配置原子写入失败，核实目录已删除时不谎报整体失败，也不隐藏分支或持久化警告。
- 打包应用使用独立临时 profile 和临时 Git 仓库完成 UI 验收：根路径“选择目录”打开系统选择器，取消保留原值，选中填入草稿，“保存全局设置”后持久化正确。
- 列表主 checkout 没有删除按钮，锁定 Worktree 的按钮禁用并展示锁定原因。
- 打开有 1 项已跟踪修改、1 个未跟踪文件的删除预览，统计与实际文件一致；风险未确认时提交禁用，确认后启用，切换“同时删除本地分支”会重新检查并清空风险确认。
- UI 验收在删除预览点击取消，核实条目、脏文件和锁定的相邻目录全部保留。实际删除行为由上述真实 Git 集成测试验证。
- 对目录执行完整安全检查时，如果内容超过 250,000 项或扫描超过 20 秒，将保守拒绝删除；隐藏索引状态及未登记嵌套 Git 仓库需先在 Git 中处理。子模块删除行为见上方增量验收。
- 预检与最终 Git 操作无法对外部进程写入提供全局事务锁；应用请求串行执行，执行前重新检查 token，可选分支删除额外比较原提交 OID。

验证日期：2026-11-17。服务层测试针对无 Electron 依赖的 `createWorktreeService({ dataDir })` 公开接口；主统筹另完成下述桌面验收。

## 运行

```sh
npm test
```

命令由项目配置解析为 `tsx --test tests/*.test.ts`。需要本机 Node、Git 及已安装的项目依赖；测试不联网、不安装依赖。

测试自身的独立类型检查：

```sh
node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution Bundler --allowImportingTsExtensions --types node tests/fixtures.ts tests/worktree-service.test.ts
```

## 当前结果

- 集成测试：27 通过，0 失败，0 跳过，约 11.5 秒；已按最终模板/原始分支契约回归。
- 测试及其后端依赖的独立 TypeScript 检查：通过。
- 运行环境：Node v26.12.0，Git 2.54.0（Apple Git-157），macOS。
- 两项首轮契约缺陷已由后端线程修复：模板错误替换合法名称中的空格；默认前缀掩盖原始非法分支名 `-bad`。QA 未修改后端实现，相关原始断言均保留。
- 当前没有已确认但未修复的可复现服务层 bug。

两项已修复问题的定向回归命令（在当前实现应通过）：

```sh
node_modules/.bin/tsx --test --test-name-pattern='root template|branch input' tests/worktree-service.test.ts
```

## 覆盖

- 导入：主 checkout、已有关联 worktree、子目录/关联 checkout 重复导入去重、非 Git 与缺失目录拒绝。
- 配置：全局前缀，仓库继承、清空、自定义、恢复继承；根目录中两个变量的展开；Unicode 仓库名称持久化。
- 校验：非法 Git 分支、路径穿越、控制字符、参数式分支名、缺失/非法基准分支、已存在或已 checkout 的分支。
- 创建：真实 Git 分支与 worktree、指定基准分支、原 checkout 保持、预览只读、元数据跨服务重启保留。
- 防覆盖：模板根路径下的非空目录、空目录、符号链接；规范化后可能碰撞的分支名称不得复用已有 checkout。
- 刷新：应用外创建/移除 worktree、锁定原因、外部条目不会误标为应用管理。
- 异常：应用记录对应目录被移除，Git 注册清理后仍可识别；仓库消失保留诊断并拒绝操作。
- 重建：保留现有分支提交内容；分支也消失时从记录基准分支重建并给出警告；目标目录非空或为空时均拒绝覆盖；基准分支也消失时保留记录，恢复基准分支后可重试；分支被其他 worktree 占用时拒绝且保留对方未提交文件；缺失目录仍被锁定时拒绝，显式解锁后可恢复。
- 串行化：并发设置与仓库更新无丢失，三个并发创建均可持久化，同分支并发创建只有一次成功。
- 持久化：真实 JSON 可解析；设置、仓库配置、worktree ID/baseBranch 保留；移除应用仓库记录不改 Git worktree 注册。
- 闲置：真实外部 checkout 的目录/index 活动时间设为 60 天前，30 天阈值判闲置，90 天阈值判活跃；新创建 checkout 活跃。

## 安全隔离与边界

`tests/fixtures.ts` 在系统临时目录生成真实仓库与独立 dataDir，并在每个测试结束清理。Git 通过 execFile 参数调用，提交使用 QA 身份，禁用 hooks 和全局 Git 配置；不在项目源码仓库执行任何 Git 写操作。

本轮不覆盖 Electron IPC、窗口与 UI 交互、打包产物、Git 缺失/超时、跨进程多实例竞争、掉电中断、Windows/Linux 差异。创建/重建及元数据持久化使用真实文件系统和 Git；未使用 Git mock。

活动时间是目录、`.git` 的 mtime 与最近提交时间的最大值，不保证识别所有未暂存文件的原地编辑。`<REPOSITORY_NAME>` 必须保留合法名称中的空格，生成叶目录的 slug 可另行规范化。原始分支名和加前缀后的完整分支名均须通过 Git 校验；原始 `-bad` 在默认 `wt/` 前缀下仍须拒绝。

## 桌面与打包验收（主统筹）

- `npm run build`：renderer/main TypeScript 检查与 Vite 生产构建通过，无构建警告。
- `npm run package` 的打包步骤：已生成 `release/WorkTrees Lite-darwin-arm64/WorkTrees Lite.app`；最终运行时为 Electron 45.3.3。
- `npm audit`：0 个漏洞。运行时下载以官方 npm 包内 SHA-256 校验，通过后使用标准 Electron artifact cache。
- 实际启动打包后的 `.app`，确认沙箱 preload/受限 IPC 与本地持久化正常。
- 使用 `WORKTREES_LITE_DATA_DIR` 指向独立临时 profile，通过真实 UI 保存含 `<REPOSITORY_NAME>` 的目录模板、导入临时 Git 仓库、预览并创建 `wt/feature/ui-smoke`。
- 真实 UI 搜索 `ui-smoke` 后仅显示目标 worktree；移开该测试目录后点击刷新，缺失/异常计数为 1，缺失筛选仅显示目标条目。
- 真实 UI 打开重建预览，显示已有分支、原目录和未提交修改无法恢复提示；确认后成功重建，缺失计数归零。
- 随后使用独立 Git/文件检查核实重建目录存在、当前分支为 `wt/feature/ui-smoke`、README 提交内容正确；测试应用已退出。
- 用户真实项目和默认应用 profile 均未导入或改写，测试文件仅位于系统临时目录。

未实测 Windows/Linux；当前交付为 macOS arm64。外部 worktree 可发现和展示，重建仅针对本应用已保存元数据的记录。
