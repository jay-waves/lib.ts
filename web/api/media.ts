import { z } from 'zod';
import { requestJson } from './client.ts';
import { documentInfoSchema } from './documents.ts';

export const dimensionsSchema = z.object({ width: z.number().int().positive(), height: z.number().int().positive() });
export const imageMetadataSchema = z.object({
  dimensions: dimensionsSchema.optional(),
  exif: z.array(z.string()),
  capturedAt: z.number().int().optional(),
});
export type ImageMetadata = z.infer<typeof imageMetadataSchema>;
export const videoMetadataSchema = z.object({
  dimensions: dimensionsSchema.optional(),
  durationSeconds: z.number().int().nonnegative().optional(),
  bitrate: z.number().int().positive().optional(),
  codec: z.string().optional(),
});
export type VideoMetadata = z.infer<typeof videoMetadataSchema>;
export const mediaDimensionsResponseSchema = z.object({
  files: z.array(documentInfoSchema),
});
export type MediaDimensionsResponse = z.infer<typeof mediaDimensionsResponseSchema>;

export const mediaMetadataSchema = z.object({
  path: z.string(), modified: z.string(),
  media: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('image'), details: imageMetadataSchema }),
    z.object({ kind: z.literal('video'), details: videoMetadataSchema }),
  ]),
});

export function getMediaMetadata(apiBase: string, path: string, signal?: AbortSignal) {
  return requestJson(`${apiBase}/media/metadata?${new URLSearchParams({ path })}`, mediaMetadataSchema, { signal });
}

export function getMediaDimensions(apiBase: string, paths: string[], signal?: AbortSignal, includeCaptureTime = false) {
  return requestJson(`${apiBase}/media/dimensions`, mediaDimensionsResponseSchema, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths, includeCaptureTime }),
  });
}

// Launching is a backend operation; the response identifies its execution target.
export function openMedia(apiBase: string, path: string) {
  return requestJson(`${apiBase}/media/open`, z.object({ ok: z.literal(true), target: z.literal('server') }), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
}
