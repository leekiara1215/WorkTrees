import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createWorktreeService } from '../src/main/worktree-service.ts';
import { fixture, git, gitWithEnv } from './fixtures.ts';
import type { DeletePreview } from '../src/shared/types.ts';

function readableError(error: unknown) {
  assert(error instanceof Error);
  assert.equal(typeof (error as Error & { code?: string }).code, 'string');
  assert.match(error.message, /[\u3400-\u9fff]/);
  return true;
}

function deletion(preview: DeletePreview, confirmRisks = false) {
  return { worktreeId: preview.worktreeId, deleteBranch: preview.deleteBranch, token: preview.token, confirmRisks };
}

async function commitFile(checkout: string, name = 'unique.txt', content = 'branch-only commit\n') {
  await writeFile(path.join(checkout, name), content);
  await git(checkout, 'add', '--', name);
  await git(checkout, 'commit', '-m', 'Unique worktree content');
  return git(checkout, 'rev-parse', 'HEAD');
}

test('delete preview is read-only; clean removal retains branch and clears managed metadata across restart', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('clean-delete'));
  const before = await git(f.repoPath, 'worktree', 'list', '--porcelain');
  const preview = await f.service.previewDelete(created.id, false);
  assert.equal(preview.path, created.path);
  assert.equal(preview.branch, created.branch);
  assert.equal(preview.deleteBranch, false);
  assert.equal(preview.requiresConfirmation, false);
  assert.equal(preview.trackedChanges + preview.untrackedFiles + preview.ignoredFiles, 0);
  assert(preview.token.length > 0);
  assert.equal(await git(f.repoPath, 'worktree', 'list', '--porcelain'), before);
  assert.equal(await readFile(path.join(created.path, 'README.md'), 'utf8'), 'QA fixture\n');
  const outcome = await f.service.deleteWorktree(deletion(preview));
  assert.equal(outcome.worktreeId, created.id);
  assert.equal(outcome.branchDeleted, false);
  await assert.rejects(access(created.path));
  assert.equal(await git(f.repoPath, 'rev-parse', `refs/heads/${created.branch}`), created.head);
  assert(!(await f.service.getSnapshot()).worktrees.some(w => w.id === created.id));
  assert(!(await createWorktreeService({ dataDir: f.dataDir }).getSnapshot()).worktrees.some(w => w.id === created.id));
  assert.equal(await readFile(path.join(f.repoPath, 'README.md'), 'utf8'), 'QA fixture\n');
});

test('main checkout remains undeletable after changing its branch name', async t => {
  const f = await fixture(t);
  await git(f.repoPath, 'branch', '-m', 'main-is-a-feature-now');
  const main = (await f.service.getSnapshot()).worktrees.find(w => w.isMain)!;
  for (const deleteBranch of [false, true]) {
    await assert.rejects(f.service.previewDelete(main.id, deleteBranch), readableError);
    await assert.rejects(f.service.deleteWorktree({ worktreeId: main.id, deleteBranch, token: 'invented', confirmRisks: true }), readableError);
  }
  assert.equal(await git(f.repoPath, 'branch', '--show-current'), 'main-is-a-feature-now');
  assert.equal(await readFile(path.join(f.repoPath, 'README.md'), 'utf8'), 'QA fixture\n');
});

test('external worktree can be removed without touching another checkout or deleting its branch', async t => {
  const f = await fixture(t);
  const external = path.join(f.root, 'external checkout');
  await git(f.repoPath, 'worktree', 'add', '-b', 'external', external, 'main');
  const other = await f.service.createWorktree(f.input('other'));
  await writeFile(path.join(other.path, 'sentinel.txt'), 'other checkout data');
  const entry = (await f.service.getSnapshot()).worktrees.find(w => w.path === external)!;
  assert(!entry.managed && !entry.isMain);
  const preview = await f.service.previewDelete(entry.id, false);
  await f.service.deleteWorktree(deletion(preview));
  await assert.rejects(access(external));
  assert.equal(await git(f.repoPath, 'rev-parse', 'refs/heads/external'), await git(f.repoPath, 'rev-parse', 'main'));
  assert.equal(await readFile(path.join(other.path, 'sentinel.txt'), 'utf8'), 'other checkout data');
});

