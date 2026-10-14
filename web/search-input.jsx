import React, { useRef } from 'react';
import { TextInput, useMergedRefs } from '@primer/react';
import { SearchIcon, XIcon } from '@primer/octicons-react';

export function SearchInput({ ref, value, onClear, clearable = Boolean(value),
  clearLabel = 'Clear search', disabled, ...props }) {
  const inputRef = useRef(null);
  const mergedRef = useMergedRefs(ref, inputRef);
  return <TextInput {...props} ref={mergedRef} value={value} disabled={disabled} leadingVisual={SearchIcon}
    trailingAction={clearable ? <TextInput.Action type="button" icon={XIcon} aria-label={clearLabel}
      disabled={disabled} onClick={() => { onClear(); inputRef.current?.focus(); }} /> : undefined} />;
}
