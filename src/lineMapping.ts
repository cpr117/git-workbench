export interface MappedRange { start: number; end: number; expanded: boolean; added: boolean; }

// Zero-context Git hunks map unchanged lines exactly. A rewritten block maps to
// its entire pre-edit block: line identity inside an arbitrary rewrite is unknown.
export function mapLineRange(patch: string, start: number, end: number, currentLines: number): MappedRange {
  if (start > currentLines) throw new Error('所选位置没有可追溯的代码，文件末尾空行暂无提交历史。');
  end = Math.min(end, currentLines);
  let oldCursor = 1, newCursor = 1, first = Infinity, last = 0, expanded = false, added = false;
  const include = (from: number, to: number) => { first = Math.min(first, from); last = Math.max(last, to); };
  const unchanged = (until: number) => {
    const from = Math.max(start, newCursor), to = Math.min(end, until);
    if (from <= to) include(oldCursor + from - newCursor, oldCursor + to - newCursor);
  };
  for (const hunk of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const newCount = hunk[4] === undefined ? 1 : Number(hunk[4]);
    const oldStart = Number(hunk[1]) + (oldCount === 0 ? 1 : 0);
    const newStart = Number(hunk[3]) + (newCount === 0 ? 1 : 0);
    unchanged(newStart - 1);
    if (newCount && start < newStart + newCount && end >= newStart) {
      if (oldCount) { include(oldStart, oldStart + oldCount - 1); expanded = true; }
      else added = true;
    }
    oldCursor = oldStart + oldCount; newCursor = newStart + newCount;
  }
  unchanged(currentLines);
  if (!last) throw new Error('所选代码是未提交的新增内容，没有对应的已提交历史；可使用“查看文件历史”。');
  return { start: first, end: last, expanded, added };
}
