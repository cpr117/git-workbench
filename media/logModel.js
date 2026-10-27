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
  function branchMenu(ref, currentBranch, locale = 'zh-cn') {
    const t = (typeof module !== 'undefined' && module.exports ? require('./i18n.js') : root.GitWorkbenchI18n).createTranslator(locale);
    const local = !ref.remote && !ref.tag, attached = currentBranch && !currentBranch.startsWith('(');
    return [
      { label: ref.tag ? t("检出标签（分离 HEAD）…") : t("检出…"), action: 'checkout', disabled: ref.current },
      { label: t("从「{0}」新建分支…", ref.name), action: 'create' },
      { label: t("检出并变基到「{0}」…", currentBranch), action: 'checkoutRebase', disabled: !local || ref.current || !attached },
      { separator: true },
      { label: t("与当前分支「{0}」比较", currentBranch), action: 'compare' },
      { label: t("与工作区比较（整个仓库）"), action: 'workingDiff' },
      { separator: true },
      { label: t("将当前「{0}」变基到「{1}」…", currentBranch, ref.name), action: 'rebase', disabled: ref.current || !attached },
      { label: t("将「{0}」合并到当前「{1}」…", ref.name, currentBranch), action: 'merge', disabled: ref.current || !attached },
      { separator: true },
      { label: t("从上游更新（仅快进）…"), action: 'update', disabled: !local },
      { label: t("推送「{0}」…", ref.name), action: 'push', disabled: !local },
      { separator: true },
      { label: t("重命名所选分支…"), action: 'rename', disabled: !local },
      { label: t("删除所选分支…"), action: 'delete', disabled: !local || ref.current },
    ];
  }
  const api = { branchTree, branchMenu };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GitLogModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
