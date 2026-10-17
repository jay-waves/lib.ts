import type { TreeNode } from './api/contracts';
import { FileTypeIcon } from './file-type-icon';
import { fileUrl } from './urls.mjs';
import { isPlainTreeActivation } from './file-tree.mjs';
import type { Bookmark } from './api/contracts';

export function BookmarkList({ files, bookmarks, selected, navigate }: {
  files: Pick<TreeNode, 'name' | 'path'>[];
  bookmarks: Bookmark[];
  selected: string;
  navigate(path: string, directory: boolean, line?: number): void;
}) {
  const entries = files.flatMap(file => bookmarks.filter(item => item.path === file.path)
    .sort((a, b) => (a.line ?? 0) - (b.line ?? 0)).map(bookmark => ({ ...file, line: bookmark.line })));
  return <ul className="m-0 list-none p-0" aria-label="Bookmarks">
    {entries.map(file => <li key={`${file.path}:${file.line ?? 'file'}`} className="flex items-center gap-1 rounded-ui">
      <a className="sidebar-list-item bookmark-link relative flex min-w-0 flex-1 items-center gap-2 rounded-ui px-2 py-1.5 text-ui leading-5 text-inherit no-underline hover:no-underline" href={fileUrl(file.path, false) + (file.line ? `?line=${file.line}#L${file.line}` : '')}
        aria-current={file.path === selected ? 'page' : undefined}
        onClick={event => {
          if (!isPlainTreeActivation(event)) return;
          event.preventDefault();
          navigate(file.path, false, file.line);
        }}>
        <span className="inline-flex size-4 flex-none items-center justify-center text-muted [&_svg]:block [&_svg]:size-3.5!" aria-hidden="true"><FileTypeIcon name={file.name} /></span>
        <span className="sidebar-path"><bdi dir="ltr">{file.path}{file.line ? `:[${file.line}]` : ''}</bdi></span>
      </a>
    </li>)}
  </ul>;
}
