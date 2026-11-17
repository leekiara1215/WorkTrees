import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { git, ServiceError } from './git/client.js';

const refuse = (message: string, details?: string): never => { throw new ServiceError('WORKTREE_UNSAFE', message, details); };

/** Verify both ends of Git's worktree link before permitting a destructive operation. */
export async function inspectDeleteDirectory(repoPath: string, path: string): Promise<{ exists: boolean; signature: string }> {
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
    return { exists: false, signature: 'missing' };
  }
  if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(path) !== path) refuse('Worktree 路径已被替换或包含符号链接，无法安全删除。', path);
  const dotGit = join(path, '.git');
  const dotEntry = await lstat(dotGit).catch(() => null);
  if (!dotEntry?.isFile() || dotEntry.isSymbolicLink()) refuse('此目录不再是原 Git Worktree，已停止删除。', path);
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

  // A file's ctime changes even when its mtime is restored. This catches updates to
  // already-dirty/untracked/ignored files without loading large file contents.
  const hash = createHash('sha256');
  let visited = 0;
  const started = Date.now();
  async function scan(current: string): Promise<void> {
    if (++visited > 250_000 || Date.now() - started > 20_000) refuse('目录内容过多，无法完成安全检查；请先在 Git 中整理该 Worktree。', path);
    const info = await lstat(current, { bigint: true });
    const name = relative(path, current);
    hash.update(JSON.stringify([name, String(info.dev), String(info.ino), String(info.mode), String(info.size), String(info.mtimeNs), String(info.ctimeNs)]));
    if (info.isDirectory() && !info.isSymbolicLink()) {
      const children = (await readdir(current)).sort();
      if (current !== path && ['HEAD', 'config', 'objects', 'refs'].every(name => children.includes(name))) refuse('目录内可能包含裸 Git 仓库，请先单独处理后再删除。', current);
      for (const child of children) {
        if (child === '.git') {
          if (current !== path) refuse('目录内包含嵌套 Git 仓库或子模块，请先单独处理后再删除。', join(current, child));
          continue;
        }
        await scan(join(current, child));
      }
    }
  }
  await scan(path);
  // Include the .git link identity, without traversing the shared repository.
  const dotInfo = await lstat(dotGit, { bigint: true });
  hash.update(`${gitDir}\0${link}\0${dotInfo.ino}\0${dotInfo.ctimeNs}`);
  return { exists: true, signature: hash.digest('hex') };
}

export function isInside(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return !rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
