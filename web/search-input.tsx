import React, { useRef } from 'react';
import { TextInput, useMergedRefs } from '@primer/react';
import { SearchIcon, XIcon } from '@primer/octicons-react';

type SearchInputProps = Omit<React.ComponentProps<typeof TextInput>, 'trailingAction' | 'leadingVisual' | 'value' | 'defaultValue'> & {
  value: string;
  onClear: () => void;
  clearable?: boolean;
  clearLabel?: string;
};

export function SearchInput({ ref, value, onClear, clearable = Boolean(value),
  clearLabel = 'Clear search', disabled, ...props }: SearchInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const mergedRef = useMergedRefs(ref, inputRef);
  return <TextInput {...props} ref={mergedRef} value={value} disabled={disabled} leadingVisual={SearchIcon}
    trailingAction={clearable ? <TextInput.Action type="button" icon={XIcon} aria-label={clearLabel}
      disabled={disabled} onClick={() => { onClear(); inputRef.current?.focus(); }} /> : undefined} />;
}
