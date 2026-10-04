import { cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Run Vite directly so packaging does not depend on a platform-specific npm shell.
await new Promise((done, fail) => {
  const child = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build'], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  });
  child.once('error', fail);
  child.once('exit', code => code === 0 ? done() : fail(new Error(`Build failed (${code})`)));
});
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve(root, 'release', `markdown-preview-${process.platform}-${process.arch}-${stamp}`);
await mkdir(output, { recursive: true });
// Preserve the runtime layout, including Markdown plugins imported from src/.
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.mjs')) await cp(resolve(root, entry.name), resolve(output, entry.name));
}
for (const path of ['dist', 'package.json', 'package-lock.json', 'LICENSE']) {
  await cp(resolve(root, path), resolve(output, path), { recursive: true });
}
await mkdir(resolve(output, 'library'));
for (const entry of await readdir(resolve(root, 'library'), { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.mjs')) await cp(resolve(root, 'library', entry.name), resolve(output, 'library', entry.name));
}
for (const name of ['sidenotes.js', 'heading-sections.js']) {
  await mkdir(resolve(output, 'src/markdown'), { recursive: true });
  await cp(resolve(root, 'src/markdown', name), resolve(output, 'src/markdown', name));
}
await mkdir(resolve(output, 'data'));
await writeFile(resolve(output, 'DEPLOY.md'), `# Deployment\n\nBuilt with Node ${process.version} on ${process.platform}/${process.arch}.\n\n1. Copy this entire directory to your deployment location.\n2. Install Node.js (the build machine uses ${process.version}).\n3. Run npm ci --omit=dev in this directory on the target machine.\n4. Start with: node server-node.mjs E:/notes\n5. Open http://127.0.0.1:49191/ in your browser.\n\nUse an absolute notes path. Repo registrations are saved in data/repos.json.\nExisting data is intentionally excluded from this package. When updating, stop\nthe old service and keep the deployment directory's data folder. When migrating\nan existing installation, copy its data folder separately; registered paths must\nexist on the target machine. Do not run multiple processes against the same data.\n\nFor Neovim, prepend this deployment directory to runtimepath and connect to the\nrunning service. Example: vim.opt.rtp:prepend("E:/apps/markdown-preview")\n\nDependencies are not bundled. Fonts and\nTypst package caches are machine-local and are not included.\n`, 'utf8');
console.log(`\nDeployment directory: ${output}`);
