import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
const { choose } = require(path.resolve(__dirname, '../../media/selection.js')) as {
  choose(order: string[], current: string[], anchor: string, hash: string, modifiers?: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }): { hashes: string[]; anchor: string };
};

test('Shift selects both endpoints and all visible commits, retaining the original anchor', () => {
  const order = ['a', 'b', 'c', 'd'];
  const first = choose(order, ['b'], 'b', 'd', { shiftKey: true });
  assert.deepEqual(first, { hashes: ['b', 'c', 'd'], anchor: 'b' });
  assert.deepEqual(choose(order, first.hashes, first.anchor, 'a', { shiftKey: true }), { hashes: ['a', 'b'], anchor: 'b' });
  assert.deepEqual(choose(['a', 'c', 'd'], ['a'], 'a', 'd', { shiftKey: true }).hashes, ['a', 'c', 'd']);
});

test('Cmd/Ctrl toggles without a two-commit limit and a normal click resets the selection', () => {
  const order = ['a', 'b', 'c', 'd'];
  assert.deepEqual(choose(order, ['a', 'b'], 'b', 'd', { metaKey: true }).hashes, ['a', 'b', 'd']);
  assert.deepEqual(choose(order, ['a', 'b', 'd'], 'd', 'b', { ctrlKey: true }).hashes, ['a', 'd']);
  assert.deepEqual(choose(order, ['a', 'd'], 'd', 'c').hashes, ['c']);
  assert.deepEqual(choose(order, ['a'], 'a', 'a', { ctrlKey: true }).hashes, ['a']);
});
