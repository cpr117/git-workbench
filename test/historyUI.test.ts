import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';

type Input = { key?: string; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; preventDefault?: () => void };
type Message = { type: string; hash?: string; hashes?: string[] };
class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  style = { setProperty() {} };
  value = ''; textContent = ''; className = ''; innerHTML = ''; disabled = false; hidden = false;
  scrollTop = 0; scrollLeft = 0;
  onclick?: (event: Input) => void;
  onkeydown?: (event: Input) => void;
  oninput?: () => void;
  constructor(private readonly document: { activeElement?: Element }) {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  contains(element?: Element): boolean { return this === element || this.children.some(child => child.contains(element)); }
  focus() { this.document.activeElement = this; }
  setAttribute() {}
  getBoundingClientRect() { return { top: 0, height: 20 }; }
}

// Run the shipped UI handlers with a small DOM stand-in; selection and filtering
// still execute media/history.js and media/selection.js rather than test copies.
function fixture() {
  const root = path.resolve(__dirname, '../..');
  const elements = new Map<string, Element>();
  const document = {
    activeElement: undefined as Element | undefined,
    documentElement: { lang: '', dataset: {}, style: { setProperty() {} } },
    getElementById(id: string) { if (!elements.has(id)) elements.set(id, new Element(document)); return elements.get(id)!; },
    createElement() { return new Element(document); },
  };
  const messages: Message[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const window = { gitWorkbenchLanguage: 'en', addEventListener(type: string, listener: (event: unknown) => void) { listeners.set(type, listener); } };
  const api = { getState: () => undefined, setState() {}, postMessage: (message: Message) => messages.push(message) };
  runInNewContext(readFileSync(path.join(root, 'media/history.js'), 'utf8'), {
    window, document, acquireVsCodeApi: () => api,
    GitSelection: require(path.join(root, 'media/selection.js')),
    GitWorkbenchI18n: require(path.join(root, 'media/i18n.js')),
  });
  const entries = ['a', 'b', 'c', 'd', 'e'].map((letter, index) => ({
    hash: letter.repeat(40), subject: `${index % 2 === 0 ? 'keep' : 'hide'} ${letter}`, author: 'Fixture', date: '',
  }));
  const receive = (type: string, data: unknown) => listeners.get('message')!({ data: { type, data } });
  receive('history', { entries, file: 'fixture.txt', root: '/fixture', presentation: 'popup' });
  receive('historyDetail', { hash: entries[2].hash, parent: entries[3].hash, rows: [], patch: '', subject: entries[2].subject, author: 'Fixture', date: '' });
  messages.length = 0;
  const element = (id: string) => document.getElementById(id);
  const search = (query: string) => { element('search').value = query; element('search').oninput!(); };
  const click = (id: string) => element(id).onclick!({});
  return { entries, messages, element, search, click };
}

test('history buttons skip filtered-out revisions and stop at visible endpoints', () => {
  const { entries, messages, element, search, click } = fixture();
  search('keep');
  assert.equal(element('list').children.length, 3);
  assert.equal(element('newer').disabled, false); assert.equal(element('older').disabled, false);
  click('newer');
  assert.equal(messages.at(-1)!.hash, entries[0].hash);
  assert.equal(element('newer').disabled, true);
  click('older'); assert.equal(messages.at(-1)!.hash, entries[2].hash);
  click('older'); assert.equal(messages.at(-1)!.hash, entries[4].hash);
  assert.equal(element('older').disabled, true);
});

test('a single match, no matches or a hidden selection disable history navigation without changing selection', () => {
  const { messages, element, search, click } = fixture();
  for (const query of ['keep c', 'missing', 'hide']) {
    search(query);
    assert.equal(element('newer').disabled, true, query);
    assert.equal(element('older').disabled, true, query);
    click('newer'); click('older');
    assert.equal(messages.length, 0, 'navigation must not select an invisible revision');
  }
  search('');
  assert.equal(element('newer').disabled, false); assert.equal(element('older').disabled, false);
});

test('buttons and keyboard navigation use the same filtered ordering and retain Shift multi-selection', () => {
  const { entries, messages, element, search, click } = fixture();
  search('keep');
  click('newer');
  element('list').children[0].onkeydown!({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(messages.at(-1)!.hash, entries[2].hash);
  element('list').children[1].onkeydown!({ key: 'ArrowDown', shiftKey: true, preventDefault() {} });
  assert.equal(messages.at(-1)!.type, 'selectMany');
  assert.deepEqual(Array.from(messages.at(-1)!.hashes!), [entries[2].hash, entries[4].hash]);
  click('newer');
  assert.equal(messages.at(-1)!.hash, entries[2].hash, 'ordinary navigation returns to a single visible revision');
});
