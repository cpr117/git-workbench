/* global acquireVsCodeApi, GitSelection, GitLogModel */
'use strict';
(() => {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const state = { snapshot: null, detail: null, selected: saved.selected, compared: saved.hashes || [], anchor: saved.selected, tab: saved.tab || 'history', loading: false, operating: false, collapsed: new Set(saved.collapsed || []), panes: saved.panes || {} };
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
  const persist = () => vscode.setState({ selected: state.selected, hashes: state.compared, tab: state.tab, collapsed: [...state.collapsed], panes: state.panes });
  const shorten = hash => (hash || '').slice(0, 8);
  $('app').innerHTML = `
    <header class="topbar">
      <strong class="git-label">Git</strong>
      <nav class="tabs" aria-label="工作区视图"><button id="history-tab" role="tab">Log: 全部分支</button><button id="working-tab" role="tab">工作区 <span id="changes-count">0</span></button></nav>
      <button id="repo" class="repo" title="切换仓库">选择仓库</button><span id="branch-state"></span>
      <div class="top-actions"><span id="busy" role="status"></span><button id="continue" hidden>继续操作</button><button id="abort" hidden>中止</button><button id="refresh" title="刷新">↻</button><button id="operations">Git 操作 ▾</button></div>
    </header>
    <div id="notice" class="notice" role="alert" hidden><span id="notice-text"></span><button id="dismiss" aria-label="关闭提示">×</button></div>
    <main id="history-view" class="history-layout">
      <aside class="branches" aria-label="分支与标签"><div class="branch-search"><input id="branch-search" type="search" placeholder="Branch or tag" aria-label="搜索分支或标签"><button id="new-branch" title="从选中提交或 HEAD 创建分支">＋</button></div><div id="refs"></div></aside>
      <div id="left-split" class="splitter" role="separator" tabindex="0" aria-label="调整分支目录宽度" aria-orientation="vertical"></div>
      <section class="commit-pane" aria-label="提交图">
        <form id="filters" class="filters">
          <input id="search" placeholder="搜索提交信息" aria-label="搜索提交信息">
          <button type="button" id="filter-toggle" title="按作者、日期、路径筛选">User · Date · Paths ▾</button><button type="submit" title="应用筛选">搜索</button>
          <div id="advanced" class="advanced" hidden><input id="author" placeholder="作者（Git 正则）" aria-label="作者"><input id="path" placeholder="路径，如 src/main.go" aria-label="文件或目录路径"><label>起始 <input id="since" type="date"></label><label>截止 <input id="until" type="date"></label></div>
        </form>
        <div class="list-heading"><span id="history-count">等待加载</span><button id="compare" hidden>仅比两个快照</button><button id="clear-filters">清除筛选</button></div>
        <div id="commits" class="commits" role="listbox" aria-multiselectable="true" aria-label="提交列表"></div>
        <div class="list-footer"><button id="more">加载更多</button><span id="limit-note"></span></div>
      </section>
      <div id="right-split" class="splitter" role="separator" tabindex="0" aria-label="调整变更详情宽度" aria-orientation="vertical"></div>
      <aside class="details" id="details" aria-label="提交变更与详情">
        <section id="changed-files" class="files-pane" aria-label="变更文件"><div class="empty-list">选择提交以查看变更文件</div></section>
        <div id="detail-split" class="splitter horizontal" role="separator" tabindex="0" aria-label="调整文件与详情高度" aria-orientation="horizontal"></div>
        <section id="commit-detail" class="info-pane" aria-label="提交详情"><div class="empty-list">Commit details</div></section>
      </aside>
    </main>
    <main id="working-view" class="working-layout" hidden>
      <section class="working-main"><div class="working-toolbar"><div><h1>工作区改动</h1><p>暂存、检查差异，然后提交。</p></div><div id="working-actions"></div></div><div id="working-files"></div></section>
      <aside class="working-help"><div class="section-title">工作流</div><ol><li>点击文件打开原生 Diff。</li><li>暂存需要提交的文件。</li><li>点击“提交暂存区”。</li></ol><p>部分代码块：在编辑器选中代码，右键选择“暂存选中代码块”。</p><p>冲突：比较 Ours / Theirs，打开工作区文件解决后暂存，再继续操作。</p><div id="sync-actions"></div></aside>
    </main>
    <footer class="footer"><span id="root-path">本地 Git · 数据不上传</span><span>Shift 多选 · 右键提交操作</span></footer>
    <div id="context-menu" class="context-menu" role="menu" hidden></div>`;

  function setTab(tab) {
    state.tab = tab; persist();
    $('history-view').hidden = tab !== 'history'; $('working-view').hidden = tab !== 'working';
    $('history-tab').setAttribute('aria-selected', String(tab === 'history'));
    $('working-tab').setAttribute('aria-selected', String(tab === 'working'));
  }
  $('history-tab').onclick = () => setTab('history');
  $('working-tab').onclick = () => setTab('working');
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
    if (!commits.length) list.append(make('div', 'empty-list', '没有匹配的提交。新仓库可先到工作区暂存并提交文件。'));
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
    $('history-count').textContent = `${commits.length} 条提交 · 已选 ${state.compared.length}${filter.ref ? ' · ' + filter.ref.replace(/^refs\/(heads|remotes|tags)\//, '') : ' · 全部分支'}`;
    $('compare').hidden = state.compared.length !== 2;
    $('more').hidden = commits.length < (filter.limit || 200) || (filter.limit || 200) >= 5000;
    $('limit-note').textContent = (filter.limit || 200) >= 5000 ? '已显示最多 5,000 条，请使用筛选缩小范围' : '按拓扑顺序 · 按需加载';
  }
  function renderRefs() {
    if (!state.snapshot) return;
    const { refs, filters: filter } = state.snapshot;
    const container = $('refs'); const scroll = container.scrollTop; container.replaceChildren();
    const entry = (parent, label, ref, icon, current = false) => {
      const item = button('', () => send('filters', { filters: { ...filters(), ref, limit: 200 } }), 'branch-item');
      item.append(make('span', 'branch-icon', icon), make('span', 'branch-name', label));
      if (current) { item.classList.add('current'); item.title = '当前检出分支 · ' + ref; }
      else item.title = ref || '显示全部引用';
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
    entry(container, 'HEAD (Current Branch)', 'HEAD', '◉');
    entry(container, '全部分支', '', '⑂');
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
    if (!groups.length && searching) container.append(make('div', 'no-refs', '没有匹配的分支或标签'));
    container.scrollTop = scroll;
  }
  function clearDetail() {
    $('changed-files').replaceChildren(make('div', 'empty-list', '选择提交以查看变更文件'));
    $('commit-detail').replaceChildren(make('div', 'empty-list', 'Commit details'));
  }
  function renderDetail(data) {
    state.detail = data;
    if (!data.compare && data.target) { state.selected = data.target; state.anchor = data.target; state.compared = [data.target]; persist(); renderCommits(); }
    const panel = $('commit-detail'); panel.replaceChildren();
    const files = $('changed-files'); files.replaceChildren();
    const heading = make('div', 'section-title', data.aggregate ? '多提交改动' : data.compare ? '版本比较' : '提交详情'); panel.append(heading);
    const body = make('div', 'detail-body');
    body.append(make('h2', 'commit-title', data.commit?.subject || data.message));
    if (data.commit) {
      body.append(make('p', 'meta', `${data.commit.author} · ${data.commit.date.slice(0, 16).replace('T', ' ')}`));
      body.append(button(data.target, () => send('copy', { hash: data.target }), 'full-hash'));
      const toolbar = make('div', 'detail-toolbar'); toolbar.append(button('操作此提交 ▾', () => send('menu', { hash: data.target }))); body.append(toolbar);
      if (data.commit.parents.length > 1) {
        const label = make('label', 'parent-label', '比较父提交 '); const select = make('select');
        data.commit.parents.forEach((parent, index) => { const option = make('option', '', `${index + 1} · ${shorten(parent)}`); option.value = parent; option.selected = parent === data.base; select.append(option); });
        select.onchange = () => send('select', { hash: data.target, parent: select.value }); label.append(select); body.append(label);
      }
      body.append(make('pre', 'commit-message', data.message));
    }
    if (data.aggregate) body.append(make('p', 'meta', `基准 ${shorten(data.base)} → ${shorten(data.target)} · 包含最旧所选提交和区间内的中间修改；互相抵消的修改不计入净改动。`));
    files.append(make('div', 'section-title', `${data.files.length} 个变更文件 · 点击打开 Diff`));
    if (!data.files.length) files.append(make('p', 'meta', '此版本比较没有文件变化。'));
    data.files.forEach(file => {
      const entry = make('div', 'changed-file');
      const diff = button('', () => send('diff', { path: file.path, commitHash: file.commitHash }), 'file-diff');
      diff.append(make('span', `file-status status-${file.status[0]}`, file.status[0]), make('span', 'file-path', file.commitHash ? `${shorten(file.commitHash)} · ${file.path}` : file.path));
      diff.title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
      entry.append(diff);
      if (!data.aggregate) { const restore = button('↶', () => send('restore', { path: file.path }), 'restore-file'); restore.title = '恢复工作区文件为此版本'; entry.append(restore); }
      files.append(entry);
    }); panel.append(body);
  }
  function renderWorking() {
    const container = $('working-files'); container.replaceChildren();
    const conflict = status => ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(status);
    const changes = state.snapshot.status;
    const groups = [
      ['冲突', changes.filter(file => conflict(file.status)), 'conflict'],
      ['已暂存', changes.filter(file => !conflict(file.status) && file.index !== ' ' && file.index !== '?'), 'index'],
      ['未暂存 / 未跟踪', changes.filter(file => !conflict(file.status) && file.worktree !== ' '), 'worktree']
    ];
    if (!changes.length) container.append(make('div', 'empty-list', '工作区干净，所有改动均已提交。'));
    groups.forEach(([title, files, area]) => {
      if (!files.length) return;
      container.append(make('h2', 'working-group', `${title} · ${files.length}`));
      files.forEach(file => {
        const row = make('div', 'working-file');
        const diff = button('', () => send('working', { action: 'diff', path: file.path, area }), 'working-diff');
        diff.append(make('code', 'work-status', file.status), make('span', 'file-path', file.path)); row.append(diff);
        const action = id => send('working', { action: id, path: file.path, area });
        row.append(button('打开', () => action('open')));
        row.append(button(area === 'index' ? '取消暂存' : '暂存', () => action(area === 'index' ? 'unstage' : 'stage')));
        if (area === 'worktree' && file.index !== '?') row.append(button('丢弃', () => action('discard'), 'danger-text'));
        container.append(row);
      });
    });
  }
  function contextMenu(event, hash) {
    const menu = $('context-menu'); menu.replaceChildren();
    const items = [
      ['复制提交 ID', null], ['从此提交创建分支', 'branchCreate'], ['创建标签', 'tagCreate'], ['检出此提交', 'checkout'],
      ['Cherry-pick', 'cherryPick'], ['Revert', 'revert'], ['合并到当前分支', 'merge'], ['当前分支变基到这里', 'rebase'], ['Reset 到这里…', 'reset']
    ];
    items.forEach(([label, action]) => {
      const item = button(label, () => { menu.hidden = true; if (action) send('action', { action, hash }); else send('copy', { hash }); });
      item.setAttribute('role', 'menuitem'); if (action === 'reset') item.classList.add('danger-text'); menu.append(item);
    });
    positionMenu(event);
  }
  function branchMenu(event, ref) {
    const menu = $('context-menu'); menu.replaceChildren();
    GitLogModel.branchMenu(ref, state.snapshot.state.branch).forEach(spec => {
      if (spec.separator) { const line = make('hr'); line.setAttribute('role', 'separator'); menu.append(line); return; }
      const item = button(spec.label, () => { menu.hidden = true; send('branchAction', { action: spec.action, ref: ref.full }); });
      item.disabled = Boolean(spec.disabled || state.operating);
      item.setAttribute('role', 'menuitem');
      if (spec.action === 'delete') item.classList.add('danger-text');
      menu.append(item);
    });
    positionMenu(event);
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
  for (const [label, action] of [['暂存全部', 'stageAll'], ['取消全部暂存', 'unstageAll'], ['提交暂存区', 'commit'], ['Amend', 'amend']]) $('working-actions').append(button(label, () => send('action', { action }), action === 'commit' ? 'primary' : ''));
  for (const [label, action] of [['Fetch', 'fetch'], ['Pull', 'pull'], ['Push', 'push'], ['Stash', 'stash'], ['恢复 Stash', 'stashPop'], ['原生提交面板', 'scm']]) $('sync-actions').append(button(label, () => send('action', { action })));
  function busy() { $('busy').textContent = state.operating ? 'Git 操作中…' : state.loading ? '加载中…' : ''; $('app').classList.toggle('operating', state.operating); }
  window.addEventListener('message', event => {
    const { type, data } = event.data || {};
    if (type === 'reset') {
      state.snapshot = null; state.detail = null; state.selected = undefined; state.compared = []; persist();
      $('commits').replaceChildren(); $('refs').replaceChildren(); clearDetail(); $('working-files').replaceChildren();
    } else if (type === 'snapshot') {
      $('context-menu').hidden = true;
      state.snapshot = data;
      $('repo').textContent = data.root.split(/[\\/]/).pop(); $('repo').title = data.root;
      $('history-tab').textContent = 'Log: ' + (data.filters.ref ? data.filters.ref.replace(/^refs\/(heads|remotes|tags)\//, '') : '全部分支');
      $('filter-toggle').classList.toggle('filter-active', Boolean(data.filters.author || data.filters.path || data.filters.since || data.filters.until));
      $('root-path').textContent = data.root; $('branch-state').textContent = `${data.state.branch}${data.state.operation ? ' · ' + data.state.operation + ' 进行中' : ''}`;
      $('continue').hidden = $('abort').hidden = !data.state.operation;
      $('changes-count').textContent = String(data.status.length);
      for (const key of ['search', 'author', 'path', 'since', 'until']) $(key).value = data.filters[key] || '';
      state.compared = state.compared.filter(hash => data.commits.some(commit => commit.hash === hash));
      if (state.selected && !data.commits.some(commit => commit.hash === state.selected)) state.selected = undefined;
      if (!state.compared.length && state.selected) state.compared = [state.selected];
      if (state.compared.length && !state.compared.includes(state.selected)) state.selected = state.compared[0];
      renderRefs(); renderCommits(); renderWorking();
      if (state.compared.length > 1) send('selectMany', { hashes: state.compared });
      else if (state.selected) send('select', { hash: state.selected });
      else { state.detail = null; clearDetail(); }
    } else if (type === 'detail') renderDetail(data);
    else if (type === 'loading') { state.loading = data; busy(); }
    else if (type === 'operating') { state.operating = data; busy(); }
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
  applyPanes(); setTab(state.tab); send('init');
})();
