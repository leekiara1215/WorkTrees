import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createWorktreeService } from '../src/main/worktree-service.ts';
import { fixture, git, gitWithEnv } from './fixtures.ts';

function readableError(error: unknown) {
  assert(error instanceof Error, 'service rejects with an Error');
  const appError = error as Error & { code?: string };
  assert.equal(typeof appError.code, 'string', 'error has a stable code');
  assert.match(error.message, /[\u3400-\u9fff]/, 'error is readable in Chinese');
  return true;
}

test('import discovers main checkout and existing worktrees; duplicate and nested imports stay unique', async t => {
  const f = await fixture(t);
  const external = path.join(f.root, 'external checkout');
  await git(f.repoPath, 'worktree', 'add', '-b', 'external', external, 'main');
  await mkdir(path.join(f.repoPath, 'nested'));
  const nested = await f.service.addRepository(path.join(f.repoPath, 'nested'));
  const linked = await f.service.addRepository(external);
  const again = await f.service.addRepository(f.repoPath);
  assert.equal(nested.id, f.repo.id);
  assert.equal(linked.id, f.repo.id);
  assert.equal(again.id, f.repo.id);
  const snapshot = await f.service.getSnapshot();
  assert.equal(snapshot.repositories.length, 1);
  assert(snapshot.worktrees.some(w => w.isMain && w.path === f.repoPath));
  assert(snapshot.worktrees.some(w => w.path === external && !w.isMain && !w.managed));
});

test('import rejects non-Git and nonexistent directories without persisting them', async t => {
  const f = await fixture(t);
  const plain = path.join(f.root, 'plain');
  await mkdir(plain);
  await assert.rejects(f.service.addRepository(plain), readableError);
  await assert.rejects(f.service.addRepository(path.join(f.root, 'absent')), readableError);
  assert.equal((await f.service.getSnapshot()).repositories.length, 1);
});

test('repository prefix inherits, clears, overrides, and returns to inheritance', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.previewCreate(f.input('one'))).branch, 'wt/one');
  await f.service.updateRepository(f.repo.id, { branchPrefix: '' });
  assert.equal((await f.service.previewCreate(f.input('two'))).branch, 'two');
  await f.service.updateRepository(f.repo.id, { branchPrefix: 'team/' });
  assert.equal((await f.service.previewCreate(f.input('three'))).branch, 'team/three');
  await f.service.updateRepository(f.repo.id, { branchPrefix: null });
  await f.service.updateSettings({ branchPrefix: 'global/' });
  assert.equal((await f.service.previewCreate(f.input('four'))).branch, 'global/four');
});

test('root template expands repository path/name and remains unchanged by preview', async t => {
  const f = await fixture(t);
  await f.service.updateSettings({ worktreeRoot: '<REPOSITORY_PATH>/../outputs/<REPOSITORY_NAME>' });
  const preview = await f.service.previewCreate(f.input('nested/topic'));
  const expectedRoot = path.join(f.root, 'outputs', path.basename(f.repoPath));
  assert.equal(path.dirname(preview.path), expectedRoot);
  assert.equal(preview.branch, 'wt/nested/topic');
  assert(path.basename(preview.path).includes(f.repo.id.slice(0, 8)));
  await assert.rejects(access(preview.path));
  await assert.rejects(git(f.repoPath, 'show-ref', '--verify', 'refs/heads/wt/nested/topic'));
});

test('branch input cannot escape the root, use Git flags, or create invalid refs', async t => {
  const f = await fixture(t);
  for (const branchName of ['', '../escape', '../../escape', '/absolute', '-bad', 'bad..name', 'bad name', 'bad~name', 'bad:name', 'bad?name', 'bad[branch', 'bad\\name', 'topic.lock', 'a//b', 'a@{b', 'line\nbreak']) {
    await assert.rejects(f.service.previewCreate(f.input(branchName)), readableError, branchName);
    await assert.rejects(f.service.createWorktree(f.input(branchName)), readableError, branchName);
  }
  assert.deepEqual((await f.service.listBranches(f.repo.id)).filter(b => !b.remote).map(b => b.name), ['main']);
});

