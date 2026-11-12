// Confirm dialogs for files, opened with openOverlay({ mod: "file-dialog", kind: "dialog", width: 560, props }).
//   { kind: "delete", path, dir, on, space }: moves to the Trash here, deletes on a remote; closes the file's editor tab.
//   { kind: "unsaved", path, tab }: Save asks that editor tab to save and close (shared "editor.saveClose");
//     Don't Save closes the tab without saving.
// Enter = the primary button, Esc = Cancel.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, exec, theme, notify, shared, setShared, spaces } from "herdr";

const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const base = (p = "") => p.split("/").pop();

export default class FileDialog extends View {
  init(_p, cx) {
    this.p = props() ?? {};
    this.handle = cx.focus_handle(); this.handle.focus();
  }

  close() { closeOverlay(this.p.overlay); }

  remove(cx) {
    const { path, on, space } = this.p;
    if (this.busy) return; // a second click or Enter while deleting
    this.busy = true; cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", on ? `rm -rf ${q(path)}` : `trash ${q(path)}`], { on }).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) { notify({ title: `Could not delete ${base(path)}`, body: r.stderr, level: "error" }); this.busy = false; cx.notify(); return; }
      // The file's tab, or for a folder every file under it (the map also keeps closed tabs).
      const live = new Set(spaces().find((s) => s.id === space)?.tabs.map((x) => x.id));
      for (const [key, tab] of Object.entries(shared("editor.tabs") ?? {}))
        if (live.has(tab) && (key === `${space}|${path}` || key.startsWith(`${space}|${path}/`))) run("tab.close", { id: tab, confirmed: true });
      this.close();
    });
  }

  save() { setShared("editor.saveClose", { tab: this.p.tab, at: Date.now() }); this.close(); }
  discard() { run("tab.close", { id: this.p.tab, confirmed: true }); this.close(); }

  render() {
    const t = theme(), p = this.p, del = p.kind === "delete";
    const button = (id, label, style, action) => h_flex().id(id).h(36).px(16).items_center().justify_center().rounded(10).cursor_pointer()
      .text_size(13).font_medium()
      .when(style === "danger", (el) => el.bg(t.blocked).text_color(t.background).hover((s) => s.opacity(0.88)))
      .when(style === "primary", (el) => el.bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.88)))
      .when(style === "plain", (el) => el.border_1().border_color(t.input).bg(t.raised).text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => action(cx)).child(label);
    const body = del
      ? (p.on ? `will be deleted for good on ${p.on}. This can't be undone.` : p.dir ? "and everything in it will be moved to the Trash." : "will be moved to the Trash.")
      : "has unsaved changes. Do you want to save before closing?";
    const title = del ? `Delete ${p.dir ? "Folder" : "File"}` : "Unsaved Changes";
    const primary = del ? (cx) => this.remove(cx) : () => this.save();

    // Sized by content: the overlay is as tall as this; no flex_1 gap between text and buttons.
    return v_flex().id("file-dialog").track_focus(this.handle).w_full().relative().pl(28).pr(28).pt(26).pb(24).bg(t.popover)
      .on_key_down((e, cx) => {
        // A remote delete can't be undone (no Trash there): only a click on Delete does it.
        if (e.key === "enter") { if (!(del && p.on)) primary(cx); } else if (e.key === "escape") this.close(); else return;
        cx.stop_propagation();
      })
      .child(div().id("fd-x").absolute().top(14).right(14).size(28).flex().items_center().justify_center().rounded(8).cursor_pointer().text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.close()).child(svg("mods/file-dialog/close.svg").size(16)))
      .child(div().pr(28).text_size(15).font_semibold().text_color(t.foreground).child(title))
      .child(div().pt(8).text_size(13).line_height(1.45).text_color(t.muted).child(`"${base(p.path)}" ${body}`))
      .child(h_flex().pt(20).gap(10).justify_end()
        .child(button("fd-cancel", "Cancel", "plain", () => this.close()))
        .when(!del, (el) => el.child(button("fd-discard", "Don't Save", "plain", () => this.discard())))
        .child(button("fd-ok", del ? (this.busy ? "Deleting…" : "Delete") : "Save", del ? "danger" : "primary", primary)));
  }
}
