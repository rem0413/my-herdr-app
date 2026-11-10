// Mod Manager: source, layout ownership, current usage, toggles and repo updates.
// - Source: "repo" (mod-sources.json, updated by update-mods.sh), "herdr" (installed.json), else "local".
// - On/off: hides/shows the mod's blocks in the shown layout (layout.hide/show). Mods with a kit.json
//   also follow shared "herdr-mods.disabled" (they draw nothing while listed), so they can be off with no block.
// - Updates: `update-mods.sh -n` checks, `update-mods.sh <mod>` updates (it runs herdr-app check).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, appHome, theme, layout, layouts, panes, spaces, keys, readTextFile, writeTextFile, openOverlay, nextCommand, run, shared, setShared, props, closeOverlay, notify } from "herdr";
import { usesMod, usage } from "./usage.js";
import { grepPattern, dependencies, keyReferences, reachable, canDelete } from "./references.js";

const OFF_KEY = "herdr-mods.disabled";
const off = () => { const v = shared(OFF_KEY); return Array.isArray(v) ? v : []; };

// Blocks (with an id) that show `mod` in the layout tree, floating blocks too.
function blocks(node, mod, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.content?.mod === mod && node.id) out.push(node);
  for (const c of [...(node.children ?? []), ...(node.floating ?? [])]) blocks(c, mod, out);
  return out;
}

export default class ModManager extends View {
  init(_props, cx) {
    this.mods = [];       // { name, kit, local }
    this.sources = {};    // mod-sources.json
    this.updates = {};    // name -> "<old> -> <new>" | "up to date" | error text
    this.busy = null;     // "check:<mod>" while checking, "<mod>" while updating
    this.filter = "all";
    this.message = null;
    this.layoutTrees = [];
    this.overlays = [];
    this.edges = {};
    this.scanReady = false;
    if (props()?.mode === "details") return;
    this.refreshRuntime(cx);
    cx.timer.every(3000, cx => this.refreshRuntime(cx));
    this.load(cx);
    cx.spawn(async cx => {
      for (;;) if (await nextCommand() === "refresh") this.load(cx);
    });
  }

  sh(script, args = [], timeout = 30000) {
    return exec("sh", ["-c", script, "mm", ...args], { cwd: appHome(), timeout });
  }

  refreshRuntime(cx) {
    cx.spawn(async cx => {
      try {
        const r = await exec("herdr-app", ["status"]);
        if (r.code !== 0) throw new Error(r.stderr || "Cannot read app status");
        this.overlays = JSON.parse(r.stdout).overlays ?? [];
        cx.notify();
      } catch (error) {
        this.message = `Runtime status unavailable: ${error.message ?? error}`;
        this.overlays = null;
        cx.notify();
      }
    });
  }

  load(cx) {
    cx.spawn(async cx => {
      try { await this.loadData(cx); }
      catch (error) { this.scanReady = false; this.message = String(error.message ?? error); cx.notify(); }
    });
  }

