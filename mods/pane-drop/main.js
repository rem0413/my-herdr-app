// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "pane-drop" } } } }
// Clone of the shipped `pane` header, plus: drop files on the header of a pane on another
// machine and they're uploaded to <pane cwd>/.drop-files/ there (upload.sh), then the
// remote path is pasted into that terminal (via the clipboard, no Enter).
// Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home, appHome, exec, notify, shared, openOverlay } from "herdr";

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

  // action: instead of run(command, args) (an unsaved editor pane asks first).
  button(t, id, icon, command, args, action) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        action ? action() : run(command, args);
      })
      .child(svg(`mods/pane-drop/${icon}.svg`).size(14));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    // file-editor panes: the file's name and folder (shared by file-editor), its git letter and unsaved dot.
    const file = p.mod === "file-editor" ? Object.entries(shared("editor.tabs") ?? {}).find(([, id]) => id === p.tab)?.[0].split("|").slice(1).join("|") : null;
    const edit = file ? (shared("editor.state") ?? {})[p.tab] : null;
    const gitColor = edit?.git === "U" || edit?.git === "A" ? "#73c991" : edit?.git === "D" || edit?.git === "!" ? "#e06c75" : "#e5a54b";
    const name = file ? file.split("/").pop() : ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = file ? (edit?.icon?.tint === false ? image(edit.icon.path).w(14).h(14).flex_none() : svg(edit?.icon?.path ?? "mods/my-files/icons/file.svg").size(14).flex_none().text_color(edit?.icon?.color ?? t.dim)) : icon(p.program, 14, t.dim);
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
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(edit?.git ? gitColor : t.foreground)
        .when(Object.values(shared("editor.preview") ?? {}).includes(p.tab), (el) => el.italic()).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(file ? folder(file.slice(0, file.lastIndexOf("/")) || "/") : folder(p.cwd)))
      .when(Boolean(edit?.git), el => el.child(div().flex_none().text_color(gitColor).child(edit.git)))
      .when(Boolean(edit?.dirty), el => el.child(div().size(7).flex_none().rounded(4).bg(t.foreground)))
      .when(this.busy > 0, el => el.child(div().flex_none().text_color(t.accent).child(`Uploading ${this.busy}…`)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(edit?.dirty
          ? this.button(t, `ph-x-${pane}`, "close", "mod.open", null, () => openOverlay({ mod: "file-dialog", kind: "dialog", width: 560, props: { kind: "unsaved", path: file, tab: p.tab } }))
          : this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
