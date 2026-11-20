import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { git, ServiceError } from './git/client.js';

const refuse = (message: string, details?: string): never => { throw new ServiceError('WORKTREE_UNSAFE', message, details); };

/** Verify both ends of Git's worktree link before permitting a destructive operation. */
export async function inspectDeleteDirectory(repoPath: string, path: string): Promise<{ exists: boolean; signature: string; gitDir: string }> {
  if (!isAbsolute(path) || resolve(path) !== path) refuse('Worktree 路径不是规范的绝对路径。', path);
  let entry;
  try { entry = await lstat(path, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A missing leaf is valid only when all existing parents still resolve to the recorded path.
    let parent = dirname(path);
    while (true) {
      try { if (await realpath(parent) !== parent) refuse('原路径的上级目录已发生变化，请先检查目录。', path); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const next = dirname(parent); if (next === parent) throw error; parent = next;
    }
    const common = await realpath((await git(repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
    const adminRoot = join(common, 'worktrees');
    for (const name of await readdir(adminRoot)) {
      const admin = join(adminRoot, name);
      if ((await lstat(admin)).isSymbolicLink()) continue;
      const backlink = await readFile(join(admin, 'gitdir'), 'utf8').catch(() => '');
      if (backlink.trim() !== join(path, '.git')) continue;
      if (await realpath(admin) !== admin || (await lstat(join(admin, 'gitdir'))).isSymbolicLink()) refuse('缺失 Worktree 的管理目录身份不一致。', admin);
      return { exists: false, signature: 'missing', gitDir: admin };
    }
    return refuse('无法找到缺失 Worktree 对应的 Git 管理目录。', path);
  }
  if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(path) !== path) refuse('Worktree 路径已被替换或包含符号链接，无法安全删除。', path);
  const dotGit = join(path, '.git');
  const dotEntry = await lstat(dotGit, { bigint: true }).catch(() => null)
    ?? refuse('此目录不再是原 Git Worktree，已停止删除。', path);
  if (!dotEntry.isFile()) refuse('此目录不再是原 Git Worktree，已停止删除。', path);
  const common = await realpath((await git(repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  const childCommon = await realpath((await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  const top = await realpath((await git(path, ['rev-parse', '--show-toplevel'])).trim());
  const gitDir = await realpath((await git(path, ['rev-parse', '--absolute-git-dir'])).trim());
  const adminRoot = join(common, 'worktrees');
  if (common !== childCommon || top !== path || dirname(gitDir) !== adminRoot || await realpath(adminRoot) !== adminRoot) refuse('目录的 Git 身份与原仓库不一致，已停止删除。', path);
  const link = (await readFile(dotGit, 'utf8')).trim();
  if (!link.startsWith('gitdir: ') || await realpath(resolve(path, link.slice(8))) !== gitDir) refuse('Worktree 的 Git 链接无效，已停止删除。', path);
  const backlink = (await readFile(join(gitDir, 'gitdir'), 'utf8')).trim();
  if (!isAbsolute(backlink) || resolve(backlink) !== dotGit || await realpath(backlink) !== dotGit) refuse('Worktree 的 Git 注册路径与目录不一致，已停止删除。', path);
  // Root timestamps can change when an ignored path is created or removed.
  const signature = JSON.stringify([link, ...[entry.dev, entry.ino, entry.mode, dotEntry.ino, dotEntry.ctimeNs].map(String)]);
  return { exists: true, signature, gitDir };
}

export function isInside(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return !rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
