import { Button } from '@primer/react';
import { startTransition, useActionState } from 'react';
import { openMedia } from './api/media';
import { apiBase } from './urls.mjs';

export function OpenMedia({ path }: { path: string }) {
  const [result, open, pending] = useActionState(async () => {
    try {
      await openMedia(apiBase, path);
      return { error: '', sent: true };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), sent: false };
    }
  }, { error: '', sent: false });
  return <div className="my-3 flex flex-col items-center gap-2">
    <Button disabled={pending} onClick={() => startTransition(() => open())}
      title="Opens the original file on the computer running lib.ts">
      {pending ? 'Opening…' : 'Open in system application'}
    </Button>
    {result.error && <p role="alert">{result.error}</p>}
    {result.sent && <p role="status">Open request sent.</p>}
  </div>;
}
