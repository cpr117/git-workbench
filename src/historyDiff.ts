export interface DiffCell { line: number; text: string; }
export interface DiffRow { kind: 'context' | 'change' | 'hunk' | 'note'; left?: DiffCell; right?: DiffCell; label?: string; }

// Align contiguous removed/added lines while preserving Git's original line numbers.
export function selectionDiff(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0, newLine = 0, inHunk = false;
  let removed: DiffCell[] = [], added: DiffCell[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) rows.push({ kind: 'change', left: removed[i], right: added[i] });
    removed = []; added = [];
  };
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      flush(); oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true;
      rows.push({ kind: 'hunk', label: line }); continue;
    }
    if (line.startsWith('diff --git ')) { flush(); inHunk = false; continue; }
    if (!inHunk) continue;
    if (line.startsWith('-')) removed.push({ line: oldLine++, text: line.slice(1) });
    else if (line.startsWith('+')) added.push({ line: newLine++, text: line.slice(1) });
    else if (line.startsWith(' ')) {
      flush(); rows.push({ kind: 'context', left: { line: oldLine++, text: line.slice(1) }, right: { line: newLine++, text: line.slice(1) } });
    } else if (line.startsWith('\\ ')) {
      flush(); rows.push({ kind: 'note', label: line.slice(2) });
    }
  }
  flush(); return rows;
}


export interface HistorySnapshot { text: string; offset: number; }

// git log -L includes the tracked range, even when it has moved in the file.
export function historySnapshot(patch: string, side: 'left' | 'right'): HistorySnapshot {
  const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/m.exec(patch);
  if (!hunk) throw new Error('该历史版本缺少选区范围，无法比较；请重新打开历史。');
  const cells = selectionDiff(patch).flatMap(row => row[side] ? [row[side]!] : []);
  if (cells.some((cell, index) => index > 0 && cell.line !== cells[index - 1].line + 1)) throw new Error('该历史选区包含分离的代码片段，请缩小选区或使用文件历史。');
  const start = Number(hunk[side === 'left' ? 1 : 3]);
  const raw = patch.split('\n');
  const noNewline = raw.some((line, index) => line.startsWith('\\ No newline') && (raw[index - 1]?.startsWith(side === 'left' ? '-' : '+') || raw[index - 1]?.startsWith(' ')));
  return { text: cells.map(cell => cell.text).join('\n') + (cells.length && !noNewline ? '\n' : ''), offset: cells.length ? cells[0].line - 1 : start };
}

export function offsetPatch(patch: string, left: number, right: number): string {
  return patch.replace(/^@@ -(\d+)(,\d+)? \+(\d+)(,\d+)? @@/gm, (_all, old: string, oldCount: string | undefined, next: string, newCount: string | undefined) => `@@ -${Number(old) + left}${oldCount || ''} +${Number(next) + right}${newCount || ''} @@`);
}
