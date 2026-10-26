import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Change } from '../src/git';

interface Node { name: string; path: string; file?: Change; children?: Node[]; }
const model = require('../../media/comparisonTree.js') as { build(files: Change[], scope?: string, query?: string, options?: { mode?: string; sort?: string }): Node };

test('comparison tree groups only changed paths, sorts folders first and strips the selected scope', () => {
  const tree = model.build([
    { path: 'src/z.txt', status: 'D' }, { path: 'src/internal/new.txt', status: 'A' },
    { path: 'src/a.txt', status: 'M' }, { path: 'src/internal/renamed.txt', oldPath: 'src/old.txt', status: 'R100' },
  ], 'src');
  assert.deepEqual(tree.children!.map(node => node.name), ['internal', 'a.txt', 'z.txt']);
  assert.deepEqual(tree.children![0].children!.map(node => node.file!.status), ['A', 'R100']);
  assert.equal(tree.children![1].path, 'src/a.txt');
});

test('filtering retains ancestor folders, matches old rename paths and handles special names safely', () => {
  const files = [{ path: '__proto__/constructor/<script>.txt', status: 'M' }, { path: 'other/new.txt', oldPath: 'before/name.txt', status: 'R100' }];
  const tree = model.build(files, '', '<SCRIPT>');
  assert.equal(tree.children![0].name, '__proto__');
  assert.equal(tree.children![0].children![0].children![0].name, '<script>.txt');
  assert.equal(model.build(files, '', 'before/name').children![0].children![0].file, files[1]);
  assert.deepEqual(model.build(files, '', 'no match').children, []);
});

test('list mode sorts by path, name or status while retaining original file identities', () => {
  const files = [{ path: 'src/a/z.txt', status: 'M' }, { path: 'src/z/a.txt', status: 'D' }, { path: 'src/b/a.txt', status: 'A' }];
  const list = (sort: string) => model.build(files, 'src', '', { mode: 'list', sort }).children!;
  assert.deepEqual(list('path').map(node => node.path), ['src/a/z.txt', 'src/b/a.txt', 'src/z/a.txt']);
  assert.deepEqual(list('name').map(node => node.path), ['src/b/a.txt', 'src/z/a.txt', 'src/a/z.txt']);
  assert.deepEqual(list('status').map(node => node.file!.status), ['A', 'D', 'M']);
  assert.ok(list('path').every(node => node.file && !node.children));
  assert.equal(model.build(files, 'src', 'z.txt', { mode: 'list' }).children![0].file, files[0]);
});