test('locked worktree cannot be previewed or deleted, and is never automatically unlocked', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('locked'));
  const previous = await f.service.previewDelete(created.id, false);
  await git(f.repoPath, 'worktree', 'lock', '--reason', 'kepler:task:test-owner', created.path);
  await assert.rejects(f.service.previewDelete(created.id, false), readableError);
  await assert.rejects(f.service.deleteWorktree(deletion(previous, true)), readableError);
  const actual = (await f.service.getSnapshot()).worktrees.find(w => w.id === created.id)!;
  assert(actual.locked);
  assert.equal(actual.lockReason, 'kepler:task:test-owner');
  assert.equal(await readFile(path.join(created.path, 'README.md'), 'utf8'), 'QA fixture\n');
});

test('tracked, untracked and ignored files are reported and require explicit risk confirmation', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('dirty'));
  await writeFile(path.join(created.path, '.gitignore'), 'cache/\n');
  await git(created.path, 'add', '.gitignore');
  await git(created.path, 'commit', '-m', 'Ignore cache');
  await writeFile(path.join(created.path, 'README.md'), 'uncommitted edits\n');
  await writeFile(path.join(created.path, 'draft.txt'), 'untracked draft');
  await mkdir(path.join(created.path, 'cache'));
  await writeFile(path.join(created.path, 'cache', 'important.bin'), 'ignored local data');
  const preview = await f.service.previewDelete(created.id, false);
  assert(preview.trackedChanges >= 1);
  assert(preview.untrackedFiles >= 1);
  assert(preview.ignoredFiles >= 1);
  assert(preview.requiresConfirmation);
  await assert.rejects(f.service.deleteWorktree(deletion(preview)), readableError);
  assert.equal(await readFile(path.join(created.path, 'cache', 'important.bin'), 'utf8'), 'ignored local data');
  const outcome = await f.service.deleteWorktree(deletion(preview, true));
  assert.equal(outcome.branchDeleted, false);
  await assert.rejects(access(created.path));
  await git(f.repoPath, 'show-ref', '--verify', `refs/heads/${created.branch}`);
});

test('ignored-only local data needs confirmation even when Git otherwise considers checkout clean', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('ignored-only'));
  await writeFile(path.join(created.path, '.gitignore'), 'local.secret\n');
  await git(created.path, 'add', '.gitignore');
  await git(created.path, 'commit', '-m', 'Ignore local data');
  await writeFile(path.join(created.path, 'local.secret'), 'must not vanish without confirmation');
  assert.equal(await git(created.path, 'status', '--porcelain'), '');
  const preview = await f.service.previewDelete(created.id, false);
  assert.equal(preview.trackedChanges, 0);
  assert.equal(preview.untrackedFiles, 0);
  assert(preview.ignoredFiles >= 1 && preview.requiresConfirmation);
  await assert.rejects(f.service.deleteWorktree(deletion(preview)), readableError);
  assert.equal(await readFile(path.join(created.path, 'local.secret'), 'utf8'), 'must not vanish without confirmation');
});

test('keeping a branch preserves unique commits without treating absence of upstream as data loss', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('preserve-commits'));
  const head = await commitFile(created.path);
  const preview = await f.service.previewDelete(created.id, false);
  assert.equal(preview.requiresConfirmation, false);
  await f.service.deleteWorktree(deletion(preview));
  assert.equal(await git(f.repoPath, 'rev-parse', `refs/heads/${created.branch}`), head);
  assert.equal(await git(f.repoPath, 'show', `${created.branch}:unique.txt`), 'branch-only commit');
});

test('optional branch deletion reports unique commits and requires confirmed data-loss consent', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('delete-unique-branch'));
  const head = await commitFile(created.path);
  const preview = await f.service.previewDelete(created.id, true);
  assert.equal(preview.deleteBranch, true);
  assert(preview.uniqueCommits >= 1);
  assert(preview.requiresConfirmation);
  await assert.rejects(f.service.deleteWorktree(deletion(preview)), readableError);
  assert.equal(await git(created.path, 'rev-parse', 'HEAD'), head);
  const outcome = await f.service.deleteWorktree(deletion(preview, true));
  assert.equal(outcome.branchDeleted, true);
  await assert.rejects(git(f.repoPath, 'show-ref', '--verify', `refs/heads/${created.branch}`));
  await assert.rejects(access(created.path));
});

