import { execFile } from 'node:child_process';

export class ServiceError extends Error {
  constructor(public code: string, message: string, public details?: string, public retryable = false) {
    super(message);
    this.name = 'ServiceError';
  }
}

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
    // A terminal launching Electron may carry repository-scoped Git variables.
    // They must never redirect an operation away from the selected repository.
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete (env as NodeJS.ProcessEnv)[key];
    execFile('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
      env,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const message = stderr.trim() || error.message;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return reject(new ServiceError('GIT_NOT_FOUND', '未找到 Git，请先安装 Git 并重新启动应用。', message));
      }
      if (error.killed || (error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        return reject(new ServiceError('GIT_TIMEOUT', 'Git 操作超时，请检查仓库后重试。', message, true));
      }
      reject(new ServiceError('GIT_ERROR', 'Git 操作失败，请查看详情。', message, true));
    });
  });
}

export interface GitWorktree {
  path: string; head: string | null; branch: string | null; bare: boolean;
  locked: boolean; lockReason: string | null; prunable: boolean;
}

export function parseWorktrees(output: string): GitWorktree[] {
  const result: GitWorktree[] = [];
  let current: GitWorktree | undefined;
  for (const field of output.split('\0')) {
    if (!field) { current = undefined; continue; }
    if (field.startsWith('worktree ')) {
      current = { path: field.slice(9), head: null, branch: null, bare: false, locked: false, lockReason: null, prunable: false };
      result.push(current);
    } else if (current) {
      if (field.startsWith('HEAD ')) current.head = field.slice(5);
      if (field.startsWith('branch ')) current.branch = field.slice(7).replace(/^refs\/heads\//, '');
      if (field === 'bare') current.bare = true;
      if (field === 'locked' || field.startsWith('locked ')) { current.locked = true; current.lockReason = field.slice(7) || null; }
      if (field === 'prunable' || field.startsWith('prunable ')) current.prunable = true;
    }
  }
  return result;
}

export async function listGitWorktrees(path: string): Promise<GitWorktree[]> {
  return parseWorktrees(await git(path, ['worktree', 'list', '--porcelain', '-z']));
}
