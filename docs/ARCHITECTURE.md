# 实现结构

WorkTrees Lite 使用 Electron、React 和 TypeScript，以 Git 自身的 Worktree 登记为发现依据。

## 数据与进程

- `src/main/main.ts`：窗口、单实例锁和受限 IPC。renderer 使用沙箱、context isolation，不开放通用 shell 或文件系统接口。
- `src/main/preload.cts`：只暴露 `AppApi` 中的固定方法，所有响应通过 `Result<T>` 返回。
- `src/main/worktree-service.ts`：仓库、设置、创建、发现、重建与安全删除流程；同一实例串行处理请求。
- `src/main/git/client.ts`：通过 `execFile` 参数数组调用 Git，清除继承的仓库重定向变量；应用的 Git 操作不运行 hooks。
- `src/main/storage/store.ts`：应用 userData 下的 JSON 元数据，通过同目录临时文件、fsync 和 rename 原子写入。损坏配置保留原文件并报错。
- `src/renderer/`：列表、筛选、创建/重建/删除预览、偏好设置。根目录选择复用 Electron 系统文件夹对话框，选择结果只修改设置草稿。
- `src/shared/types.ts`：前后端接口契约。

## 创建与恢复

创建先校验原始分支名和带前缀的完整分支名，再展开根目录模板并检查碰撞。已有路径不覆盖；创建意图先保存，以便 Git 执行中断时保留恢复记录。

恢复只处理本应用已保存的 Worktree 记录。原分支仍在时检出原分支；分支缺失时，预览中说明从保存的基准重新创建。锁定、分支被其他 Worktree 使用、路径已存在等情况均拒绝操作。恢复不清理其他 Worktree 的 Git 登记，也不找回已丢失的未提交修改。

默认数据目录由 Electron userData 决定。开发验收可通过 `WORKTREES_LITE_DATA_DIR` 指定独立绝对路径，以隔离测试配置。

## 安全删除

删除采用只读预检和执行两步。主 checkout、锁定记录及无法确认身份的路径拒绝删除；主 checkout 根据 Git 登记及目录身份判断，不根据分支名称判断。默认只移除 Worktree 并保留分支，可选同时删除分支。

预检展示已跟踪修改、未跟踪文件、忽略文件和提交风险。未提交文件可能随目录移除而丢失；删除分支或移除游离 HEAD 时，额外检查是否有其他分支、远程跟踪分支或标签保留提交。没有 upstream 本身不代表提交丢失。

执行请求携带预览 token 与风险确认，后端重新检查状态。只通过 Git 的 Worktree 接口移除目标，不自动解锁或清理其他条目；可选分支删除比较原提交 ID。目录删除成功后如果分支删除失败，返回部分成功警告，界面刷新列表并保留反馈。
