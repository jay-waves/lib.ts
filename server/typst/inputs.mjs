// Preview convention shared by all documents; no template manifest required.
export function typstInputs(theme = 'light') {
  if (theme !== 'light' && theme !== 'dark') throw new Error('Theme must be light or dark');
  return { theme };
}

export function typstCompilationKey(file, modified, inputs) {
  return JSON.stringify([file, modified, Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b))]);
}