  async loadData(cx) {
      this.scanReady = false;
      let layoutsReady = false;
      try {
        this.layoutTrees = await Promise.all(layouts().map(async name => ({
          name, tree: JSON.parse(await readTextFile(`${appHome()}/layouts/${name}.json`)),
        })));
        layoutsReady = true;
      } catch (error) {
        this.message = `Cannot read layout usage: ${error.message ?? error}`;
      }
      const r = await this.sh('for d in mods/*/; do n=${d#mods/}; n=${n%/}; [ -f "$d/main.js" ] || continue; '
        + 'k=0; [ -f "$d/kit.json" ] && k=1; echo "$n $k"; done; '
        + 'echo ---; cat mod-sources.json 2>/dev/null; echo ---; jq -c "keys" installed.json 2>/dev/null; '
        + 'echo ---; git status --porcelain -- mods 2>/dev/null');
      const [list, src, herdr, dirty = ""] = r.stdout.split("---\n");
      try { this.sources = JSON.parse(src || "{}"); } catch { this.sources = {}; }
      let shipped = [];
      try { shipped = JSON.parse(herdr); } catch { throw new Error("Cannot verify shipped mod registry"); }
      const changed = new Set(dirty.split("\n").filter(l => !l.startsWith("??")).map(l => l.slice(3).match(/^"?mods\/([^/"]+)/)?.[1]).filter(Boolean));
      this.mods = list.split("\n").filter(Boolean).map(l => {
        const [name, kit] = l.split(" ");
        const source = this.sources[name] ? "repo" : shipped.includes(name) ? "herdr" : "local";
        return { name, kit: kit === "1", changed: changed.has(name), source, shipped: shipped.includes(name) };
      });
      this.scanReady = false;
      try {
        // One regex pass over every mod source (rg ~30 ms, grep ~1.5 s fallback) instead of reading files through the bridge.
        const names = this.mods.map(m => m.name);
        const pattern = grepPattern(names);
        const files = await exec("rg", ["-o", "-N", "--no-heading", "--with-filename", "--no-ignore", "--hidden", "-g", "*.js", "-g", "mod.json", "-g", "kit.json", "-g", "!node_modules", "-e", pattern, "mods"], { cwd: appHome() })
          .catch(() => exec("grep", ["-rEo", "--include=*.js", "--include=mod.json", "--include=kit.json", "--exclude-dir=node_modules", pattern, "mods"], { cwd: appHome() }));
        if (files.code > 1) throw new Error(files.stderr);
        this.edges = dependencies(files.stdout, names);
        this.scanReady = layoutsReady;
      } catch (error) {
        this.message = `Usage scan incomplete: ${error.message ?? error}`;
      }
      cx.notify();
  }

  // One repo mod at a time: `update-mods.sh -n <mod>` prints "<mod>: up to date (…)" or "<mod>: <old> -> <new>".
  check(name, cx) {
    this.busy = `check:${name}`; this.message = `Checking ${name}…`; cx.notify();
    cx.spawn(async cx => {
      const r = await this.sh('./update-mods.sh -n "$1"', [name], 60000).catch(e => ({ code: 1, stdout: "", stderr: String(e) }));
      const m = r.stdout.match(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: (.*)$`, "m"));
      if (m) this.updates[name] = m[1];
      this.message = r.code || !m ? `Check of ${name} failed: ${(r.stderr || r.stdout).trim().split("\n").pop()}`
        : m[1].includes("->") ? `${name}: update available` : `${name} is up to date`;
      this.busy = null; cx.notify();
    });
  }

  update(name, cx) {
    this.busy = name; this.message = `Updating ${name}…`; cx.notify();
    cx.spawn(async cx => {
      const r = await this.sh('./update-mods.sh "$1"', [name], 180000).catch(e => ({ code: 1, stdout: "", stderr: String(e) }));
      const ok = r.code === 0 && r.stdout.includes("check passed");
      this.message = ok ? `${name} updated` : `Update of ${name} failed: ${(r.stderr || r.stdout).trim().split("\n").pop()}`;
      if (ok) this.updates[name] = "up to date";
      notify({ title: this.message, level: ok ? "success" : "error", timeout: 5000 });
      this.busy = null;
      this.load(cx);
    });
  }

  // On when it is not in the kit off-list and at least one of its blocks shows.
  state(m) {
    const bs = blocks(layout(), m.name);
    const isOff = off().includes(m.name) || (bs.length > 0 && bs.every(b => b.hidden));
    return { bs, isOff, can: bs.length > 0 || m.kit };
  }

  toggle(m) {
    const { bs, isOff } = this.state(m);
    for (const b of bs) run(isOff ? "layout.show" : "layout.hide", { id: b.id });
    if (m.kit) setShared(OFF_KEY, isOff ? off().filter(n => n !== m.name) : [...off(), m.name]);
  }
  usageIndex() {
    const info = new Map();
    const roots = [];
    const active = shared("layout");
    for (const m of this.mods) {
      const owners = this.layoutTrees.filter(({ name, tree }) => usesMod(name === active ? layout() : tree, m.name)).map(x => x.name);
      const shortcuts = keyReferences(keys(), m.name).filter(key => !key.startsWith("layout:") || this.layoutTrees.some(x => key.startsWith(`layout:${x.name}: `)));
      const tabs = panes().filter(p => p.mod === m.name).map(p => {
        const space = spaces().find(s => s.tabs.some(t => t.id === p.tab));
        const tab = space?.tabs.find(t => t.id === p.tab);
        return `${space?.name ?? "?"} / ${tab?.name || p.tab}`;
      });
      const overlay = this.overlays?.includes(m.name) || (m.name === "mod-manager" && Boolean(props()?.overlay));
      const callers = Object.entries(this.edges).filter(([, targets]) => targets.includes(m.name)).map(([name]) => name);
      if (owners.length || shortcuts.length || tabs.length || overlay || m.source === "herdr") roots.push(m.name);
      info.set(m.name, { owners, shortcuts, tabs, overlay, callers });
    }
    const used = reachable(roots, this.edges);
    for (const m of this.mods) info.get(m.name).unused = this.scanReady && this.overlays !== null && !used.has(m.name);
    return info;
  }


  render(cx) {
    const t = theme();
    if (props()?.mode === "details") return this.details(t);
    if (props()?.mode === "delete") return this.deleteDialog(t, cx);
    const counts = { all: this.mods.length };
    for (const m of this.mods) counts[m.source] = (counts[m.source] ?? 0) + 1;
    const index = this.usageIndex();
    const shown = this.mods.filter(m => this.filter === "all" || m.source === this.filter);
    return v_flex().id("mod-manager").size_full().bg(t.popover).text_size(12.5).text_color(t.foreground)
      .child(h_flex().px(14).py(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().font_semibold().text_size(13.5).child("Mod Manager"))
        .child(this.icon(t, "reload", "mods/mod-manager/refresh.svg", "Reload the mod list", Boolean(this.busy), (_e, cx) => this.load(cx)))
        .child(this.icon(t, "close", "mods/workspace-chrome/x.svg", "Close", false, () => closeOverlay(props()?.overlay))))
      .child(h_flex().px(14).py(8).gap(6)
        .children(["all", "repo", "local", "herdr"].map(f =>
          div().id(`f-${f}`).px(10).py(3).rounded(10).text_size(11.5)
            .bg(this.filter === f ? t.selected : t.surface).text_color(this.filter === f ? t.foreground : t.muted)
            .hover(s => s.bg(t.hover)).on_click((_e, cx) => { this.filter = f; cx.notify(); })
            .child(`${f[0].toUpperCase()}${f.slice(1)} ${counts[f] ?? 0}`))))
      .child(v_flex().id("mm-list").flex_1().min_h(0).overflow_y_scrollbar().px(14).pb(8).gap(6)
        .children(shown.map(m => this.row(t, m, cx, index.get(m.name)))))
      .child(div().px(14).py(8).border_t(1).border_color(t.border).text_size(11.5).text_color(t.dim)
        .child(this.message ?? (this.scanReady ? "Info shows usage. Only unreferenced non-Herdr mods can be deleted." : "Scanning usage…")));
  }

  row(t, m, cx, info) {
    const { isOff, can } = this.state(m);
    const src = this.sources[m.name];
    const upd = this.updates[m.name];
    const hasUpdate = upd?.includes("->");
    const tag = { repo: t.accent, herdr: t.dim, local: t.muted }[m.source];
    const owners = info.owners;
    const activity = usage(m.name, layout(), {
      disabled: m.kit && off().includes(m.name),
      pane: panes().some(p => p.mod === m.name),
      overlay: this.overlays?.includes(m.name) || (m.name === "mod-manager" && Boolean(props()?.overlay)),
    });
    const running = activity.startsWith("Running");
    const label = !this.scanReady ? "Scanning" : info.unused ? "Unreferenced" : running ? "Running" : m.source === "herdr" ? "System" : "Referenced";
    const color = info.unused ? t.blocked : running ? t.done : t.muted;
    const summary = [owners.length ? `Layouts: ${owners.join(", ")}` : "", info.shortcuts.length ? "Keyboard shortcut" : "", info.tabs.length ? "Open tab" : "", info.callers.length ? `Referenced by: ${info.callers.join(", ")}` : ""].filter(Boolean).join(" · ");
    return h_flex().id(`m-${m.name}`).px(10).py(8).gap(10).items_center().rounded(6).bg(t.surface).border_1().border_color(t.border)
      .child(div().w(42).flex_none().px(5).rounded(4).border_1().border_color(tag).text_size(10.5).text_color(tag).child(m.source))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(h_flex().gap(6).items_center()
          .child(div().font_semibold().truncate().text_color(isOff ? t.dim : t.foreground).child(m.name))
          .when(m.changed, el => el.child(div().text_size(10.5).text_color(t.blocked).child("edited")))
          .when(isOff, el => el.child(div().text_size(10.5).text_color(t.dim).child("off"))))
        .child(h_flex().gap(5).items_center()
          .child(svg(`mods/mod-manager/${info.unused ? "unused" : running ? "running" : "linked"}.svg`).size(12).text_color(color).tooltip(summary || label))
          .child(div().text_size(11).text_color(color).child(label))))
      .child(this.icon(t, `details-${m.name}`, "mods/mod-manager/info.svg", this.scanReady ? "Usage details" : "Scanning usage…", !this.scanReady, () => openOverlay({
        mod: "mod-manager", kind: "dialog", width: 460, height: 420,
        props: { mode: "details", name: m.name, source: m.source, repo: src, update: upd, info, activity, label, changed: m.changed },
      })))
      .child(this.icon(t, `delete-${m.name}`, "mods/mod-manager/trash.svg", m.shipped || m.source === "herdr" ? "Herdr mods cannot be deleted" : !canDelete(m, info, this.scanReady) ? "Mod is referenced or scan is incomplete" : "Delete unused mod", Boolean(this.busy) || !canDelete(m, info, this.scanReady), () => openOverlay({
        mod: "mod-manager", kind: "dialog", width: 420, height: 230,
        props: { mode: "delete", name: m.name },
      })))
      .when(Boolean(src), el => el.child(hasUpdate
        ? this.icon(t, `u-${m.name}`, "mods/mod-manager/update.svg", `Update to ${upd.split("-> ")[1].slice(0, 7)}`, Boolean(this.busy), (_e, cx) => this.update(m.name, cx), this.busy === m.name, true)
        : this.icon(t, `c-${m.name}`, "mods/mod-manager/check.svg", "Check for update", Boolean(this.busy), (_e, cx) => this.check(m.name, cx), this.busy === `check:${m.name}`)))
      .child(can ? this.switch(t, `s-${m.name}`, !isOff, () => this.toggle(m))
        : div().w(34).text_size(10.5).text_color(t.dim).child("—"));
  }
  details(t) {
    const p = props(), info = p.info;
    const tag = { repo: t.accent, herdr: t.dim, local: t.muted }[p.source];
    const status = info.unused ? t.blocked : p.label === "Running" ? t.done : t.muted;
    const chip = text => div().px(7).py(2).rounded(4).bg(t.raised).text_size(11).text_color(t.foreground).child(text);
    const pill = (text, color) => div().px(7).py(1).rounded(4).border_1().border_color(color).text_size(10.5).text_color(color).child(text);
    const repo = p.repo?.repo?.replace(/^https?:\/\/github\.com\//, "");
    const section = (icon, title, items) => h_flex().gap(10).items_start().px(12).py(10).rounded(6).bg(t.surface).border_1().border_color(t.border)
      .child(div().flex_none().p(5).rounded(5).bg(t.raised).text_color(t.muted).child(svg(`mods/mod-manager/${icon}.svg`).size(14)))
      .child(v_flex().flex_1().min_w(0).gap(5)
        .child(div().text_size(11).text_color(t.dim).child(title))
        .child(items.length ? h_flex().flex_wrap().gap(4).children(items.map(chip)) : div().text_size(11.5).text_color(t.dim).child("None")));
    const locked = p.source === "herdr" || !info.unused;
    const note = p.source === "herdr" ? "Herdr may invoke this internally. Deletion locked."
      : info.unused ? "No usage found. Dynamic or external callers may be missed." : "Referenced mod. Deletion locked.";
    return v_flex().size_full().bg(t.popover).text_color(t.foreground).text_size(12)
      .child(h_flex().px(14).py(12).gap(10).items_center().border_b(1).border_color(t.border)
        .child(div().flex_none().p(7).rounded(7).bg(t.raised).text_color(tag).child(svg("mods/mod-manager/puzzle.svg").size(18)))
        .child(v_flex().flex_1().min_w(0).gap(4)
          .child(div().font_semibold().text_size(14).truncate().child(p.name))
          .child(h_flex().gap(5).items_center()
            .child(pill(p.source, tag))
            .child(pill(p.label, status))
            .when(Boolean(p.changed), el => el.child(pill("edited", t.blocked)))))
        .child(this.icon(t, "close-details", "mods/workspace-chrome/x.svg", "Close", false, () => closeOverlay(p.overlay))))
      .child(v_flex().id("usage-details").flex_1().min_h(0).overflow_y_scrollbar().p(14).gap(8)
        .when(Boolean(repo), el => el.child(section("source", "Source", [repo, (p.repo?.commit ?? "?").slice(0, 7), ...(p.update ? [p.update] : [])])))
        .child(section("activity", "Activity", [p.activity]))
        .child(section("layout", "Layouts", info.owners))
        .child(section("keyboard", "Shortcuts", info.shortcuts))
        .child(section("tab", "Open tabs", info.tabs))
        .child(section("linked", "Referenced by mods", info.callers)))
      .child(h_flex().px(14).py(10).gap(8).items_center().border_t(1).border_color(t.border).text_size(11.5)
        .text_color(locked ? t.muted : t.blocked)
        .child(svg(`mods/mod-manager/${locked ? "lock" : "unused"}.svg`).size(13))
        .child(div().flex_1().child(note)));
  }

  deleteDialog(t, cx) {
    const name = props().name;
    const m = this.mods.find(m => m.name === name);
    const allowed = canDelete(m, this.usageIndex().get(name), this.scanReady);
    return v_flex().size_full().p(16).gap(12).bg(t.popover).text_color(t.foreground).text_size(12)
      .child(div().font_semibold().text_size(14).child(`Delete ${name}?`))
      .child(div().flex_1().child(this.message ?? "Permanently removes this mod folder. Saved mod data is kept. Dynamic callers may be missed."))
      .child(h_flex().gap(10).justify_end()
        .child(div().id("cancel-delete").px(10).py(6).on_click(() => closeOverlay(props().overlay)).child("Cancel"))
        .child(div().id("confirm-delete").px(10).py(6).rounded(4).bg(t.surface).text_color(allowed ? t.blocked : t.dim)
          .when(Boolean(allowed) && !this.busy, el => el.on_click((_e, cx) => this.removeMod(name, cx)))
          .child(this.busy ? "Deleting…" : !this.scanReady ? "Checking usage…" : allowed ? "Delete permanently" : "Deletion locked")));
  }

  removeMod(name, cx) {
    this.busy = `delete:${name}`;
    cx.notify();
    cx.spawn(async cx => {
      try {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new Error("Invalid mod name");
        const status = await exec("herdr-app", ["status"]);
        if (status.code !== 0) throw new Error("Cannot verify live usage");
        this.overlays = JSON.parse(status.stdout).overlays ?? [];
        await this.loadData(cx);
        const m = this.mods.find(m => m.name === name);
        if (!canDelete(m, this.usageIndex().get(name), this.scanReady)) throw new Error("Deletion locked: mod is used, shipped, or scan is incomplete");
        const path = `${appHome()}/mod-sources.json`;
        const expected = await readTextFile(path);
        const sources = JSON.parse(expected ?? "{}");
        const result = await exec("rm", ["-rf", "--", `${appHome()}/mods/${name}`]);
        if (result.code !== 0) throw new Error(result.stderr || "Delete failed");
        if (sources[name]) {
          delete sources[name];
          await writeTextFile(path, JSON.stringify(sources, null, 2) + "\n", expected);
        }
        setShared(OFF_KEY, off().filter(n => n !== name));
        run("mod-manager.refresh");
        notify({ title: `Deleted ${name}`, level: "success" });
        closeOverlay(props().overlay);
      } catch (error) {
        this.message = String(error.message ?? error);
      } finally { this.busy = null; cx.notify(); }
    });
  }


  // An icon button with a tooltip; `spin` while its work runs, `primary` for the row's Update.
  icon(t, id, path, tip, disabled, onClick, spin = false, primary = false) {
    return div().id(id).flex_none().p(5).rounded(5).tooltip(tip)
      .bg(primary ? t.solid : t.popover).text_color(primary ? t.solid_foreground : t.muted)
      .when(disabled && !spin, el => el.opacity(0.5))
      .when(!disabled, el => el.hover(s => s.bg(primary ? t.solid : t.hover).text_color(primary ? t.solid_foreground : t.foreground)).on_click(onClick))
      .child(spin ? svg("mods/workspace-chrome/spinner.svg").size(14).spin(900) : svg(path).size(14));
  }

  switch(t, id, on, onClick) {
    return div().id(id).flex_none().w(34).h(18).rounded(9).p(2).bg(on ? t.accent : t.input).on_click(onClick)
      .child(h_flex().size_full().when(on, el => el.justify_end())
        .child(div().size(14).rounded(7).bg(on ? t.accent_foreground : t.muted)));
  }
}
