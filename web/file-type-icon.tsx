import { MarkdownIcon, FileIcon } from '@primer/octicons-react';

export function FileTypeIcon({ name }: { name: string }) {
  return name.toLowerCase().endsWith('.md') ? <MarkdownIcon /> : <FileIcon />;
}
