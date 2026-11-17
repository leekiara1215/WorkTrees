# 实现结构

WorkTrees Lite 使用 Electron、React 和 TypeScript，以 Git 自身的 Worktree 登记为发现依据。

## 数据与进程

- `src/main/main.ts`：窗口、单实例锁和受限 IPC。renderer 使用沙箱、context isolation，不开放通用 shell 或文件系统接口。
- `src/main/preload.cts`：只暴露 `AppApi` 中的固定方法，所有响应通过 `Result<T>` 返回。
- `src/main/worktree-service.ts`：仓库、设置、创建、发现与重建流程；同一实例串行处理请求。
- `src/main/git/client.ts`：通过 `execFile` 参数数组调用 Git，清除继承的仓库重定向变量；应用的 Git 操作不运行 hooks。
- `src/main/storage/store.ts`：应用 userData 下的 JSON 元数据，通过同目录临时文件、fsync 和 rename 原子写入。损坏配置保留原文件并报错。
- `src/renderer/`：列表、筛选、创建与重建预览、偏好设置。
- `src/shared/types.ts`：前后端接口契约。

## 创建与恢复

创建先校验原始分支名和带前缀的完整分支名，再展开根目录模板并检查碰撞。已有路径不覆盖；创建意图先保存，以便 Git 执行中断时保留恢复记录。

恢复只处理本应用已保存的 Worktree 记录。原分支仍在时检出原分支；分支缺失时，预览中说明从保存的基准重新创建。锁定、分支被其他 Worktree 使用、路径已存在等情况均拒绝操作。恢复不清理其他 Worktree 的 Git 登记，也不找回已丢失的未提交修改。

默认数据目录由 Electron userData 决定。开发验收可通过 `WORKTREES_LITE_DATA_DIR` 指定独立绝对路径，以隔离测试配置。
