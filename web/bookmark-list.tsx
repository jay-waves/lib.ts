import type { TreeNode } from './api/contracts';
import { FileTypeIcon } from './file-type-icon';
import { fileUrl } from './urls.mjs';
import { isPlainTreeActivation } from './file-tree.mjs';
import { bookmarkPositionKey, bookmarkMatchesRequest } from './bookmark-position.mjs';
import type { Bookmark } from './api/contracts';

export function BookmarkList({ files, bookmarks, selected, request, navigate }: {
  files: Pick<TreeNode, 'name' | 'path'>[];
  bookmarks: Bookmark[];
  selected: string;
  request: { path: string; line?: number | null; page?: Bookmark['page'] | null };
  navigate(path: string, directory: boolean, line?: number, page?: Bookmark['page']): void;
}) {
  const entries = files.flatMap(file => {
    const seen = new Set<string>();
    return bookmarks.filter(item => item.path === file.path)
      .sort((a, b) => (a.page?.index ?? a.line ?? 1) - (b.page?.index ?? b.line ?? 1) || (a.page?.y ?? 0) - (b.page?.y ?? 0))
      .flatMap(bookmark => {
        const line = bookmark.page ? undefined : bookmark.line ?? 1;
        const key = bookmarkPositionKey(bookmark);
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ ...file, line, page: bookmark.page, key }];
      });
  });
  return <ul className="m-0 flex list-none flex-col p-0" aria-label="Bookmarks">
    {entries.map(file => <li key={`${file.path}:${file.key}`} className="flex items-center gap-1 rounded-ui">
      <a className="sidebar-list-item bookmark-link relative flex min-w-0 flex-1 items-center gap-2 rounded-ui px-2 py-1.5 text-ui leading-5 text-inherit no-underline hover:no-underline" href={fileUrl(file.path, false) + (file.page ? `?page=${file.page.index + 1}&x=${file.page.x}&y=${file.page.y}` : `?line=${file.line}#L${file.line}`)}
        aria-current={file.path === selected && bookmarkMatchesRequest(file, request) ? 'page' : undefined}
        onClick={event => {
          if (!isPlainTreeActivation(event)) return;
          event.preventDefault();
          navigate(file.path, false, file.line, file.page);
        }}>
        <span className="inline-flex size-4 flex-none items-center justify-center text-muted [&_svg]:block [&_svg]:size-3.5!" aria-hidden="true"><FileTypeIcon name={file.name} /></span>
        <span className="sidebar-path"><bdi dir="ltr">{file.path}{file.page ? `:p${file.page.index + 1}` : `:${file.line}`}</bdi></span>
      </a>
    </li>)}
  </ul>;
}
