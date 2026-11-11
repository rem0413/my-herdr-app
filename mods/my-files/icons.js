// { path, color, tint } for a Files row or editor tab.
// Default: Material Icon Theme (full-color, draw with image()), lookup adapted from filer-pro (MIT):
// a path rule (".github/workflows") beats a name, a name beats an extension, the longest extension wins.
// file-editor.json "icons": { "theme": "classic" } uses the old tinted set (draw with svg() + color):
// exact name, then the longest dotted suffix ("d.ts" before "ts"), then default.
import MATERIAL from "./material.js";

const ICONS = "mods/my-files/icons/", MAT = "mods/my-files/material/";

const bare = (name) => name.replace(/^__(.+)__$/, "$1").replace(/^[._-]/, "");
const opened = (id) => id.endsWith("_light") ? `${id.slice(0, -6)}-open_light` : `${id}-open`;
const look = (table, key, dark) => (dark ? undefined : MATERIAL.light[table][key]) ?? MATERIAL[table][key];

// rel: the path from the tree root ("src/app.ts"), or just the name.
function material(rel, dir, open, dark) {
  const parts = rel.toLowerCase().split("/"), name = parts[parts.length - 1];
  const table = dir ? "folderNames" : "fileNames";
  const find = (key) => look(table, key, dark) ?? (dir ? look(table, bare(key), dark) : undefined);
  let id;
  for (let i = 0; !id && i < parts.length - 1; i++) id = find(parts.slice(i).join("/"));
  if (dir) {
    id ??= find(name) ?? MATERIAL.folder;
    return `${MAT}${open ? opened(id) : id}.svg`;
  }
  id ??= look(table, name, dark);
  for (let dot = name.indexOf("."); !id && dot !== -1; dot = name.indexOf(".", dot + 1)) id = look("fileExtensions", name.slice(dot + 1), dark);
  return `${MAT}${id ?? MATERIAL.file}.svg`;
}

export function iconFor(rel, dir, config, { open = false, dark = true } = {}) {
  const icons = config?.icons ?? {}, name = rel.split("/").pop();
  if (icons.theme !== "classic") return { path: material(rel, dir, open, dark), color: null, tint: false };
  const path = (icon) => !icon ? `${ICONS}file.svg` : icon.includes("/") ? icon : `${ICONS}${icon}.svg`;
  if (dir) {
    const f = icons.folder ?? {};
    return { path: path(f.icon ?? "folder"), color: icons.folders?.[name] ?? icons.folders?.[name.toLowerCase()] ?? f.color ?? null, tint: true };
  }
  let hit = icons.names?.[name];
  const parts = name.toLowerCase().split(".");
  for (let i = 1; !hit && i < parts.length; i++) hit = icons.extensions?.[parts.slice(i).join(".")];
  hit ??= icons.default ?? {};
  return { path: path(hit.icon), color: hit.color ?? null, tint: true };
}
