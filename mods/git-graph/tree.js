// Changed files as tree rows: folders first, then files, each by name.
// ponytail: no compacting of single-child folder chains (a/b/c); add if deep paths get noisy.
export function treeRows(files, collapsed) {
  const root = { dirs: new Map(), files: [] };
  for (const f of files) {
    let node = root;
    for (const part of f.path.split("/").slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push(f);
  }
  const rows = [];
  const walk = (node, prefix, depth) => {
    for (const [name, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      const path = prefix + name;
      rows.push({ dir: true, path, name, depth });
      if (!collapsed.has(path)) walk(child, path + "/", depth + 1);
    }
    for (const f of [...node.files].sort((a, b) => a.path.localeCompare(b.path)))
      rows.push({ file: f, name: f.path.split("/").pop(), depth });
  };
  walk(root, "", 0);
  return rows;
}
