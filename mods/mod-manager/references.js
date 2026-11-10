// Conservative static scan: literals, command prefixes and cross-mod asset/import paths.
// Dynamic names cannot be proven by this scan; unreferenced never means safe to delete.
export function dependencies(text, names, self) {
  const found = new Set();
  for (const match of text.matchAll(/["'`]([^"'`\n]+)["'`]/g)) {
    const value = match[1];
    for (const name of names) {
      if (name !== self && (value === name || value.startsWith(`${name}.`)
        || value === `mod.open:${name}` || value.startsWith(`mod.open:${name}:`) || value.includes(`mods/${name}/`)
        || value.startsWith(`../${name}/`))) found.add(name);
    }
  }
  return [...found];
}

export function keyReferences(bindings, name) {
  const result = [];
  for (const [section, entries] of Object.entries(bindings ?? {})) {
    for (const [key, action] of Object.entries(entries ?? {})) {
      const command = typeof action === "string" ? action : action?.command;
      if (command === `mod.open:${name}` || command?.startsWith(`${name}.`)
        || (command === "mod.open" && action?.args?.name === name)) result.push(`${section}: ${key}`);
    }
  }
  return result;
}

export function reachable(roots, edges) {
  const used = new Set(roots), queue = [...used];
  for (let i = 0; i < queue.length; i++) {
    for (const name of edges[queue[i]] ?? []) {
      if (!used.has(name)) { used.add(name); queue.push(name); }
    }
  }
  return used;
}

export function canDelete(mod, info, ready) {
  return Boolean(ready && mod && !mod.shipped && mod.source !== "herdr" && info?.unused
    && !info.callers.length && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(mod.name));
}
