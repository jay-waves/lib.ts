import { spawn } from 'node:child_process';
import { win32 } from 'node:path';

export function openSystemBrowser(url, {
  platform = process.platform, env = process.env, launch = spawn,
} = {}) {
  const target = new URL(url);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1')
    throw new Error('Only local library URLs can be opened');
  const command = platform === 'win32'
    ? win32.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'explorer.exe')
    : platform === 'darwin' ? 'open' : 'xdg-open';
  return new Promise((resolve, reject) => {
    const child = launch(command, [target.href], { shell: false, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
