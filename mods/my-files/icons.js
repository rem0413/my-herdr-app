// { path, color } for a Files row or editor tab, from file-editor.json "icons".
// Lookup: exact name, then the longest dotted suffix ("d.ts" before "ts"), then default.
const ICONS = "mods/my-files/icons/";

export function iconFor(name, dir, config) {
  const icons = config?.icons ?? {};
  const path = (icon) => !icon ? `${ICONS}file.svg` : icon.includes("/") ? icon : `${ICONS}${icon}.svg`;
  if (dir) {
    const f = icons.folder ?? {};
    return { path: path(f.icon ?? "folder"), color: icons.folders?.[name] ?? icons.folders?.[name.toLowerCase()] ?? f.color ?? null };
  }
  let hit = icons.names?.[name];
  const parts = name.toLowerCase().split(".");
  for (let i = 1; !hit && i < parts.length; i++) hit = icons.extensions?.[parts.slice(i).join(".")];
  hit ??= icons.default ?? {};
  return { path: path(hit.icon), color: hit.color ?? null };
}
