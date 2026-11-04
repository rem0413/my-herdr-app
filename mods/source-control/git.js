// Pure helpers: no herdr calls, so `node mods/source-control/git.test.mjs` runs them.

// `git status --porcelain=v1 -z --no-renames` -> files. x/y: index/worktree columns.
// staged: "all" (index matches worktree), "some" (staged and still edited), "none".
export function parseStatus(stdout) {
  return stdout.split("\0").filter(Boolean).map((entry) => {
    const x = entry[0], y = entry[1], path = entry.slice(3);
    const untracked = x === "?";
    const conflict = x === "U" || y === "U" || (x === y && (x === "A" || x === "D"));
    const letter = untracked ? "U" : conflict ? "!" : x === "A" ? "A" : (x === "D" || y === "D") ? "D" : "M";
    const staged = untracked || conflict || x === " " ? "none" : y === " " ? "all" : "some";
    return { path, x, y, untracked, conflict, letter, staged, add: 0, del: 0 };
  });
}

// `git diff --numstat -z --no-renames` -> { path: {add, del, binary} }, summed into `into`.
export function parseNumstat(stdout, into = {}) {
  for (const entry of stdout.split("\0")) {
    const [a, d, ...rest] = entry.split("\t");
    if (!rest.length) continue;
    const path = rest.join("\t"), old = into[path] ?? { add: 0, del: 0 };
    into[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
  }
  return into;
}

// Checkbox state of a set of files.
export function checkState(files) {
  if (!files.length) return "none";
  if (files.every((f) => f.staged === "all")) return "all";
  return files.some((f) => f.staged !== "none") ? "some" : "none";
}

// Files as tree rows: folders first (single-child chains joined: "src/ui"), then files.
// Dir rows carry every file under them (for their checkbox). key: unique per group, for collapse state.
export function treeRows(files, collapsed, group = "") {
  const root = { dirs: new Map(), files: [] };
  for (const f of files) {
    let node = root;
    for (const part of f.path.split("/").slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push(f);
  }
  const all = (node) => [...node.files, ...[...node.dirs.values()].flatMap(all)];
  const rows = [];
  const walk = (node, prefix, depth) => {
    for (let [name, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      while (!child.files.length && child.dirs.size === 1) {
        const [[n, c]] = child.dirs;
        name += "/" + n; child = c;
      }
      const path = prefix + name, key = `${group}:${path}`;
      rows.push({ dir: true, key, path, name, depth, files: all(child) });
      if (!collapsed.has(key)) walk(child, path + "/", depth + 1);
    }
    for (const f of [...node.files].sort((a, b) => a.path.localeCompare(b.path)))
      rows.push({ file: f, key: `${group}:${f.path}`, name: f.path.split("/").pop(), depth });
  };
  walk(root, "", 0);
  return rows;
}

// `%D` -> ref chips: { kind: "head" | "branch" | "remote" | "tag", name }.
export function parseRefs(d) {
  return d.split(", ").map((r) => r.trim()).filter(Boolean).flatMap((r) => {
    if (r === "HEAD") return [{ kind: "head", name: "HEAD" }];
    if (r.startsWith("HEAD -> ")) return [{ kind: "head", name: r.slice(8) }];
    if (r.startsWith("tag: ")) return [{ kind: "tag", name: r.slice(5) }];
    if (r.endsWith("/HEAD")) return [];
    return [{ kind: r.includes("/") ? "remote" : "branch", name: r }];
  });
}

export function ago(sec) {
  const d = Date.now() / 1000 - sec;
  if (d < 60) return `${Math.max(1, Math.round(d))}s ago`;
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  if (d < 86400 * 30) return `${Math.round(d / 86400)}d ago`;
  return new Date(sec * 1000).toISOString().slice(0, 10);
}