test('invalid and missing base branches are rejected without a directory or new branch', async t => {
  const f = await fixture(t);
  for (const baseBranch of ['does-not-exist', '--orphan', 'main; touch injected']) {
    await assert.rejects(f.service.createWorktree({ ...f.input(), baseBranch }), readableError);
  }
  assert.equal((await f.service.getSnapshot()).worktrees.filter(w => w.managed).length, 0);
});

test('preview rejects an existing branch and an already checked out branch', async t => {
  const f = await fixture(t);
  await git(f.repoPath, 'branch', 'wt/existing');
  await assert.rejects(f.service.previewCreate(f.input('existing')), readableError);
  await f.service.updateRepository(f.repo.id, { branchPrefix: '' });
  await assert.rejects(f.service.previewCreate(f.input('main')), readableError);
});

test('creation uses real Git worktrees, preserves source checkout, and persists managed metadata', async t => {
  const f = await fixture(t);
  const head = await git(f.repoPath, 'rev-parse', 'HEAD');
  const preview = await f.service.previewCreate(f.input('real/topic'));
  const created = await f.service.createWorktree(f.input('real/topic'));
  assert.equal(created.path, preview.path);
  assert.equal(created.branch, 'wt/real/topic');
  assert.equal(created.baseBranch, 'main');
  assert.equal(created.repoId, f.repo.id);
  assert(created.managed && created.exists && !created.isMain);
  assert.equal(await git(created.path, 'rev-parse', 'HEAD'), head);
  assert.equal(await git(created.path, 'branch', '--show-current'), 'wt/real/topic');
  assert.equal(await readFile(path.join(created.path, 'README.md'), 'utf8'), 'QA fixture\n');
  assert.equal(await git(f.repoPath, 'branch', '--show-current'), 'main');
  assert.equal(await git(f.repoPath, 'status', '--porcelain'), '');
  const restored = await createWorktreeService({ dataDir: f.dataDir }).getSnapshot();
  assert(restored.worktrees.some(w => w.id === created.id && w.managed && w.baseBranch === 'main'));
});

test('creation refuses both nonempty and empty target directories without overwriting them', async t => {
  const f = await fixture(t);
  await f.service.updateSettings({ worktreeRoot: '<REPOSITORY_PATH>/../shared/<REPOSITORY_NAME>' });
  for (const [branch, nonempty] of [['occupied', true], ['empty', false]] as const) {
    const preview = await f.service.previewCreate(f.input(branch));
    await mkdir(preview.path, { recursive: true });
    if (nonempty) await writeFile(path.join(preview.path, 'sentinel'), 'keep me');
    await assert.rejects(f.service.createWorktree(f.input(branch)), readableError);
    if (nonempty) assert.equal(await readFile(path.join(preview.path, 'sentinel'), 'utf8'), 'keep me');
    else assert.deepEqual(await readdir(preview.path), []);
    await assert.rejects(git(f.repoPath, 'show-ref', '--verify', `refs/heads/wt/${branch}`));
  }
});

test('creation refuses a target symlink without changing its destination', async t => {
  const f = await fixture(t);
  const preview = await f.service.previewCreate(f.input('symlink'));
  const outside = path.join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'sentinel'), 'untouched');
  await mkdir(path.dirname(preview.path), { recursive: true });
  await symlink(outside, preview.path, 'dir');
  await assert.rejects(f.service.createWorktree(f.input('symlink')), readableError);
  assert.equal(await readFile(path.join(outside, 'sentinel'), 'utf8'), 'untouched');
});

