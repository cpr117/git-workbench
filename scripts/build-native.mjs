import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
if (process.platform !== 'darwin') throw new Error('原生历史小窗需要在 macOS 上构建。');
const root = fileURLToPath(new URL('../', import.meta.url));
const contents = path.join(root, 'native-bin/Orbit Git History.app/Contents');
const build = path.join(root, '.build/native');
rmSync(path.join(root, 'native-bin'), { recursive: true, force: true });
mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
mkdirSync(build, { recursive: true });
copyFileSync(path.join(root, 'native/Info.plist'), path.join(contents, 'Info.plist'));
const architectures = ['arm64', 'x86_64'];
for (const arch of architectures) {
  execFileSync('xcrun', ['swiftc', '-O', '-module-cache-path', path.join(build, 'module-cache'), '-target', `${arch}-apple-macosx12.0`, path.join(root, 'native/HistoryWindow.swift'), '-o', path.join(build, arch)], { stdio: 'inherit' });
}
execFileSync('xcrun', ['lipo', '-create', ...architectures.map(arch => path.join(build, arch)), '-output', path.join(contents, 'MacOS/GitWorkbenchHistory')], { stdio: 'inherit' });
execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', path.dirname(contents)], { stdio: 'inherit' });
console.log('Native history popup built for macOS arm64 + x86_64.');
