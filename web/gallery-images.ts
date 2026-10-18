import type { TreeNode } from './api/contracts';

// The browser decides decode support. Unsupported files remain accessible cards.
const imageExtension = /\.(?:avif|bmp|gif|ico|jpe?g|jfif|png|svg|webp|apng|tiff?|heic|heif|jxl)$/i;
export const isGalleryVideo = (name: string) => /\.(?:mp4|m4v|mov|webm|ogv)$/i.test(name);

export const directorySortOptions = {
  'name-asc': 'Name: A–Z',
  'name-desc': 'Name: Z–A',
  'time-desc': 'Time: Newest first',
  'time-asc': 'Time: Oldest first',
} as const;
export type DirectorySort = keyof typeof directorySortOptions;
export type GalleryImage = TreeNode & { liveVideo?: TreeNode };
export const mediaKey = (node: GalleryImage) => `${node.path}:${node.modified}${node.liveVideo ? `:${node.liveVideo.path}:${node.liveVideo.modified}` : ''}`;

const names = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export function sortDirectoryNodes<T extends TreeNode>(nodes: readonly T[], sort: DirectorySort): T[] {
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

export function galleryImages(nodes: readonly TreeNode[], recursive: boolean): GalleryImage[] {
  const images: GalleryImage[] = [];
  const photos = new Map(nodes.filter(node => node.type === 'file' && /\.jpeg$/i.test(node.name))
    .map(node => [node.name.slice(0, -5), node]));
  const livePhotos = new Map<TreeNode, TreeNode>();
  const pairedVideos = new Set<TreeNode>();
  for (const node of nodes) {
    if (node.type !== 'file' || !/\.mov$/i.test(node.name)) continue;
    const photo = photos.get(node.name.slice(0, -4));
    if (photo && !livePhotos.has(photo)) {
      livePhotos.set(photo, node);
      pairedVideos.add(node);
    }
  }
  for (const node of nodes) {
    if (node.type === 'directory') {
      if (recursive) images.push(...galleryImages(node.children ?? [], true));
    } else if (!pairedVideos.has(node) && (imageExtension.test(node.name) || isGalleryVideo(node.name))) {
      const liveVideo = livePhotos.get(node);
      images.push(liveVideo ? { ...node, liveVideo } : node);
    }
  }
  return images;
}
