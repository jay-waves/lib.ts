import { serveWorker } from '../worker-host.mjs';
import { renderMarkdown } from './renderer.mjs';

serveWorker({ render: ({ source, options }) => renderMarkdown(source, options) }, { profilePrefix: 'markdown' });