test('branch names that normalize to the same path never reuse or overwrite a checkout', async t => {
  const f = await fixture(t);
  const first = await f.service.createWorktree(f.input('a/b'));
  await writeFile(path.join(first.path, 'sentinel'), 'first checkout');
  try {
    const second = await f.service.createWorktree(f.input('a-b'));
    assert.notEqual(second.path, first.path);
    assert.equal(await git(second.path, 'branch', '--show-current'), 'wt/a-b');
  } catch (error) {
    readableError(error);
  }
  assert.equal(await readFile(path.join(first.path, 'sentinel'), 'utf8'), 'first checkout');
  assert.equal(await git(first.path, 'branch', '--show-current'), 'wt/a/b');
});

test('refresh discovers external creation, locking and removal without managing external entries', async t => {
  const f = await fixture(t);
  const external = path.join(f.root, 'external');
  await git(f.repoPath, 'worktree', 'add', '-b', 'outside', external, 'main');
  let entry = (await f.service.getSnapshot()).worktrees.find(w => w.path === external);
  assert(entry && entry.exists && !entry.managed);
  await git(f.repoPath, 'worktree', 'lock', '--reason', 'QA lock', external);
  entry = (await f.service.getSnapshot()).worktrees.find(w => w.path === external);
  assert(entry?.locked);
  assert.equal(entry.lockReason, 'QA lock');
  await git(f.repoPath, 'worktree', 'unlock', external);
  await git(f.repoPath, 'worktree', 'remove', external);
  assert(!(await f.service.getSnapshot()).worktrees.some(w => w.path === external));
});

test('missing managed worktree remains visible after Git metadata is pruned and app restarts', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('missing'));
  await rm(created.path, { recursive: true, force: true });
  await git(f.repoPath, 'worktree', 'prune', '--expire', 'now');
  const snapshot = await createWorktreeService({ dataDir: f.dataDir }).getSnapshot();
  const missing = snapshot.worktrees.find(w => w.id === created.id);
  assert(missing && missing.managed && !missing.exists && missing.error);
  assert.equal(missing.path, created.path);
  assert.equal(missing.baseBranch, 'main');
});

test('recovery uses an existing branch and restores its latest committed content', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('recover-existing'));
  await writeFile(path.join(created.path, 'committed.txt'), 'branch-specific content');
  await git(created.path, 'add', 'committed.txt');
  await git(created.path, 'commit', '-m', 'Branch content');
  const branchHead = await git(created.path, 'rev-parse', 'HEAD');
  await rm(created.path, { recursive: true, force: true });
  const preview = await f.service.previewRecovery(created.id);
  assert.equal(preview.action, 'recreate-existing-branch');
  assert.equal(preview.branchExists, true);
  const recovered = await f.service.recreateWorktree(created.id);
  assert.equal(recovered.id, created.id);
  assert.equal(recovered.path, created.path);
  assert.equal(await git(recovered.path, 'rev-parse', 'HEAD'), branchHead);
  assert.equal(await readFile(path.join(recovered.path, 'committed.txt'), 'utf8'), 'branch-specific content');
});

test('recovery recreates a deleted branch from the recorded base and warns about it', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('recover-base'));
  await rm(created.path, { recursive: true, force: true });
  await git(f.repoPath, 'worktree', 'prune', '--expire', 'now');
  await git(f.repoPath, 'branch', '-D', created.branch!);
  const preview = await f.service.previewRecovery(created.id);
  assert.equal(preview.action, 'recreate-from-base');
  assert.equal(preview.branchExists, false);
  assert.equal(preview.baseBranch, 'main');
  assert(preview.warnings.length > 0);
  const recovered = await f.service.recreateWorktree(created.id);
  assert.equal(recovered.branch, created.branch);
  assert.equal(await git(recovered.path, 'rev-parse', 'HEAD'), await git(f.repoPath, 'rev-parse', 'main'));
});

