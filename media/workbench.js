/* global acquireVsCodeApi, GitSelection, GitLogModel, GitComparisonTree, GitWorkbenchI18n */
'use strict';
(() => {
  const language = GitWorkbenchI18n.normalizeLocale(window.gitWorkbenchLanguage || 'zh-cn');
  document.documentElement.lang = language;
  const t = GitWorkbenchI18n.createTranslator(language);
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  let modules = { graph: true, stash: true, selectionHistory: true, fileHistory: true, blame: true, editorMenu: true, statusBar: true, comparison: true, explorerMenu: true, operations: true, ...window.gitWorkbenchModules };
  const availableTabs = () => ['history', 'stash'].filter(tab => modules[tab === 'history' ? 'graph' : 'stash']);
  const state = { snapshot: null, detail: null, selected: saved.selected, compared: saved.hashes || [], anchor: saved.selected, tab: ['history', 'stash'].includes(saved.tab) ? saved.tab : 'history', loading: false, operating: false, collapsed: new Set(saved.collapsed || []), panes: saved.panes || {}, stashSelected: saved.stashSelected, stashRoot: saved.stashRoot, stashDetail: null, stashFile: null, stashPendingDiff: null, stashCollapsed: new Set() };
  const palette = ['#7c9cff', '#61c6a7', '#d49bed', '#e6b86a', '#77c4dd', '#e58c9c', '#a9c77a'];
  const svgNS = 'http://www.w3.org/2000/svg';
  const $ = id => document.getElementById(id);
  const send = (type, data = {}) => vscode.postMessage({ type, repoRoot: state.snapshot?.root, ...data });
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (text, onClick, className = '') => {
    const node = make('button', className, text); node.type = 'button'; node.addEventListener('click', onClick); return node;
  };
  const persist = () => vscode.setState({ selected: state.selected, hashes: state.compared, tab: state.tab, collapsed: [...state.collapsed], panes: state.panes, stashSelected: state.stashSelected, stashRoot: state.stashRoot });
  const shorten = hash => (hash || '').slice(0, 8);
  $('app').innerHTML = `
    <header class="topbar">
      <strong class="git-label">Git</strong>
      <nav class="tabs" aria-label="${t("Git 视图")}"><button id="history-tab" role="tab">Log: ${t("全部分支")}</button><button id="stash-tab" role="tab">Stash <span id="stash-count">0</span></button></nav>
      <button id="open-changes" title="${t("打开源代码管理中的更改")}">${t("更改")} ↗</button><button id="repo" class="repo" title="${t("切换仓库")}">${t("选择仓库")}</button><span id="branch-state"></span>
      <div class="top-actions"><button id="modules" title="${t("功能开关")}">⚙</button><span id="busy" role="status"></span><button id="continue" hidden>${t("继续操作")}</button><button id="abort" hidden>${t("中止")}</button><button id="refresh" title="${t("刷新")}">↻</button><button id="operations" title="${t("仓库 Git 操作")}">${t("仓库 Git 操作 ▾")}</button></div>
    </header>
    <div id="notice" class="notice" role="alert" hidden><span id="notice-text"></span><button id="dismiss" aria-label="${t("关闭提示")}">×</button></div>
    <main id="history-view" class="history-layout">
      <aside class="branches" aria-label="${t("分支与标签")}"><div class="branch-search"><input id="branch-search" type="search" placeholder="${t("分支或标签")}" aria-label="${t("搜索分支或标签")}"><button id="new-branch" title="${t("从选中提交或 HEAD 创建分支")}">＋</button></div><div id="refs"></div></aside>
      <div id="left-split" class="splitter" role="separator" tabindex="0" aria-label="${t("调整分支目录宽度")}" aria-orientation="vertical"></div>
      <section class="commit-pane" aria-label="${t("提交图")}">
        <form id="filters" class="filters">
          <input id="search" placeholder="${t("搜索提交信息")}" aria-label="${t("搜索提交信息")}">
          <button type="button" id="filter-toggle" title="${t("按作者、日期、路径筛选")}">${t("作者 · 日期 · 路径 ▾")}</button><button type="submit" title="${t("应用筛选")}">${t("搜索")}</button>
          <div id="advanced" class="advanced" hidden><input id="author" placeholder="${t("作者（Git 正则）")}" aria-label="${t("作者")}"><input id="path" placeholder="${t("路径，如 src/main.go")}" aria-label="${t("文件或目录路径")}"><label>${t("起始")} <input id="since" type="date"></label><label>${t("截止")} <input id="until" type="date"></label></div>
        </form>
        <div class="list-heading"><span id="history-count">${t("等待加载")}</span><button id="compare" hidden>${t("仅比两个快照")}</button><button id="clear-filters">${t("清除筛选")}</button></div>
        <div id="commits" class="commits" role="listbox" aria-multiselectable="true" aria-label="${t("提交列表")}"></div>
        <div class="list-footer"><button id="more">${t("加载更多")}</button><span id="limit-note"></span></div>
      </section>
      <div id="right-split" class="splitter" role="separator" tabindex="0" aria-label="${t("调整变更详情宽度")}" aria-orientation="vertical"></div>
      <aside class="details" id="details" aria-label="${t("提交变更与详情")}">
        <section id="changed-files" class="files-pane" aria-label="${t("变更文件")}"><div class="empty-list">${t("选择提交以查看变更文件")}</div></section>
        <div id="detail-split" class="splitter horizontal" role="separator" tabindex="0" aria-label="${t("调整文件与详情高度")}" aria-orientation="horizontal"></div>
        <section id="commit-detail" class="info-pane" aria-label="${t("提交详情")}"><div class="empty-list">${t("提交详情")}</div></section>
      </aside>
    </main>
    <main id="stash-view" class="stash-layout" hidden>
      <section class="stash-list-pane"><div class="stash-toolbar"><strong>Stash</strong><button id="stash-create">${t("新建 Stash…")}</button></div><div id="stash-list" role="listbox" aria-label="${t("Stash 列表")}"></div></section>
      <section class="stash-files-pane"><div class="stash-toolbar"><strong id="stash-heading">${t("选择 Stash 查看文件")}</strong><div id="stash-actions"></div></div><div id="stash-info"></div><div class="stash-toolbar"><input id="stash-search" type="search" placeholder="${t("筛选文件路径")}" aria-label="${t("筛选文件路径")}"><button id="stash-expand">${t("全部展开")}</button><button id="stash-collapse">${t("全部折叠")}</button></div><div id="stash-files"></div></section>
    </main>
    <main id="modules-empty" hidden><p>${t("提交树和 Stash 均已停用，请在 Orbit Git → 功能开关中启用。")}</p></main>
    <footer class="footer"><span id="root-path">${t("本地 Git · 数据不上传")}</span><span id="footer-hint">Shift ${t("多选 · 右键提交操作")}</span></footer>
    <div id="context-menu" class="context-menu" role="menu" hidden></div>`;

  function setTab(tab) {
    if (!availableTabs().includes(tab)) tab = availableTabs()[0];
    $('modules-empty').hidden = Boolean(tab);
    state.tab = tab; persist();
    const hints = { history: 'Shift ' + t('多选 · 右键提交操作'), stash: t('选择 Stash 查看文件') };
    $('footer-hint').textContent = hints[tab] || '';
    $('context-menu').hidden = true;
    $('history-view').hidden = tab !== 'history';
    $('history-tab').setAttribute('aria-selected', String(tab === 'history'));
    $('stash-view').hidden = tab !== 'stash';
    $('stash-tab').setAttribute('aria-selected', String(tab === 'stash'));
    if (tab === 'stash' && state.snapshot) {
      send('stashRefresh');
      if (state.stashSelected && !state.stashDetail) stashMessage('stashSelect', state.stashSelected);
    }
    for (const name of ['history', 'stash']) $(name + '-tab').tabIndex = name === tab ? 0 : -1;
  }
  $('modules').onclick = () => send('modules');
  $('history-tab').onclick = () => setTab('history');
  $('open-changes').onclick = () => send('scm');
  $('stash-tab').onclick = () => setTab('stash');
  document.querySelector('.tabs').setAttribute('role', 'tablist');
  document.querySelector('.tabs').onkeydown = event => {
    const names = availableTabs();
    if (!names.length) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    let index = names.indexOf(state.tab);
    if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = names.length - 1;
    else index = (index + (event.key === 'ArrowRight' ? 1 : -1) + names.length) % names.length;
    setTab(names[index]); $(names[index] + '-tab').focus();
  };
  $('stash-create').onclick = () => send('action', { action: 'stash' });
  $('stash-search').oninput = renderStashFiles;
  $('stash-expand').onclick = () => { state.stashCollapsed.clear(); renderStashFiles(); };
  $('stash-collapse').onclick = () => { document.querySelectorAll('#stash-files details').forEach(node => state.stashCollapsed.add(node.dataset.path)); renderStashFiles(); };
  $('repo').onclick = () => send('repo');
  $('refresh').onclick = () => send('refresh');
  $('operations').onclick = () => send('menu', { hash: state.selected });
  $('new-branch').onclick = () => send('action', { action: 'branchCreate', hash: state.selected });
  $('continue').onclick = () => send('action', { action: 'continue' });
  $('abort').onclick = () => send('action', { action: 'abort' });
  $('dismiss').onclick = () => { $('notice').hidden = true; };
  $('branch-search').oninput = renderRefs;
  $('filter-toggle').onclick = () => { $('advanced').hidden = !$('advanced').hidden; };
  const filters = () => ({ ...(state.snapshot?.filters || {}), search: $('search').value, author: $('author').value, path: $('path').value, since: $('since').value, until: $('until').value, limit: 200 });
  $('filters').onsubmit = event => { event.preventDefault(); send('filters', { filters: filters() }); };
  $('clear-filters').onclick = () => send('filters', { filters: { limit: 200 } });
  $('more').onclick = () => send('filters', { filters: { ...state.snapshot.filters, limit: Math.min(5000, (state.snapshot.filters.limit || 200) + 200) } });
  $('compare').onclick = () => { if (state.compared.length === 2) send('compare', { base: state.snapshot.commits.filter(commit => state.compared.includes(commit.hash)).at(-1).hash, target: state.snapshot.commits.find(commit => state.compared.includes(commit.hash)).hash }); };

  function select(hash) {
    state.selected = hash; state.anchor = hash; state.compared = [hash]; persist();
    renderCommits(); send('select', { hash });
  }
  function graphSvg(row, index, width) {
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} 26`); svg.setAttribute('width', String(width)); svg.setAttribute('height', '26'); svg.setAttribute('aria-hidden', 'true');
    const x = lane => 12 + lane * 14;
    const draw = (d, lane) => { const p = document.createElementNS(svgNS, 'path'); p.setAttribute('d', d); p.setAttribute('stroke', palette[lane % palette.length]); p.setAttribute('fill', 'none'); p.setAttribute('stroke-width', '1.3'); svg.append(p); };
    const previous = index ? state.snapshot.graph[index - 1].after : [];
    row.before.forEach((hash, lane) => { if (lane !== row.lane || previous.includes(hash)) draw(`M ${x(lane)} 0 V 13`, row.beforeColors[lane]); });
    row.edges.forEach(edge => draw(edge.from === edge.to ? `M ${x(edge.from)} 13 V 26` : `M ${x(edge.from)} 13 C ${x(edge.from)} 20 ${x(edge.to)} 18 ${x(edge.to)} 26`, edge.color));
    if (row.hiddenParents) { draw(`M ${x(row.lane)} 17 V 24`, row.color); svg.lastChild.setAttribute('stroke-dasharray', '2 2'); }
    const circle = document.createElementNS(svgNS, 'circle'); circle.setAttribute('cx', String(x(row.lane))); circle.setAttribute('cy', '13'); circle.setAttribute('r', '3'); circle.setAttribute('fill', palette[row.color % palette.length]); svg.append(circle);
    return svg;
  }
  function renderCommits() {
    if (!state.snapshot) return;
    const { commits, graph, filters: filter } = state.snapshot;
    const list = $('commits'); const scroll = list.scrollTop;
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.hash : undefined;
    list.replaceChildren();
    const width = Math.max(36, ...graph.map(row => (Math.max(row.before.length, row.after.length) + 1) * 14));
    if (!commits.length) list.append(make('div', 'empty-list', t("没有匹配的提交。新仓库可先到工作区暂存并提交文件。")));
    commits.forEach((commit, index) => {
      const row = make('button', 'commit-row'); row.type = 'button'; row.setAttribute('role', 'option'); row.dataset.hash = commit.hash; row.setAttribute('aria-selected', String(state.compared.includes(commit.hash)));
      row.style.setProperty('--graph-width', `${width}px`);
      row.title = `${commit.subject}\n${commit.hash}\n${commit.author}`;
      if (state.compared.includes(commit.hash)) row.classList.add('selected');
      row.append(graphSvg(graph[index], index, width));
      const subject = make('span', 'subject');
      subject.append(make('span', 'subject-text', commit.subject));
      const refs = make('span', 'commit-refs');
      if (commit.refs) { const badge = make('span', 'ref-badge', commit.refs.replace(/refs\/(heads|remotes|tags)\//g, '')); badge.title = commit.refs; refs.append(badge); }
      const date = make('time', 'date', commit.date.slice(0, 16).replace('T', ' ')); date.dateTime = commit.date; date.title = commit.date;
      row.append(subject, refs, make('span', 'author', commit.author), date);
      row.onclick = event => {
        const selection = GitSelection.choose(commits.map(item => item.hash), state.compared, state.anchor, commit.hash, event);
        state.selected = selection.hashes.includes(commit.hash) ? commit.hash : selection.hashes[0]; state.compared = selection.hashes; state.anchor = selection.anchor; persist(); renderCommits();
        [...list.children].find(child => child.dataset.hash === commit.hash)?.focus({ preventScroll: true });
        if (state.compared.length > 1) send('selectMany', { hashes: state.compared }); else send('select', { hash: state.compared[0] });
      };
      row.onkeydown = event => {
        if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const next = commits[index + (event.key === 'ArrowDown' ? 1 : -1)];
        if (next) { const target = [...$('commits').children].find(child => child.dataset.hash === next.hash); target?.onclick(event); [...$('commits').children].find(child => child.dataset.hash === next.hash)?.focus(); }
      };
      row.oncontextmenu = event => { event.preventDefault(); select(commit.hash); contextMenu(event, commit.hash); };
      list.append(row);
    });
    list.scrollTop = scroll;
    if (focused) [...list.children].find(child => child.dataset.hash === focused)?.focus({ preventScroll: true });
    $('history-count').textContent = t("{0} 条提交 · 已选 {1}{2}", commits.length, state.compared.length, filter.ref ? ' · ' + filter.ref.replace(/^refs\/(heads|remotes|tags)\//, '') : t(" · 全部分支"));
    $('compare').hidden = state.compared.length !== 2;
    $('more').hidden = commits.length < (filter.limit || 200) || (filter.limit || 200) >= 5000;
    $('limit-note').textContent = (filter.limit || 200) >= 5000 ? t("已显示最多 5,000 条，请使用筛选缩小范围") : t("按拓扑顺序 · 按需加载");
  }
  function renderRefs() {
    if (!state.snapshot) return;
    const { refs, filters: filter } = state.snapshot;
    const container = $('refs'); const scroll = container.scrollTop; container.replaceChildren();
    const entry = (parent, label, ref, icon, current = false) => {
      const item = button('', () => send('filters', { filters: { ...filters(), ref, limit: 200 } }), 'branch-item');
      item.append(make('span', 'branch-icon', icon), make('span', 'branch-name', label));
      if (current) { item.classList.add('current'); item.title = t("当前检出分支 · ") + ref; }
      else item.title = ref || t("显示全部引用");
      const target = refs.find(value => value.full === ref) || (ref === 'HEAD' ? refs.find(value => value.current) : undefined);
      if (target) {
        item.setAttribute('aria-haspopup', 'menu');
        item.oncontextmenu = event => { event.preventDefault(); branchMenu(event, target); };
        item.onkeydown = event => {
          if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
            event.preventDefault(); const rect = item.getBoundingClientRect();
            branchMenu({ clientX: rect.left, clientY: rect.bottom }, target);
          }
        };
      }
      if ((filter.ref || '') === ref) item.classList.add('active'); parent.append(item);
    };
    entry(container, t("HEAD（当前分支）"), 'HEAD', '◉');
    entry(container, t("全部分支"), '', '⑂');
    const searching = Boolean($('branch-search').value.trim());
    function folder(parent, node, group = false) {
      if (node.ref) { entry(parent, node.name, node.ref.full, node.ref.current ? '★' : node.ref.tag ? '◇' : '⑂', node.ref.current); return; }
      const details = make('details', group ? 'ref-root' : 'ref-folder'); details.open = searching || !state.collapsed.has(node.key);
      const summary = make('summary'); summary.append(make('span', 'branch-icon', group ? '' : '▱'), make('span', '', node.name)); details.append(summary);
      const children = make('div', 'ref-children'); node.children.forEach(child => folder(children, child)); details.append(children);
      details.addEventListener('toggle', () => {
        if (searching || !details.isConnected) return;
        if (details.open) state.collapsed.delete(node.key); else state.collapsed.add(node.key); persist();
      }); parent.append(details);
    }
    const groups = GitLogModel.branchTree(refs, $('branch-search').value);
    groups.forEach(group => folder(container, group, true));
    if (!groups.length && searching) container.append(make('div', 'no-refs', t("没有匹配的分支或标签")));
    container.scrollTop = scroll;
  }
  function clearDetail() {
    $('changed-files').replaceChildren(make('div', 'empty-list', t("选择提交以查看变更文件")));
    $('commit-detail').replaceChildren(make('div', 'empty-list', t("提交详情")));
  }
  function renderDetail(data) {
    state.detail = data;
    if (!data.compare && data.target) { state.selected = data.target; state.anchor = data.target; state.compared = [data.target]; persist(); renderCommits(); }
    const panel = $('commit-detail'); panel.replaceChildren();
    const files = $('changed-files'); files.replaceChildren();
    const heading = make('div', 'section-title', data.aggregate ? t("多提交改动") : data.compare ? t("版本比较") : t("提交详情")); panel.append(heading);
    const body = make('div', 'detail-body');
    body.append(make('h2', 'commit-title', data.commit?.subject || data.message));
    if (data.commit) {
      body.append(make('p', 'meta', `${data.commit.author} · ${data.commit.date.slice(0, 16).replace('T', ' ')}`));
      body.append(button(data.target, () => send('copy', { hash: data.target }), 'full-hash'));
      const toolbar = make('div', 'detail-toolbar'); if (modules.operations) toolbar.append(button(t("操作此提交 ▾"), () => send('menu', { hash: data.target }))); body.append(toolbar);
      if (data.commit.parents.length > 1) {
        const label = make('label', 'parent-label', t("比较父提交 ")); const select = make('select');
        data.commit.parents.forEach((parent, index) => { const option = make('option', '', `${index + 1} · ${shorten(parent)}`); option.value = parent; option.selected = parent === data.base; select.append(option); });
        select.onchange = () => send('select', { hash: data.target, parent: select.value }); label.append(select); body.append(label);
      }
      body.append(make('pre', 'commit-message', data.message));
    }
    if (data.aggregate) body.append(make('p', 'meta', t("基准 {0} → {1} · 包含最旧所选提交和区间内的中间修改；互相抵消的修改不计入净改动。", shorten(data.base), shorten(data.target))));
    files.append(make('div', 'section-title', t("{0} 个变更文件 · 点击打开 Diff", data.files.length)));
    if (!data.files.length) files.append(make('p', 'meta', t("此版本比较没有文件变化。")));
    data.files.forEach(file => {
      const entry = make('div', 'changed-file');
      const diff = button('', () => send('diff', { path: file.path, commitHash: file.commitHash }), 'file-diff');
      diff.append(make('span', `file-status status-${file.status[0]}`, file.status[0]), make('span', 'file-path', file.commitHash ? `${shorten(file.commitHash)} · ${file.path}` : file.path));
      diff.title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
      entry.append(diff);
      if (!data.aggregate && modules.operations) { const restore = button('↶', () => send('restore', { path: file.path }), 'restore-file'); restore.title = t("恢复工作区文件为此版本"); entry.append(restore); }
      files.append(entry);
    }); panel.append(body);
  }
  const sameStash = (a, b) => a && b && a.ref === b.ref && a.hash === b.hash;
  function stashMessage(type, entry, extra = {}) {
    if (!state.snapshot) return;
    send(type, { ref: entry.ref, hash: entry.hash, token: state.snapshot.stashToken, ...extra });
  }
  function selectStash(entry) {
    state.stashSelected = { ref: entry.ref, hash: entry.hash }; state.stashRoot = state.snapshot.root;
    state.stashDetail = null; state.stashFile = null; state.stashPendingDiff = null; persist();
    renderStashes(); renderStashFiles(); $('stash-list').querySelector('[aria-selected=true]')?.focus(); stashMessage('stashSelect', entry);
  }
  function showStashDiff(entry, newTab) {
    if (!sameStash(state.stashDetail?.stash, entry)) selectStash(entry);
    if (sameStash(state.stashDetail?.stash, entry)) {
      const file = state.stashDetail.files.find(item => item.id === state.stashFile) || state.stashDetail.files[0];
      if (file) stashMessage('stashDiff', entry, { fileId: file.id, newTab });
    } else state.stashPendingDiff = { newTab };
  }
  function stashMenu(event, entry, file) {
    const menu = $('context-menu'); menu.replaceChildren();
    const actions = file || !modules.operations ? [] : [[t('恢复并删除 Stash'), 'pop'], [t('应用 Stash'), 'apply'], ['Unstash…', 'unstash'], [t('删除 Stash'), 'drop']];
    for (const [label, action] of actions) {
      const item = button(label, () => { menu.hidden = true; stashMessage('stashAction', entry, { action }); });
      item.disabled = state.operating; item.setAttribute('role', 'menuitem');
      if (action === 'drop') item.classList.add('danger-text');
      menu.append(item);
    }
    if (actions.length) menu.append(make('hr'));
    for (const [label, newTab] of [[t('显示差异'), false], [t('在新标签页显示差异'), true]]) {
      const item = button(label, () => { menu.hidden = true; if (file) stashMessage('stashDiff', entry, { fileId: file.id, newTab }); else showStashDiff(entry, newTab); });
      item.setAttribute('role', 'menuitem'); menu.append(item);
    }
    positionMenu(event);
  }
  function renderStashes() {
    const list = $('stash-list'); list.replaceChildren();
    const entries = state.snapshot?.stashes || [];
    $('stash-count').textContent = String(entries.length);
    if (!entries.length) list.append(make('p', 'empty-list', t('没有 Stash。')));
    entries.forEach((entry, index) => {
      const row = button('', () => selectStash(entry), 'stash-entry');
      row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(sameStash(entry, state.stashSelected)));
      row.append(make('strong', 'stash-subject', entry.subject), make('span', 'stash-meta', `${entry.ref} · ${entry.hash.slice(0, 8)} · ${entry.date.slice(0, 10)}`));
      row.title = `${entry.subject}\n${entry.ref} · ${entry.hash}\n${entry.date}`;
      row.oncontextmenu = event => { event.preventDefault(); if (!sameStash(entry, state.stashSelected)) selectStash(entry); stashMenu(event, entry); };
      row.onkeydown = event => {
        if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          let next = index + (event.key === 'ArrowUp' ? -1 : 1);
          if (event.key === 'Home') next = 0;
          if (event.key === 'End') next = entries.length - 1;
          next = Math.max(0, Math.min(entries.length - 1, next));
          selectStash(entries[next]); $('stash-list').children[next]?.focus();
        } else if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
          event.preventDefault(); const box = row.getBoundingClientRect(); stashMenu({ clientX: box.left, clientY: box.bottom }, entry);
        }
      };
      list.append(row);
    });
  }
  function renderStashFiles() {
    const container = $('stash-files'), actions = $('stash-actions'), detail = state.stashDetail;
    container.replaceChildren(); actions.replaceChildren();
    $('stash-heading').textContent = detail ? `${detail.stash.ref} · ${t('{0} 个文件', detail.files.length)}` : t('选择 Stash 查看文件');
    $('stash-info').textContent = detail ? detail.stash.subject : '';
    $('stash-info').title = detail?.stash.subject || '';
    if (!detail) { container.append(make('p', 'empty-list', state.stashSelected ? t('加载中…') : t('选择 Stash 查看文件'))); return; }
    for (const [label, action] of (modules.operations ? [[t('应用 Stash'), 'apply'], [t('恢复并删除 Stash'), 'pop'], ['Unstash…', 'unstash'], [t('删除 Stash'), 'drop']] : [])) {
      const item = button(label, () => stashMessage('stashAction', detail.stash, { action }));
      item.disabled = state.operating; actions.append(item);
    }
    const query = $('stash-search').value.trim();
    const tree = GitComparisonTree.build(detail.files, '', query);
    function append(parent, node) {
      if (node.file) {
        const file = node.file;
        const row = button('', () => { state.stashFile = file.id; container.querySelector('.selected')?.classList.remove('selected'); row.classList.add('selected'); stashMessage('stashDiff', detail.stash, { fileId: file.id }); }, 'stash-file');
        row.classList.toggle('selected', state.stashFile === file.id);
        row.append(make('span', 'file-path', node.name));
        if (file.source !== 'worktree') row.append(make('span', 'stash-source', file.source === 'index' ? t('暂存区') : t('未跟踪')));
        row.append(make('code', `file-status status-${file.status[0]}`, file.status));
        row.title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
        row.oncontextmenu = event => { event.preventDefault(); stashMenu(event, detail.stash, file); };
        row.onkeydown = event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); const box = row.getBoundingClientRect(); stashMenu({ clientX: box.left, clientY: box.bottom }, detail.stash, file); } };
        parent.append(row); return;
      }
      const folder = make('details', 'stash-folder'); folder.dataset.path = node.path; folder.open = Boolean(query) || !state.stashCollapsed.has(node.path);
      const summary = make('summary', '', node.name); summary.title = node.path;
      summary.onkeydown = event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); folder.open = event.key === 'ArrowRight'; } };
      folder.ontoggle = () => { if (query) return; if (folder.open) state.stashCollapsed.delete(node.path); else state.stashCollapsed.add(node.path); };
      const children = make('div', 'stash-children'); node.children.forEach(child => append(children, child)); folder.append(summary, children); parent.append(folder);
    }
    tree.children.forEach(node => append(container, node));
    if (!tree.children.length) container.append(make('p', 'empty-list', t('无变更')));
  }

  function contextMenu(event, hash) {
    const menu = $('context-menu'); menu.replaceChildren();
    const items = [
      [t("复制提交 ID"), null], [t("从此提交创建分支"), 'branchCreate'], [t("创建标签"), 'tagCreate'], [t("检出此提交"), 'checkout'],
      ['Cherry-pick', 'cherryPick'], ['Revert', 'revert'], [t("合并到当前分支"), 'merge'], [t("当前分支变基到这里"), 'rebase'], [t("Reset 到这里…"), 'reset']
    ];
    items.filter(([, action]) => !action || modules.operations).forEach(([label, action]) => {
      const item = button(label, () => { menu.hidden = true; if (action) send('action', { action, hash }); else send('copy', { hash }); });
      item.setAttribute('role', 'menuitem'); if (action === 'reset') item.classList.add('danger-text'); menu.append(item);
    });
    positionMenu(event);
  }
  function branchMenu(event, ref) {
    const menu = $('context-menu'); menu.replaceChildren();
    let separator = false;
    GitLogModel.branchMenu(ref, state.snapshot.state.branch, window.gitWorkbenchLanguage || 'zh-cn').filter(spec => spec.separator || (['compare', 'workingDiff'].includes(spec.action) ? modules.comparison : modules.operations)).forEach(spec => {
      if (spec.separator) { separator = true; return; }
      if (separator && menu.children.length) { const line = make('hr'); line.setAttribute('role', 'separator'); menu.append(line); }
      separator = false;
      const item = button(spec.label, () => { menu.hidden = true; send('branchAction', { action: spec.action, ref: ref.full }); });
      item.disabled = Boolean(spec.disabled || state.operating);
      item.setAttribute('role', 'menuitem');
      if (spec.action === 'delete') item.classList.add('danger-text');
      menu.append(item);
    });
    if (menu.children.length) positionMenu(event);
  }
  function positionMenu(event) {
    const menu = $('context-menu'); menu.hidden = false;
    menu.style.left = `${Math.max(4, Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 4))}px`;
    menu.querySelector('button:not(:disabled)')?.focus();
  }
  document.addEventListener('click', event => { if (!$('context-menu').contains(event.target)) $('context-menu').hidden = true; });
  document.addEventListener('keydown', event => {
    const menu = $('context-menu');
    if (event.key === 'Escape') menu.hidden = true;
    if (!menu.hidden && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault(); const items = [...menu.querySelectorAll('button:not(:disabled)')];
      const index = items.indexOf(document.activeElement), step = event.key === 'ArrowDown' ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) send('refresh'); });
  function updateStashes(entries, token) {
    const previous = state.stashRoot === state.snapshot.root ? state.stashSelected : null;
    state.snapshot.stashes = entries; state.snapshot.stashToken = token;
    state.stashDetail = null; state.stashPendingDiff = null;
    state.stashSelected = entries.find(entry => sameStash(entry, previous)) || entries.find(entry => entry.hash === previous?.hash) || entries[0];
    state.stashRoot = state.snapshot.root;
    renderStashes(); renderStashFiles(); persist();
    if (state.stashSelected && state.tab === 'stash') stashMessage('stashSelect', state.stashSelected);
  }
  function applyModules(data) {
    modules = { ...modules, ...data };
    $('history-tab').hidden = !modules.graph; $('stash-tab').hidden = !modules.stash;
    for (const id of ['operations', 'new-branch', 'stash-create']) $(id).hidden = !modules.operations;
    $('continue').hidden = $('abort').hidden = !modules.operations || !state.snapshot?.state.operation;
    if (!modules.graph) { state.detail = null; state.selected = undefined; state.compared = []; clearDetail(); }
    if (!modules.stash) { state.stashDetail = null; state.stashSelected = undefined; state.stashPendingDiff = null; }
    if (state.detail) renderDetail(state.detail);
    renderStashFiles(); setTab(state.tab);
  }
  function busy() { $('busy').textContent = state.operating ? t("Git 操作中…") : state.loading ? t("加载中…") : ''; $('app').classList.toggle('operating', state.operating); }
  window.addEventListener('message', event => {
    const { type, data } = event.data || {};
    if (type === 'modules') { applyModules(data); }
    else if (type === 'reset') {
      $('context-menu').hidden = true;
      state.snapshot = null; state.detail = null; state.selected = undefined; state.compared = []; state.stashSelected = undefined; state.stashDetail = null; state.stashPendingDiff = null; state.stashCollapsed.clear(); renderStashes(); renderStashFiles(); persist();
      $('commits').replaceChildren(); $('refs').replaceChildren(); clearDetail();
    } else if (type === 'snapshot') {
      $('context-menu').hidden = true;
      state.snapshot = data;
      $('repo').textContent = data.root.split(/[\\/]/).pop(); $('repo').title = data.root;
      $('history-tab').textContent = 'Log: ' + (data.filters.ref ? data.filters.ref.replace(/^refs\/(heads|remotes|tags)\//, '') : t("全部分支"));
      $('filter-toggle').classList.toggle('filter-active', Boolean(data.filters.author || data.filters.path || data.filters.since || data.filters.until));
      $('root-path').textContent = data.root; $('branch-state').textContent = `${data.state.branch}${data.state.operation ? ' · ' + data.state.operation + t(" 进行中") : ''}`;
      $('continue').hidden = $('abort').hidden = !modules.operations || !data.state.operation;
      for (const key of ['search', 'author', 'path', 'since', 'until']) $(key).value = data.filters[key] || '';
      state.compared = state.compared.filter(hash => data.commits.some(commit => commit.hash === hash));
      if (state.selected && !data.commits.some(commit => commit.hash === state.selected)) state.selected = undefined;
      if (!state.compared.length && state.selected) state.compared = [state.selected];
      if (state.compared.length && !state.compared.includes(state.selected)) state.selected = state.compared[0];
      renderRefs(); renderCommits(); updateStashes(data.stashes || [], data.stashToken);
      if (state.compared.length > 1) send('selectMany', { hashes: state.compared });
      else if (state.selected) send('select', { hash: state.selected });
      else { state.detail = null; clearDetail(); }
    } else if (type === 'stashes') {
      if (data.root !== state.snapshot?.root) return;
      $('context-menu').hidden = true;
      updateStashes(data.entries, data.token);
    } else if (type === 'stashDetail') {
      if (data.token !== state.snapshot?.stashToken || !sameStash(data.stash, state.stashSelected)) return;
      state.stashDetail = data; renderStashFiles();
      if (state.stashPendingDiff) { const pending = state.stashPendingDiff; state.stashPendingDiff = null; showStashDiff(data.stash, pending.newTab); }
    } else if (type === 'detail') renderDetail(data);
    else if (type === 'loading') { state.loading = data; busy(); }
    else if (type === 'operating') { state.operating = data; busy(); renderStashFiles(); $('stash-create').disabled = Boolean(data); }
    else if (type === 'error') { $('notice-text').textContent = data; $('notice').hidden = false; state.loading = false; busy(); }
  });
  function applyPanes() {
    const left = Math.max(12, Math.min(38, Number(state.panes.left) || 28));
    const right = Math.max(18, Math.min(38, Number(state.panes.right) || 23));
    const top = Math.max(20, Math.min(80, Number(state.panes.top) || 56));
    $('history-view').style.setProperty('--left-pane', left + '%');
    $('history-view').style.setProperty('--right-pane', right + '%');
    $('details').style.setProperty('--files-height', top + '%');
    for (const [id, value] of [['left-split', left], ['right-split', right], ['detail-split', top]]) {
      $(id).setAttribute('aria-valuenow', String(Math.round(value))); $(id).setAttribute('aria-valuemin', id === 'detail-split' ? '20' : id === 'left-split' ? '12' : '18'); $(id).setAttribute('aria-valuemax', id === 'detail-split' ? '80' : '38');
    }
  }
  for (const [id, key] of [['left-split', 'left'], ['right-split', 'right'], ['detail-split', 'top']]) {
    const splitter = $(id); let dragging = false;
    splitter.onpointerdown = event => { if (event.button !== 0) return; dragging = true; splitter.focus(); splitter.setPointerCapture(event.pointerId); event.preventDefault(); };
    splitter.onpointermove = event => {
      if (!dragging) return;
      const box = (key === 'top' ? $('details') : $('history-view')).getBoundingClientRect();
      state.panes[key] = key === 'top' ? (event.clientY - box.top) / box.height * 100 : key === 'left' ? (event.clientX - box.left) / box.width * 100 : (box.right - event.clientX) / box.width * 100;
      state.panes[key] = Math.max(key === 'top' ? 20 : key === 'left' ? 12 : 18, Math.min(key === 'top' ? 80 : 38, state.panes[key])); applyPanes();
    };
    splitter.onpointerup = splitter.onpointercancel = () => { dragging = false; persist(); };
    splitter.onkeydown = event => {
      const keys = key === 'top' ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
      if (!keys.includes(event.key)) return;
      event.preventDefault(); const direction = event.key === keys[0] ? -1 : 1;
      const value = Number(splitter.getAttribute('aria-valuenow')) + direction * (key === 'right' ? -2 : 2);
      state.panes[key] = Math.max(key === 'top' ? 20 : key === 'left' ? 12 : 18, Math.min(key === 'top' ? 80 : 38, value)); applyPanes(); persist();
    };
  }
  applyPanes(); applyModules(modules); send('init');
})();
