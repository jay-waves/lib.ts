import { IconButton } from '@primer/react';
import { XIcon } from '@primer/octicons-react';
import type { TreeNode } from './api/contracts';
import type { BookmarkState } from './bookmarks';
import { FileTypeIcon } from './file-type-icon';
import { fileUrl } from './urls.mjs';
import { isPlainTreeActivation } from './file-tree.mjs';

export function BookmarkList({ files, selected, navigate, state }: {
  files: Pick<TreeNode, 'name' | 'path'>[];
  selected: string;
  navigate(path: string, directory: boolean): void;
  state: BookmarkState;
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
        <span className="bookmark-icon" aria-hidden="true"><FileTypeIcon name={file.name} /></span>
        <span className="bookmark-label"><span className="bookmark-file-name">{file.name}</span>
          <span className="bookmark-parent-path">{file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : '/'}</span>
        </span>
      </a>
      <IconButton icon={XIcon} aria-label={`Remove bookmark: ${file.path}`} title="Remove bookmark"
        size="small" variant="invisible" disabled={state.loading || state.saving}
        onClick={() => { void state.setBookmark(file.path, false); }} />
    </li>)}
  </ul>;
}
