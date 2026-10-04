import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import { TextInput } from '@primer/react';
import { SearchIcon, XIcon } from '@primer/octicons-react';

export const SearchInput = forwardRef(function SearchInput({ value, onClear, clearable = Boolean(value),
  clearLabel = 'Clear search', disabled, ...props }, ref) {
  const inputRef = useRef(null);
  useImperativeHandle(ref, () => inputRef.current);
  return <TextInput {...props} ref={inputRef} value={value} disabled={disabled} leadingVisual={SearchIcon}
    trailingAction={clearable ? <TextInput.Action type="button" icon={XIcon} aria-label={clearLabel}
      disabled={disabled} onClick={() => { onClear(); inputRef.current?.focus(); }} /> : undefined} />;
});
