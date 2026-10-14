import { stat } from 'node:fs/promises';
import { serveWorker } from '../worker-host.mjs';
import { createPdfStore } from './store.mjs';

const store = createPdfStore();
async function checkRevision(file, info) {
  const current = await stat(file);
  if (current.mtimeMs !== info.mtimeMs || current.size !== info.size)
    throw Object.assign(new Error('Document changed; reload its metadata'), { status: 410 });
}
serveWorker({
  async document({ file, info }) {
    await checkRevision(file, info);
    return store.document(file, info);
  },
  async page({ file, info, page, width }) {
    await checkRevision(file, info);
    return store.page(file, page, width, info);
  },
  sweep: ({ active, now, idleMs }) => store.sweep(file => active.includes(file), now, idleMs),
}, { profilePrefix: 'pdf', transfer: value => value?.body ? [value.body] : [] });
