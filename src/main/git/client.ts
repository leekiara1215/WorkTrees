import { execFile, spawn } from 'node:child_process';

export class ServiceError extends Error {
  constructor(public code: string, message: string, public details?: string, public retryable = false) {
    super(message);
    this.name = 'ServiceError';
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  // A terminal launching Electron may carry repository-scoped Git variables.
  // They must never redirect an operation away from the selected repository.
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete (env as NodeJS.ProcessEnv)[key];
  return env;
}

function gitArgs(cwd: string, args: string[]): string[] {
  return ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args];
}

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', gitArgs(cwd, args), {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
      env: gitEnvironment(),
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

function cancelled(details?: string): ServiceError {
  return new ServiceError('GIT_CANCELLED', '任务已取消。请检查目录状态后再试。', details, true);
}

export function checkCheckoutCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}

export async function checkoutGit(cwd: string, args: string[], signal?: AbortSignal): Promise<void> {
  checkCheckoutCancellation(signal);
  return new Promise((resolve, reject) => {
    // Git may run checkout filters or LFS helpers. Put them in the same process
    // group so cancelling waits for the checkout and its helpers to stop.
    const useProcessGroup = process.platform !== 'win32';
    const child = spawn('git', gitArgs(cwd, args), {
      env: gitEnvironment(), stdio: ['ignore', 'ignore', 'pipe'],
      detached: useProcessGroup, windowsHide: true,
    });
    let stderr = '';
    let spawnError: NodeJS.ErrnoException | undefined;
    let stopping: Promise<void> | undefined;
    let finishStopping: (() => void) | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-65_536); });
    child.on('error', error => { spawnError = error; });

    function signalGroup(killSignal: NodeJS.Signals | 0): boolean {
      if (!child.pid) return false;
      try {
        process.kill(-child.pid, killSignal);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
        throw error;
      }
    }

    function stop() {
      if (stopping || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
      stopping = new Promise<void>(done => {
        if (!useProcessGroup) {
          execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 }, error => {
            if (error) child.kill('SIGKILL');
            done();
          });
          return;
        }
        finishStopping = done;
        if (!signalGroup('SIGTERM')) { done(); return; }
        escalation = setTimeout(() => {
          signalGroup('SIGKILL');
          done();
        }, 1_500);
      });
    }
    signal?.addEventListener('abort', stop, { once: true });

    child.once('close', async (code, exitSignal) => {
      signal?.removeEventListener('abort', stop);
      if (escalation && !signalGroup(0)) {
        clearTimeout(escalation);
        finishStopping?.();
      }
      await stopping;
      const details = stderr.trim() || spawnError?.message;
      if (code === 0) resolve();
      else if (stopping) reject(cancelled(details));
      else if (spawnError?.code === 'ENOENT') reject(new ServiceError('GIT_NOT_FOUND', '未找到 Git，请先安装 Git 并重新启动应用。', details));
      else reject(new ServiceError('GIT_ERROR', 'Git 操作失败，请查看详情。', details ?? String(exitSignal ?? code), true));
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
