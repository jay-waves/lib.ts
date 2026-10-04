import { spawn } from 'node:child_process';
import { win32 } from 'node:path';

export function openSystemDirectory(directory, {
  platform = process.platform, env = process.env, launch = spawn,
} = {}) {
  const windows = platform === 'win32';
  const command = windows ? win32.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'explorer.exe')
    : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = [windows ? win32.normalize(directory) : directory];
  return new Promise((resolve, reject) => {
    // This is an interactive GUI launch. Keep it attached and visible on Windows.
    const child = launch(command, args, { shell: false, windowsHide: false, stdio: 'ignore' });
    let timer;
    const finish = error => {
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    child.once('error', finish);
    child.once('exit', (code, signal) => {
      // Explorer may return 1 after handing a request to the existing desktop process.
      if (code === 0 || (windows && code === 1)) finish();
      else finish(new Error(`File explorer failed to open directory (${signal || code})`));
    });
    child.once('spawn', () => {
      // Some file managers keep their launcher process alive with the window.
      timer = setTimeout(() => { child.unref(); finish(); }, 1000);
    });
  });
}
