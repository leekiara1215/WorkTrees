import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyMacApp } from './verify-mac-package.mjs';

if (process.platform !== 'darwin') throw new Error('DMG 打包需要在 macOS 上执行。');
const exec = promisify(execFile);
const run = (command, args) => exec(command, args, { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const release = resolve(`release/v${version}`);
const app = join(release, `WorkTrees Lite-darwin-${process.arch}`, 'WorkTrees Lite.app');
const outputDir = resolve(process.argv[2] ?? release);
const name = `WorkTrees-Lite-v${version}-macOS-${process.arch}-internal.dmg`;
const output = join(outputDir, name);
const appName = basename(app);
const backgroundName = 'interstellar-delivery.tiff';
const backgroundPath = join('.background', backgroundName);
const aliasScript = fileURLToPath(new URL('./dmg-applications-alias.swift', import.meta.url));
const iconFile = fileURLToPath(new URL('../resources/interstellar-dock.png', import.meta.url));
await verifyMacApp(app);
await mkdir(outputDir, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'worktrees-dmg-'));
let mounted = false;
const mount = join(temporary, 'mounted');
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
try {
  const contents = join(temporary, 'contents');
  await mkdir(contents);
  await mkdir(mount);
  await mkdir(join(contents, '.background'));
  await run('ditto', [app, join(contents, appName)]);
  await copyFile(new URL(`../resources/${backgroundName}`, import.meta.url), join(contents, backgroundPath));
  const stagingImage = join(temporary, 'staging.dmg');
  const image = join(temporary, name);
  await run('hdiutil', ['create', '-volname', `WorkTrees Lite ${version} 内部测试`, '-srcfolder', contents, '-fs', 'HFS+', '-format', 'UDRW', stagingImage]);
  await run('hdiutil', ['attach', '-noautoopen', '-nobrowse', '-mountpoint', mount, stagingImage]);
  mounted = true;
  const applicationsAlias = join(mount, 'Applications');
  const aliasTool = join(temporary, 'dmg-applications-alias');
  await run('xcrun', ['swiftc', aliasScript, '-o', aliasTool]);
  await run(aliasTool, [applicationsAlias, iconFile]);
  const layoutScript = fileURLToPath(new URL('./layout-dmg.applescript', import.meta.url));
  try {
    await run('osascript', [layoutScript, mount, appName, backgroundName]);
  } catch (error) {
    throw new Error('无法设置 DMG 布局。请在已登录的 macOS 桌面运行，并允许终端控制 Finder。', { cause: error });
  }
  await run('hdiutil', ['detach', mount]);
  mounted = false;
  await run('hdiutil', ['convert', stagingImage, '-format', 'UDZO', '-o', image]);
  await run('hdiutil', ['verify', image]);
  await mkdir(mount, { recursive: true });
  await run('hdiutil', ['attach', '-readonly', '-noautoopen', '-nobrowse', '-mountpoint', mount, image]);
  mounted = true;
  if ((await stat(join(mount, '.DS_Store'))).size === 0) throw new Error('DMG 缺少 Finder 布局。');
  const visibleItems = (await readdir(mount)).filter((item) => !item.startsWith('.'));
  if (visibleItems.length !== 2 || !visibleItems.includes(appName) || !visibleItems.includes('Applications')) throw new Error('DMG 安装窗口应只显示应用和 Applications 替身。');
  await run(aliasTool, [applicationsAlias]);
  if (await digest(join(contents, backgroundPath)) !== await digest(join(mount, backgroundPath))) throw new Error('DMG 安装背景不一致。');
  const mountedApp = join(mount, appName);
  await verifyMacApp(mountedApp);
  for (const file of ['Contents/Resources/app.asar', 'Contents/_CodeSignature/CodeResources']) {
    if (await digest(join(app, file)) !== await digest(join(mountedApp, file))) throw new Error(`DMG 中的应用与源构建不一致：${file}`);
  }
  await run('hdiutil', ['detach', mount]);
  mounted = false;
  // Copy through a temporary sibling so a failed write cannot replace a usable image.
  const incoming = join(outputDir, `.${name}.${process.pid}.tmp`);
  try { await copyFile(image, incoming); await rename(incoming, output); }
  finally { await rm(incoming, { force: true }); }
  const sha256 = await digest(output);
  await writeFile(`${output}.sha256`, `${sha256}  ${basename(output)}\n`);
  console.log(JSON.stringify({ path: output, sizeMB: Math.round((await stat(output)).size / 1024 / 1024), sha256, signing: 'ad-hoc', notarized: false }, null, 2));
} finally {
  if (mounted) await run('hdiutil', ['detach', mount]);
  await rm(temporary, { recursive: true, force: true });
}
