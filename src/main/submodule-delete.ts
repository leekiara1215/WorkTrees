import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { SubmoduleDeleteOutcome, SubmoduleDeletePreview } from '../shared/types.js';
import { isInside } from './delete-safety.js';
import { git, parseWorktrees, ServiceError } from './git/client.js';

const refuse = (message: string, details?: string): never => { throw new ServiceError('SUBMODULE_UNSAFE', message, details); };
async function info(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function metadataGit(directory: string, args: string[]) {
  return git(directory, ['--git-dir', directory, '--work-tree', directory, ...args]);
}
async function optional(cwd: string, args: string[], metadata = false) {
  try { return (await (metadata ? metadataGit(cwd, args) : git(cwd, args))).trim(); }
  catch (error) { if (error instanceof ServiceError && error.code === 'GIT_ERROR') return null; throw error; }
}

function gitlinks(output: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const entry of output.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    const [mode, second, third] = entry.slice(0, tab).split(' ');
    if (mode !== '160000') continue;
    if (third !== '0' && second !== 'commit') refuse('子模块索引存在冲突，请先解决冲突。');
    result.set(entry.slice(tab + 1), second === 'commit' ? third! : second!);
  }
  return result;
}
async function tree(cwd: string, commit: string | null, metadata = false) {
  return commit ? gitlinks(await (metadata ? metadataGit(cwd, ['ls-tree', '-rz', '--full-tree', commit]) : git(cwd, ['ls-tree', '-rz', '--full-tree', commit]))) : new Map<string, string>();
}
async function submoduleWorktrees(admin: string, common: string, checkoutPath?: string) {
  // Git reports a submodule's common directory as its main worktree path on some versions.
  // Resolve core.worktree explicitly; overriding it for this read also handles a missing checkout.
  const entries = parseWorktrees(await metadataGit(admin, ['worktree', 'list', '--porcelain', '-z']));
  const main = await optional(common, ['config', '--get', 'core.worktree'], true);
  for (const entry of entries) if (entry.path === common) entry.path = main ? resolve(common, main) : checkoutPath ?? common;
  return entries;
}
function safeChild(parent: string, child: string): string {
  const result = resolve(parent, child);
  if (!child || isAbsolute(child) || result === parent || !isInside(parent, result) || child.split(/[\\/]/).some(part => part === '..' || part.toLowerCase() === '.git')) refuse('子模块路径或名称不安全。', child);
  return result;
}
function count(output: string) { return output.split('\0').filter(Boolean).length; }
export function trackedFileChanges(status: string, index: string) {
  const nested = gitlinks(index);
  const parts = status.split('\0').filter(Boolean);
  let changes = 0;
  for (let i = 0; i < parts.length; i++) {
    const state = parts[i]!.slice(0, 2);
    const path = parts[i]!.slice(3);
    // Child working directory/HEAD changes are covered by its own preview. A staged
    // gitlink change is still an uncommitted modification to the parent repository.
    if (state !== '??' && state !== '!!' && !(state[0] === ' ' && nested.has(path))) changes++;
    if (/[RC]/.test(state)) i++;
  }
  return changes;
}
export function hasSubmoduleFiles(module: SubmoduleDeletePreview) {
  return module.trackedChanges + module.untrackedFiles + module.ignoredFiles > 0;
}
export interface InspectedSubmodule {
  preview: SubmoduleDeletePreview; source: string | null; gitDir: string | null; common: string | null; checkoutPath: string;
  refs: string; stashLog: string; objectFormat: string; signature: string; commonWillBeRemoved: boolean;
}

