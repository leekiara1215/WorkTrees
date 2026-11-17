import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { TestContext } from 'node:test';
import { createWorktreeService } from '../src/main/worktree-service.ts';

const exec = promisify(execFile);

export async function git(cwd: string, ...args: string[]) {
  return gitWithEnv(cwd, {}, ...args);
}

export async function gitWithEnv(cwd: string, extraEnv: NodeJS.ProcessEnv, ...args: string[]) {
  const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'WorkTrees QA',
      GIT_AUTHOR_EMAIL: 'qa@example.invalid',
      GIT_COMMITTER_NAME: 'WorkTrees QA',
      GIT_COMMITTER_EMAIL: 'qa@example.invalid',
      GIT_TERMINAL_PROMPT: '0',
      ...extraEnv,
    },
    timeout: 15_000,
  });
  return stdout.trim();
}

export async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'worktrees-lite-qa-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoPath = path.join(root, 'sample repo');
  const dataDir = path.join(root, 'app-data');
  const worktreeRoot = path.join(root, 'worktrees');
  await mkdir(repoPath);
  await git(repoPath, 'init', '-b', 'main');
  await writeFile(path.join(repoPath, 'README.md'), 'QA fixture\n');
  await git(repoPath, 'add', 'README.md');
  await git(repoPath, 'commit', '-m', 'Initial QA fixture');
  const service = createWorktreeService({ dataDir });
  await service.updateSettings({ worktreeRoot, branchPrefix: 'wt/', staleDays: 30 });
  const repo = await service.addRepository(repoPath);
  const input = (branchName = 'feature') => ({ repoId: repo.id, baseBranch: 'main', branchName });
  return { root, repoPath, dataDir, worktreeRoot, service, repo, input };
}
