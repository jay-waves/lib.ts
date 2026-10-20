import { useSystemOpen } from './use-system-open';

export function OpenMedia({ path }: { path: string }) {
  const { error, open, pending } = useSystemOpen('media', path);
  return <div className="my-3 flex flex-col items-center gap-2">
    <button type="button" className="ui-text-button" disabled={pending} onClick={open}
      title="Opens the original file on the computer running lib.ts">
      Open in system application
    </button>
    {error && <p role="alert">{error}</p>}
  </div>;
}