test('recovery never overwrites an occupied target and preserves the record for retry', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('recover-occupied'));
  await rm(created.path, { recursive: true, force: true });
  await mkdir(created.path);
  await writeFile(path.join(created.path, 'sentinel'), 'user data');
  await assert.rejects(f.service.recreateWorktree(created.id), readableError);
  assert.equal(await readFile(path.join(created.path, 'sentinel'), 'utf8'), 'user data');
  await rm(created.path, { recursive: true });
  assert((await f.service.getSnapshot()).worktrees.some(w => w.id === created.id));
  assert.equal((await f.service.recreateWorktree(created.id)).id, created.id);
});

test('recovery refuses an empty existing target directory', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('recover-empty'));
  await rm(created.path, { recursive: true, force: true });
  await mkdir(created.path);
  await assert.rejects(f.service.recreateWorktree(created.id), readableError);
  assert.deepEqual(await readdir(created.path), []);
});

test('recovery refuses a branch used by another worktree and preserves that checkout', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('recover-in-use'));
  await rm(created.path, { recursive: true, force: true });
  await git(f.repoPath, 'worktree', 'prune', '--expire', 'now');
  const other = path.join(f.root, 'branch moved elsewhere');
  await git(f.repoPath, 'worktree', 'add', other, created.branch!);
  await writeFile(path.join(other, 'sentinel'), 'uncommitted user file');
  const before = await git(f.repoPath, 'worktree', 'list', '--porcelain');
  await assert.rejects(f.service.previewRecovery(created.id), readableError);
  await assert.rejects(f.service.recreateWorktree(created.id), readableError);
  assert.equal(await readFile(path.join(other, 'sentinel'), 'utf8'), 'uncommitted user file');
  assert.equal(await git(other, 'branch', '--show-current'), created.branch);
  assert.equal(await git(f.repoPath, 'worktree', 'list', '--porcelain'), before);
  await assert.rejects(access(created.path));
  assert((await f.service.getSnapshot()).worktrees.some(w => w.id === created.id && !w.exists));
});

test('recovery refuses a locked missing checkout and succeeds after explicit unlock', async t => {
  const f = await fixture(t);
  const created = await f.service.createWorktree(f.input('recover-locked'));
  await git(f.repoPath, 'worktree', 'lock', '--reason', 'Keep registration', created.path);
  await rm(created.path, { recursive: true, force: true });
  const before = await git(f.repoPath, 'worktree', 'list', '--porcelain');
  await assert.rejects(f.service.previewRecovery(created.id), readableError);
  await assert.rejects(f.service.recreateWorktree(created.id), readableError);
  assert.equal(await git(f.repoPath, 'worktree', 'list', '--porcelain'), before);
  await assert.rejects(access(created.path));
  await git(f.repoPath, 'worktree', 'unlock', created.path);
  assert.equal((await f.service.recreateWorktree(created.id)).id, created.id);
});

test('repository disappearance produces snapshot diagnostics and readable action errors', async t => {
  const f = await fixture(t);
  await rename(f.repoPath, path.join(f.root, 'moved repository'));
  const snapshot = await f.service.getSnapshot();
  assert.equal(snapshot.repositories[0]?.id, f.repo.id);
  assert(snapshot.errors.length > 0 || snapshot.worktrees.some(w => w.error));
  await assert.rejects(f.service.listBranches(f.repo.id), readableError);
  await assert.rejects(f.service.createWorktree(f.input()), readableError);
});

test('overlapping settings/repository writes and creates keep every successful mutation', async t => {
  const f = await fixture(t);
  await Promise.all([
    f.service.updateSettings({ branchPrefix: 'batch/' }),
    f.service.updateSettings({ staleDays: 12 }),
    f.service.updateSettings({ themeColor: 'blue' }),
    f.service.updateRepository(f.repo.id, { name: 'QA renamed repo' }),
  ]);
  const created = await Promise.all(['one', 'two', 'three'].map(name => f.service.createWorktree(f.input(name))));
  assert.equal(new Set(created.map(w => w.path)).size, 3);
  const snapshot = await createWorktreeService({ dataDir: f.dataDir }).getSnapshot();
  assert.equal(snapshot.settings.branchPrefix, 'batch/');
  assert.equal(snapshot.settings.staleDays, 12);
  assert.equal(snapshot.settings.themeColor, 'blue');
  assert.equal(snapshot.repositories[0]?.name, 'QA renamed repo');
  for (const item of created) assert(snapshot.worktrees.some(w => w.id === item.id && w.exists));
});

