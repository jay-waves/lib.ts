import { basename, parse } from 'node:path';

export function folderName(root) {
  return basename(root) || parse(root).root.replace(/[\\/:]+/g, '') || 'root';
}

export function repoSegment(repo) {
  return encodeURIComponent(repo.slug || folderName(repo.root));
}
