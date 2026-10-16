import type { TreeNode } from './api/contracts';
import { FileTypeIcon } from './file-type-icon';
import { fileUrl } from './urls.mjs';
import { isPlainTreeActivation } from './file-tree.mjs';

export function BookmarkList({ files, selected, navigate }: {
  files: Pick<TreeNode, 'name' | 'path'>[];
  selected: string;
  navigate(path: string, directory: boolean): void;
}) {
  return <ul className="m-0 list-none p-0" aria-label="Bookmarked files">
    {files.map(file => <li key={file.path} className="flex items-center gap-1 rounded-ui">
      <a className="sidebar-list-item bookmark-link relative flex min-w-0 flex-1 items-center gap-2 rounded-ui px-2 py-1.5 text-inherit no-underline hover:no-underline" href={fileUrl(file.path, false)}
        aria-current={file.path === selected ? 'page' : undefined}
        onClick={event => {
          if (!isPlainTreeActivation(event)) return;
          event.preventDefault();
          navigate(file.path, false);
        }}>
        <span className="flex flex-none text-muted" aria-hidden="true"><FileTypeIcon name={file.name} /></span>
        <span className="sidebar-path"><bdi dir="ltr">{file.path}</bdi></span>
      </a>
    </li>)}
  </ul>;
}