test('racing duplicate creates yield one checkout and one readable rejection', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.service.createWorktree(f.input('race')), f.service.createWorktree(f.input('race'))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const rejected = results.find(r => r.status === 'rejected');
  assert(rejected?.status === 'rejected');
  readableError(rejected.reason);
  assert.equal((await f.service.getSnapshot()).worktrees.filter(w => w.managed).length, 1);
});

test('removal preserves Git and restores settings and Worktree records on re-import', async t => {
  const f = await fixture(t);
  await f.service.updateSettings({ branchPrefix: 'persist/', staleDays: 9 });
  await f.service.updateRepository(f.repo.id, { name: '持久化 仓库', branchPrefix: '' });
  const existingTree = await f.service.createWorktree(f.input('existing'));
  const missingTree = await f.service.createWorktree(f.input('missing'));
  await git(f.repoPath, 'worktree', 'remove', missingTree.path);
  const restored = createWorktreeService({ dataDir: f.dataDir });
  const snapshot = await restored.getSnapshot();
  assert.equal(snapshot.settings.branchPrefix, 'persist/');
  assert.equal(snapshot.settings.staleDays, 9);
  assert.equal(snapshot.repositories[0]?.name, '持久化 仓库');
  assert.equal(snapshot.repositories[0]?.branchPrefix, '');
  const jsonFiles = (await readdir(f.dataDir)).filter(name => name.endsWith('.json'));
  assert(jsonFiles.length > 0, 'state persists in JSON');
  for (const name of jsonFiles) JSON.parse(await readFile(path.join(f.dataDir, name), 'utf8'));
  const before = await git(f.repoPath, 'worktree', 'list', '--porcelain');
  await restored.removeRepository(f.repo.id);
  const restarted = createWorktreeService({ dataDir: f.dataDir });
  const hidden = await restarted.getSnapshot();
  assert.deepEqual(hidden.repositories, []);
  assert.deepEqual(hidden.worktrees, []);
  await assert.rejects(restarted.previewRecovery(missingTree.id), { code: 'REPOSITORY_NOT_FOUND' });
  assert.equal(await git(f.repoPath, 'worktree', 'list', '--porcelain'), before);
  await access(existingTree.path);
  const reimported = await restarted.addRepository(existingTree.path);
  assert.deepEqual(reimported, snapshot.repositories[0]);
  const active = await restarted.getSnapshot();
  assert(active.worktrees.some(tree => tree.id === existingTree.id && tree.managed && tree.exists));
  assert(active.worktrees.some(tree => tree.id === missingTree.id && tree.managed && !tree.exists));
  assert.equal((await restarted.previewRecovery(missingTree.id)).path, missingTree.path);
});

test('theme defaults to green for older profiles and rejects unsupported updates', async t => {
  const f = await fixture(t);
  const file = path.join(f.dataDir, 'worktrees.json');
  const profile = JSON.parse(await readFile(file, 'utf8'));
  delete profile.settings.themeColor;
  await writeFile(file, JSON.stringify(profile));

  const service = createWorktreeService({ dataDir: f.dataDir });
  const { settings } = await service.getSnapshot();
  assert.equal(settings.themeColor, 'green');
  assert.equal(settings.worktreeRoot, profile.settings.worktreeRoot);
  assert.equal(settings.branchPrefix, profile.settings.branchPrefix);
  await service.updateSettings({ themeColor: 'purple' });
  await assert.rejects(service.updateSettings({ themeColor: 'unsupported' as never }), { code: 'INVALID_INPUT' });
  assert.equal((await createWorktreeService({ dataDir: f.dataDir }).getSnapshot()).settings.themeColor, 'purple');
});

