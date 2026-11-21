import type { ThemeColor } from './theme-colors.js';

export interface AppError { code: string; message: string; details?: string; retryable?: boolean }
export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError };
export interface Settings { worktreeRoot: string; branchPrefix: string; staleDays: number; themeColor: ThemeColor }
export interface Repository { id: string; name: string; path: string; defaultBranch: string | null; branchPrefix: string | null; addedAt: string }
export interface Branch { name: string; remote: boolean; current: boolean }
export interface Worktree {
  id: string; repoId: string; repoName: string; path: string; branch: string | null; head: string | null;
  baseBranch: string | null; isMain: boolean; exists: boolean; locked: boolean; lockReason: string | null;
  prunable: boolean; managed: boolean; canRemoveRecord: boolean; createdAt: string | null; lastActivityAt: string | null;
  stale: boolean; error: AppError | null;
}
export interface Snapshot { settings: Settings; repositories: Repository[]; worktrees: Worktree[]; errors: AppError[]; refreshedAt: string }
export interface CreateInput { repoId: string; baseBranch: string; branchName: string; useExistingBranch?: boolean; useSelectedBranch?: boolean }
export interface CreatePreview { repoId: string; branch: string; baseBranch: string; path: string; warnings: string[]; retry?: RecoveryPreview; useExistingBranch?: boolean }
export interface RecoveryPreview { worktreeId: string; path: string; branch: string; baseBranch: string | null; branchExists: boolean; action: 'recreate-existing-branch' | 'recreate-from-base'; warnings: string[] }
export interface DeletePreview {
  worktreeId: string; path: string; branch: string | null; head: string | null;
  deleteBranch: boolean; trackedChanges: number; untrackedFiles: number;
  uniqueCommits: number; requiresConfirmation: boolean; warnings: string[]; token: string;
  baseBranch: string | null; baseHead: string | null; submodules: SubmoduleDeletePreview[];
}
export interface SubmoduleDeletePreview {
  path: string; branch: string | null; head: string | null; baseHead: string | null;
  state: 'ready' | 'uninitialized' | 'missing-worktree';
  comparison: 'same' | 'different' | 'unknown'; ahead: number | null; behind: number | null;
  trackedChanges: number; untrackedFiles: number;
  canDiscard: boolean; protectionReason: string | null;
}
export interface SubmoduleDeleteOutcome {
  path: string; backupPath: string | null; discarded: boolean; branchDeleted: boolean;
}
export interface DeleteInput { worktreeId: string; deleteBranch: boolean; token: string; confirmRisks: boolean; discardSubmodules?: string[]; confirmSubmoduleFiles?: string[] }
export interface DeleteOutcome { worktreeId: string; path: string; branch: string | null; branchDeleted: boolean; warnings: string[]; submodules: SubmoduleDeleteOutcome[] }
export interface AppApi {
  onCloseRequested(approve: () => Promise<boolean>): () => void;
  getSnapshot(): Promise<Result<Snapshot>>;
  chooseDirectory(): Promise<Result<string | null>>;
  addRepository(path: string): Promise<Result<Repository>>;
  removeRepository(repoId: string): Promise<Result<void>>;
  updateRepository(repoId: string, patch: { name?: string; branchPrefix?: string | null }): Promise<Result<Repository>>;
  updateSettings(patch: Partial<Settings>): Promise<Result<Settings>>;
  listBranches(repoId: string): Promise<Result<Branch[]>>;
  previewCreate(input: CreateInput): Promise<Result<CreatePreview>>;
  createWorktree(input: CreateInput, taskId: string): Promise<Result<Worktree>>;
  previewRecovery(worktreeId: string): Promise<Result<RecoveryPreview>>;
  recreateWorktree(worktreeId: string, taskId: string): Promise<Result<Worktree>>;
  cancelCheckout(taskId: string): Promise<Result<void>>;
  removeWorktreeRecord(worktreeId: string): Promise<Result<void>>;
  previewDelete(worktreeId: string, deleteBranch: boolean): Promise<Result<DeletePreview>>;
  deleteWorktree(input: DeleteInput): Promise<Result<DeleteOutcome>>;
  revealPath(path: string): Promise<Result<void>>;
  copyText(text: string): Promise<Result<void>>;
}
declare global { interface Window { worktrees: AppApi } }
