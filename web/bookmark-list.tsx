import type { TreeNode } from './api/contracts';
import { fileUrl } from './urls.mjs';
import { isPlainTreeActivation } from './file-tree.mjs';

export function BookmarkList({ files, selected, navigate }: {
  files: Pick<TreeNode, 'name' | 'path'>[];
  selected: string;
  navigate(path: string, directory: boolean): void;
}) {
  return <ul className="bookmark-list" aria-label="Bookmarked files">
    {files.map(file => <li key={file.path} className="bookmark-row">
      <a className="bookmark-link" href={fileUrl(file.path, false)} title={file.path}
        aria-current={file.path === selected ? 'page' : undefined}
        onClick={event => {
          if (!isPlainTreeActivation(event)) return;
          event.preventDefault();
          navigate(file.path, false);
        }}>
        <span className="bookmark-path">{file.path}</span>
      </a>
    </li>)}
  </ul>;
}
