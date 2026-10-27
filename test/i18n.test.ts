import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
const root = path.resolve(__dirname, '../..');
const catalog = require(path.join(root, 'media/i18n.js')) as {
  messages: Record<string, string>;
  normalizeLocale(language?: string): string;
  createTranslator(language?: string): (key: string, ...values: unknown[]) => string;
};

test('locale matching follows host display language and uses English fallback', () => {
  for (const locale of ['zh', 'zh-cn', 'zh-CN', 'zh_TW', 'zh-Hans']) assert.equal(catalog.normalizeLocale(locale), 'zh-cn');
  for (const locale of ['en', 'en-US', 'fr', 'de', undefined]) {
    assert.equal(catalog.normalizeLocale(locale), 'en');
    assert.equal(catalog.createTranslator(locale)('选择仓库'), 'Select repository');
  }
  assert.equal(catalog.createTranslator('zh-cn')('选择仓库'), '选择仓库');
});

test('translated templates preserve repository content without interpreting nested placeholders', () => {
  const t = catalog.createTranslator('en');
  assert.equal(t('从「{0}」新建分支…', '修复/{1}/<script>'), 'New branch from “修复/{1}/<script>”…');
  for (const [key, translated] of Object.entries(catalog.messages)) {
    assert.ok(translated.length > 0, key);
    assert.equal(/[\u3400-\u9fff]/.test(translated), false, key);
    assert.deepEqual((key.match(/\{\d+\}/g) || []).sort(), (translated.match(/\{\d+\}/g) || []).sort(), key);
  }
});

test('all host and webview UI keys have English translations', () => {
  const files = [...readdirSync(path.join(root, 'src')).filter(file => file.endsWith('.ts')).map(file => 'src/' + file), 'media/history.js', 'media/workbench.js', 'media/logModel.js'];
  let count = 0;
  for (const file of files) {
    const tree = ts.createSourceFile(file, readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        count++; assert.ok(Object.hasOwn(catalog.messages, node.arguments[0].text), `${file}: ${node.arguments[0].text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  assert.ok(count > 400);
});

test('manifest localization covers every contribution key in English and Chinese', () => {
  const raw = readFileSync(path.join(root, 'package.json'), 'utf8');
  const en = JSON.parse(readFileSync(path.join(root, 'package.nls.json'), 'utf8'));
  const zh = JSON.parse(readFileSync(path.join(root, 'package.nls.zh-cn.json'), 'utf8'));
  const manifest = JSON.parse(raw);
  const walk = (value: unknown) => {
    if (typeof value === 'string' && /^%[^%]+%$/.test(value)) {
      const key = value.slice(1, -1); assert.equal(typeof en[key], 'string'); assert.equal(typeof zh[key], 'string');
      assert.equal(/[\u3400-\u9fff]/.test(en[key]), false);
    } else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(manifest);
  assert.equal(en[manifest.contributes.views.scm[0].name.slice(1, -1)], 'Compare');
  assert.equal(zh[manifest.contributes.views.scm[0].name.slice(1, -1)], '对比');
});

test('branch menu translation retains exact repository names and disabled actions', () => {
  const model = require(path.join(root, 'media/logModel.js')) as { branchMenu(ref: object, branch: string, locale?: string): { label?: string; action?: string; disabled?: boolean }[] };
  const ref = { name: '功能/中文', full: 'refs/heads/功能/中文', current: false, remote: false, tag: false };
  const en = model.branchMenu(ref, '当前分支', 'en');
  const zh = model.branchMenu(ref, '当前分支', 'zh-cn');
  assert.equal(en.find(item => item.action === 'create')!.label, 'New branch from “功能/中文”…');
  assert.equal(en.find(item => item.action === 'compare')!.label, 'Compare with current branch “当前分支”');
  assert.deepEqual(en.map(({ action, disabled }) => ({ action, disabled })), zh.map(({ action, disabled }) => ({ action, disabled })));
});
