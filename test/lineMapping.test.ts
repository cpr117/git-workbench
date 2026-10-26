import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mapLineRange } from '../src/lineMapping';

test('zero-context insertion and deletion boundaries map unchanged lines precisely', () => {
  assert.deepEqual(mapLineRange('@@ -0,0 +1,2 @@\n+a\n+b\n', 3, 4, 5), { start: 1, end: 2, expanded: false, added: false });
  assert.deepEqual(mapLineRange('@@ -2,2 +1,0 @@\n-a\n-b\n', 2, 3, 3), { start: 4, end: 5, expanded: false, added: false });
  assert.deepEqual(mapLineRange('@@ -1 +1,2 @@\n-a\n+b\n+c\n@@ -5,0 +7 @@\n+x\n', 4, 5, 8), { start: 3, end: 4, expanded: false, added: false });
});

test('rewrites map to the pre-edit block while new-only selections never borrow neighboring history', () => {
  assert.deepEqual(mapLineRange('@@ -5,3 +5,4 @@\n', 6, 6, 10), { start: 5, end: 7, expanded: true, added: false });
  assert.throws(() => mapLineRange('@@ -2,0 +3,2 @@\n', 3, 4, 6), /新增内容/);
  assert.deepEqual(mapLineRange('@@ -2,0 +3,2 @@\n', 2, 5, 6), { start: 2, end: 3, expanded: false, added: true });
  assert.throws(() => mapLineRange('', 4, 4, 3), /文件末尾/);
});
