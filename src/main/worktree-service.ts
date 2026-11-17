import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { AppError, Branch, CreateInput, CreatePreview, RecoveryPreview, Repository, Settings, Snapshot, Worktree } from '../shared/types.js';
import { git, listGitWorktrees, ServiceError, type GitWorktree } from './git/client.js';
import { createStore, type ManagedWorktree, type StoreData } from './storage/store.js';

function fail(code: string, message: string, details?: string): never { throw new ServiceError(code, message, details); }
function text(value: unknown, label: string, max = 1024): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail('INVALID_INPUT', `${label}不能为空或包含控制字符。`);
  return value;
}
function plain(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', '参数格式无效。');
}
function appError(error: unknown): AppError {
  if (error instanceof ServiceError) return { code: error.code, message: error.message, details: error.details, retryable: error.retryable };
  return { code: 'IO_ERROR', message: '无法访问本地文件，请检查路径和权限。', details: String(error), retryable: true };
}
async function occupied(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function samePath(a: string, b: string): boolean { return resolve(a) === resolve(b); }
async function physicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await physicalPath(parent), basename(path));
  }
}
function slug(value: string): string {
  return value.normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[. -]+|[. -]+$/g, '').slice(0, 64) || 'worktree';
}
function rootPath(template: string, repo: Repository): string {
  // Keep human-readable spaces while making the variable a single safe path component.
  const repoName = repo.name.normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/^[. ]+|[. ]+$/g, '') || 'repository';
  let root = template.replaceAll('<REPOSITORY_PATH>', repo.path).replaceAll('<REPOSITORY_NAME>', repoName);
  if (/[<>]/.test(root)) fail('INVALID_PATH_TEMPLATE', '目录模板包含未知变量。');
  if (root === '~') root = homedir();
  else if (root.startsWith('~/')) root = join(homedir(), root.slice(2));
  if (!isAbsolute(root)) fail('INVALID_PATH_TEMPLATE', 'Worktree 根目录必须是绝对路径，或使用 ~/ 和支持的变量。');
  return resolve(root);
}

