'use strict';
((host) => {
  function build(files, scope = '', query = '', options = {}) {
    const root = { name: scope || '仓库', path: '', children: [] };
    const folders = new Map([['', root]]);
    const needle = query.trim().toLowerCase();
    for (const file of files) {
      if (needle && !`${file.path} ${file.oldPath || ''}`.toLowerCase().includes(needle)) continue;
      const relative = scope && file.path.startsWith(`${scope}/`) ? file.path.slice(scope.length + 1) : file.path;
      const parts = relative.split('/'); let parent = root, prefix = '';
      for (const name of options.mode === 'list' ? [] : parts.slice(0, -1)) {
        prefix = prefix ? `${prefix}/${name}` : name;
        if (!folders.has(prefix)) {
          const folder = { name, path: prefix, children: [] };
          folders.set(prefix, folder); parent.children.push(folder);
        }
        parent = folders.get(prefix);
      }
      parent.children.push({ name: parts.at(-1), path: file.path, file });
    }
    function sort(node) {
      node.children.sort((a, b) => Number(!!a.file) - Number(!!b.file)
        || (options.sort === 'status' && a.file && b.file ? a.file.status[0].localeCompare(b.file.status[0]) : 0)
        || (options.sort === 'name' ? a.name.localeCompare(b.name) : a.path.localeCompare(b.path))
        || a.path.localeCompare(b.path));
      for (const child of node.children) if (child.children) sort(child);
    }
    sort(root); return root;
  }
  const api = { build };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else host.GitComparisonTree = api;
})(typeof window === 'object' ? window : globalThis);