test('commit retained by another branch permits branch deletion without unique-commit confirmation', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('branch-covered'));
  const head = await commitFile(created.path);
  await git(f.repoPath, 'branch', 'safety-copy', head);
  const preview = await f.service.previewDelete(created.id, true);
  assert.equal(preview.uniqueCommits, 0);
  assert.equal(preview.requiresConfirmation, false);
  const outcome = await f.service.deleteWorktree(deletion(preview));
  assert.equal(outcome.branchDeleted, true);
  assert.equal(await git(f.repoPath, 'rev-parse', 'safety-copy'), head);
});

test('tag and remote-tracking references also retain commits when deleting a local branch', async t => {
  const f = await fixture(t);
  for (const kind of ['tag', 'remote']) {
    const created = await f.service.createWorktree(f.input(`covered-by-${kind}`));
    const head = await commitFile(created.path);
    if (kind === 'tag') await git(f.repoPath, 'tag', 'saved-work', head);
    else await git(f.repoPath, 'update-ref', 'refs/remotes/origin/saved-work', head);
    const preview = await f.service.previewDelete(created.id, true);
    assert.equal(preview.uniqueCommits, 0);
    assert.equal(preview.requiresConfirmation, false);
    assert.equal((await f.service.deleteWorktree(deletion(preview))).branchDeleted, true);
  }
});

test('detached HEAD with unreferenced commit requires confirmation even when retaining branches', async t => {
  const f = await fixture(t);
  const checkout = path.join(f.root, 'detached checkout');
  await git(f.repoPath, 'worktree', 'add', '--detach', checkout, 'main');
  const head = await commitFile(checkout);
  const entry = (await f.service.getSnapshot()).worktrees.find(w => w.path === checkout)!;
  const preview = await f.service.previewDelete(entry.id, false);
  assert.equal(preview.branch, null);
  assert.equal(preview.head, head);
  assert(preview.uniqueCommits >= 1 && preview.requiresConfirmation);
  await assert.rejects(f.service.deleteWorktree(deletion(preview)), readableError);
  assert.equal(await git(checkout, 'rev-parse', 'HEAD'), head);
  await f.service.deleteWorktree(deletion(preview, true));
  await assert.rejects(access(checkout));
});

test('detached worktree preview scans directory trees and indexes larger than 16 MiB', async t => {
  const f = await fixture(t);
  const directory = Array(4).fill('folder-' + 'a'.repeat(180)).join('/');
  const blob = await git(f.repoPath, 'rev-parse', 'HEAD:README.md');
  const entries = Array.from({ length: 22_000 }, (_, i) => `100644 ${blob}\t${directory}/${i}.txt\0`).join('');
  assert(Buffer.byteLength(entries) > 16 * 1024 * 1024);
  const env = { GIT_INDEX_FILE: path.join(f.root, 'large-index') };
  await gitWithEnv(f.repoPath, env, 'read-tree', 'HEAD');
  execFileSync('git', ['-C', f.repoPath, 'update-index', '-z', '--index-info'], { env: { ...process.env, ...env }, input: entries });
  const tree = await gitWithEnv(f.repoPath, env, 'write-tree');
  const head = await git(f.repoPath, 'commit-tree', tree, '-p', 'HEAD', '-m', 'Large checkout');
  const checkout = path.join(f.root, 'large checkout');
  await git(f.repoPath, 'worktree', 'add', '--detach', checkout, head);
  const entry = (await f.service.getSnapshot()).worktrees.find(w => w.path === checkout)!;
  const preview = await f.service.previewDelete(entry.id, false);
  assert.equal(preview.trackedChanges, 0);
  assert.equal(preview.uniqueCommits, 1);
  assert(preview.requiresConfirmation);

  await git(checkout, 'mv', '--', 'README.md', 'renamed\t内容.md');
  const updated = await f.service.previewDelete(entry.id, false);
  assert.equal(updated.trackedChanges, 1);
  assert.notEqual(updated.token, preview.token);
});

