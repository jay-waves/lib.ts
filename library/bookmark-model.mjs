export function validateBookmark(path, bookmarked) {
  if (typeof path !== 'string' || !path || path.length > 4096 || /[\\:\0\r\n]/.test(path) ||
      path.split('/').some(part => !part || part === '.' || part === '..'))
    throw new Error('A repository-relative file path is required.');
  if (typeof bookmarked !== 'boolean') throw new Error('The bookmarked field must be true or false.');
}
