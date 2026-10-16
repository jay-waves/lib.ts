import test from 'node:test';
import assert from 'node:assert/strict';
import { repositoryUrl, documentUrl, repositoryApiUrl, searchUrl, gitUrl, parseRepositoryLocation, directoryPathSegments } from '../web/paths.ts';

test('directory breadcrumbs use the server hostname and keep drive/share roots navigable', () => {
  const windows = { hostname: 'jay-pc', rootPath: '' };
  const linux = { hostname: 'jay-server', rootPath: '/' };
  assert.deepEqual(directoryPathSegments('E:\\notes\\中文 project', windows), [
    { label: 'jay-pc', path: '' }, { label: 'E:', path: 'E:\\' },
    { label: 'notes', path: 'E:\\notes' },
    { label: '中文 project', path: 'E:\\notes\\中文 project' },
  ]);
  assert.deepEqual(directoryPathSegments('E:/notes/', windows), [
    { label: 'jay-pc', path: '' }, { label: 'E:', path: 'E:/' },
    { label: 'notes', path: 'E:/notes' },
  ]);
  assert.deepEqual(directoryPathSegments('\\\\server\\share\\notes', windows), [
    { label: 'server' }, { label: 'share', path: '\\\\server\\share' },
    { label: 'notes', path: '\\\\server\\share\\notes' },
  ]);
  assert.deepEqual(directoryPathSegments('//server/share/xx/yy', windows), [
    { label: 'server' }, { label: 'share', path: '//server/share' },
    { label: 'xx', path: '//server/share/xx' }, { label: 'yy', path: '//server/share/xx/yy' },
  ]);
  assert.deepEqual(directoryPathSegments('/home/a\\b', linux), [
    { label: 'jay-server', path: '/' }, { label: 'home', path: '/home' },
    { label: 'a\\b', path: '/home/a\\b' },
  ]);
  assert.deepEqual(directoryPathSegments('/', linux), [{ label: 'jay-server', path: '/' }]);
  assert.deepEqual(directoryPathSegments('', windows), [{ label: 'jay-pc', path: '' }]);
  assert.deepEqual(directoryPathSegments('C:\\', windows), [
    { label: 'jay-pc', path: '' }, { label: 'C:', path: 'C:\\' },
  ]);
  assert.deepEqual(directoryPathSegments('\\\\server\\share', windows), [
    { label: 'server' }, { label: 'share', path: '\\\\server\\share' },
  ]);
});

test('repository URLs encode each path segment and round-trip through the page parser', () => {
  const repo = '中文 notes #%';
  const path = 'docs/a #.typ';
  const url = documentUrl(repo, path);
  assert.equal(repositoryUrl(repo), '/%E4%B8%AD%E6%96%87%20notes%20%23%25/tree/');
  assert.equal(url, '/%E4%B8%AD%E6%96%87%20notes%20%23%25/tree/docs/a%20%23.typ');
  assert.deepEqual(parseRepositoryLocation(url), { repo, kind: 'tree', path });
  assert.deepEqual(parseRepositoryLocation(repositoryUrl(repo)), { repo, kind: 'tree', path: '' });
  assert.equal(documentUrl(repo, 'docs/', true), '/%E4%B8%AD%E6%96%87%20notes%20%23%25/tree/docs/');
  assert.equal(repositoryApiUrl(repo, 'document'), '/%E4%B8%AD%E6%96%87%20notes%20%23%25/api/document');
});

test('search and Git URLs restore their route kind and encode query values', () => {
  const search = searchUrl('til', 'two words', 'bookmarks');
  const git = gitUrl('til', 'src/a #.js', 'staged');
  assert.equal(search, '/til/search?q=two+words&scope=bookmarks');
  assert.equal(searchUrl('til', 'needle', 'current-file', 'docs/a #.typ'), '/til/search?q=needle&scope=current-file&file=docs%2Fa+%23.typ');
  assert.equal(git, '/til/git?path=src%2Fa+%23.js&scope=staged');
  assert.equal(parseRepositoryLocation(new URL(search, 'http://localhost').pathname).kind, 'search');
  assert.equal(parseRepositoryLocation(new URL(git, 'http://localhost').pathname).kind, 'git');
  assert.equal(parseRepositoryLocation('/api/repos'), null);
  assert.equal(parseRepositoryLocation('/notes/a.typ'), null);
});
