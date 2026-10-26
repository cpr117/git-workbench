import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
type Ref = { name: string; full: string; current?: boolean; remote?: boolean; tag?: boolean };
type BranchNode = { name: string; key: string; ref?: Ref; children: BranchNode[] };
const { branchTree } = require(path.resolve(__dirname, '../../media/logModel.js')) as { branchTree(refs: Ref[], query?: string): BranchNode[] };
const refs: Ref[] = [
  { name: 'main', full: 'refs/heads/main', current: true },
  { name: 'feature/payments', full: 'refs/heads/feature/payments' },
  { name: 'feature/report/daily', full: 'refs/heads/feature/report/daily' },
  { name: 'origin/main', full: 'refs/remotes/origin/main', remote: true },
  { name: 'v1/stable', full: 'refs/tags/v1/stable', tag: true },
];
test('branch paths form independent Local, Remote and Tags hierarchies retaining exact ref targets', () => {
  const tree = branchTree(refs);
  assert.deepEqual(tree.map(node => node.name), ['Local', 'Remote', 'Tags']);
  assert.equal(tree[0].children[0].name, 'feature');
  assert.equal(tree[0].children[0].children[1].ref?.full, 'refs/heads/feature/payments');
  assert.equal(tree[0].children[0].children[0].children[0].ref?.full, 'refs/heads/feature/report/daily');
  assert.equal(tree[0].children[1].ref?.current, true);
  assert.equal(tree[1].children[0].children[0].ref?.full, 'refs/remotes/origin/main');
});
test('branch search retains matching ancestors and treats special property names as ordinary refs', () => {
  const tree = branchTree(refs, 'REPORT/DAILY');
  assert.equal(tree.length, 1); assert.equal(tree[0].children.length, 1);
  assert.equal(tree[0].children[0].children[0].children[0].name, 'daily');
  assert.deepEqual(branchTree(refs, 'missing'), []);
  const special = branchTree([{ name: '__proto__/constructor', full: 'refs/heads/__proto__/constructor' }]);
  assert.equal(special[0].children[0].children[0].ref?.full, 'refs/heads/__proto__/constructor');
});

const { branchMenu } = require(path.resolve(__dirname, '../../media/logModel.js')) as { branchMenu(ref: Ref, current: string): { action?: string; disabled?: boolean; separator?: boolean; label?: string }[] };
test('branch context menu labels directions and gates current remote and tag operations', () => {
  const menu = branchMenu(refs[1], 'main');
  assert.deepEqual(menu.filter(item => item.action).map(item => item.action), ['checkout', 'create', 'checkoutRebase', 'compare', 'workingDiff', 'rebase', 'merge', 'update', 'push', 'rename', 'delete']);
  assert.match(menu.find(item => item.action === 'merge')!.label!, /payments.*main/);
  assert.match(menu.find(item => item.action === 'rebase')!.label!, /main.*payments/);
  const disabled = (ref: Ref, action: string) => branchMenu(ref, 'main').find(item => item.action === action)!.disabled;
  assert.ok(disabled(refs[0], 'checkout')); assert.ok(disabled(refs[0], 'delete'));
  assert.ok(disabled(refs[3], 'rename')); assert.ok(disabled(refs[3], 'update'));
  assert.ok(disabled(refs[4], 'push')); assert.equal(Boolean(disabled(refs[3], 'workingDiff')), false);
});
