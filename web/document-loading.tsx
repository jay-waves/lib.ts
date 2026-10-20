import { useState } from 'react';
import type { DocumentInfo } from './document-info';
import { isMediaPreview } from './preview-kind.mjs';
import { thumbnailUrl } from './media/media-urls.mjs';
import { apiBase } from './urls.mjs';

// The page surface needs identity only; it never starts a reader session.
export function DocumentLoading({ info }: { info: DocumentInfo }) {
  const [coverError, setCoverError] = useState(false);
  const paged = info.type === 'pdf' || info.type === 'typst';
  return <div role="status" aria-label={`Loading ${info.name}`} aria-busy="true">
    {isMediaPreview(info) && info.modified && !coverError
      ? <div className="p-4"><img className="mx-auto block h-auto max-h-[80vh] max-w-full rounded-ui object-contain"
        src={thumbnailUrl(apiBase, info)} alt="" onError={() => setCoverError(true)} /></div>
      : <div className={paged ? 'bg-subtle p-6' : 'status'}>
        <div className={paged ? 'mx-auto grid aspect-[210/297] w-full max-w-[900px] place-items-center bg-surface' : undefined}>
          <span className="rendering-label">Loading preview</span>
        </div>
      </div>}
  </div>;
}
