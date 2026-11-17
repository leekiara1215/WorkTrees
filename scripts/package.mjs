import { packager } from '@electron/packager';
import { readFile } from 'node:fs/promises';
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const paths = await packager({ dir: '.', name: 'WorkTrees Lite', executableName: 'WorkTrees Lite', appBundleId: 'com.betta.worktrees-lite', out: `release/v${version}`, overwrite: true, platform: process.platform, arch: process.arch, asar: true, prune: true, ignore: [/^\/src($|\/)/, /^\/tests($|\/)/, /^\/docs($|\/)/, /^\/scripts($|\/)/, /^\/release($|\/)/, /^\/\.git($|\/)/, /^\/tsconfig/, /^\/vite\.config/] });
console.log(paths.join('\n'));
