import type { TreeNode } from './api/contracts';

// The browser decides decode support. Unsupported files remain accessible cards.
const imageExtension = /\.(?:avif|bmp|gif|ico|jpe?g|jfif|png|svg|webp|apng|tiff?|heic|heif|jxl)$/i;
export const isGalleryVideo = (name: string) => /\.(?:mp4|m4v|webm|ogv)$/i.test(name);

export const directorySortOptions = {
  'name-asc': 'Name: A–Z',
  'name-desc': 'Name: Z–A',
  'time-desc': 'Time: Newest first',
  'time-asc': 'Time: Oldest first',
} as const;
export type DirectorySort = keyof typeof directorySortOptions;

const names = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export function sortDirectoryNodes(nodes: readonly TreeNode[], sort: DirectorySort): TreeNode[] {
  return [...nodes].sort((a, b) => {
    const byName = names.compare(a.name, b.name) || names.compare(a.path, b.path);
    if (sort === 'name-asc') return byName;
    if (sort === 'name-desc') return -byName;
    const aTime = Date.parse(a.modified), bTime = Date.parse(b.modified);
    if (!Number.isFinite(aTime)) return Number.isFinite(bTime) ? 1 : byName;
    if (!Number.isFinite(bTime)) return -1;
    return (sort === 'time-asc' ? aTime - bTime : bTime - aTime) || byName;
  });
}

export function galleryImages(nodes: readonly TreeNode[], recursive: boolean): TreeNode[] {
  const images: TreeNode[] = [];
  for (const node of nodes) {
    if (node.type === 'directory') {
      if (recursive) images.push(...galleryImages(node.children ?? [], true));
    } else if (imageExtension.test(node.name) || isGalleryVideo(node.name)) images.push(node);
  }
  return images;
}