export function createWorktreeService({ dataDir }: { dataDir: string }) {
  text(dataDir, '配置目录');
  const store = createStore(resolve(dataDir));
  let data: StoreData;
  let initialized: Promise<void> | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  const ready = () => initialized ??= store.load().then(value => { data = value; });
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = tail.then(async () => { await ready(); return operation(); });
    tail = task.catch(() => undefined);
    return task.catch(error => { if (error instanceof ServiceError) throw error; const e = appError(error); throw new ServiceError(e.code, e.message, e.details, e.retryable); });
  }
  async function save(next: StoreData): Promise<void> { await store.save(next); data = next; }
  function repository(repoId: string): Repository {
    text(repoId, '仓库 ID');
    return data.repositories.find(repo => repo.id === repoId) ?? fail('REPOSITORY_NOT_FOUND', '找不到该仓库，请重新导入。');
  }
  async function requireRepo(repo: Repository): Promise<void> {
    if (!await occupied(repo.path)) fail('REPOSITORY_MISSING', '仓库目录不存在，请恢复原仓库目录。', repo.path);
    let top: string;
    try { top = (await git(repo.path, ['rev-parse', '--show-toplevel'])).trim(); }
    catch (error) {
      if (error instanceof ServiceError && error.code === 'GIT_ERROR') fail('NOT_GIT_REPOSITORY', '该目录已不是有效的 Git 工作仓库。', repo.path);
      throw error;
    }
    // Do not accidentally operate on a parent repo if the imported .git was removed.
    if (!samePath(await realpath(top), await realpath(repo.path))) fail('NOT_GIT_REPOSITORY', '导入的目录已不是原 Git 仓库根目录。', repo.path);
  }
  async function branches(repo: Repository): Promise<Branch[]> {
    await requireRepo(repo);
    const output = await git(repo.path, ['for-each-ref', '--format=%(refname)%00%(HEAD)%00%(symref)', 'refs/heads/', 'refs/remotes/']);
    return output.split('\n').filter(Boolean).flatMap(line => {
      const [ref = '', head, symref] = line.split('\0');
      if (symref) return [];
      const remote = ref.startsWith('refs/remotes/');
      return [{ name: ref.replace(/^refs\/(heads|remotes)\//, ''), remote, current: head === '*' }];
    });
  }
  async function validateBranch(repo: Repository, branch: string): Promise<void> {
    text(branch, '分支名', 240);
    if (branch.startsWith('-') || branch === 'HEAD' || branch.includes('@{')) fail('INVALID_BRANCH', '分支名无效，请使用普通 Git 分支名。');
    try { await git(repo.path, ['check-ref-format', '--branch', branch]); }
    catch (error) {
      if (error instanceof ServiceError && error.code === 'GIT_ERROR') fail('INVALID_BRANCH', '分支名无效，请检查空格、斜杠和特殊字符。', branch);
      throw error;
    }
  }
  async function validatePrefix(prefix: unknown, repo?: Repository): Promise<string> {
    if (typeof prefix !== 'string' || prefix.length > 150 || /[\u0000-\u0020\u007f]/.test(prefix)) fail('INVALID_PREFIX', '分支前缀无效，不能包含空白或控制字符。');
    if (prefix) {
      if (prefix.startsWith('-') || prefix.includes('@{')) fail('INVALID_PREFIX', '分支前缀无效。');
      try { await git(repo?.path ?? dataDir, ['check-ref-format', '--branch', `${prefix}worktree-check`]); }
      catch (error) {
        // check-ref-format does not need a repository, but its -C directory must exist.
        if (error instanceof ServiceError && error.code === 'GIT_ERROR') fail('INVALID_PREFIX', '分支前缀无法组成合法的 Git 分支名。', prefix);
        throw error;
      }
    }
    return prefix;
  }
  async function preview(input: CreateInput): Promise<CreatePreview> {
    plain(input);
    const repo = repository(input.repoId);
    await requireRepo(repo);
    text(input.baseBranch, '基准分支'); text(input.branchName, '分支名', 240);
    await validateBranch(repo, input.branchName);
    const branch = (repo.branchPrefix ?? data.settings.branchPrefix) + input.branchName;
    await validateBranch(repo, branch);
    const refs = await branches(repo);
    if (!refs.some(ref => ref.name === input.baseBranch)) fail('BASE_BRANCH_MISSING', '基准分支不存在，请刷新分支列表。', input.baseBranch);
    if (refs.some(ref => !ref.remote && ref.name === branch)) fail('BRANCH_EXISTS', '目标分支已存在，请使用新的分支名。', branch);
    // Git records physical paths. Resolve existing ancestors before saving a future path,
    // including common macOS aliases such as /tmp -> /private/tmp.
    const root = await physicalPath(rootPath(data.settings.worktreeRoot, repo));
    const leaf = `${slug(repo.name)}-${slug(branch)}-${repo.id.slice(0, 8)}-${createHash('sha256').update(branch).digest('hex').slice(0, 8)}`;
    const path = join(root, leaf);
    const rel = relative(root, path);
    if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail('INVALID_PATH', '生成的目录超出根目录。');
    if (await occupied(path)) fail('PATH_EXISTS', '目标目录已存在，请调整根目录或分支名称。', path);
    const registrations = await listGitWorktrees(repo.path);
    if (registrations.some(w => samePath(w.path, path)) || data.managedWorktrees.some(w => samePath(w.path, path))) fail('PATH_REGISTERED', '该路径已有 Worktree 记录，请从异常列表重建或调整名称。', path);
    const warnings: string[] = [];
    const inside = relative(repo.path, path);
    if (inside && !inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside)) warnings.push('目标目录位于原仓库内，可能被原仓库视为未跟踪文件。');
    return { repoId: repo.id, branch, baseBranch: input.baseBranch, path, warnings };
  }
  async function activity(path: string): Promise<string | null> {
    const stamps: number[] = [];
    const add = async (p: string) => { try { stamps.push((await stat(p)).mtimeMs); } catch { /* Missing activity metadata is not a worktree error. */ } };
    await add(path);
    await add(join(path, '.git'));
    try {
      const date = Date.parse((await git(path, ['log', '-1', '--format=%cI'])).trim());
      if (Number.isFinite(date)) stamps.push(date);
    }
    catch { /* A malformed external checkout is reported separately. */ }
    return stamps.length ? new Date(Math.max(...stamps)).toISOString() : null;
  }
  async function worktree(repo: Repository, discovered: GitWorktree | undefined, record?: ManagedWorktree, repoError?: AppError, mainPath?: string): Promise<Worktree> {
    const path = discovered?.path ?? record!.path;
    const exists = await occupied(path);
    let error = repoError ?? null;
    if (!exists && !error) error = { code: 'WORKTREE_MISSING', message: 'Worktree 目录缺失，可使用已保存记录安全重建。', details: path, retryable: true };
    if (exists && !repoError) {
      try {
        const top = (await git(path, ['rev-parse', '--show-toplevel'])).trim();
        if (!samePath(top, path)) error = { code: 'WORKTREE_INVALID', message: '该目录不再是有效的 Worktree 根目录。', details: path };
      } catch (e) { error = appError(e); }
    }
    const lastActivityAt = exists ? await activity(path) : null;
    return {
      id: record?.id ?? `external-${createHash('sha256').update(`${repo.id}\0${path}`).digest('hex').slice(0, 24)}`,
      repoId: repo.id, repoName: repo.name, path, branch: discovered?.branch ?? record?.branch ?? null,
      head: discovered?.head ?? null, baseBranch: record?.baseBranch ?? null,
      isMain: samePath(path, mainPath ?? repo.path), exists, locked: discovered?.locked ?? false,
      lockReason: discovered?.lockReason ?? null, prunable: discovered?.prunable ?? false,
      managed: !!record, createdAt: record?.createdAt ?? null, lastActivityAt,
      stale: !!lastActivityAt && Date.now() - Date.parse(lastActivityAt) > data.settings.staleDays * 86_400_000, error,
    };
  }
  async function snapshot(): Promise<Snapshot> {
    const worktrees: Worktree[] = []; const errors: AppError[] = [];
    for (const repo of data.repositories) {
      let discovered: GitWorktree[] = []; let error: AppError | undefined;
      try { await requireRepo(repo); discovered = await listGitWorktrees(repo.path); }
      catch (e) { error = appError(e); errors.push({ ...error, details: `${repo.name}: ${error.details ?? repo.path}` }); }
      const records = data.managedWorktrees.filter(w => w.repoId === repo.id);
      for (const w of discovered) worktrees.push(await worktree(repo, w, records.find(r => samePath(r.path, w.path)), error, discovered[0]?.path));
      for (const record of records.filter(r => !discovered.some(w => samePath(w.path, r.path)))) worktrees.push(await worktree(repo, undefined, record, error));
      if (error && !worktrees.some(w => w.repoId === repo.id && w.isMain)) worktrees.push(await worktree(repo, { path: repo.path, head: null, branch: null, bare: false, locked: false, lockReason: null, prunable: false }, undefined, error));
    }
    return { settings: { ...data.settings }, repositories: data.repositories.map(r => ({ ...r })), worktrees, errors, refreshedAt: new Date().toISOString() };
  }
  async function recovery(worktreeId: string): Promise<RecoveryPreview> {
    text(worktreeId, 'Worktree ID');
    const record = data.managedWorktrees.find(w => w.id === worktreeId) ?? fail('WORKTREE_NOT_MANAGED', '仅支持重建本应用创建并保存的 Worktree。');
    const repo = repository(record.repoId); await requireRepo(repo);
    if (await occupied(record.path)) fail('PATH_EXISTS', '原目录已经存在，重建不会覆盖已有目录。', record.path);
    if (!isAbsolute(record.path) || samePath(record.path, repo.path)) fail('INVALID_PATH', '保存的 Worktree 路径无效。');
    await validateBranch(repo, record.branch);
    const registrations = await listGitWorktrees(repo.path);
    const entry = registrations.find(w => samePath(w.path, record.path));
    if (entry?.locked) fail('WORKTREE_LOCKED', 'Worktree 已锁定，请先在 Git 中确认并解除锁定。', entry.lockReason ?? record.path);
    if (entry && entry.branch !== record.branch) fail('WORKTREE_CONFLICT', '路径注册的分支与保存记录不一致，请先检查 Git Worktree 状态。');
    if (registrations.some(w => w.branch === record.branch && !samePath(w.path, record.path))) fail('BRANCH_IN_USE', '该分支已被其他 Worktree 使用，无法在原路径重建。', record.branch);
    const refs = await branches(repo);
    const branchExists = refs.some(b => !b.remote && b.name === record.branch);
    if (!branchExists && !refs.some(b => b.name === record.baseBranch)) fail('BASE_BRANCH_MISSING', '原分支和记录的基准分支均不存在，无法重建。', record.baseBranch);
    return { worktreeId, path: record.path, branch: record.branch, baseBranch: record.baseBranch, branchExists,
      action: branchExists ? 'recreate-existing-branch' : 'recreate-from-base', warnings: [branchExists ? '使用现有分支重建目录。' : `原分支已不存在，将从 ${record.baseBranch} 重新创建。`, '无法恢复原目录中未提交的修改或未跟踪文件。'] };
  }
  return {
    getSnapshot: () => serial(snapshot),
    addRepository: (path: string) => serial(async (): Promise<Repository> => {
      text(path, '仓库路径', 4096);
      if (!isAbsolute(path)) fail('INVALID_PATH', '仓库路径必须是绝对路径。');
      if (!await occupied(path)) fail('REPOSITORY_MISSING', '仓库目录不存在。', path);
      let top: string;
      try { top = (await git(path, ['rev-parse', '--show-toplevel'])).trim(); }
      catch (error) { if (error instanceof ServiceError && error.code === 'GIT_ERROR') fail('NOT_GIT_REPOSITORY', '请选择有效的非裸 Git 工作仓库。', path); throw error; }
      const checkout = await realpath(top);
      const entries = await listGitWorktrees(checkout);
      const canonical = await realpath(entries[0]?.path ?? checkout).catch(() => checkout);
      const existing = data.repositories.find(r => samePath(r.path, canonical));
      if (existing) return { ...existing };
      const provisional: Repository = { id: randomUUID(), name: basename(canonical), path: canonical, defaultBranch: null, branchPrefix: null, addedAt: new Date().toISOString() };
      const refs = await branches(provisional);
      provisional.defaultBranch = refs.find(b => !b.remote && b.name === 'main')?.name ?? refs.find(b => !b.remote && b.name === 'master')?.name ?? refs.find(b => b.current)?.name ?? refs[0]?.name ?? null;
      await save({ ...data, repositories: [...data.repositories, provisional] });
      return { ...provisional };
    }),
    removeRepository: (repoId: string) => serial(async (): Promise<void> => {
      repository(repoId);
      await save({ ...data, repositories: data.repositories.filter(r => r.id !== repoId), managedWorktrees: data.managedWorktrees.filter(w => w.repoId !== repoId) });
    }),
    updateRepository: (repoId: string, patch: { name?: string; branchPrefix?: string | null }) => serial(async (): Promise<Repository> => {
      const repo = repository(repoId); plain(patch);
      if (Object.keys(patch).some(k => !['name', 'branchPrefix'].includes(k))) fail('INVALID_INPUT', '仓库配置包含未知字段。');
      const next = { ...repo };
      if (patch.name !== undefined) next.name = text(patch.name, '仓库名称', 120).trim();
      if (patch.branchPrefix !== undefined) next.branchPrefix = patch.branchPrefix === null ? null : await validatePrefix(patch.branchPrefix, repo);
      await save({ ...data, repositories: data.repositories.map(r => r.id === repoId ? next : r) }); return { ...next };
    }),
    updateSettings: (patch: Partial<Settings>) => serial(async (): Promise<Settings> => {
      plain(patch);
      if (Object.keys(patch).some(k => !['worktreeRoot', 'branchPrefix', 'staleDays'].includes(k))) fail('INVALID_INPUT', '设置包含未知字段。');
      const next = { ...data.settings };
      if (patch.worktreeRoot !== undefined) {
        next.worktreeRoot = text(patch.worktreeRoot, 'Worktree 根目录', 4096);
        rootPath(next.worktreeRoot, { name: 'repository', path: '/repository' } as Repository);
      }
      if (patch.branchPrefix !== undefined) {
        // Use an existing neutral directory; configuring settings must not create user directories.
        next.branchPrefix = await validatePrefix(patch.branchPrefix, { path: homedir() } as Repository);
      }
      if (patch.staleDays !== undefined) {
        if (!Number.isInteger(patch.staleDays) || patch.staleDays < 1 || patch.staleDays > 3650) fail('INVALID_INPUT', '闲置天数必须是 1–3650 的整数。');
        next.staleDays = patch.staleDays;
      }
      await save({ ...data, settings: next }); return { ...next };
    }),
    listBranches: (repoId: string) => serial(() => branches(repository(repoId))),
    previewCreate: (input: CreateInput) => serial(() => preview(input)),
    createWorktree: (input: CreateInput) => serial(async (): Promise<Worktree> => {
      const plan = await preview(input); const repo = repository(plan.repoId);
      const record: ManagedWorktree = { id: randomUUID(), repoId: repo.id, path: plan.path, branch: plan.branch, baseBranch: plan.baseBranch, createdAt: new Date().toISOString() };
      await mkdir(dirname(plan.path), { recursive: true });
      if (await occupied(plan.path)) fail('PATH_EXISTS', '目标目录已存在，已停止创建。', plan.path);
      // Save intent first so an interrupted Git call or a later persistence failure remains recoverable.
      await save({ ...data, managedWorktrees: [...data.managedWorktrees, record] });
      const refs = await branches(repo);
      const base = `${refs.some(b => !b.remote && b.name === plan.baseBranch) ? 'refs/heads/' : 'refs/remotes/'}${plan.baseBranch}`;
      await git(repo.path, ['worktree', 'add', '-b', plan.branch, '--', plan.path, base]);
      const found = (await listGitWorktrees(repo.path)).find(w => samePath(w.path, record.path));
      return worktree(repo, found, record);
    }),
    previewRecovery: (worktreeId: string) => serial(() => recovery(worktreeId)),
    recreateWorktree: (worktreeId: string) => serial(async (): Promise<Worktree> => {
      const plan = await recovery(worktreeId);
      const record = data.managedWorktrees.find(w => w.id === worktreeId)!; const repo = repository(record.repoId);
      await mkdir(dirname(plan.path), { recursive: true });
      if (await occupied(plan.path)) fail('PATH_EXISTS', '原目录已经存在，已停止重建。', plan.path);
      const args = ['worktree', 'add'];
      // Git -f replaces only a stale registration at this exact missing path; recovery() guards branch ownership and locks.
      if ((await listGitWorktrees(repo.path)).some(w => samePath(w.path, plan.path))) args.push('--force');
      if (!plan.branchExists) args.push('-b', plan.branch);
      const refs = await branches(repo);
      const base = `${refs.some(b => !b.remote && b.name === record.baseBranch) ? 'refs/heads/' : 'refs/remotes/'}${record.baseBranch}`;
      args.push('--', plan.path, plan.branchExists ? plan.branch : base);
      await git(repo.path, args);
      return worktree(repo, (await listGitWorktrees(repo.path)).find(w => samePath(w.path, plan.path)), record);
    }),
  };
}
