import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { isThemeColor } from '../shared/theme-colors.js';
import type { AppError, Branch, CreateInput, CreatePreview, DeleteInput, DeleteOutcome, DeletePreview, RecoveryPreview, Repository, Settings, Snapshot, Worktree } from '../shared/types.js';
import { checkCheckoutCancellation, checkoutGit, git, listGitWorktrees, ServiceError, type GitWorktree } from './git/client.js';
import { createStore, type ManagedWorktree, type StoreData } from './storage/store.js';
import { inspectDeleteDirectory, isInside } from './delete-safety.js';
import { completeSubmoduleRemoval, hasSubmoduleFiles, inspectSubmodules, preserveSubmodules, trackedFileChanges } from './submodule-delete.js';

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
  const deleteTokenSalt = randomUUID();
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
    if (input.useExistingBranch !== undefined && typeof input.useExistingBranch !== 'boolean') fail('INVALID_INPUT', '是否使用已有分支必须明确选择。');
    await validateBranch(repo, input.branchName);
    const branch = (repo.branchPrefix ?? data.settings.branchPrefix) + input.branchName;
    await validateBranch(repo, branch);
    // Git records physical paths. Resolve existing ancestors before saving a future path,
    // including common macOS aliases such as /tmp -> /private/tmp.
    const root = await physicalPath(rootPath(data.settings.worktreeRoot, repo));
    const leaf = `${slug(repo.name)}-${slug(branch)}-${repo.id.slice(0, 8)}-${createHash('sha256').update(branch).digest('hex').slice(0, 8)}`;
    const path = join(root, leaf);
    const rel = relative(root, path);
    if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail('INVALID_PATH', '生成的目录超出根目录。');
    const warnings: string[] = [];
    const inside = relative(repo.path, path);
    if (inside && !inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside)) warnings.push('目标目录位于原仓库内，可能被原仓库视为未跟踪文件。');
    const records = data.managedWorktrees.filter(w => samePath(w.path, path));
    const record = records.length === 1 ? records[0] : undefined;
    if (record?.repoId === repo.id && record.branch === branch && !await occupied(path)) {
      const retry = await recovery(record.id);
      return { repoId: repo.id, branch, baseBranch: record.baseBranch, path, warnings: [...warnings, ...retry.warnings], retry };
    }
    const refs = await branches(repo);
    if (!refs.some(ref => ref.name === input.baseBranch)) fail('BASE_BRANCH_MISSING', '基准分支不存在，请刷新分支列表。', input.baseBranch);
    const branchExists = refs.some(ref => !ref.remote && ref.name === branch);
    if (branchExists && !input.useExistingBranch) fail('BRANCH_EXISTS', '目标分支已存在，可以使用该分支或输入新的分支名。', branch);
    if (!branchExists && input.useExistingBranch) fail('BRANCH_MISSING', '目标分支已不存在，请重新校验。', branch);
    if (await occupied(path)) fail('PATH_EXISTS', '目标目录已存在，请调整根目录或分支名称。', path);
    const registrations = await listGitWorktrees(repo.path);
    if (registrations.some(w => samePath(w.path, path)) || records.length) fail('PATH_REGISTERED', '该路径已有 Worktree 记录，请从异常列表重建或调整名称。', path);
    if (input.useExistingBranch) {
      if (registrations.some(w => w.branch === branch)) fail('BRANCH_IN_USE', '该分支已被其他 Worktree 使用。', branch);
      warnings.push('使用现有分支的当前提交检出到新目录，保留已有提交。');
      return { repoId: repo.id, branch, baseBranch: input.baseBranch, path, warnings, useExistingBranch: true };
    }
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
    const isMain = samePath(path, mainPath ?? repo.path);
    return {
      id: record?.id ?? `external-${createHash('sha256').update(`${repo.id}\0${path}`).digest('hex').slice(0, 24)}`,
      repoId: repo.id, repoName: repo.name, path, branch: discovered?.branch ?? record?.branch ?? null,
      head: discovered?.head ?? null, baseBranch: record?.baseBranch ?? null,
      isMain, exists, locked: discovered?.locked ?? false,
      lockReason: discovered?.lockReason ?? null, prunable: discovered?.prunable ?? false,
      managed: !!record, canRemoveRecord: !!record && !discovered && !exists && !repoError && !isMain,
      createdAt: record?.createdAt ?? null, lastActivityAt,
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
    if (!samePath(record.path, await physicalPath(record.path))) fail('WORKTREE_CONFLICT', '原目录的实际路径已变化，请检查后再重建。', record.path);
    await validateBranch(repo, record.branch);
    recoveryRegistration(record, await listGitWorktrees(repo.path));
    const refs = await branches(repo);
    const branchExists = refs.some(b => !b.remote && b.name === record.branch);
    if (!branchExists && !refs.some(b => b.name === record.baseBranch)) fail('BASE_BRANCH_MISSING', '原分支和记录的基准分支均不存在，无法重建。', record.baseBranch);
    return { worktreeId, path: record.path, branch: record.branch, baseBranch: record.baseBranch, branchExists,
      action: branchExists ? 'recreate-existing-branch' : 'recreate-from-base', warnings: [branchExists ? '使用现有分支重建目录。' : `原分支已不存在，将从 ${record.baseBranch} 重新创建。`, '无法恢复原目录中未提交的修改或未跟踪文件。'] };
  }
  function recoveryRegistration(record: ManagedWorktree, registrations: GitWorktree[]): GitWorktree | undefined {
    const entry = registrations.find(w => samePath(w.path, record.path));
    if (entry?.locked) fail('WORKTREE_LOCKED', 'Worktree 已锁定，请先在 Git 中确认并解除锁定。', entry.lockReason ?? record.path);
    if (entry && entry.branch !== record.branch) fail('WORKTREE_CONFLICT', '路径注册的分支与保存记录不一致，请先检查 Git Worktree 状态。');
    if (entry && !entry.prunable) fail('WORKTREE_CONFLICT', 'Git 尚未将原注册标记为可清理，请检查后再重建。', record.path);
    if (registrations.some(w => w.branch === record.branch && !samePath(w.path, record.path))) fail('BRANCH_IN_USE', '该分支已被其他 Worktree 使用，无法在原路径重建。', record.branch);
    return entry;
  }
  async function checkout(repo: Repository, record: ManagedWorktree, mode: 'create' | 'use-existing' | 'recover', signal?: AbortSignal): Promise<Worktree> {
    checkCheckoutCancellation(signal);
    await mkdir(dirname(record.path), { recursive: true });
    const refs = await branches(repo);
    const branchExists = mode !== 'create' && refs.some(b => !b.remote && b.name === record.branch);
    if (mode === 'use-existing' && !branchExists) fail('BRANCH_MISSING', '目标分支已不存在，请重新校验。', record.branch);
    const base = refs.find(b => !b.remote && b.name === record.baseBranch) ?? refs.find(b => b.remote && b.name === record.baseBranch);
    const ref = branchExists ? record.branch : base && `${base.remote ? 'refs/remotes/' : 'refs/heads/'}${base.name}`;
    if (!ref) fail('BASE_BRANCH_MISSING', '基准分支不存在，请刷新分支列表。', record.baseBranch);
    const stale = mode === 'recover' && recoveryRegistration(record, await listGitWorktrees(repo.path));
    if (!samePath(await physicalPath(record.path), record.path) || await occupied(record.path)) fail('PATH_EXISTS', '原路径已被占用或发生变化，已停止检出。', record.path);
    checkCheckoutCancellation(signal);
    if (mode !== 'recover') {
      // Keep the intent if Git leaves a branch but cannot finish checkout.
      await save({ ...data, managedWorktrees: [...data.managedWorktrees, record] });
    }
    const args = ['worktree', 'add'];
    // Git requires --force to replace this exact, unlocked registration at a missing path.
    if (stale) args.push('--force');
    if (!branchExists) args.push('-b', record.branch);
    await checkoutGit(repo.path, [...args, '--', record.path, ref], signal);
    const found = (await listGitWorktrees(repo.path)).find(w => samePath(w.path, record.path));
    const result = await worktree(repo, found, record);
    if (found?.branch !== record.branch || !result.exists || result.error) fail('WORKTREE_INCOMPLETE', 'Git 检出后无法确认工作目录已就绪，请刷新列表检查。', result.error?.details ?? record.path);
    return result;
  }
  function externalId(repo: Repository, path: string): string {
    return `external-${createHash('sha256').update(`${repo.id}\0${path}`).digest('hex').slice(0, 24)}`;
  }
  async function deleteTarget(worktreeId: string) {
    text(worktreeId, 'Worktree ID');
    const record = data.managedWorktrees.find(w => w.id === worktreeId);
    if (record) {
      const repo = repository(record.repoId); await requireRepo(repo);
      const entries = await listGitWorktrees(repo.path);
      const entry = entries.find(w => samePath(w.path, record.path));
      if (!entry) fail('WORKTREE_NOT_REGISTERED', 'Git 中已没有这条 Worktree 注册，请刷新并检查原目录。', record.path);
      return { repo, entries, entry };
    }
    for (const repo of data.repositories) {
      let entries: GitWorktree[];
      try { await requireRepo(repo); entries = await listGitWorktrees(repo.path); }
      catch { continue; }
      const entry = entries.find(w => externalId(repo, w.path) === worktreeId);
      if (entry) return { repo, entries, entry };
    }
    return fail('WORKTREE_NOT_FOUND', '这条 Worktree 已不存在，请刷新列表。');
  }
  async function deletion(worktreeId: string, deleteBranch: boolean) {
    if (typeof deleteBranch !== 'boolean') fail('INVALID_INPUT', '是否删除分支必须明确选择。');
    const { repo, entries, entry } = await deleteTarget(worktreeId);
    const mainPath = await physicalPath(entries[0]?.path ?? repo.path);
    const path = await physicalPath(entry.path);
    if (samePath(path, mainPath) || samePath(path, await physicalPath(repo.path)) || entry.bare) fail('MAIN_WORKTREE', '主仓库不能通过 Worktree 删除操作移除。');
    if (entry.locked) fail('WORKTREE_LOCKED', 'Worktree 已锁定，请先检查锁定原因并在 Git 中手动处理。', entry.lockReason ?? entry.path);
    if (entry.path !== path) fail('WORKTREE_UNSAFE', 'Worktree 路径包含别名或符号链接，无法安全删除。', entry.path);
    const knownRepositories = [...data.repositories, ...(data.removedRepositories ?? [])];
    if (entries.some(other => other !== entry && isInside(path, other.path)) || knownRepositories.some(other => isInside(path, other.path)) || isInside(path, await physicalPath(resolve(dataDir)))) fail('WORKTREE_UNSAFE', '此目录内包含其他仓库、Worktree 或应用数据，请先单独处理。', path);
    if (deleteBranch && !entry.branch) fail('INVALID_INPUT', '游离 HEAD 没有可删除的本地分支。');
    if (!entry.head || !/^[0-9a-f]{40,64}$/.test(entry.head)) fail('WORKTREE_UNSAFE', '无法确定 Worktree 的提交状态，已停止删除。');
    const identity = await inspectDeleteDirectory(repo.path, path, new Set(), false);
    const record = data.managedWorktrees.find(w => w.id === worktreeId);
    const baseBranch = record?.baseBranch ?? repo.defaultBranch;
    let baseHead: string | null = null;
    if (baseBranch) {
      const available = await branches(repo);
      const base = available.find(b => !b.remote && b.name === baseBranch) ?? available.find(b => b.remote && b.name === baseBranch);
      if (base) baseHead = (await git(repo.path, ['rev-parse', '--verify', `${base.remote ? 'refs/remotes/' : 'refs/heads/'}${base.name}^{commit}`])).trim();
    }
    const modules = await inspectSubmodules(path, baseHead, identity.exists ? undefined : identity.gitDir);
    const directory = identity.exists ? await inspectDeleteDirectory(repo.path, path, new Set(modules.filter(m => m.preview.state === 'ready').map(m => resolve(path, m.preview.path)))) : identity;
    let status = ''; let index = ''; let trackedChanges = 0; let untrackedFiles = 0; let ignoredFiles = 0;
    if (directory.exists) {
      const trackedFlags = (await git(path, ['ls-files', '-v', '-z'])).split('\0').filter(Boolean);
      if (trackedFlags.some(line => line[0] === 'S' || /^[a-z]/.test(line))) fail('WORKTREE_UNSAFE', '此 Worktree 存在隐藏文件状态的索引标记，请先处理 sparse/skip-worktree/assume-unchanged 后再删除。');
      index = await git(path, ['ls-files', '--stage', '-z']);
      status = await git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none']);
      trackedChanges = trackedFileChanges(status, index);
      untrackedFiles = (await git(path, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).length;
      ignoredFiles = (await git(path, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).split('\0').filter(Boolean).length;
      const currentHead = (await git(path, ['rev-parse', '--verify', 'HEAD'])).trim();
      if (currentHead !== entry.head) fail('DELETE_PREVIEW_STALE', 'Worktree 状态正在变化，请重新检查后再删除。');
    }
    const refs = await git(repo.path, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', 'refs/heads/', 'refs/remotes/', 'refs/tags/']);
    const otherRefs = refs.split('\n').filter(Boolean).map(line => line.split('\0')[0]!).filter(ref => ref !== `refs/heads/${entry.branch}`);
    if (otherRefs.length > 10_000 || otherRefs.join('').length > 100_000) fail('WORKTREE_UNSAFE', '仓库引用过多，无法完成提交保留检查。');
    const uniqueCommits = Number((await git(repo.path, ['rev-list', '--count', entry.head, ...(otherRefs.length ? ['--not', ...otherRefs] : []), '--'])).trim());
    if (!Number.isSafeInteger(uniqueCommits) || uniqueCommits < 0) fail('WORKTREE_UNSAFE', '无法确认提交是否由其他引用保留。');
    const requiresConfirmation = trackedChanges + untrackedFiles + ignoredFiles > 0 || uniqueCommits > 0 && (deleteBranch || !entry.branch);
    const warnings: string[] = [];
    if (!directory.exists) warnings.push('目录已经缺失，将仅清理这条 Git Worktree 注册和应用记录。');
    if (modules.length) warnings.push('默认将子模块分支、提交及其他引用保存到应用数据目录中的独立 Git 备份；未提交文件不会随分支保留。');
    if (modules.length && !baseHead) warnings.push('基准分支不可用，子模块比较结果为无法确认，将默认保留其提交。');
    if (trackedChanges) warnings.push(`${trackedChanges} 项已跟踪文件修改尚未提交，删除后无法恢复。`);
    if (untrackedFiles) warnings.push(`${untrackedFiles} 个未跟踪文件将一并删除，无法通过 Git 恢复。`);
    if (ignoredFiles) warnings.push(`${ignoredFiles} 个被 Git 忽略的文件也会随目录删除。`);
    if (uniqueCommits > 0) warnings.push(deleteBranch || !entry.branch ? `${uniqueCommits} 个提交未被其他分支或标签保留；删除后可能无法找回。` : `${uniqueCommits} 个独有提交仍由分支 ${entry.branch} 保留。`);
    warnings.push(deleteBranch ? `同时删除本地分支 ${entry.branch}，不会修改远程仓库。` : entry.branch ? `保留本地分支 ${entry.branch} 及其提交。` : '此目录处于游离 HEAD 状态。');
    const payload = { worktreeId, path, branch: entry.branch, head: entry.head, deleteBranch, trackedChanges, untrackedFiles, ignoredFiles, uniqueCommits, requiresConfirmation, warnings, baseBranch, baseHead, submodules: modules.map(m => m.preview) };
    const token = createHash('sha256').update(deleteTokenSalt).update(JSON.stringify({ payload, directory, refs, entries, status, index, modules: modules.map(m => m.signature) })).digest('hex');
    const preview: DeletePreview = { ...payload, token };
    return { preview, repo, modules };
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
      const removedRepositories = data.removedRepositories ?? [];
      const removed = removedRepositories.find(repo => samePath(repo.path, canonical));
      if (removed) {
        await save({ ...data, repositories: [...data.repositories, removed], removedRepositories: removedRepositories.filter(repo => repo.id !== removed.id) });
        return { ...removed };
      }
      const provisional: Repository = { id: randomUUID(), name: basename(canonical), path: canonical, defaultBranch: null, branchPrefix: null, addedAt: new Date().toISOString() };
      const refs = await branches(provisional);
      provisional.defaultBranch = refs.find(b => !b.remote && b.name === 'main')?.name ?? refs.find(b => !b.remote && b.name === 'master')?.name ?? refs.find(b => b.current)?.name ?? refs[0]?.name ?? null;
      await save({ ...data, repositories: [...data.repositories, provisional] });
      return { ...provisional };
    }),
    removeRepository: (repoId: string) => serial(async (): Promise<void> => {
      const repo = repository(repoId);
      await save({ ...data, repositories: data.repositories.filter(r => r.id !== repoId), removedRepositories: [...(data.removedRepositories ?? []), repo] });
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
      if (Object.keys(patch).some(k => !['worktreeRoot', 'branchPrefix', 'staleDays', 'themeColor'].includes(k))) fail('INVALID_INPUT', '设置包含未知字段。');
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
      if (patch.themeColor !== undefined) {
        if (!isThemeColor(patch.themeColor)) fail('INVALID_INPUT', '请选择有效的主题色。');
        next.themeColor = patch.themeColor;
      }
      await save({ ...data, settings: next }); return { ...next };
    }),
    listBranches: (repoId: string) => serial(() => branches(repository(repoId))),
    previewCreate: (input: CreateInput) => serial(() => preview(input)),
    createWorktree: (input: CreateInput, signal?: AbortSignal) => serial(async (): Promise<Worktree> => {
      checkCheckoutCancellation(signal);
      const plan = await preview(input); const repo = repository(plan.repoId);
      if (plan.retry) {
        const { worktreeId } = plan.retry;
        const record = data.managedWorktrees.find(w => w.id === worktreeId)!;
        return checkout(repo, record, 'recover', signal);
      }
      const record: ManagedWorktree = { id: randomUUID(), repoId: repo.id, path: plan.path, branch: plan.branch, baseBranch: plan.baseBranch, createdAt: new Date().toISOString() };
      return checkout(repo, record, plan.useExistingBranch ? 'use-existing' : 'create', signal);
    }),
    previewRecovery: (worktreeId: string) => serial(() => recovery(worktreeId)),
    recreateWorktree: (worktreeId: string, signal?: AbortSignal) => serial(async (): Promise<Worktree> => {
      checkCheckoutCancellation(signal);
      await recovery(worktreeId);
      const record = data.managedWorktrees.find(w => w.id === worktreeId)!; const repo = repository(record.repoId);
      return checkout(repo, record, 'recover', signal);
    }),
    removeWorktreeRecord: (worktreeId: string) => serial(async (): Promise<void> => {
      text(worktreeId, 'Worktree ID');
      const record = data.managedWorktrees.find(w => w.id === worktreeId) ?? fail('WORKTREE_NOT_MANAGED', '找不到可移除的应用记录，请刷新列表。');
      const repo = repository(record.repoId);
      await requireRepo(repo);
      if (!isAbsolute(record.path) || samePath(record.path, repo.path)) fail('INVALID_PATH', '保存的 Worktree 路径无效。');
      const path = await physicalPath(record.path);
      const entries = await listGitWorktrees(repo.path);
      if (entries.some(entry => samePath(entry.path, record.path) || samePath(entry.path, path)) || await occupied(record.path)) {
        fail('WORKTREE_PRESENT', '目录或 Git Worktree 注册仍存在，请刷新后使用安全删除。', record.path);
      }
      await save({ ...data, managedWorktrees: data.managedWorktrees.filter(w => w.id !== record.id) });
    }),
    previewDelete: (worktreeId: string, deleteBranch: boolean) => serial(async (): Promise<DeletePreview> => (await deletion(worktreeId, deleteBranch)).preview),
    deleteWorktree: (input: DeleteInput) => serial(async (): Promise<DeleteOutcome> => {
      plain(input);
      if (typeof input.confirmRisks !== 'boolean' || typeof input.token !== 'string' || !/^[0-9a-f]{64}$/.test(input.token)) fail('INVALID_INPUT', '请先检查删除预览并确认风险。');
      const { preview: plan, repo, modules } = await deletion(input.worktreeId, input.deleteBranch);
      if (input.token !== plan.token) fail('DELETE_PREVIEW_STALE', '目录、文件或 Git 状态已变化，请重新检查删除预览。');
      if (plan.requiresConfirmation && !input.confirmRisks) fail('DELETE_CONFIRMATION_REQUIRED', '请明确确认未提交文件或提交丢失风险后再删除。');
      function selection(value: unknown, allowed: string[], label: string): Set<string> {
        if (value === undefined) return new Set();
        if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !allowed.includes(v)) || new Set(value).size !== value.length) fail('INVALID_INPUT', `${label}包含无效或重复的子模块。`);
        return new Set(value as string[]);
      }
      const discard = selection(input.discardSubmodules, plan.submodules.filter(m => m.canDiscard).map(m => m.path), '放弃保留选择');
      const confirmFiles = selection(input.confirmSubmoduleFiles, plan.submodules.filter(hasSubmoduleFiles).map(m => m.path), '文件丢弃确认');
      if (plan.submodules.some(m => hasSubmoduleFiles(m) && !confirmFiles.has(m.path))) fail('SUBMODULE_CONFIRMATION_REQUIRED', '请逐个确认子模块中未提交、未跟踪及忽略文件的丢弃风险。');
      const submodules = await preserveSubmodules(modules, discard, resolve(dataDir));
      // Saving an independent copy can take time; never delete from an older preview.
      if (modules.length && (await deletion(input.worktreeId, input.deleteBranch)).preview.token !== plan.token) fail('DELETE_PREVIEW_STALE', '子模块备份期间状态发生变化，已保留备份，请重新检查。', submodules.filter(m => m.backupPath).map(m => `${m.path}: ${m.backupPath}`).join('\n'));
      const args = ['worktree', 'remove'];
      if (plan.trackedChanges + plan.untrackedFiles > 0 || modules.length) args.push('--force');
      args.push('--', plan.path);
      await git(repo.path, args);
      const warnings: string[] = [];
      await completeSubmoduleRemoval(modules, submodules, warnings);
      const next = { ...data, managedWorktrees: data.managedWorktrees.filter(w => !(w.repoId === repo.id && samePath(w.path, plan.path))) };
      try { await save(next); }
      catch (error) {
        // The filesystem action succeeded. Reflect it in this process and report the
        // persistence failure explicitly instead of presenting a failed deletion.
        data = next;
        warnings.push(`目录已删除，但应用记录未能保存；重启后可能重新显示缺失记录。${appError(error).message}`);
      }
      let branchDeleted = false;
      if (plan.deleteBranch && plan.branch) {
        try {
          const current = await listGitWorktrees(repo.path);
          if (current.some(w => w.branch === plan.branch)) fail('BRANCH_IN_USE', '该分支已被另一个 Worktree 使用。');
          // Compare-and-swap protects commits written after the preview. There is no
          // forceful branch deletion that could silently remove a newer branch tip.
          await git(repo.path, ['update-ref', '--no-deref', '-d', `refs/heads/${plan.branch}`, plan.head!]);
          branchDeleted = true;
        } catch (error) { warnings.push(`目录已删除，但本地分支 ${plan.branch} 未删除，请检查后重试。${appError(error).message}`); }
      }
      return { worktreeId: input.worktreeId, path: plan.path, branch: plan.branch, branchDeleted, warnings, submodules };
    }),
  };
}