test('preview is invalidated when checkout HEAD changes before deletion', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('head-changed'));
  const preview = await f.service.previewDelete(created.id, true);
  const head = await commitFile(created.path);
  await assert.rejects(f.service.deleteWorktree(deletion(preview, true)), readableError);
  assert.equal(await git(created.path, 'rev-parse', 'HEAD'), head);
  assert.equal(await readFile(path.join(created.path, 'unique.txt'), 'utf8'), 'branch-only commit\n');
});

test('preview is invalidated by new uncommitted files and changing deletion options', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('preview-changed'));
  const preview = await f.service.previewDelete(created.id, false);
  await assert.rejects(f.service.deleteWorktree({ ...deletion(preview), deleteBranch: true }), readableError);
  await writeFile(path.join(created.path, 'after-preview.txt'), 'created after preview');
  await assert.rejects(f.service.deleteWorktree(deletion(preview, true)), readableError);
  assert.equal(await readFile(path.join(created.path, 'after-preview.txt'), 'utf8'), 'created after preview');
  await git(f.repoPath, 'show-ref', '--verify', `refs/heads/${created.branch}`);
});

test('replaced non-Git directory is not deleted even with previous preview and explicit confirmation', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('replaced'));
  const preview = await f.service.previewDelete(created.id, false);
  const moved = path.join(f.root, 'original checkout preserved');
  await rename(created.path, moved);
  await mkdir(created.path);
  await writeFile(path.join(created.path, 'sentinel.txt'), 'replacement user data');
  await assert.rejects(f.service.previewDelete(created.id, false), readableError);
  await assert.rejects(f.service.deleteWorktree(deletion(preview, true)), readableError);
  assert.equal(await readFile(path.join(created.path, 'sentinel.txt'), 'utf8'), 'replacement user data');
  assert.equal(await readFile(path.join(moved, 'README.md'), 'utf8'), 'QA fixture\n');
});

test('replacement with an independent Git repository is rejected and preserved', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('replaced-with-git'));
  const preview = await f.service.previewDelete(created.id, false);
  await rename(created.path, path.join(f.root, 'original checkout'));
  await mkdir(created.path);
  await git(created.path, 'init', '-b', 'replacement-main');
  const head = await commitFile(created.path, 'sentinel.txt', 'independent repository data');
  await assert.rejects(f.service.previewDelete(created.id, false), readableError);
  await assert.rejects(f.service.deleteWorktree(deletion(preview, true)), readableError);
  assert.equal(await git(created.path, 'rev-parse', 'HEAD'), head);
  assert.equal(await readFile(path.join(created.path, 'sentinel.txt'), 'utf8'), 'independent repository data');
});

test('worktree path replaced by symlink does not delete destination or moved original checkout', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('symlink-replaced'));
  const preview = await f.service.previewDelete(created.id, false);
  const moved = path.join(f.root, 'moved original');
  await rename(created.path, moved);
  await symlink(moved, created.path, 'dir');
  await assert.rejects(f.service.previewDelete(created.id, false), readableError);
  await assert.rejects(f.service.deleteWorktree(deletion(preview, true)), readableError);
  assert.equal(await readFile(path.join(moved, 'README.md'), 'utf8'), 'QA fixture\n');
});

test('unregistered missing directory is refused and its recoverable managed record remains', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('missing-delete'));
  const preview = await f.service.previewDelete(created.id, false);
  await rm(created.path, { recursive: true });
  await git(f.repoPath, 'worktree', 'prune', '--expire', 'now');
  await assert.rejects(f.service.previewDelete(created.id, false), readableError);
  await assert.rejects(f.service.deleteWorktree(deletion(preview, true)), readableError);
  assert((await f.service.getSnapshot()).worktrees.some(w => w.id === created.id && !w.exists));
  await git(f.repoPath, 'show-ref', '--verify', `refs/heads/${created.branch}`);
});

