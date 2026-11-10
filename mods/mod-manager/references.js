// Conservative static scan: literals, command prefixes and cross-mod asset/import paths.
// Dynamic names cannot be proven by this scan; unreferenced never means safe to delete.
// One `grep -rEo` over mods/ with this pattern; mod names are [A-Za-z0-9_-] (no regex escaping needed).
export function grepPattern(names) {
  const n = `(${names.join("|")})`, q = "[\"'`]";
  return `${q}${n}${q}|${q}${n}\\.|${q}mod\\.open:${n}[\"'\`:]|mods/${n}/|${q}\\.\\./${n}/`;
}

// `grep -o` output lines "mods/<owner>/<file>:<match>" into { owner: [target, ...] }.
export function dependencies(output, names) {
  const edges = {}, known = new Set(names);
  for (const line of output.split("\n")) {
    const [, owner, match] = line.match(/^mods\/([^/]+)\/[^:]*:(.*)$/) ?? [];
    const target = match?.replace(/^["'`]/, "").replace(/^(mod\.open:|mods\/|\.\.\/)/, "").match(/^[A-Za-z0-9_-]+/)?.[0];
    if (!known.has(target) || target === owner) continue;
    (edges[owner] ??= new Set()).add(target);
  }
  return Object.fromEntries(Object.entries(edges).map(([k, v]) => [k, [...v]]));
}

// `bindings` is herdr's keys(): [{ section, keys, action }].
export function keyReferences(bindings, name) {
  return (bindings ?? []).filter(({ action }) => action === `mod.open:${name}` || action?.startsWith(`${name}.`)
    || action?.startsWith(`mod.open:${name}:`)).map(b => `${b.section}: ${b.keys}`);
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
