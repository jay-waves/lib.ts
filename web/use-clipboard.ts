import { useEffect, useState } from 'react';

export function useClipboard() {
  const [copied, setCopied] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(''), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy(label: string, value: string | undefined) {
    try {
      if (value === undefined) throw new Error('Content is unavailable. Reload the page and try again.');
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setError('');
    } catch (cause) {
      setError(`Could not copy ${label}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  return { copied, error, copy };
}
