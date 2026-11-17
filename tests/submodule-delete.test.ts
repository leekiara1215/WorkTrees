import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fixture, git } from './fixtures.ts';
import type { DeletePreview } from '../src/shared/types.ts';

function deletion(preview: DeletePreview, discardSubmodules: string[] = [], confirmSubmoduleFiles: string[] = []) {
  return { worktreeId: preview.worktreeId, deleteBranch: false, token: preview.token, confirmRisks: true, discardSubmodules, confirmSubmoduleFiles };
}
async function commit(cwd: string, file = 'module.txt', content = 'module change') {
  await writeFile(path.join(cwd, file), content);
  await git(cwd, 'add', '--', file);
  await git(cwd, 'commit', '-m', content);
  return git(cwd, 'rev-parse', 'HEAD');
}
async function setup(t: TestContext, names = ['module']) {
  const f = await fixture(t);
  const origin = path.join(f.root, 'module-origin');
  await mkdir(origin);
  await git(origin, 'init', '-b', 'main');
  const base = await commit(origin, 'module.txt', 'base');
  for (const name of names) await git(f.repoPath, '-c', 'protocol.file.allow=always', 'submodule', 'add', origin, name);
  await git(f.repoPath, 'commit', '-am', 'Add modules');
  const created = await f.service.createWorktree(f.input('modules'));
  await git(created.path, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive');
  return { ...f, created, origin, base, module: path.join(created.path, names[0]!) };
}

test('identical clean submodule permits deletion without discard confirmation and preserves independent Git data', async t => {
  const f = await setup(t);
  await git(f.module, 'switch', '-c', 'same-feature');
  const before = await git(f.module, 'for-each-ref');
  const preview = await f.service.previewDelete(f.created.id, false);
  assert.equal(preview.submodules[0]!.comparison, 'same');
  assert.equal(preview.submodules[0]!.canDiscard, false);
  assert.equal(preview.requiresConfirmation, false);
  assert.equal(preview.baseBranch, 'main');
  assert.equal(await git(f.module, 'for-each-ref'), before, 'preview is read-only');
  const outcome = await f.service.deleteWorktree({ ...deletion(preview), confirmRisks: false });
  await assert.rejects(access(f.created.path));
  const backup = outcome.submodules[0]!.backupPath!;
  assert.equal(await git(backup, 'rev-parse', 'refs/heads/same-feature'), f.base);
  await rm(f.origin, { recursive: true });
  await rm(path.join(f.repoPath, '.git', 'modules'), { recursive: true });
  assert.equal(await git(backup, 'show', `${f.base}:module.txt`), 'base');
  await git(backup, 'fsck', '--full');
  await assert.rejects(access(path.join(backup, 'objects', 'info', 'alternates')));
});

test('different detached commits are retained by default and remain cloneable after deletion', async t => {
  const f = await setup(t);
  const head = await commit(f.module);
  const preview = await f.service.previewDelete(f.created.id, false);
  const module = preview.submodules[0]!;
  assert.equal(module.branch, null);
  assert.equal(module.comparison, 'different');
  assert.equal(module.ahead, 1);
  assert.equal(module.behind, 0);
  assert.equal(module.canDiscard, true);
  const outcome = await f.service.deleteWorktree(deletion(preview));
  const backup = outcome.submodules[0]!.backupPath!;
  assert.equal(await git(backup, 'rev-parse', 'HEAD'), head);
  const restored = path.join(f.root, 'restored');
  await git(f.root, 'clone', backup, restored);
  assert.equal(await readFile(path.join(restored, 'module.txt'), 'utf8'), 'module change');
});

test('per-module discard drops only selected branch and retains other branches, tags and stash', async t => {
  const f = await setup(t, ['first', 'second']);
  const second = path.join(f.created.path, 'second');
  await git(f.module, 'switch', '-c', 'first-feature');
  const firstHead = await commit(f.module);
  await git(f.module, 'symbolic-ref', 'refs/heads/feature-alias', 'refs/heads/first-feature');
  await git(f.module, 'tag', '-a', 'saved-tag', '-m', 'keep', f.base);
  await git(f.module, 'branch', 'saved-branch', f.base);
  await writeFile(path.join(f.module, 'module.txt'), 'stashed edits');
  await git(f.module, 'stash', 'push', '-m', 'keep stash');
  await writeFile(path.join(f.module, 'module.txt'), 'second stashed edits');
  await git(f.module, 'stash', 'push', '-m', 'keep second stash');
  const stash = await git(f.module, 'rev-parse', 'refs/stash');
  await git(second, 'switch', '-c', 'second-feature');
  const secondHead = await commit(second, 'module.txt', 'second change');
  const preview = await f.service.previewDelete(f.created.id, false);
  const outcome = await f.service.deleteWorktree(deletion(preview, ['first']));
  const first = outcome.submodules.find(m => m.path === 'first')!;
  assert(first.discarded && first.branchDeleted);
  assert.equal(outcome.submodules.find(m => m.path === 'second')!.discarded, false);
  await assert.rejects(git(first.backupPath!, 'show-ref', '--verify', 'refs/heads/first-feature'));
  assert.equal(await git(first.backupPath!, 'rev-parse', 'refs/heads/feature-alias'), firstHead);
  assert.equal(await git(first.backupPath!, 'rev-parse', 'refs/stash'), stash);
  assert.equal(await git(first.backupPath!, 'show', 'refs/stash:module.txt'), 'second stashed edits');
  assert.equal(await git(first.backupPath!, 'show', 'stash@{1}:module.txt'), 'stashed edits');
  assert.equal((await git(first.backupPath!, 'reflog', 'show', '--format=%H', 'refs/stash')).split('\n').length, 2);
  assert.equal(await git(first.backupPath!, 'rev-parse', 'refs/heads/saved-branch'), f.base);
  assert.equal(await git(first.backupPath!, 'rev-parse', 'saved-tag^{commit}'), f.base);
  assert.equal(await git(outcome.submodules.find(m => m.path === 'second')!.backupPath!, 'rev-parse', 'refs/heads/second-feature'), secondHead);
  // Objects retained by stash may still include the discarded head; discard removes its branch, not all other references.
  assert.notEqual(firstHead, f.base);
});

test('same commit with dirty, untracked and ignored files needs separate module confirmation', async t => {
  const f = await setup(t);
  await writeFile(path.join(f.module, 'module.txt'), 'uncommitted');
  await writeFile(path.join(f.module, 'draft.txt'), 'draft');
  const exclude = (await git(f.module, 'rev-parse', '--git-path', 'info/exclude'));
  await writeFile(path.resolve(f.module, exclude), 'cache.bin\n');
  await writeFile(path.join(f.module, 'cache.bin'), 'cache');
  const preview = await f.service.previewDelete(f.created.id, false);
  const module = preview.submodules[0]!;
  assert.equal(module.comparison, 'same');
  assert.equal(module.canDiscard, false);
  assert.equal(module.trackedChanges, 1);
  assert.equal(module.untrackedFiles, 1);
  assert.equal(module.ignoredFiles, 1);
  await assert.rejects(f.service.deleteWorktree(deletion(preview)), { code: 'SUBMODULE_CONFIRMATION_REQUIRED' });
  await f.service.deleteWorktree(deletion(preview, [], ['module']));
  await assert.rejects(access(f.created.path));
});

test('invalid, duplicate and identical-module discard selections are rejected', async t => {
  const f = await setup(t);
  const preview = await f.service.previewDelete(f.created.id, false);
  for (const selected of [['module'], ['../outside'], ['module', 'module']]) {
    await assert.rejects(f.service.deleteWorktree(deletion(preview, selected)), { code: 'INVALID_INPUT' });
  }
  await access(f.module);
});

test('submodule HEAD, refs and dirty file changes invalidate the preview', async t => {
  const f = await setup(t);
  let preview = await f.service.previewDelete(f.created.id, false);
  await git(f.module, 'branch', 'new-reference');
  await assert.rejects(f.service.deleteWorktree(deletion(preview)), { code: 'DELETE_PREVIEW_STALE' });
  preview = await f.service.previewDelete(f.created.id, false);
  await commit(f.module);
  await assert.rejects(f.service.deleteWorktree(deletion(preview)), { code: 'DELETE_PREVIEW_STALE' });
  await writeFile(path.join(f.module, 'module.txt'), 'dirty before');
  preview = await f.service.previewDelete(f.created.id, false);
  await writeFile(path.join(f.module, 'module.txt'), 'dirty after!');
  await assert.rejects(f.service.deleteWorktree(deletion(preview, [], ['module'])), { code: 'DELETE_PREVIEW_STALE' });
  await access(f.created.path);
});

test('uninitialized registered submodule does not block safe removal', async t => {
  const f = await setup(t);
  await git(f.created.path, 'submodule', 'deinit', '--all');
  const preview = await f.service.previewDelete(f.created.id, false);
  assert.equal(preview.submodules[0]!.state, 'missing-worktree');
  const outcome = await f.service.deleteWorktree(deletion(preview));
  assert(outcome.submodules[0]!.backupPath);
  await assert.rejects(access(f.created.path));
  const other = await f.service.createWorktree(f.input('never-initialized'));
  const next = await f.service.previewDelete(other.id, false);
  assert.equal(next.submodules[0]!.state, 'uninitialized');
  assert.equal(next.submodules[0]!.canDiscard, false);
  await f.service.deleteWorktree(deletion(next));
});

test('missing submodule directory still preserves local Git branches', async t => {
  const f = await setup(t);
  await git(f.module, 'switch', '-c', 'keep-missing');
  const head = await commit(f.module);
  await rm(f.module, { recursive: true });
  const preview = await f.service.previewDelete(f.created.id, false);
  assert.equal(preview.submodules[0]!.state, 'missing-worktree');
  const outcome = await f.service.deleteWorktree(deletion(preview));
  assert.equal(await git(outcome.submodules[0]!.backupPath!, 'rev-parse', 'refs/heads/keep-missing'), head);
});

test('registered submodule containing unrelated nested repository remains protected', async t => {
  const f = await setup(t);
  const nested = path.join(f.module, 'unrelated');
  await mkdir(nested);
  await git(nested, 'init', '-b', 'main');
  await commit(nested);
  await assert.rejects(f.service.previewDelete(f.created.id, false), { code: 'WORKTREE_UNSAFE' });
  await access(nested);
});

test('failed preservation leaves parent and all modules intact', async t => {
  const f = await setup(t);
  await writeFile(path.join(f.dataDir, 'submodule-backups'), 'block backup path');
  const preview = await f.service.previewDelete(f.created.id, false);
  await assert.rejects(f.service.deleteWorktree(deletion(preview)), { code: 'SUBMODULE_BACKUP_FAILED' });
  await access(f.created.path);
  assert.equal(await git(f.module, 'rev-parse', 'HEAD'), f.base);
});

test('missing base ref is shown as unknown, never equal', async t => {
  const f = await setup(t);
  await git(f.repoPath, 'branch', '-m', 'renamed-main');
  const preview = await f.service.previewDelete(f.created.id, false);
  assert.equal(preview.baseHead, null);
  assert.equal(preview.submodules[0]!.comparison, 'unknown');
  const outcome = await f.service.deleteWorktree(deletion(preview));
  assert.equal(await git(outcome.submodules[0]!.backupPath!, 'rev-parse', 'HEAD'), f.base);
});

test('recursive submodules are checked and preserved independently', async t => {
  const f = await setup(t);
  const inner = path.join(f.root, 'inner-origin');
  await mkdir(inner);
  await git(inner, 'init', '-b', 'main');
  const innerHead = await commit(inner);
  await git(f.module, '-c', 'protocol.file.allow=always', 'submodule', 'add', inner, 'inner');
  await git(f.module, 'commit', '-am', 'Add inner submodule');
  const preview = await f.service.previewDelete(f.created.id, false);
  assert.deepEqual(preview.submodules.map(m => m.path), ['module', 'module/inner']);
  const outcome = await f.service.deleteWorktree(deletion(preview));
  assert.equal(await git(outcome.submodules.find(m => m.path === 'module/inner')!.backupPath!, 'rev-parse', 'HEAD'), innerHead);
});

test('missing parent worktree still preserves submodule Git data before cleaning its registration', async t => {
  const f = await setup(t);
  await git(f.module, 'switch', '-c', 'missing-parent-feature');
  const head = await commit(f.module);
  await rm(f.created.path, { recursive: true });
  const preview = await f.service.previewDelete(f.created.id, false);
  assert.equal(preview.submodules[0]!.state, 'missing-worktree');
  const outcome = await f.service.deleteWorktree(deletion(preview));
  assert.equal(await git(outcome.submodules[0]!.backupPath!, 'rev-parse', 'refs/heads/missing-parent-feature'), head);
  assert(!(await f.service.getSnapshot()).worktrees.some(w => w.id === f.created.id));
});

test('orphaned submodule metadata is never silently removed', async t => {
  const f = await setup(t);
  await git(f.created.path, 'rm', '-f', 'module');
  await git(f.created.path, 'commit', '-am', 'Remove module');
  await assert.rejects(f.service.previewDelete(f.created.id, false), { code: 'SUBMODULE_UNSAFE' });
  await access(f.created.path);
});

test('linked submodule worktree registration is cleaned without deleting the source checkout', async t => {
  const f = await setup(t);
  const oldAdmin = await git(f.module, 'rev-parse', '--absolute-git-dir');
  await rm(f.module, { recursive: true });
  await rm(oldAdmin, { recursive: true });
  const mainModule = path.join(f.repoPath, 'module');
  await git(mainModule, 'worktree', 'add', '-b', 'linked-feature', f.module, f.base);
  const head = await commit(f.module);
  const preview = await f.service.previewDelete(f.created.id, false);
  assert.equal(preview.submodules[0]!.canDiscard, true);
  const outcome = await f.service.deleteWorktree(deletion(preview, ['module']));
  assert.deepEqual(outcome.warnings, []);
  assert.equal(outcome.submodules[0]!.branchDeleted, true);
  assert.equal((await git(mainModule, 'worktree', 'list', '--porcelain')).includes(f.module), false);
  await assert.rejects(git(mainModule, 'show-ref', '--verify', 'refs/heads/linked-feature'));
  assert.equal(await readFile(path.join(mainModule, 'module.txt'), 'utf8'), 'base');
  assert.notEqual(head, f.base);
});

test('locked linked submodule worktree blocks parent deletion', async t => {
  const f = await setup(t);
  const oldAdmin = await git(f.module, 'rev-parse', '--absolute-git-dir');
  await rm(f.module, { recursive: true });
  await rm(oldAdmin, { recursive: true });
  const mainModule = path.join(f.repoPath, 'module');
  await git(mainModule, 'worktree', 'add', '-b', 'locked-feature', f.module, f.base);
  await git(mainModule, 'worktree', 'lock', '--reason', 'owned by another task', f.module);
  await assert.rejects(f.service.previewDelete(f.created.id, false), { code: 'SUBMODULE_UNSAFE' });
  await access(f.module);
});

test('old-form embedded submodule Git directory is independently preserved', async t => {
  const f = await setup(t);
  const admin = await git(f.module, 'rev-parse', '--absolute-git-dir');
  await rm(path.join(f.module, '.git'));
  const { rename } = await import('node:fs/promises');
  await rename(admin, path.join(f.module, '.git'));
  await git(f.module, '--git-dir', path.join(f.module, '.git'), '--work-tree', f.module, 'config', '--unset', 'core.worktree');
  await git(f.module, 'switch', '-c', 'embedded-feature');
  const head = await commit(f.module);
  const preview = await f.service.previewDelete(f.created.id, false);
  const outcome = await f.service.deleteWorktree(deletion(preview));
  assert.equal(await git(outcome.submodules[0]!.backupPath!, 'rev-parse', 'refs/heads/embedded-feature'), head);
});

test('staged gitlink changes are reported even when submodule contents are independently retained', async t => {
  const f = await setup(t);
  await commit(f.module);
  await git(f.created.path, 'add', 'module');
  const preview = await f.service.previewDelete(f.created.id, false);
  assert.equal(preview.trackedChanges, 1);
  assert.equal(preview.requiresConfirmation, true);
  await assert.rejects(f.service.deleteWorktree({ ...deletion(preview), confirmRisks: false }), { code: 'DELETE_CONFIRMATION_REQUIRED' });
  await f.service.deleteWorktree(deletion(preview));
});

test('SHA-256 submodule repositories retain their object format in the independent backup', async t => {
  const f = await fixture(t);
  const source = path.join(f.root, 'sha256-source');
  const parent = path.join(f.root, 'sha256-parent');
  for (const directory of [source, parent]) {
    await mkdir(directory);
    await git(directory, 'init', '-b', 'main', '--object-format=sha256');
    await commit(directory);
  }
  await git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'module');
  await git(parent, 'commit', '-am', 'Add SHA-256 module');
  const repo = await f.service.addRepository(parent);
  const created = await f.service.createWorktree({ repoId: repo.id, baseBranch: 'main', branchName: 'sha256-feature' });
  await git(created.path, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init');
  const head = await commit(path.join(created.path, 'module'), 'module.txt', 'sha256 unique content');
  assert.equal(head.length, 64);
  const preview = await f.service.previewDelete(created.id, false);
  const outcome = await f.service.deleteWorktree(deletion(preview));
  assert.equal(await git(outcome.submodules[0]!.backupPath!, 'rev-parse', '--show-object-format'), 'sha256');
  assert.equal(await git(outcome.submodules[0]!.backupPath!, 'rev-parse', 'HEAD'), head);
});

test('submodule metadata redirected to an unrelated shared repository is refused', async t => {
  const f = await setup(t);
  const admin = await git(f.module, 'rev-parse', '--absolute-git-dir');
  await writeFile(path.join(admin, 'commondir'), path.join(f.origin, '.git') + '\n');
  await assert.rejects(f.service.previewDelete(f.created.id, false), { code: 'SUBMODULE_UNSAFE' });
  assert.equal(await git(f.origin, 'rev-parse', 'main'), f.base);
  await access(f.created.path);
});
