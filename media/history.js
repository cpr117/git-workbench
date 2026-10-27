/* global acquireVsCodeApi, GitSelection, GitWorkbenchI18n */
'use strict';
(() => {
  const language = GitWorkbenchI18n.normalizeLocale(window.gitWorkbenchLanguage || 'zh-cn');
  document.documentElement.lang = language;
  const t = GitWorkbenchI18n.createTranslator(language);
  const api = acquireVsCodeApi();
  const saved = api.getState() || {};
  const state = { presentation: 'popup', entries: [], selected: saved.selected, selectedHashes: saved.hashes || [], anchor: saved.selected, detail: null, changesOnly: false, patch: false, change: -1, changedRows: [] };
  const $ = id => document.getElementById(id);
  const send = (type, values = {}) => api.postMessage({ type, ...values });
  const make = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  $('app').innerHTML = `
    <header class="window-header"><div><h1 id="title">${t("选区历史")}</h1><div id="file" class="file-label"></div></div><button id="float" title="${t("切换历史展示方式")}">${t("在标签页中打开")}</button><button id="close" title="${t("关闭历史窗口")}" aria-label="${t("关闭历史窗口")}">×</button></header>
    <div id="mapping" class="mapping-notice" role="status" hidden></div>
    <div id="error" class="error" role="alert" hidden></div>
    <main class="history-shell">
      <aside class="revisions"><div class="revision-tools"><strong>${t("历史版本")}</strong><span id="count"></span></div><input id="search" type="search" placeholder="${t("搜索提交、作者、SHA")}" aria-label="${t("筛选历史版本")}"><div id="list" class="revision-list" role="listbox" aria-multiselectable="true" aria-label="${t("历史提交")}"></div><section class="commit-info"><div id="author"></div><button id="hash" title="${t("复制提交 ID")}"></button><pre id="subject"></pre><button id="open-commit">${t("在提交图查看")}</button></section></aside>
      <section class="comparison" aria-label="${t("版本差异")}">
        <div class="diff-toolbar"><div class="revision-navigation"><button id="newer" title="${t("较新版本")}">↑ ${t("较新")}</button><button id="older" title="${t("较旧版本")}">↓ ${t("较旧")}</button></div><span class="toolbar-divider"></span><button id="previous-change" title="${t("上一个差异")}">‹</button><button id="next-change" title="${t("下一个差异")}">›</button><span id="change-count"></span><div class="toolbar-end"><label><input id="changes-only" type="checkbox">${t("仅显示改动")}</label><button id="mode">${t("原始补丁")}</button></div></div>
        <div class="revision-headings"><div id="left-title">${t("父版本")}</div><div id="right-title">${t("所选版本")}</div></div>
        <div id="comparison-body" class="comparison-body"><div id="left" class="diff-side" tabindex="0" aria-label="${t("修改前代码")}"><div id="left-rows" class="code-rows"></div></div><div class="diff-divider"></div><div id="right" class="diff-side" tabindex="0" aria-label="${t("修改后代码")}"><div id="right-rows" class="code-rows"></div></div></div>
        <pre id="patch" class="raw-patch" hidden></pre><div id="empty" class="empty" hidden>${t("此版本没有可显示的文本差异。")}</div>
      </section>
    </main><footer><span id="status" role="status">${t("读取历史…")}</span><span id="range"></span></footer>`;

  function select(hash, modifiers = {}) {
    const query = $('search').value.trim().toLowerCase();
    const order = state.entries.filter(entry => `${entry.hash} ${entry.author} ${entry.subject}`.toLowerCase().includes(query)).map(entry => entry.hash);
    const selection = GitSelection.choose(order, state.selectedHashes, state.anchor, hash, modifiers);
    state.selected = selection.hashes.includes(hash) ? hash : selection.hashes[0]; state.selectedHashes = selection.hashes; state.anchor = selection.anchor; state.change = -1;
    api.setState({ selected: state.selected, hashes: state.selectedHashes }); renderList();
    [...$('list').children].find(child => child.dataset.hash === hash)?.focus({ preventScroll: true });
    if (state.selectedHashes.length > 1) send('selectMany', { hashes: state.selectedHashes }); else send('select', { hash: state.selectedHashes[0] });
  }
  function renderList() {
    const query = $('search').value.trim().toLowerCase();
    const list = $('list'), scroll = list.scrollTop;
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.hash : undefined;
    list.replaceChildren();
    const visible = state.entries.filter(entry => `${entry.hash} ${entry.author} ${entry.subject}`.toLowerCase().includes(query));
    $('count').textContent = t("{0} / {1} · 已选 {2}", visible.length, state.entries.length, state.selectedHashes.length);
    visible.forEach(entry => {
      const item = make('button', `revision${state.selectedHashes.includes(entry.hash) ? ' selected' : ''}`); item.type = 'button'; item.dataset.hash = entry.hash; item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(state.selectedHashes.includes(entry.hash)));
      item.append(make('span', 'revision-subject', entry.subject));
      const info = make('span', 'revision-meta'); info.append(make('code', '', entry.hash.slice(0, 8)), make('span', 'revision-author', entry.author), make('time', '', entry.date.slice(0, 10))); item.append(info);
      item.title = `${entry.subject}\n${entry.author}\n${entry.hash}`; item.onclick = event => select(entry.hash, event);
      item.onkeydown = event => {
        if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault(); const next = visible[visible.indexOf(entry) + (event.key === 'ArrowDown' ? 1 : -1)];
        if (next) { select(next.hash, event); [...list.children].find(child => child.dataset.hash === next.hash)?.focus(); }
      };
      list.append(item);
    });
    list.scrollTop = scroll;
    if (focused) [...list.children].find(child => child.dataset.hash === focused)?.focus({ preventScroll: true });
    const index = state.entries.findIndex(entry => entry.hash === state.selected);
    $('newer').disabled = index <= 0; $('older').disabled = index < 0 || index >= state.entries.length - 1;
  }
  function codeRow(row, side) {
    const cell = row[side];
    const element = make('div', `code-row ${row.kind}${row.kind === 'change' ? cell ? side === 'left' ? ' removed' : ' added' : ' missing' : ''}`);
    element.dataset.kind = row.kind;
    if (row.kind === 'hunk' || row.kind === 'note') { element.append(make('span', 'hunk-label', row.label)); return element; }
    element.append(make('span', 'line-number', cell ? String(cell.line) : ''), make('span', 'line-content', cell?.text || ' ')); return element;
  }
  function renderDiff() {
    if (!state.detail) return;
    const left = $('left-rows'), right = $('right-rows'); left.replaceChildren(); right.replaceChildren(); state.changedRows = [];
    const rows = state.detail.rows.filter(row => !state.changesOnly || row.kind !== 'context');
    rows.forEach((row, index) => {
      left.append(codeRow(row, 'left')); right.append(codeRow(row, 'right'));
      if (row.kind === 'change' && (index === 0 || rows[index - 1].kind !== 'change')) state.changedRows.push(index);
    });
    $('change-count').textContent = t("{0} 处差异", state.changedRows.length);
    $('empty').hidden = rows.some(row => row.kind === 'change' || row.kind === 'context');
    $('previous-change').disabled = $('next-change').disabled = state.changedRows.length === 0;
    $('left').scrollTop = $('right').scrollTop = 0;
  }
  function jumpChange(direction) {
    if (!state.changedRows.length) return;
    state.change = state.change < 0 ? direction > 0 ? 0 : state.changedRows.length - 1 : (state.change + direction + state.changedRows.length) % state.changedRows.length;
    const row = state.changedRows[state.change];
    $('left').scrollTop = $('right').scrollTop = Math.max(0, row * 22 - 44);
    $('status').textContent = t("差异 {0} / {1}", state.change + 1, state.changedRows.length);
  }
  let syncing = false;
  for (const [source, target] of [['left', 'right'], ['right', 'left']]) $(source).onscroll = () => {
    if (syncing) return; syncing = true; $(target).scrollTop = $(source).scrollTop; $(target).scrollLeft = $(source).scrollLeft; syncing = false;
  };
  $('search').oninput = renderList;
  $('float').onclick = () => send('presentation', { presentation: state.presentation === 'popup' ? 'editor' : 'popup', hashes: state.selectedHashes });
  $('close').onclick = () => send('close');
  $('open-commit').onclick = () => { if (state.selected) send('openCommit', { hash: state.selected }); };
  $('hash').onclick = () => { if (state.selected) send('copy', { hash: state.selected }); };
  $('newer').onclick = () => { const index = state.entries.findIndex(entry => entry.hash === state.selected); if (index > 0) select(state.entries[index - 1].hash); };
  $('older').onclick = () => { const index = state.entries.findIndex(entry => entry.hash === state.selected); if (index >= 0 && index + 1 < state.entries.length) select(state.entries[index + 1].hash); };
  $('changes-only').onchange = () => { state.changesOnly = $('changes-only').checked; state.change = -1; renderDiff(); };
  $('previous-change').onclick = () => jumpChange(-1); $('next-change').onclick = () => jumpChange(1);
  $('mode').onclick = () => { state.patch = !state.patch; $('patch').hidden = !state.patch; $('comparison-body').hidden = state.patch; $('mode').textContent = state.patch ? t("左右对比") : t("原始补丁"); };
  window.addEventListener('message', event => {
    const { type, data } = event.data || {};
    if (type === 'history') {
      state.entries = data.entries; state.presentation = data.presentation;
      $('mapping').textContent = data.range?.notice || ''; $('mapping').hidden = !data.range?.notice;
      $('float').textContent = state.presentation === 'popup' ? t("在标签页中打开") : t("在弹窗中打开");
      $('float').title = t("保留所选提交并切换展示方式；不更改默认设置");
      $('title').textContent = data.range ? t("选区历史 · History for Selection") : t("文件历史 · File History");
      $('file').textContent = data.file; $('file').title = `${data.root}/${data.file}`;
      $('range').textContent = data.range ? t("所选代码：{0}–{1} 行", data.range.start, data.range.end) : t("跟随文件重命名 · 最多 300 条");
      if (!state.selectedHashes.length) state.selectedHashes = [data.entries[0]?.hash].filter(Boolean);
      renderList();
    } else if (type === 'loading') { $('status').textContent = t("读取版本差异…"); $('error').hidden = true; }
    else if (type === 'historyDetail') {
      state.detail = data; state.selectedHashes = data.hashes || [data.hash]; if (!state.selectedHashes.includes(state.selected)) state.selected = data.hash; state.anchor ||= data.hash; state.change = -1; api.setState({ selected: state.selected, hashes: state.selectedHashes }); renderList(); renderDiff();
      $('author').textContent = data.date ? `${data.author} · ${data.date.replace('T', ' ').slice(0, 19)}` : data.author;
      $('hash').textContent = data.hashes ? t("已选 {0} 个提交", data.hashes.length) : data.hash; $('subject').textContent = data.subject;
      $('left-title').textContent = data.comparison ? t("最旧所选提交的父版本 · {0}", data.base.slice(0, 8)) : data.parent ? t("父版本 · {0}", data.parent.slice(0, 8)) : t("初始版本之前 · 空内容");
      $('right-title').textContent = data.comparison ? t("最新所选版本 · {0}", data.target.slice(0, 8)) : t("所选版本 · {0}", data.hash.slice(0, 8));
      $('empty').textContent = data.comparison ? t("此版本区间没有净文本差异。") : t("此版本没有可显示的文本差异。");
      send('rendered');
      $('patch').textContent = data.patch; $('status').textContent = t("Shift 点击连续多选 · ⌘ / Ctrl 点击增减");
    } else if (type === 'error') { $('error').textContent = data; $('error').hidden = false; $('status').textContent = t("读取失败，请重新选择版本"); send('rendered'); }
  });
  send('init', { hash: saved.selected, hashes: saved.hashes });
})();
