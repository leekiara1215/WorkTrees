import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function verifyMacApp(app) {
  await access(join(app, 'Contents/MacOS/WorkTrees Lite'), constants.X_OK);
  // Checks the nested helpers/frameworks AND seals of Info.plist and resources.
  // This is integrity verification, not Developer ID / notarization approval.
  await exec('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { timeout: 60_000 });
  const { stderr } = await exec('codesign', ['--display', '--verbose=4', app]);
  if (!stderr.includes('Identifier=com.betta.worktrees-lite\n') || !/Sealed Resources[ =]version=2/.test(stderr) || stderr.includes('Info.plist=not bound')) {
    throw new Error(`应用标识或资源签名无效：${app}\n${stderr}`);
  }
  console.log(`已验证应用及嵌套代码签名：${app}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('请提供需要检查的 .app 路径。');
  await verifyMacApp(resolve(process.argv[2]));
}
