import './media-details.css';
import { isMediaPreview } from './preview-kind.mjs';
import { formatRelativeModified } from './time-labels.mjs';
import type { DocumentInfo } from './document-info';

function sizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function durationLabel(seconds: number) {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function bitrateLabel(bitsPerSecond: number) {
  return bitsPerSecond >= 1_000_000
    ? `${(bitsPerSecond / 1_000_000).toFixed(1)} Mb/s`
    : `${Math.round(bitsPerSecond / 1000)} kb/s`;
}

function codecLabel(codec: string) {
  const labels: Record<string, string> = {
    h264: 'H.264', avc: 'H.264', hevc: 'HEVC', h265: 'HEVC', av1: 'AV1',
    vp8: 'VP8', vp9: 'VP9', prores: 'ProRes', mpeg4: 'MPEG-4', mjpeg: 'Motion JPEG',
  };
  return labels[codec.toLowerCase()] || codec.toUpperCase();
}

function FileSummary({ document }: { document: DocumentInfo }) {
  return <>
    {document.size != null && sizeLabel(document.size)}
    {document.modified && <>{document.size != null && ' · '}<time dateTime={document.modified}>{formatRelativeModified(document.modified)}</time></>}
  </>;
}

export function DocumentDetails({ document, dimensions, progress }: {
  document: DocumentInfo;
  dimensions?: { width: number; height: number };
  progress?: { line?: number | null; pending?: boolean };
}) {
  const imageMetadata = document.type === 'image' ? document.imageMetadata : undefined;
  const videoMetadata = document.type === 'binary' ? document.videoMetadata : undefined;
  const details = [
    ...(dimensions ? [`${dimensions.width} × ${dimensions.height} px`] : []),
    ...(imageMetadata?.exif ?? []),
    ...(videoMetadata?.durationSeconds != null ? [durationLabel(videoMetadata.durationSeconds)] : []),
    ...(videoMetadata?.bitrate ? [bitrateLabel(videoMetadata.bitrate)] : []),
    ...(videoMetadata?.codec ? [codecLabel(videoMetadata.codec)] : []),
  ].join(' · ');
  if (isMediaPreview(document)) return <div className="media-details ms-3 self-center font-code text-ui text-muted">
    <span tabIndex={details ? 0 : undefined} className="media-details-trigger ui-focus" aria-label={details ? `Media information: ${details}` : undefined}>
      <FileSummary document={document} />
    </span>
    {details && <div className="media-details-popover">{details}</div>}
  </div>;
  return <span className="ms-3 min-w-0 self-center truncate font-code text-ui leading-5 text-muted tabular-nums tracking-[-.15px] @max-reader-sm/reader:ms-0 @max-reader-sm/reader:order-3 @max-reader-sm/reader:basis-full" aria-busy={document.lineCount != null && progress?.pending}>
    {document.lineCount != null && <>{`${progress?.line ?? '—'} / ${document.lineCount} lines · `}</>}
    <FileSummary document={document} />
  </span>;
}
