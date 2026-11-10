# Mod Manager

Open with `cmd-alt-m`. Source badges sit at the far left before mod names. Compact rows show a usage icon and status: Running (play), Referenced/System (link), or Unreferenced (minus). Hover the usage icon for a summary; the info icon opens a popup with source, layouts, shortcuts, open tabs, referencing mods and activity. Only source filters remain. Reload refreshes usage; overlay status refreshes every 3 seconds.

- **Running · current layout**: referenced by a visible block, floating block or header in the current layout. A zero-height service block counts too.
- **Running · overlay**: reported by `herdr-app status`.
- **Loaded · tab pane**: present in an open tab; that tab may be inactive.
- **Hidden · may remain running**: hidden by a block/ancestor or inactive stack child. Herdr keeps initialized hidden copies alive.
- **Off · disabled by kit**: kit is in `herdr-mods.disabled`; this means disabled rendering, not process termination.
- **On demand · terminal menu**: configured right-click menu, not proof of an open instance.
- **Not in current layout / open panes**: no known current reference; not a claim that every background instance has stopped.

Herdr exposes no complete live-instance registry. Layout ownership is a reference map, not exclusivity: mods can also be opened by commands or other mods.

## Where mods are used / cleanup

**Unreferenced** marks personal/repo mods unreachable from any layout, shortcut, open pane/overlay or shipped mod. Dependencies are followed transitively; an isolated cycle does not count as usage. **Referenced** includes configured usage and system mods, not only currently visible instances.

Reload scans `.js`, `mod.json` and `kit.json` under `mods/`, excluding `node_modules`. Literal mod names, command prefixes and cross-mod asset/import paths are conservative references, not proof a code branch executes. Computed names and external callers can be missed. No automatic deletion. Shipped mods are retained because Herdr may invoke them internally. Incomplete scans do not produce cleanup candidates.

The trash icon is enabled only after a complete scan for unreferenced non-Herdr mods with no incoming mod references. A confirmation dialog rechecks usage and the shipped registry before deleting the mod folder. Shipped mods stay locked even if their source is overridden by a repo. Saved mod data is kept; the upstream entry and kit-disabled entry are removed. Deletion can still miss computed/external callers; inspect the info popup first. No mods are deleted without confirmation.

Info popups use explicit root dimensions (`420 × 340` logical px). Native popup measurement is content-based: a `size_full()` root with a `flex_1()` scroll body can collapse the body to zero height even when `openOverlay` provides dimensions.

Checks:

```sh
node mods/mod-manager/usage.test.mjs
node mods/mod-manager/references.test.mjs
herdr-app check mods/mod-manager
```
