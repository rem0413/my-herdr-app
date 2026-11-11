// Pure helpers for my-files (no Herdr imports, so node can test them).

// files: paths relative to the root; lower: the same, lowercased (built once per index).
// Every space-separated token must occur in the path. Rank by the last token against the file name:
// exact, prefix, contains, path only; then shorter paths, then alphabetical.
export function matchFiles(files, lower, query, limit = 500) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { total: 0, files: [] };
  const last = tokens[tokens.length - 1], hits = [];
  for (let i = 0; i < files.length; i++) {
    const p = lower[i];
    if (!tokens.every((tk) => p.includes(tk))) continue;
    const name = p.slice(p.lastIndexOf("/") + 1);
    hits.push({ i, score: name === last ? 0 : name.startsWith(last) ? 1 : name.includes(last) ? 2 : 3 });
  }
  hits.sort((a, b) => a.score - b.score || files[a.i].length - files[b.i].length || (files[a.i] < files[b.i] ? -1 : 1));
  return { total: hits.length, files: hits.slice(0, limit).map((h) => files[h.i]) };
}

export function bytes(n) {
  if (n == null || !(n >= 0)) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

// directory()'s sh output: "kind\0name\0" pairs (d, f, o = other/dangling), then "s\0size\0" for each
// regular file in order. Sizes are dropped when their count does not match (a file vanished meanwhile).
export function parseListing(stdout) {
  const fields = stdout.split("\0"), out = [], sizes = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const kind = fields[i], value = fields[i + 1];
    if (kind === "s") sizes.push(Number(value));
    else out.push({ name: value, dir: kind === "d", file: kind === "f" });
  }
  const files = out.filter((e) => e.file);
  if (files.length === sizes.length) files.forEach((e, i) => { e.size = sizes[i]; });
  for (const e of out) delete e.file;
  return out;
}
