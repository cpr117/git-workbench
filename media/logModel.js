/* Shared branch hierarchy for the Git log. */
(function (root) {
  'use strict';
  function branchTree(refs, query = '') {
    const groups = [
      { name: 'Local', key: 'local', test: ref => !ref.remote && !ref.tag },
      { name: 'Remote', key: 'remote', test: ref => ref.remote && !ref.tag },
      { name: 'Tags', key: 'tags', test: ref => ref.tag }
    ];
    const needle = query.trim().toLowerCase();
    return groups.map(group => {
      const children = new Map();
      for (const ref of refs.filter(group.test).filter(ref => ref.name.toLowerCase().includes(needle))) {
        const parts = ref.name.split('/'); let level = children, key = group.key;
        parts.forEach((name, index) => {
          key += '/' + name;
          if (!level.has(name)) level.set(name, { name, key, children: new Map() });
          const node = level.get(name);
          if (index === parts.length - 1) node.ref = ref;
          level = node.children;
        });
      }
      const ordered = level => [...level.values()].sort((a, b) => Number(!a.children.size) - Number(!b.children.size) || a.name.localeCompare(b.name, 'en')).map(node => ({ ...node, children: ordered(node.children) }));
      return { name: group.name, key: group.key, children: ordered(children) };
    }).filter(group => group.children.length);
  }
  function branchMenu(ref, currentBranch) {
    const local = !ref.remote && !ref.tag, attached = currentBranch && !currentBranch.startsWith('(');
    return [
      { label: ref.tag ? '检出标签（分离 HEAD）…' : '检出…', action: 'checkout', disabled: ref.current },
      { label: `从「${ref.name}」新建分支…`, action: 'create' },
      { label: `检出并变基到「${currentBranch}」…`, action: 'checkoutRebase', disabled: !local || ref.current || !attached },
      { separator: true },
      { label: `与当前分支「${currentBranch}」比较`, action: 'compare' },
      { label: '与工作区比较（整个仓库）', action: 'workingDiff' },
      { separator: true },
      { label: `将当前「${currentBranch}」变基到「${ref.name}」…`, action: 'rebase', disabled: ref.current || !attached },
      { label: `将「${ref.name}」合并到当前「${currentBranch}」…`, action: 'merge', disabled: ref.current || !attached },
      { separator: true },
      { label: '从上游更新（仅快进）…', action: 'update', disabled: !local },
      { label: `推送「${ref.name}」…`, action: 'push', disabled: !local },
      { separator: true },
      { label: '重命名所选分支…', action: 'rename', disabled: !local },
      { label: '删除所选分支…', action: 'delete', disabled: !local || ref.current },
    ];
  }
  const api = { branchTree, branchMenu };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GitLogModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
