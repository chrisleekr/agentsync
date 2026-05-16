export type DiffOp = {
  kind: "eq" | "del" | "add";
  line: string;
  ai: number;
  bi: number;
};

/** Compute the longest-common-subsequence walk of two line arrays.
 *  Shared by `unifiedDiff` and `sideBySideDiff`. */
export function computeDiffOps(a: string, b: string): DiffOp[] {
  const aLines = a === "" ? [] : a.split("\n");
  const bLines = b === "" ? [] : b.split("\n");
  const n = aLines.length;
  const m = bLines.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        aLines[i] === bLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      ops.push({ kind: "eq", line: aLines[i], ai: i, bi: j });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ kind: "del", line: aLines[i], ai: i, bi: j });
      i++;
    } else {
      ops.push({ kind: "add", line: bLines[j], ai: i, bi: j });
      j++;
    }
  }
  while (i < n) {
    ops.push({ kind: "del", line: aLines[i], ai: i, bi: j });
    i++;
  }
  while (j < m) {
    ops.push({ kind: "add", line: bLines[j], ai: i, bi: j });
    j++;
  }
  return ops;
}

/**
 * Minimal unified-style line diff. Used by the TUI Sync tab when the
 * terminal is too narrow for the side-by-side modal.
 */
export function unifiedDiff(a: string, b: string, contextLines = 3): string {
  const ops = computeDiffOps(a, b);
  if (ops.every((o) => o.kind === "eq")) return "";

  const changeIdx: number[] = [];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].kind !== "eq") changeIdx.push(k);
  }
  const hunks: { start: number; end: number }[] = [];
  for (const k of changeIdx) {
    const start = Math.max(0, k - contextLines);
    const end = Math.min(ops.length - 1, k + contextLines);
    const last = hunks[hunks.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      hunks.push({ start, end });
    }
  }

  const out: string[] = [];
  for (const h of hunks) {
    let aStart = -1;
    let bStart = -1;
    let aCount = 0;
    let bCount = 0;
    for (let k = h.start; k <= h.end; k++) {
      const op = ops[k];
      if (aStart < 0 && (op.kind === "eq" || op.kind === "del")) aStart = op.ai;
      if (bStart < 0 && (op.kind === "eq" || op.kind === "add")) bStart = op.bi;
      if (op.kind === "eq" || op.kind === "del") aCount++;
      if (op.kind === "eq" || op.kind === "add") bCount++;
    }
    if (aStart < 0) aStart = 0;
    if (bStart < 0) bStart = 0;
    // Per the unified-diff spec, a zero-length side reports its start
    // line as 0 — `patch`, `git apply`, and similar tools reject a hunk
    // header like `-1,0` (line 1 of an empty side cannot exist). Pure-add
    // at top-of-file is the common trigger.
    const aLn = aCount === 0 ? 0 : aStart + 1;
    const bLn = bCount === 0 ? 0 : bStart + 1;
    out.push(`@@ -${aLn},${aCount} +${bLn},${bCount} @@`);
    for (let k = h.start; k <= h.end; k++) {
      const op = ops[k];
      const prefix = op.kind === "eq" ? " " : op.kind === "del" ? "-" : "+";
      out.push(`${prefix}${op.line}`);
    }
  }
  return out.join("\n");
}

/** One row of a side-by-side diff. `lnA`/`lnB` are 1-based line numbers
 *  on the vault / local side; null means that side is empty for the row
 *  (a pure addition or removal with no paired counterpart). */
export interface SideBySideRow {
  lnA: number | null;
  sigA: " " | "-";
  textA: string;
  lnB: number | null;
  sigB: " " | "+";
  textB: string;
}

/** Pair the diff ops into side-by-side rows. Consecutive del/add ops are
 *  paired (max length) so a single-line edit reads as `old | new` rather
 *  than two stacked rows. Used by `sideBySideDiff` for text rendering and
 *  by the TUI diff modal for cursor + line-selection support. */
export function pairDiffRows(a: string, b: string): SideBySideRow[] {
  const ops = computeDiffOps(a, b);
  const rows: SideBySideRow[] = [];
  let k = 0;
  while (k < ops.length) {
    const op = ops[k];
    if (op.kind === "eq") {
      rows.push({
        lnA: op.ai + 1,
        sigA: " ",
        textA: op.line,
        lnB: op.bi + 1,
        sigB: " ",
        textB: op.line,
      });
      k++;
      continue;
    }
    const dels: DiffOp[] = [];
    const adds: DiffOp[] = [];
    while (k < ops.length && ops[k].kind === "del") {
      dels.push(ops[k]);
      k++;
    }
    while (k < ops.length && ops[k].kind === "add") {
      adds.push(ops[k]);
      k++;
    }
    const pairCount = Math.max(dels.length, adds.length);
    for (let p = 0; p < pairCount; p++) {
      const d = dels[p];
      const aa = adds[p];
      rows.push({
        lnA: d ? d.ai + 1 : null,
        sigA: d ? "-" : " ",
        textA: d ? d.line : "",
        lnB: aa ? aa.bi + 1 : null,
        sigB: aa ? "+" : " ",
        textB: aa ? aa.line : "",
      });
    }
  }
  return rows;
}

/**
 * Render a two-column side-by-side line diff. Each row shows the vault
 * line on the left (with its line number) and the local line on the
 * right (with its line number). Identical lines appear on both sides,
 * removals only on the left with a `-` gutter, additions only on the
 * right with a `+` gutter.
 *
 * Consecutive del+add ops are paired into a single row so a typical
 * "one-line edit" reads naturally as old | new instead of two stacked
 * rows.
 */
export function sideBySideDiff(a: string, b: string, columnWidth: number): string {
  const rows = pairDiffRows(a, b);
  if (rows.length === 0) return "";
  // pairDiffRows preserves all-equal context so the TUI modal can show full
  // file content. The text rendering still bails for "no changes anywhere"
  // to match the original sideBySideDiff contract.
  if (rows.every((r) => r.sigA === " " && r.sigB === " ")) return "";

  const lnW = Math.max(
    2,
    String(Math.max(...rows.flatMap((r) => [r.lnA ?? 0, r.lnB ?? 0]))).length,
  );
  const textW = Math.max(8, columnWidth - lnW - 2); // " 12 ±"  + text

  function clip(s: string): string {
    if (s.length <= textW) return s.padEnd(textW);
    if (textW <= 1) return s.slice(0, textW);
    return `${s.slice(0, Math.max(0, textW - 1))}…`;
  }
  function lnStr(n: number | null): string {
    return n === null ? "".padStart(lnW) : String(n).padStart(lnW);
  }

  const out: string[] = [];
  // Header
  out.push(
    `${" ".repeat(lnW)}  ${"vault".padEnd(textW)} │ ${" ".repeat(lnW)}  ${"local".padEnd(textW)}`,
  );
  out.push(`${"─".repeat(lnW)}  ${"─".repeat(textW)} │ ${"─".repeat(lnW)}  ${"─".repeat(textW)}`);
  for (const r of rows) {
    out.push(
      `${lnStr(r.lnA)} ${r.sigA}${clip(r.textA)} │ ${lnStr(r.lnB)} ${r.sigB}${clip(r.textB)}`,
    );
  }
  return out.join("\n");
}
