function mediaUrl(apiBase, media, variant = '') {
  return `${apiBase}/media${variant ? `/${variant}` : ''}?${new URLSearchParams({ path: media.path, v: media.modified })}`;
}

export const thumbnailUrl = (apiBase, media) => mediaUrl(apiBase, media, 'thumbnail');
export const mediaFileUrl = (apiBase, media) => mediaUrl(apiBase, media);

export function imagePreviewUrls(apiBase, document) {
  const thumbnail = thumbnailUrl(apiBase, document);
  const source = document.preview === 'thumbnail' ? thumbnail
    : document.preview === 'converted' ? mediaUrl(apiBase, document, 'preview')
      : mediaFileUrl(apiBase, document);
  return { thumbnail, source };
}
