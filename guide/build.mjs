import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('./', import.meta.url);
const pluginRoot = new URL('../', root);
await rm(new URL('site/', root), { recursive: true, force: true });
await cp(new URL('web/', root), new URL('site/', root), { recursive: true });
await mkdir(new URL('site/assets/plugin/', root), { recursive: true });
for (const name of ['history.js', 'history.css', 'workbench.js', 'workbench.css', 'selection.js', 'logModel.js', 'git.svg']) {
  await cp(new URL(`media/${name}`, pluginRoot), new URL(`site/assets/plugin/${name}`, root));
}
console.log(`Built static guide: ${fileURLToPath(new URL('site/', root))}`);

// Embed trusted, fixed example renderers. The sandbox retains its opaque origin,
// and the demo makes no child-document, script or style requests through the host.
const adapter = await readFile(new URL('web/demo.js', root), 'utf8');
const demoCss = await readFile(new URL('web/demo.css', root), 'utf8');
const selection = await readFile(new URL('media/selection.js', pluginRoot), 'utf8');
const logModel = await readFile(new URL('media/logModel.js', pluginRoot), 'utf8');
const documents = {};
const scriptTag = source => `<script>${source.replace(/<\/script/gi, '<\\/script')}</script>`;
for (const view of ['history', 'graph']) {
  const renderer = view === 'graph' ? 'workbench' : 'history';
  const css = await readFile(new URL(`media/${renderer}.css`, pluginRoot), 'utf8');
  const js = await readFile(new URL(`media/${renderer}.js`, pluginRoot), 'utf8');
  const ready = `queueMicrotask(()=>parent.postMessage({type:document.querySelectorAll('[role="option"]').length===4?'demoReady':'demoFailed'},'*'));`;
  documents[view] = `<!doctype html><html lang="zh-CN" data-bundled-demo data-view="${view}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Git Workbench 交互示例</title><style>${css}\n${demoCss}</style></head><body><div id="app">正在加载交互演示…</div>${scriptTag(adapter)}${scriptTag(selection)}${view === 'graph' ? scriptTag(logModel) : ''}${scriptTag(js)}${scriptTag(ready)}</body></html>`;
}
await writeFile(new URL('site/demo-bundles.js', root), `window.GitWorkbenchDemos=${JSON.stringify(documents).replace(/</g, '\\u003c')};\n`);
