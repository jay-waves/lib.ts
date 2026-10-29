import { mkdir, cp } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (command, args) => new Promise((done, fail) => {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  child.once('error', fail);
  child.once('exit', code => code === 0 ? done() : fail(new Error(`${command} failed (${code})`)));
});
await run(process.execPath, ['scripts/build-comrak-assets.mjs']);
await run(process.env.CARGO || 'cargo', ['build', '--release', '--locked', '-p', 'lib-comrak']);
const suffix = process.platform === 'win32' ? '.exe' : '';
const output = resolve(root, 'release', `lib.comrak-${process.platform}-${process.arch}`);
await mkdir(output, { recursive: true });
await cp(resolve(root, 'target/release', `lib-comrak${suffix}`), resolve(output, `lib.comrak${suffix}`));
await cp(resolve(root, 'crates/lib-comrak/README.md'), resolve(output, 'README.md'));
await cp(resolve(root, 'crates/lib-comrak/AGENTS.md'), resolve(output, 'AGENTS.md'));
await cp(resolve(root, 'crates/lib-comrak/examples'), resolve(output, 'examples'), { recursive: true });
await cp(resolve(root, 'LICENSE'), resolve(output, 'LICENSE'));
for (const name of ['KaTeX-LICENSE', 'highlight.js-LICENSE', 'Pele-LICENSE', 'D3-LICENSE', 'LinkeDOM-LICENSE', 'SourceHanSerif-LICENSE']) {
  await cp(resolve(root, 'crates/lib-comrak/generated', name), resolve(output, name));
}
console.log(`Standalone executable: ${resolve(output, `lib.comrak${suffix}`)}`);
