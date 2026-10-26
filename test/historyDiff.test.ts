import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { historySnapshot, offsetPatch, selectionDiff } from '../src/historyDiff';

test('history aligns old/new blocks and preserves each revision line number', () => {
  const rows = selectionDiff('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -5,3 +8,4 @@ function\n same\n-old\n+new\n+extra\n tail\n');
  assert.deepEqual(rows, [
    { kind: 'hunk', label: '@@ -5,3 +8,4 @@ function' },
    { kind: 'context', left: { line: 5, text: 'same' }, right: { line: 8, text: 'same' } },
    { kind: 'change', left: { line: 6, text: 'old' }, right: { line: 9, text: 'new' } },
    { kind: 'change', left: undefined, right: { line: 10, text: 'extra' } },
    { kind: 'context', left: { line: 7, text: 'tail' }, right: { line: 11, text: 'tail' } },
  ]);
});

test('root additions, deletions, header-like code and missing newline are preserved', () => {
  const rows = selectionDiff('@@ -0,0 +1,2 @@\n+--- code\n+\t indented\n\\ No newline at end of file\n@@ -10,1 +0,0 @@\n-deleted\n');
  assert.equal(rows[1].right?.text, '--- code');
  assert.equal(rows[2].right?.text, '\t indented');
  assert.equal(rows[3].kind, 'note');
  assert.equal(rows.at(-1)?.left?.line, 10);
  assert.equal(rows.at(-1)?.right, undefined);
});


test('tracked snapshots preserve each side offset, whitespace and newline state', () => {
  const patch = '@@ -5,3 +8,4 @@\n same\n-old  \n+new\n+extra\n tail\n\\ No newline at end of file\n';
  assert.deepEqual(historySnapshot(patch, 'left'), { text: 'same\nold  \ntail', offset: 4 });
  assert.deepEqual(historySnapshot(patch, 'right'), { text: 'same\nnew\nextra\ntail', offset: 7 });
  assert.equal(offsetPatch('@@ -1,3 +1,4 @@\n-old\n+new\n', 4, 7), '@@ -5,3 +8,4 @@\n-old\n+new\n');
});

test('empty snapshots, one-sided newline markers and separated fragments are handled explicitly', () => {
  assert.deepEqual(historySnapshot('@@ -0,0 +5 @@\n+new\n', 'left'), { text: '', offset: 0 });
  assert.deepEqual(historySnapshot('@@ -2 +4 @@\n-old\n\\ No newline at end of file\n+new\n', 'left'), { text: 'old', offset: 1 });
  assert.deepEqual(historySnapshot('@@ -2 +4 @@\n-old\n\\ No newline at end of file\n+new\n', 'right'), { text: 'new\n', offset: 3 });
  assert.equal(offsetPatch('@@ -0,0 +1 @@\n+new\n', 4, 8), '@@ -4,0 +9 @@\n+new\n');
  assert.throws(() => historySnapshot('@@ -1 +1 @@\n-old\n+new\n@@ -8 +8 @@\n-other\n+change\n', 'left'), /分离/);
});
