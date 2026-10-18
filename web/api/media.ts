import { z } from 'zod';
import { requestJson } from './client.ts';

export const dimensionsSchema = z.object({ width: z.number().int().positive(), height: z.number().int().positive() });
export const videoMetadataSchema = z.object({
  dimensions: dimensionsSchema.optional(),
  durationSeconds: z.number().int().nonnegative().optional(),
  bitrate: z.number().int().positive().optional(),
  codec: z.string().optional(),
});
export const mediaDimensionsResponseSchema = z.object({
  dimensions: z.record(z.string(), dimensionsSchema.nullable()),
  capturedAt: z.record(z.string(), z.number().int().nullable()),
});
export type MediaDimensionsResponse = z.infer<typeof mediaDimensionsResponseSchema>;

export function getVideoMetadata(apiBase: string, path: string, signal?: AbortSignal) {
  return requestJson(`${apiBase}/media/metadata?${new URLSearchParams({ path })}`, videoMetadataSchema, { signal });
}

export function getMediaDimensions(apiBase: string, paths: string[], signal?: AbortSignal, includeCaptureTime = false) {
  return requestJson(`${apiBase}/media/dimensions`, mediaDimensionsResponseSchema, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths, includeCaptureTime }),
  });
}