test('removing a missing unregistered record rechecks the path and keeps branch commits', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('remove-record'));
  const tip = await commitFile(created.path);
  await rm(created.path, { recursive: true });
  await assert.rejects(f.service.removeWorktreeRecord(created.id), { code: 'WORKTREE_PRESENT' });
  await git(f.repoPath, 'worktree', 'prune', '--expire', 'now');
  const snapshot = await f.service.getSnapshot();
  assert.equal(snapshot.worktrees.find(tree => tree.id === created.id)?.canRemoveRecord, true);

  await mkdir(created.path);
  await writeFile(path.join(created.path, 'sentinel'), 'user data');
  await assert.rejects(f.service.removeWorktreeRecord(created.id), { code: 'WORKTREE_PRESENT' });
  assert.equal(await readFile(path.join(created.path, 'sentinel'), 'utf8'), 'user data');
  await rm(created.path, { recursive: true });
  const entries = await git(f.repoPath, 'worktree', 'list', '--porcelain');

  await f.service.removeWorktreeRecord(created.id);
  const restarted = createWorktreeService({ dataDir: f.dataDir });
  assert(!(await restarted.getSnapshot()).worktrees.some(tree => tree.id === created.id));
  assert.equal(await git(f.repoPath, 'rev-parse', `refs/heads/${created.branch}`), tip);
  assert.equal(await git(f.repoPath, 'worktree', 'list', '--porcelain'), entries);

  const input = { ...f.input('remove-record'), useExistingBranch: true };
  assert.equal((await restarted.previewCreate(input)).useExistingBranch, true);
  const attached = await restarted.createWorktree(input);
  assert.equal(attached.path, created.path);
  assert.notEqual(attached.id, created.id);
  assert.equal(await git(attached.path, 'rev-parse', 'HEAD'), tip);
  await assert.rejects(restarted.previewCreate({ ...f.input('absent-branch'), useExistingBranch: true }), { code: 'BRANCH_MISSING' });
  await restarted.updateSettings({ branchPrefix: '' });
  await assert.rejects(restarted.previewCreate({ ...f.input('main'), useExistingBranch: true }), { code: 'BRANCH_IN_USE' });
});

test('existing dirty content changing after preview invalidates risk confirmation', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('dirty-content-changed'));
  await writeFile(path.join(created.path, 'README.md'), 'first uncommitted edits\n');
  const preview = await f.service.previewDelete(created.id, false);
  assert(preview.requiresConfirmation);
  await writeFile(path.join(created.path, 'README.md'), 'different and longer uncommitted edits\n');
  await assert.rejects(f.service.deleteWorktree(deletion(preview, true)), readableError);
  assert.equal(await readFile(path.join(created.path, 'README.md'), 'utf8'), 'different and longer uncommitted edits\n');
});

test('registered missing directory can only be cleaned through a fresh preview of the exact entry', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('registered-missing-delete'));
  const sibling = await f.service.createWorktree(f.input('missing-delete-sibling'));
  const preview = await f.service.previewDelete(created.id, false);
  await rm(created.path, { recursive: true });
  await assert.rejects(f.service.deleteWorktree(deletion(preview, true)), readableError);
  const fresh = await f.service.previewDelete(created.id, false);
  await f.service.deleteWorktree(deletion(fresh, true));
  assert(!(await f.service.getSnapshot()).worktrees.some(w => w.id === created.id));
  assert.equal(await readFile(path.join(sibling.path, 'README.md'), 'utf8'), 'QA fixture\n');
  await git(f.repoPath, 'show-ref', '--verify', `refs/heads/${created.branch}`);
});

test('duplicate concurrent deletion consumes only selected worktree and leaves sibling unchanged', async t => {
  const f = await fixture(t);
  const selected = await f.service.createWorktree(f.input('duplicate-delete'));
  const sibling = await f.service.createWorktree(f.input('sibling'));
  const preview = await f.service.previewDelete(selected.id, false);
  const results = await Promise.allSettled([f.service.deleteWorktree(deletion(preview)), f.service.deleteWorktree(deletion(preview))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(await readFile(path.join(sibling.path, 'README.md'), 'utf8'), 'QA fixture\n');
  assert.equal(await git(sibling.path, 'branch', '--show-current'), sibling.branch);
  assert(!(await f.service.getSnapshot()).worktrees.some(w => w.id === selected.id));
});

test('forged IDs, tokens and untyped IPC options are rejected without filesystem changes', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('input-validation'));
  const preview = await f.service.previewDelete(created.id, false);
  await assert.rejects(f.service.previewDelete(f.repoPath, false), readableError);
  await assert.rejects(f.service.previewDelete(created.id, 'false' as unknown as boolean), readableError);
  await assert.rejects(f.service.deleteWorktree({ ...deletion(preview, true), token: 'forged-token' }), readableError);
  await assert.rejects(f.service.deleteWorktree({ ...deletion(preview), confirmRisks: 'true' as unknown as boolean }), readableError);
  await assert.rejects(f.service.deleteWorktree(null as never), readableError);
  assert.equal(await readFile(path.join(created.path, 'README.md'), 'utf8'), 'QA fixture\n');
  assert.equal(await git(created.path, 'branch', '--show-current'), created.branch);
});

