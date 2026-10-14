import { cp, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (command, args) => new Promise((done, fail) => {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  child.once('error', fail);
  child.once('exit', code => code === 0 ? done() : fail(new Error(`${command} failed (${code})`)));
});

await run(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build']);
await run(process.env.CARGO || 'cargo', ['build', '--release']);

const platform = `${process.platform}-${process.arch}`;
const extension = process.platform === 'win32' ? '.exe' : '';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve(root, 'release', `saved-notes-${platform}-${stamp}`);
await mkdir(output, { recursive: true });
await cp(resolve(root, 'target/release', `saved-notes-library${extension}`), resolve(output, `saved-notes-library${extension}`));
await cp(resolve(root, 'dist'), resolve(output, 'dist'), { recursive: true });
for (const path of ['fonts', 'LICENSE']) {
  await cp(resolve(root, path), resolve(output, path), { recursive: true });
}
await mkdir(resolve(output, 'data'));
await writeFile(resolve(output, 'DEPLOY.md'), `# Deployment\n\nThis package contains the native Rust service for ${platform}. No Node.js runtime is required.\n\n1. Copy this directory to the target machine.\n2. Run saved-notes-library${extension} E:/notes to register and open a repository, or run it without an argument to restore saved repositories.\n3. Open http://127.0.0.1:49191/.\n\nRepository registrations and reading state are stored in data/. Keep that directory when updating. Registered repository paths must exist on the target machine. Do not run multiple service processes against the same data directory.\n\nThe package includes the frontend, Typst fonts, and their licenses. Typst package caches remain machine-local.\n`, 'utf8');
console.log(`\nDeployment directory: ${output}`);
