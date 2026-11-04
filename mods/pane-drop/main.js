// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "pane-drop" } } } }
// Clone of the shipped `pane` header, plus: drop files on the header of a pane on another
// machine and they're uploaded to <pane cwd>/.drop-files/ there (upload.sh), then the
// remote path is pasted into that terminal (via the clipboard, no Enter).
// Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home, appHome, exec, notify } from "herdr";

const quote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class Pane extends View {
  init() { this.hovered = false; this.busy = 0; }

  drop(paths, cx) {
    const p = this.me();
    if (!p?.terminal) return;
    const m = p.pane.includes("/") ? p.pane.split("/")[0] : null;
    this.busy += paths.length;
    cx.notify();
    cx.spawn(async (cx) => {
      const out = [];
      for (const f of paths) {
        try {
          if (!m) { out.push(f); continue; }
          const r = await exec("sh", [`${appHome()}/mods/pane-drop/upload.sh`, m, p.cwd || ".", f]);
          if (r.code) throw new Error(r.stderr.trim() || `exit ${r.code}`);
          out.push(r.stdout.trim());
        } catch (e) {
          notify({ title: `Upload failed: ${f.split("/").pop()}`, body: String(e.message || e), level: "error" });
        } finally { this.busy--; cx.notify(); }
      }
      if (!out.length) return;
      // ponytail: pbcopy = macOS only and overwrites the clipboard; no API types text without Enter.
      await exec("sh", ["-c", 'printf %s "$0" | pbcopy', out.map(quote).join(" ") + " "]);
      run("pane.focus", { pane: p.pane });
      run("terminal.paste");
      if (m) notify({ title: `Uploaded ${out.length} file(s) to ${m}`, body: out.join("\n"), level: "success", timeout: 4000 });
    });
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/pane-drop/${icon}.svg`).size(14));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .on_drop((e, cx) => this.drop(e.paths, cx))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(this.busy > 0, el => el.child(div().flex_none().text_color(t.accent).child(`Uploading ${this.busy}…`)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
