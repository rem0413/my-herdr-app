// Mod Manager: every mod in mods/, where it comes from, on/off, and updates from its repo.
// - Source: "repo" (mod-sources.json, updated by update-mods.sh), "herdr" (installed.json), else "local".
// - On/off: hides/shows the mod's blocks in the shown layout (layout.hide/show). Mods with a kit.json
//   also follow shared "herdr-mods.disabled" (they draw nothing while listed), so they can be off with no block.
// - Updates: `update-mods.sh -n` checks, `update-mods.sh <mod>` updates (it runs herdr-app check).
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, appHome, theme, layout, run, shared, setShared, props, closeOverlay, notify } from "herdr";

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
    this.busy = null;     // "check" | mod name
    this.filter = "all";
    this.message = null;
    this.load(cx);
  }

  sh(script, args = [], timeout = 30000) {
    return exec("sh", ["-c", script, "mm", ...args], { cwd: appHome(), timeout });
  }

  load(cx) {
    cx.spawn(async cx => {
      const r = await this.sh('for d in mods/*/; do n=${d#mods/}; n=${n%/}; [ -f "$d/main.js" ] || continue; '
        + 'k=0; [ -f "$d/kit.json" ] && k=1; c=0; git diff --quiet HEAD -- "$d" 2>/dev/null || c=1; echo "$n $k $c"; done; '
        + 'echo ---; cat mod-sources.json 2>/dev/null; echo ---; jq -c "keys" installed.json 2>/dev/null');
      const [list, src, herdr] = r.stdout.split("---\n");
      try { this.sources = JSON.parse(src || "{}"); } catch { this.sources = {}; }
      let shipped = [];
      try { shipped = JSON.parse(herdr || "[]"); } catch {}
      this.mods = list.split("\n").filter(Boolean).map(l => {
        const [name, kit, changed] = l.split(" ");
        const source = this.sources[name] ? "repo" : shipped.includes(name) ? "herdr" : "local";
        return { name, kit: kit === "1", changed: changed === "1", source };
      });
      cx.notify();
    });
  }

  check(cx) {
    this.busy = "check"; this.message = "Checking repos…"; cx.notify();
    cx.spawn(async cx => {
      const r = await this.sh("./update-mods.sh -n", [], 120000).catch(e => ({ code: 1, stdout: "", stderr: String(e) }));
      this.updates = {};
      for (const line of r.stdout.split("\n")) {
        const m = line.match(/^([^:]+): (.*)$/);
        if (m) this.updates[m[1]] = m[2];
      }
      const n = Object.values(this.updates).filter(v => v.includes("->")).length;
      this.message = r.code ? `Check failed: ${r.stderr.trim()}` : n ? `${n} update${n > 1 ? "s" : ""} available` : "Every repo mod is up to date";
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

  render(cx) {
    const t = theme();
    const counts = { all: this.mods.length };
    for (const m of this.mods) counts[m.source] = (counts[m.source] ?? 0) + 1;
    const shown = this.mods.filter(m => this.filter === "all" || m.source === this.filter);
    return v_flex().id("mod-manager").size_full().bg(t.popover).text_size(12.5).text_color(t.foreground)
      .child(h_flex().px(14).py(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().font_semibold().text_size(13.5).child("Mod Manager"))
        .child(this.button(t, "check", this.busy === "check" ? "Checking…" : "Check updates", Boolean(this.busy), () => this.check(cx)))
        .child(this.button(t, "reload", "↻", Boolean(this.busy), () => this.load(cx)))
        .child(div().id("close").px(6).rounded(4).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => closeOverlay(props()?.overlay)).child("✕")))
      .child(h_flex().px(14).py(8).gap(6)
        .children(["all", "repo", "local", "herdr"].map(f =>
          div().id(`f-${f}`).px(10).py(3).rounded(10).text_size(11.5)
            .bg(this.filter === f ? t.selected : t.surface).text_color(this.filter === f ? t.foreground : t.muted)
            .hover(s => s.bg(t.hover)).on_click((_e, cx) => { this.filter = f; cx.notify(); })
            .child(`${f[0].toUpperCase()}${f.slice(1)} ${counts[f] ?? 0}`))))
      .child(v_flex().id("mm-list").flex_1().min_h(0).overflow_y_scrollbar().px(14).pb(8).gap(6)
        .children(shown.map(m => this.row(t, m, cx))))
      .child(div().px(14).py(8).border_t(1).border_color(t.border).text_size(11.5).text_color(t.dim)
        .child(this.message ?? "Off hides the mod's blocks in this layout. Updates overwrite local edits of repo mods."));
  }

  row(t, m, cx) {
    const { isOff, can } = this.state(m);
    const src = this.sources[m.name];
    const upd = this.updates[m.name];
    const hasUpdate = upd?.includes("->");
    const repo = src && src.repo.replace(/^https:\/\/github\.com\//, "");
    const tag = { repo: t.accent, herdr: t.dim, local: t.muted }[m.source];
    return h_flex().id(`m-${m.name}`).px(10).py(8).gap(10).items_center().rounded(6).bg(t.surface).border_1().border_color(t.border)
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(6).items_center()
          .child(div().font_semibold().truncate().text_color(isOff ? t.dim : t.foreground).child(m.name))
          .child(div().px(5).rounded(4).border_1().border_color(tag).text_size(10.5).text_color(tag).child(m.source))
          .when(m.changed, el => el.child(div().text_size(10.5).text_color(t.blocked).child("edited")))
          .when(isOff, el => el.child(div().text_size(10.5).text_color(t.dim).child("off"))))
        .child(div().text_size(11.5).text_color(t.dim).truncate().child(
          src ? `${repo} · ${src.ref ?? "main"} @ ${(src.commit ?? "?").slice(0, 7)}${upd ? ` · ${hasUpdate ? `new ${upd.split("-> ")[1].slice(0, 7)}` : upd}` : ""}`
            : m.source === "herdr" ? "Shipped with Herdr, updated by the app" : "Personal mod, no upstream")))
      .when(hasUpdate, el => el.child(this.button(t, `u-${m.name}`, this.busy === m.name ? "Updating…" : "Update", Boolean(this.busy), () => this.update(m.name, cx), true)))
      .child(can ? this.switch(t, `s-${m.name}`, !isOff, () => this.toggle(m))
        : div().w(34).text_size(10.5).text_color(t.dim).child("—"));
  }

  button(t, id, label, disabled, onClick, primary = false) {
    return div().id(id).px(10).py(3).rounded(5).text_size(11.5)
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .when(disabled, el => el.opacity(0.5))
      .when(!disabled, el => el.hover(s => s.bg(t.hover)).on_click(onClick))
      .child(label);
  }

  switch(t, id, on, onClick) {
    return div().id(id).flex_none().w(34).h(18).rounded(9).p(2).bg(on ? t.accent : t.input).on_click(onClick)
      .child(h_flex().size_full().when(on, el => el.justify_end())
        .child(div().size(14).rounded(7).bg(on ? t.accent_foreground : t.muted)));
  }
}
