/* Shared by both webviews and exercised directly by the selection tests. */
(function (root) {
  'use strict';
  function choose(order, current, anchor, hash, modifiers = {}) {
    if (!order.includes(hash)) return { hashes: current, anchor };
    if (modifiers.shiftKey && order.includes(anchor)) {
      const a = order.indexOf(anchor), b = order.indexOf(hash);
      const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
      return { hashes: modifiers.ctrlKey || modifiers.metaKey ? order.filter(value => current.includes(value) || range.includes(value)) : range, anchor };
    }
    if (modifiers.ctrlKey || modifiers.metaKey) {
      const hashes = current.includes(hash) ? current.filter(value => value !== hash) : [...current, hash];
      return { hashes: hashes.length ? hashes : [hash], anchor: hash };
    }
    return { hashes: [hash], anchor: hash };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { choose };
  else root.GitSelection = { choose };
})(globalThis);
