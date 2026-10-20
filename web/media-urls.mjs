function mediaUrl(apiBase, media, variant = '') {
  const params = new URLSearchParams({ path: media.path, v: media.modified });
  // Keep this revision aligned with the HEIF disk cache in thumbnail.rs.
  // Old immutable browser entries may contain only the first image tile.
  if (variant && (media.preview === 'converted' || /\.(heic|heif)$/i.test(media.path))) {
    params.set('conversion', 'heif-grid-v1');
  }
  return `${apiBase}/media${variant ? `/${variant}` : ''}?${params}`;
}

export const thumbnailUrl = (apiBase, media) => mediaUrl(apiBase, media, 'thumbnail');
export const mediaFileUrl = (apiBase, media) => mediaUrl(apiBase, media);

export function imagePreviewUrls(apiBase, document) {
  const thumbnail = thumbnailUrl(apiBase, document);
  const source = document.preview === 'converted' ? mediaUrl(apiBase, document, 'preview')
      : mediaFileUrl(apiBase, document);
  return { thumbnail, source };
}
