import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const verifyScript = fileURLToPath(new URL('../scripts/verify-mac-package.mjs', import.meta.url));
const macOnly = { skip: process.platform !== 'darwin' };
async function bundle(directory: string, id: string) {
  await mkdir(path.join(directory, 'Contents/MacOS'), { recursive: true });
  await mkdir(path.join(directory, 'Contents/Resources'));
  await copyFile('/usr/bin/true', path.join(directory, 'Contents/MacOS/WorkTrees Lite'));
  await chmod(path.join(directory, 'Contents/MacOS/WorkTrees Lite'), 0o755);
  await writeFile(path.join(directory, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleExecutable</key><string>WorkTrees Lite</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  await writeFile(path.join(directory, 'Contents/Resources/content.txt'), 'sealed content');
}
async function signed(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'worktrees-signing-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'WorkTrees Lite.app');
  await bundle(app, 'com.betta.worktrees-lite');
  const helper = path.join(app, 'Contents/Frameworks/Helper.app');
  await bundle(helper, 'com.betta.worktrees-lite.helper');
  for (const directory of [helper, app]) await exec('codesign', ['--force', '--sign', '-', '--timestamp=none', directory]);
  return { app, helper };
}

test('mac package verification accepts a fully sealed app and nested helper', macOnly, async t => {
  const { app } = await signed(t);
  const result = await exec(process.execPath, [verifyScript, app]);
  assert.match(result.stdout, /已验证/);
});

test('mac package verification rejects modified top-level resources', macOnly, async t => {
  const { app } = await signed(t);
  await writeFile(path.join(app, 'Contents/Resources/content.txt'), 'tampered resource');
  await assert.rejects(exec(process.execPath, [verifyScript, app]));
});

test('mac package verification rejects modified nested helper resources', macOnly, async t => {
  const { app, helper } = await signed(t);
  await writeFile(path.join(helper, 'Contents/Resources/content.txt'), 'tampered helper resource');
  await assert.rejects(exec(process.execPath, [verifyScript, app]));
});

test('mac package verification rejects a renamed binary without a complete bundle signature', macOnly, async t => {
  const { app } = await signed(t);
  await copyFile('/usr/bin/true', path.join(app, 'Contents/MacOS/WorkTrees Lite'));
  await assert.rejects(exec(process.execPath, [verifyScript, app]));
});