/** Inventory only registered gitlinks. Every nested .git must pass a repository identity check. */
export async function inspectSubmodules(root: string, baseHead: string | null, missingAdmin?: string): Promise<InspectedSubmodule[]> {
  const modules: InspectedSubmodule[] = [];
  const rootAdmin = missingAdmin ?? await realpath((await git(root, ['rev-parse', '--absolute-git-dir'])).trim());
  const seen = new Set<string>();
  async function visit(parent: string, checkout: string | null, prefix: string, baseline: string | null, depth: number): Promise<void> {
    if (depth > 20 || modules.length > 200) refuse('子模块层级或数量过多，无法完成安全检查。');
    const run = (args: string[]) => checkout ? git(parent, args) : metadataGit(parent, args);
    const head = (await run(['rev-parse', '--verify', 'HEAD'])).trim();
    const links = await tree(parent, head, !checkout);
    if (checkout) {
      const staged = gitlinks(await git(parent, ['ls-files', '--stage', '-z']));
      for (const [path, oid] of staged) links.set(path, oid);
    }
    if (!links.size) return;
    const bases = await tree(parent, baseline, !checkout);
    const configFile = checkout ? join(checkout, '.gitmodules') : null;
    const configInfo = configFile ? await info(configFile) : null;
    if (configInfo && (!configInfo.isFile() || configInfo.isSymbolicLink())) refuse('子模块配置不是普通文件。', configFile!);
    const config = configInfo
      ? await git(parent, ['config', '--null', '--list', '--file', configFile!])
      : await optional(parent, ['config', '--null', '--list', '--blob', 'HEAD:.gitmodules'], !checkout);
    const names = new Map<string, string>();
    for (const field of (config ?? '').split('\0').filter(Boolean)) {
      const newline = field.indexOf('\n');
      const match = /^submodule\.(.*)\.path$/.exec(field.slice(0, newline));
      if (!match) continue;
      const path = field.slice(newline + 1);
      if (names.has(path)) refuse('子模块配置包含重复路径。', path);
      names.set(path, match[1]!);
    }
    const parentAdmin = (await run(['rev-parse', '--absolute-git-dir'])).trim();
    for (const [child, registeredHead] of [...links].sort(([a], [b]) => a.localeCompare(b))) {
      if (modules.length >= 200) refuse('子模块数量过多，无法完成安全检查。');
      const name = names.get(child) ?? refuse('子模块缺少有效的 .gitmodules 配置，无法确认仓库身份。', child);
      const fullPath = prefix ? `${prefix}/${child}` : child;
      const absolute = safeChild(root, fullPath);
      const expectedAdmin = safeChild(join(parentAdmin, 'modules'), name);
      if (await info(expectedAdmin) && await realpath(expectedAdmin) !== expectedAdmin) refuse('子模块管理目录包含符号链接。', expectedAdmin);
      // Check every existing ancestor before using Git on a child path.
      let ancestor = absolute;
      while (!await info(ancestor)) ancestor = dirname(ancestor);
      if (await realpath(ancestor) !== ancestor) refuse('子模块路径包含符号链接。', absolute);
      const dotGit = join(absolute, '.git');
      const dotInfo = checkout ? await info(dotGit) : null;
      const directoryInfo = checkout ? await info(absolute) : null;
      if (directoryInfo && (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())) refuse('子模块路径不是普通目录。', absolute);
      if (dotInfo && (dotInfo.isSymbolicLink() || !dotInfo.isFile() && !dotInfo.isDirectory())) refuse('子模块 Git 链接无效。', dotGit);
      if (!dotInfo && directoryInfo && (await readdir(absolute)).length) refuse('子模块未初始化但目录内存在文件，无法确认其状态。', absolute);
      let source: string | null = dotInfo ? absolute : null;
      if (!source && await info(expectedAdmin)) source = expectedAdmin;
      let currentHead: string | null = null; let branch: string | null = null; let common: string | null = null; let gitDir: string | null = null;
      let refs = ''; let stashLog = ''; let objectFormat = 'sha1'; let status = ''; let index = ''; let flags = ''; let identity = '';
      let trackedChanges = 0; let untrackedFiles = 0; let ignoredFiles = 0;
      let ahead: number | null = null; let behind: number | null = null;
      let protectionReason: string | null = null;
      if (source) {
        const runChild = (args: string[]) => dotInfo ? git(source!, args) : metadataGit(source!, args);
        const admin = await realpath((await runChild(['rev-parse', '--absolute-git-dir'])).trim());
        gitDir = admin;
        common = await realpath((await runChild(['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
        if (admin !== common) {
          if (dirname(admin) !== join(common, 'worktrees')) refuse('子模块共享 Git 目录未通过 Worktree 身份验证。', fullPath);
          const backlink = (await readFile(join(admin, 'gitdir'), 'utf8')).trim();
          if (backlink !== dotGit) refuse('子模块 Worktree 注册路径与目录不一致。', fullPath);
        }
        if (seen.has(admin)) refuse('多个子模块指向同一 Git 工作目录，无法安全删除。', fullPath);
        seen.add(admin);
        if (dotInfo) {
          if (await realpath((await git(source, ['rev-parse', '--show-toplevel'])).trim()) !== absolute) refuse('子模块的 Git 身份与目录不一致。', absolute);
          if (dotInfo.isDirectory()) {
            if (admin !== await realpath(dotGit)) refuse('子模块内嵌 Git 目录无效。', dotGit);
          } else {
            const link = (await readFile(dotGit, 'utf8')).trim();
            if (!link.startsWith('gitdir: ') || await realpath(resolve(absolute, link.slice(8))) !== admin) refuse('子模块 Git 链接与仓库不一致。', dotGit);
            identity = link;
            const expected = await info(expectedAdmin) ? await realpath(expectedAdmin) : null;
            if (admin !== expected) {
              // Also support a registered linked worktree of a submodule repository.
              const backlink = await optional(source, ['rev-parse', '--git-path', 'gitdir']);
              if (dirname(admin) !== join(common, 'worktrees') || !backlink || await realpath((await readFile(resolve(source, backlink), 'utf8')).trim()) !== dotGit) refuse('子模块 Git 链接指向未验证的仓库。', dotGit);
            }
          }
        }
        currentHead = (await runChild(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
        objectFormat = (await runChild(['rev-parse', '--show-object-format'])).trim();
        if (!['sha1', 'sha256'].includes(objectFormat)) refuse('无法确认子模块的 Git 对象格式。', fullPath);
        branch = (await optional(source, ['symbolic-ref', '--quiet', 'HEAD'], !dotInfo))?.replace(/^refs\/heads\//, '') ?? null;
        refs = await runChild(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)']);
        if (refs.length > 1_000_000 || refs.split('\n').length > 10_000) refuse('子模块引用过多，无法完成保留检查。', fullPath);
        const worktrees = await submoduleWorktrees(admin, common, admin === common ? absolute : undefined);
        if (worktrees.some(w => w.path === absolute && w.locked)) refuse('子模块 Worktree 已锁定，请先检查锁定原因。', fullPath);
        const commonWillBeRemoved = isInside(root, common) || isInside(rootAdmin, common);
        if (worktrees.some(w => w.path !== absolute && !isInside(root, w.path) && commonWillBeRemoved)) refuse('子模块仓库仍被目录外的 Worktree 使用，请先单独处理。', fullPath);
        if (branch && worktrees.some(w => w.branch === branch && w.path !== absolute && !isInside(root, w.path))) protectionReason = '此分支仍被其他 Worktree 使用，必须保留。';
        identity += JSON.stringify({ admin, common, worktrees });
        const stashFile = join(common, 'logs', 'refs', 'stash');
        const stashInfo = await info(stashFile);
        if (stashInfo) {
          if (!stashInfo.isFile() || stashInfo.isSymbolicLink()) refuse('子模块 stash 日志不是普通文件。', fullPath);
          if (stashInfo.size > 16 * 1024 * 1024) refuse('子模块 stash 日志过大，无法完成保留检查。', fullPath);
          stashLog = await readFile(stashFile, 'utf8');
        }
        for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
          if (await info(join(admin, marker))) refuse('子模块正在合并、变基或拣选提交，请完成后再删除。', fullPath);
        }
        if (dotInfo) {
          flags = await git(source, ['ls-files', '-v', '-z']);
          if (flags.split('\0').some(line => line[0] === 'S' || /^[a-z]/.test(line))) refuse('子模块存在 sparse/skip-worktree/assume-unchanged 标记，请先处理。', fullPath);
          index = await git(source, ['ls-files', '--stage', '-z']);
          status = await git(source, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none']);
          trackedChanges = trackedFileChanges(status, index);
          untrackedFiles = count(await git(source, ['ls-files', '--others', '--exclude-standard', '-z']));
          ignoredFiles = count(await git(source, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']));
        }
        const base = bases.get(child) ?? null;
        if (base && await optional(source, ['cat-file', '-e', `${base}^{commit}`], !dotInfo) !== null) {
          const counts = (await runChild(['rev-list', '--left-right', '--count', `${currentHead}...${base}`, '--'])).trim().split(/\s+/).map(Number);
          [ahead, behind] = counts as [number, number];
        }
      }
      const base = bases.get(child) ?? null;
      const comparison = currentHead && base && ahead !== null ? currentHead === base ? 'same' : 'different' : 'unknown';
      const preview: SubmoduleDeletePreview = {
        path: fullPath, branch, head: currentHead, baseHead: base,
        state: dotInfo ? 'ready' : source ? 'missing-worktree' : 'uninitialized',
        comparison, ahead, behind, trackedChanges, untrackedFiles, ignoredFiles,
        canDiscard: !!source && comparison !== 'same' && !protectionReason, protectionReason,
      };
      modules.push({ preview, source, gitDir, common, refs, stashLog, objectFormat, checkoutPath: absolute,
        commonWillBeRemoved: !!common && (isInside(root, common) || isInside(rootAdmin, common)),
        signature: createHash('sha256').update(JSON.stringify({ preview, registeredHead, refs, stashLog, objectFormat, status, index, flags, identity, config })).digest('hex') });
      if (source) await visit(source, dotInfo ? absolute : null, fullPath, ahead !== null ? base : null, depth + 1);
    }
  }
  await visit(missingAdmin ?? root, missingAdmin ? null : root, '', baseHead, 0);
  // Previously removed gitlinks can leave repositories in the worktree's admin directory.
  // Refuse unclassified data rather than silently dropping its branches during removal.
  const inspected = new Set<string>();
  let visited = 0;
  async function checkAdmin(directory: string): Promise<void> {
    if (!await info(directory) || inspected.has(directory)) return;
    if (++visited > 2_000) refuse('子模块管理目录过多，无法完成安全检查。');
    inspected.add(directory);
    if (await realpath(directory) !== directory) refuse('子模块管理目录包含符号链接。', directory);
    const children = await readdir(directory);
    if (children.includes('HEAD') && children.includes('config') && (children.includes('objects') || children.includes('commondir'))) {
      if (!seen.has(directory)) refuse('存在已移除或未登记的子模块 Git 数据，请先单独保留后再删除。', directory);
      await checkAdmin(join(directory, 'modules'));
    } else {
      for (const child of children) if ((await lstat(join(directory, child))).isDirectory()) await checkAdmin(join(directory, child));
    }
  }
  await checkAdmin(join(rootAdmin, 'modules'));
  for (const module of modules) if (module.gitDir && isInside(root, module.gitDir)) await checkAdmin(join(module.gitDir, 'modules'));
  return modules;
}

/** Fetch into a fresh independent object database; never use alternates or hardlinks. */
export async function preserveSubmodules(modules: InspectedSubmodule[], discard: ReadonlySet<string>, dataDir: string): Promise<SubmoduleDeleteOutcome[]> {
  const outcomes: SubmoduleDeleteOutcome[] = [];
  const operation = join(dataDir, 'submodule-backups', randomUUID());
  for (const module of modules) {
    const { preview, source } = module;
    const discarded = discard.has(preview.path);
    const outcome: SubmoduleDeleteOutcome = { path: preview.path, backupPath: null, discarded, branchDeleted: false };
    outcomes.push(outcome);
    if (!source || !preview.head) continue;
    const originalRefs = module.refs.split('\n').filter(Boolean).map(line => {
      const [name, oid, symref] = line.split('\0');
      return { name: name!, oid: oid!, symref };
    });
    const retained = originalRefs.filter(ref => !discarded || ref.name !== `refs/heads/${preview.branch}`);
    if (discarded && !retained.length) continue;
    const backup = join(operation, `${outcomes.length}-${createHash('sha256').update(preview.path).digest('hex').slice(0, 12)}.git`);
    try {
      await mkdir(backup, { recursive: true, mode: 0o700 });
      await git(backup, ['init', '--bare', `--object-format=${module.objectFormat}`]);
      const recoveryRef = `refs/worktrees-lite/${randomUUID()}`;
      const bundle = join(backup, 'preservation.bundle');
      const stashHeads = [...new Set(module.stashLog.split('\n').filter(Boolean).flatMap(line => line.split(' ').slice(0, 2)).filter(oid => /^[0-9a-f]{40,64}$/.test(oid) && !/^0+$/.test(oid)))];
      await metadataGit(module.gitDir!, ['bundle', 'create', bundle, '--all', 'HEAD', ...stashHeads]);
      await git(backup, ['fetch', '--no-tags', '--no-write-fetch-head', bundle, '+refs/*:refs/*', `+HEAD:${recoveryRef}`]);
      await unlink(bundle);
      if (discarded) {
        if (preview.branch) await git(backup, ['update-ref', '--no-deref', '-d', `refs/heads/${preview.branch}`, preview.head]);
        await git(backup, ['update-ref', '-d', recoveryRef, preview.head]);
      } else {
        await git(backup, ['update-ref', '--no-deref', 'HEAD', preview.head]);
      }
      // Fetch must preserve every promised reference, including stash and other local branches.
      for (const ref of retained) {
        if ((await git(backup, ['rev-parse', '--verify', ref.name])).trim() !== ref.oid) refuse('子模块备份引用校验失败。', `${preview.path}: ${ref.name}`);
        // If the selected branch was the target of another symbolic reference,
        // retain that other reference as a direct OID rather than making it dangling.
        if (ref.symref && await optional(backup, ['rev-parse', '--verify', ref.symref]) === ref.oid) await git(backup, ['symbolic-ref', ref.name, ref.symref]);
      }
      const stashRoot = `refs/worktrees-lite/stash-${randomUUID()}`;
      for (const [index, oid] of stashHeads.entries()) await git(backup, ['update-ref', `${stashRoot}/${index}`, oid]);
      if (module.stashLog) {
        await mkdir(join(backup, 'logs', 'refs'), { recursive: true });
        await writeFile(join(backup, 'logs', 'refs', 'stash'), module.stashLog, { mode: 0o600 });
      }
      await git(backup, ['fsck', '--connectivity-only']);
      await writeFile(join(backup, 'worktrees-lite-backup.json'), JSON.stringify({ path: preview.path, branch: preview.branch, head: preview.head, discarded, recoveryRef: discarded ? null : recoveryRef, source, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
      outcome.backupPath = backup;
    } catch (error) {
      const details = error instanceof ServiceError ? `${error.message}\n${error.details ?? ''}` : String(error);
      throw new ServiceError('SUBMODULE_BACKUP_FAILED', '子模块保留失败，尚未删除 Worktree。', `${preview.path}\n${backup}\n${details}\n已完成备份：${outcomes.filter(o => o.backupPath).map(o => `${o.path}: ${o.backupPath}`).join('\n')}`, true);
    }
  }
  return outcomes;
}

export async function completeSubmoduleRemoval(modules: InspectedSubmodule[], outcomes: SubmoduleDeleteOutcome[], warnings: string[]) {
  for (const outcome of [...outcomes].reverse()) {
    const module = modules.find(m => m.preview.path === outcome.path)!;
    if (module.common && module.gitDir !== module.common && !module.commonWillBeRemoved) {
      try { await metadataGit(module.common, ['worktree', 'remove', '--', module.checkoutPath]); }
      catch (error) { warnings.push(`目录已删除，但子模块 ${outcome.path} 的 Worktree 注册未清理，请手动检查：${String(error)}`); continue; }
    }
    if (!outcome.discarded || !module.preview.branch || !module.common) continue;
    if (module.commonWillBeRemoved) { outcome.branchDeleted = true; continue; }
    try {
      const others = await submoduleWorktrees(module.common, module.common);
      if (others.some(w => w.branch === module.preview.branch && w.path !== module.checkoutPath)) refuse('子模块分支已被其他 Worktree 使用。');
      await metadataGit(module.common, ['update-ref', '--no-deref', '-d', `refs/heads/${module.preview.branch}`, module.preview.head!]);
      outcome.branchDeleted = true;
    } catch (error) {
      warnings.push(`目录已删除，但子模块 ${outcome.path} 的分支未删除：${String(error)}`);
    }
  }
}
