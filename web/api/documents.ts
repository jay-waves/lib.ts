import { z } from 'zod';
import { requestJson } from './client.ts';
import { documentEvents } from './contracts.ts';
import { subscribeEvents } from './events.ts';

const pageSchema = z.object({ url: z.string(), width: z.number().positive(), height: z.number().positive() });
const positionSchema = z.object({ page: z.number().int().positive(), y: z.number() });
const diagnosticPositionSchema = z.object({ line: z.number().int().positive(), column: z.number().int().positive() });
const diagnosticSchema = z.object({
  file: z.string(), severity: z.string(), message: z.string(),
  range: z.object({ start: diagnosticPositionSchema, end: diagnosticPositionSchema }).nullable(),
});
const identity = { path: z.string(), absolutePath: z.string(), name: z.string() };
const metadata = { size: z.number().int().nonnegative(), modified: z.string() };
const source = { lineCount: z.number().int().nonnegative(), source: z.string() };

export const documentSchema = z.discriminatedUnion('type', [
  z.object({ ...identity, ...metadata, ...source, type: z.literal('html'), url: z.string() }),
  z.object({ ...identity, ...metadata, type: z.literal('image'), mime: z.string(), format: z.string(), url: z.string() }),
  z.object({ ...identity, ...metadata, type: z.literal('binary'), mime: z.string(), format: z.string().optional(), url: z.string() }),
  z.object({ ...identity, ...metadata, ...source, type: z.literal('markdown'), html: z.string().optional() }),
  z.object({ ...identity, ...source, type: z.literal('text'),
    outline: z.array(z.object({ name: z.string(), level: z.number().int().positive(),
      line: z.number().int().positive() })),
  }),
  z.object({ ...identity, ...metadata, type: z.literal('pdf'), revision: z.string(), pages: z.array(pageSchema),
    outline: z.array(z.object({ name: z.string(), level: z.number().int().nonnegative(),
      page: z.number().int().positive().optional(), y: z.number().optional() })),
  }),
  z.object({ ...identity, ...metadata, ...source, type: z.literal('typst'), pages: z.array(pageSchema),
    outline: z.array(z.object({ name: z.string(), level: z.number().int().nonnegative(),
      line: z.number().int().positive(), position: positionSchema.nullable() })),
    anchors: z.array(z.object({ line: z.number().int().positive(), page: z.number().int().positive(),
      y: z.number(), absoluteY: z.number() })),
    compile: z.object({ id: z.string().nullable(), status: z.enum(['success', 'failed']),
      diagnostics: z.array(diagnosticSchema) }).nullable(),
  }),
]);
export type LibraryDocument = z.infer<typeof documentSchema>;
export type DocumentView = 'raw' | 'preview';

export function getDocument(apiBase: string, path: string, view: DocumentView, theme: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ path, view, theme });
  return requestJson(`${apiBase}/document?${query}`, documentSchema, { signal });
}

export function watchDocument(apiBase: string, path: string, assets: string[], handlers: {
  connected: (payload: z.infer<typeof documentEvents.connected>) => void;
  document: () => void;
  assets: (payload: z.infer<typeof documentEvents.assets>) => void;
}) {
  const query = new URLSearchParams({ path });
  for (const asset of assets) query.append('asset', asset);
  return subscribeEvents(`${apiBase}/library/events?${query}`, documentEvents, handlers);
}
