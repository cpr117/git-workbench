import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';

type Input = { key?: string; preventDefault(): void };
class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  style = { setProperty() {} };
  classList = { toggle() {}, add() {}, remove() {} };
  attrs = new Map<string, string>();
  value = ''; textContent = ''; className = ''; innerHTML = ''; disabled = false; hidden = false;
  scrollTop = 0; tabIndex = 0;
  onclick?: () => void;
  onkeydown?: (event: Input) => void;
  oncontextmenu?: (event: Input) => void;
  title = "";
  constructor(private readonly document: { activeElement?: Element }) {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  contains(element?: Element): boolean { return this === element || this.children.some(child => child.contains(element)); }
  focus() { this.document.activeElement = this; }
  setAttribute(key: string, value: string) { this.attrs.set(key, value); }
  getAttribute(key: string) { return this.attrs.get(key); }
  addEventListener(type: string, listener: () => void) { if (type === 'click') this.onclick = listener; }
  querySelector() { return undefined; }
}
function fixture(enabled: Record<string, boolean> = {}, savedTab = 'history') {
  const root = path.resolve(__dirname, '../..');
  const elements = new Map<string, Element>();
  const document = {
    activeElement: undefined as Element | undefined,
    documentElement: { lang: '' },
    getElementById(id: string) { if (!elements.has(id)) elements.set(id, new Element(document)); return elements.get(id)!; },
    createElement() { return new Element(document); },
    querySelector(selector: string) { return document.getElementById(selector); },
    addEventListener() {},
  };
  const messages: { type: string }[] = [];
  let listener: (event: unknown) => void;
  const window = { gitWorkbenchLanguage: 'en', gitWorkbenchModules: enabled, addEventListener(_type: string, callback: typeof listener) { listener = callback; } };
  const api = { getState: () => ({ tab: savedTab }), setState() {}, postMessage: (message: { type: string }) => messages.push(message) };
  runInNewContext(readFileSync(path.join(root, 'media/workbench.js'), 'utf8'), {
    window, document, acquireVsCodeApi: () => api,
    GitSelection: require(path.join(root, 'media/selection.js')),
    GitComparisonTree: require(path.join(root, 'media/comparisonTree.js')),
    GitLogModel: require(path.join(root, 'media/logModel.js')),
    GitWorkbenchI18n: require(path.join(root, 'media/i18n.js')),
  });
  return { element: document.getElementById, messages, receive: (type: string, data: unknown) => listener({ data: { type, data } }) };
}

test('disabled tab cannot be restored from saved state or reached by keyboard or stale click', () => {
  const { element } = fixture({ graph: false }, 'history');
  assert.equal(element('history-tab').hidden, true); assert.equal(element('history-view').hidden, true);
  assert.equal(element('stash-view').hidden, false); assert.equal(element('stash-tab').tabIndex, 0);
  element('history-tab').onclick!(); assert.equal(element('history-view').hidden, true);
  for (const key of ['Home', 'End', 'ArrowLeft', 'ArrowRight']) element('.tabs').onkeydown!({ key, preventDefault() {} });
  assert.equal(element('history-view').hidden, true); assert.equal(element('stash-view').hidden, false);
});

test('live module changes update write controls and tab fallback, with an always available settings button', () => {
  const { element, receive, messages } = fixture();
  receive('modules', { operations: false, stash: false });
  for (const id of ['operations', 'new-branch', 'stash-create', 'continue', 'abort', 'stash-tab']) assert.equal(element(id).hidden, true, id);
  assert.equal(element('history-view').hidden, false);
  receive('operating', false); assert.equal(element('stash-create').hidden, true);
  receive('modules', { graph: false });
  assert.equal(element('history-view').hidden, true); assert.equal(element('stash-view').hidden, true); assert.equal(element('modules-empty').hidden, false);
  element('modules').onclick!(); assert.equal(messages.at(-1)!.type, 'modules');
  receive('modules', { stash: true, operations: true });
  assert.equal(element('stash-view').hidden, false); assert.equal(element('operations').hidden, false); assert.equal(element('modules-empty').hidden, true);
});

test('turning off writes removes restore and commit actions from an already displayed commit', () => {
  const { element, receive } = fixture();
  receive('detail', { commit: { subject: 'Fixture', author: 'Test', date: '', parents: [] }, message: 'Fixture', target: 'a'.repeat(40), files: [{ path: 'a.txt', status: 'M' }] });
  assert.equal(element('changed-files').children[1].children.length, 2);
  receive('modules', { operations: false });
  assert.equal(element('changed-files').children[1].children.length, 1, 'native diff remains, restore is removed');
  const body = element('commit-detail').children[1];
  assert.equal(body.children.find(node => node.className === 'detail-toolbar')!.children.length, 0);
});


test('branch menus retain read-only comparisons and do not show empty menus or leftover separators', () => {
  const { element, receive } = fixture();
  receive('snapshot', { root: '/fixture', refs: [{ full: 'refs/heads/other', name: 'other', current: false, tag: false, remote: false }], commits: [], graph: [], filters: {}, state: { branch: 'main' }, stashes: [] });
  const find = (node: Element): Element | undefined => node.title === 'refs/heads/other' ? node : node.children.map(find).find(Boolean);
  const row = find(element('refs'))!;
  receive('modules', { operations: false });
  row.oncontextmenu!({ preventDefault() {} });
  const menu = element('context-menu');
  assert.equal(menu.hidden, false);
  assert.equal(menu.children.length, 2);
  assert.ok(menu.children.every(child => child.textContent.includes('Compare') || child.textContent.includes('Diff')));
  receive('modules', { comparison: false });
  row.oncontextmenu!({ preventDefault() {} });
  assert.equal(menu.children.length, 0); assert.equal(menu.hidden, true);
});
