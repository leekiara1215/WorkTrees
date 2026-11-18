import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DEFAULT_THEME_COLOR, isThemeColor } from '../../shared/theme-colors.js';
import type { Repository, Settings } from '../../shared/types.js';
import { ServiceError } from '../git/client.js';

export interface ManagedWorktree {
  id: string; repoId: string; path: string; branch: string; baseBranch: string; createdAt: string;
}
export interface StoreData {
  version: 1; settings: Settings; repositories: Repository[]; managedWorktrees: ManagedWorktree[];
}

export const defaultSettings = (): Settings => ({ worktreeRoot: join(homedir(), 'WorktreesLite'), branchPrefix: 'wt/', staleDays: 14, themeColor: DEFAULT_THEME_COLOR });

export function createStore(dataDir: string) {
  const file = join(dataDir, 'worktrees.json');
  return {
    async load(): Promise<StoreData> {
      let raw: string;
      try { raw = await readFile(file, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, settings: defaultSettings(), repositories: [], managedWorktrees: [] };
        throw new ServiceError('STORAGE_ERROR', '无法读取本地配置。', String(error));
      }
      try {
        const data = JSON.parse(raw) as StoreData;
        if (data.version !== 1 || !data.settings || !Array.isArray(data.repositories) || !Array.isArray(data.managedWorktrees)
          || typeof data.settings.worktreeRoot !== 'string' || typeof data.settings.branchPrefix !== 'string'
          || !Number.isInteger(data.settings.staleDays) || data.settings.staleDays < 1
          || data.repositories.some(r => !r || !['id', 'path', 'name', 'addedAt'].every(k => typeof (r as unknown as Record<string, unknown>)[k] === 'string')
            || !(r.branchPrefix === null || typeof r.branchPrefix === 'string') || !(r.defaultBranch === null || typeof r.defaultBranch === 'string'))
          || data.managedWorktrees.some(w => !w || !['id', 'repoId', 'path', 'branch', 'baseBranch', 'createdAt'].every(k => typeof (w as unknown as Record<string, unknown>)[k] === 'string'))) {
          throw new Error('Unsupported or invalid data schema');
        }
        if (!isThemeColor(data.settings.themeColor)) data.settings.themeColor = DEFAULT_THEME_COLOR;
        return data;
      } catch (error) {
        throw new ServiceError('STORAGE_CORRUPT', '本地配置文件损坏，已保留原文件，请先备份并修复。', `${file}: ${String(error)}`);
      }
    },
    async save(data: StoreData): Promise<void> {
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await mkdir(dataDir, { recursive: true });
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(data, null, 2) + '\n', 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, file);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw new ServiceError('STORAGE_ERROR', '无法保存本地配置。', String(error), true);
      }
    },
  };
}