test('nested Git repository blocks deletion without removing nested or parent data', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('nested-repo'));
  const previous = await f.service.previewDelete(created.id, false);
  const nested = path.join(created.path, 'nested');
  await mkdir(nested);
  await git(nested, 'init', '-b', 'nested-main');
  const head = await commitFile(nested, 'sentinel.txt', 'nested independent commit');
  await assert.rejects(f.service.previewDelete(created.id, false), readableError);
  await assert.rejects(f.service.deleteWorktree(deletion(previous, true)), readableError);
  assert.equal(await git(nested, 'rev-parse', 'HEAD'), head);
  assert.equal(await readFile(path.join(nested, 'sentinel.txt'), 'utf8'), 'nested independent commit');
  assert.equal(await readFile(path.join(created.path, 'README.md'), 'utf8'), 'QA fixture\n');
});

test('index assume-unchanged flag cannot conceal edits during delete safety inspection', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('hidden-index-edits'));
  await git(created.path, 'update-index', '--assume-unchanged', 'README.md');
  await writeFile(path.join(created.path, 'README.md'), 'edits Git is hiding');
  assert.equal(await git(created.path, 'status', '--porcelain'), '');
  await assert.rejects(f.service.previewDelete(created.id, false), readableError);
  assert.equal(await readFile(path.join(created.path, 'README.md'), 'utf8'), 'edits Git is hiding');
});

test('a gitlink entry blocks removal even when its submodule directory is absent', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('submodule-gitlink'));
  const head = await git(created.path, 'rev-parse', 'HEAD');
  await git(created.path, 'update-index', '--add', '--cacheinfo', `160000,${head},module`);
  await git(created.path, 'commit', '-m', 'Register gitlink');
  await assert.rejects(f.service.previewDelete(created.id, false), readableError);
  assert.equal(await readFile(path.join(created.path, 'README.md'), 'utf8'), 'QA fixture\n');
  assert.match(await git(created.path, 'ls-files', '--stage', 'module'), /^160000 /);
});

test('branch deletion failure reports partial success and keeps branch and its commits', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('branch-lock'));
  const head = await commitFile(created.path);
  const preview = await f.service.previewDelete(created.id, true);
  const commonDir = await git(f.repoPath, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  await writeFile(path.join(commonDir, 'refs', 'heads', `${created.branch}.lock`), 'simulated other writer');
  const outcome = await f.service.deleteWorktree(deletion(preview, true));
  assert.equal(outcome.branchDeleted, false);
  assert(outcome.warnings.length > 0);
  await assert.rejects(access(created.path));
  assert.equal(await git(f.repoPath, 'rev-parse', `refs/heads/${created.branch}`), head);
  assert(!(await f.service.getSnapshot()).worktrees.some(w => w.id === created.id));
});

test('metadata write failure reports completed directory removal instead of retrying a destructive operation', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('metadata-failure'));
  const preview = await f.service.previewDelete(created.id, false);
  const storeFile = path.join(f.dataDir, 'worktrees.json');
  await rename(storeFile, `${storeFile}.backup`);
  await mkdir(storeFile);
  const outcome = await f.service.deleteWorktree(deletion(preview));
  assert(outcome.warnings.length > 0);
  assert.equal(outcome.branchDeleted, false);
  await assert.rejects(access(created.path));
  await git(f.repoPath, 'show-ref', '--verify', `refs/heads/${created.branch}`);
  assert(!(await f.service.getSnapshot()).worktrees.some(w => w.id === created.id));
});
