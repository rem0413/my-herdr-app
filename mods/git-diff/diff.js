// Unified diff -> side-by-side rows. Each row: { l, r } (a side is { n, text, kind } or null = filler), or { hunk: "@@ … @@" }
// before each hunk. Within a change block, the i-th removed line sits beside the i-th added line.
export function pairRows(patch) {
  const rows = [];
  let old = 0, next = 0, del = [], add = [], hunks = 0;
  const flush = () => {
    for (let i = 0; i < Math.max(del.length, add.length); i++) rows.push({ l: del[i] ?? null, r: add[i] ?? null });
    del = []; add = [];
  };
  for (const raw of patch.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(raw);
    if (h) { flush(); hunks++; rows.push({ hunk: raw }); old = Number(h[1]); next = Number(h[2]); continue; }
    if (!hunks) continue; // file headers
    const k = raw[0], text = raw.slice(1).replace(/\t/g, "    ");
    if (k === "-") del.push({ n: old++, text, kind: "-" });
    else if (k === "+") add.push({ n: next++, text, kind: "+" });
    else if (k === " ") { flush(); rows.push({ l: { n: old++, text, kind: " " }, r: { n: next++, text, kind: " " } }); }
  }
  flush();
  return rows;
}

// Unified diff -> one row per line: { hunk } or { kind, o, n, text } (o/n: old/new line number, null when absent).
export function unifiedRows(patch) {
  const rows = [];
  let old = 0, next = 0, hunks = 0;
  for (const raw of patch.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(raw);
    if (h) { hunks++; rows.push({ hunk: raw }); old = Number(h[1]); next = Number(h[2]); continue; }
    if (!hunks) continue;
    const k = raw[0], text = raw.slice(1).replace(/\t/g, "    ");
    if (k === "-") rows.push({ kind: k, o: old++, n: null, text });
    else if (k === "+") rows.push({ kind: k, o: null, n: next++, text });
    else if (k === " ") rows.push({ kind: k, o: old++, n: next++, text });
  }
  return rows;
}

// Added / removed line counts of a patch.
export function countPatch(patch) {
  let add = 0, del = 0, hunks = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) hunks++;
    else if (hunks && raw[0] === "+") add++;
    else if (hunks && raw[0] === "-") del++;
  }
  return { add, del };
}
