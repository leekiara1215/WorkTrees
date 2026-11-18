import { packager } from '@electron/packager';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyMacApp } from './verify-mac-package.mjs';
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const paths = await packager({
  dir: '.', name: 'WorkTrees Lite', executableName: 'WorkTrees Lite',
  appBundleId: 'com.betta.worktrees-lite', out: `release/v${version}`,
  overwrite: true, platform: process.platform, arch: process.arch,
  asar: true, prune: true,
  // Internal builds still need a complete signature: the Electron linker signature
  // does not seal the renamed application or its modified resources.
  ...(process.platform === 'darwin' ? { osxSign: {
    identity: '-', identityValidation: false, continueOnError: false,
    preAutoEntitlements: false, preEmbedProvisioningProfile: false, strictVerify: true,
    optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' }),
  } } : {}),
  ignore: [/^\/src($|\/)/, /^\/tests($|\/)/, /^\/docs($|\/)/, /^\/scripts($|\/)/, /^\/release($|\/)/, /^\/resources\/interstellar-(delivery\.tiff|dock\.png)$/, /^\/\.git($|\/)/, /^\/tsconfig/, /^\/vite\.config/],
});
if (process.platform === 'darwin') {
  for (const path of paths) await verifyMacApp(join(path, 'WorkTrees Lite.app'));
  console.warn('内部测试构建：已完成 ad-hoc 签名校验，未使用 Developer ID，未经过 Apple 公证。');
}
console.log(paths.join('\n'));