test('creation starts from the selected base branch rather than the source checkout', async t => {
  const f = await fixture(t);
  await git(f.repoPath, 'checkout', '-b', 'release');
  await writeFile(path.join(f.repoPath, 'release.txt'), 'release only');
  await git(f.repoPath, 'add', 'release.txt');
  await git(f.repoPath, 'commit', '-m', 'Release content');
  const releaseHead = await git(f.repoPath, 'rev-parse', 'HEAD');
  await git(f.repoPath, 'checkout', 'main');
  const created = await f.service.createWorktree({ ...f.input('from-release'), baseBranch: 'release' });
  assert.equal(await git(created.path, 'rev-parse', 'HEAD'), releaseHead);
  assert.equal(await readFile(path.join(created.path, 'release.txt'), 'utf8'), 'release only');
  assert.equal(created.baseBranch, 'release');
});

test('recovery reports a missing recorded base, retains metadata, and succeeds after base restoration', async t => {
  const f = await fixture(t);
  await git(f.repoPath, 'branch', 'temporary-base');
  const created = await f.service.createWorktree({ ...f.input('both-gone'), baseBranch: 'temporary-base' });
  await rm(created.path, { recursive: true, force: true });
  await git(f.repoPath, 'worktree', 'prune', '--expire', 'now');
  await git(f.repoPath, 'branch', '-D', created.branch!, 'temporary-base');
  await assert.rejects(f.service.recreateWorktree(created.id), readableError);
  assert((await f.service.getSnapshot()).worktrees.some(w => w.id === created.id && !w.exists));
  await git(f.repoPath, 'branch', 'temporary-base', 'main');
  assert.equal((await f.service.recreateWorktree(created.id)).id, created.id);
});

test('read-only preview and refresh preserve Git refs and worktree registrations', async t => {
  const f = await fixture(t);
  const refs = await git(f.repoPath, 'show-ref');
  const registrations = await git(f.repoPath, 'worktree', 'list', '--porcelain');
  await f.service.previewCreate(f.input());
  await f.service.getSnapshot();
  await f.service.listBranches(f.repo.id);
  assert.equal(await git(f.repoPath, 'show-ref'), refs);
  assert.equal(await git(f.repoPath, 'worktree', 'list', '--porcelain'), registrations);
});

test('stale status follows activity age and the configured day threshold', async t => {
  const f = await fixture(t);
  const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  const date = old.toISOString();
  await gitWithEnv(f.repoPath, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, 'commit', '--amend', '--no-edit', '--date', date);
  const external = path.join(f.root, 'old external');
  await git(f.repoPath, 'worktree', 'add', '-b', 'old-external', external, 'main');
  for (const filename of ['README.md', '.git']) await utimes(path.join(external, filename), old, old);
  // A worktree's Git index also records checkout activity; age the fixture's index.
  await utimes(await git(external, 'rev-parse', '--path-format=absolute', '--git-path', 'index'), old, old);
  await utimes(external, old, old);
  await f.service.updateSettings({ staleDays: 30 });
  let entry = (await f.service.getSnapshot()).worktrees.find(w => w.path === external);
  assert(entry?.lastActivityAt, 'external checkout exposes activity time');
  assert(entry.stale, '60-day old checkout is stale at a 30-day threshold');
  await f.service.updateSettings({ staleDays: 90 });
  entry = (await f.service.getSnapshot()).worktrees.find(w => w.path === external);
  assert.equal(entry?.stale, false, 'same checkout is active at a 90-day threshold');
  const recent = await f.service.createWorktree(f.input('recent'));
  assert.equal(recent.stale, false, 'a newly created checkout is active');
});
