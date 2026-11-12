// Right-click menu for a Files row (my-files opens it as a popup).
// New File / New Folder / Rename are typed inline in Files; Delete asks in file-dialog.
// props: { overlay, path (absolute), root (the tree's folder), dir, on (machine or null), space }.
// Open in apps: file-editor.json "openWith": [{ name, app }] (macOS app names for `open -a`).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, openOverlay, run, exec, readTextFile, appHome, home, theme, notify, setShared, shared } from "herdr";

const I = (n) => `mods/file-menu/icons/${n}.svg`;
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const base = (p = "") => p.split("/").pop();
const parent = (p) => p.slice(0, p.lastIndexOf("/")) || "/";
// Main menu and submenu width; Open in row top = 6 rows (30) + 1 separator (9) above it.
const MENU_W = 250, OPEN_IN_TOP = 6 * 30 + 9;
const DEFAULT_APPS = [{ name: "Cursor", app: "Cursor" }, { name: "VS Code", app: "Visual Studio Code" }, { name: "Sublime Text", app: "Sublime Text" }, { name: "Xcode", app: "Xcode" }];

export default class FileMenu extends View {
  init(_p, cx) {
    this.p = props() ?? {};
    this.sub = false; // Open in submenu shown (on hover)
    this.apps = DEFAULT_APPS;
    this.handle = cx.focus_handle(); this.handle.focus();
    cx.spawn(async (cx) => {
      const text = await readTextFile(`${appHome()}/file-editor.json`).catch(() => null);
      try { const list = JSON.parse(text ?? "{}").openWith; if (Array.isArray(list)) { this.apps = list; cx.notify(); } } catch {}
    });
  }

  close() { closeOverlay(this.p.overlay); }

  // Runs a shell script on the file's machine; reports failure as a toast.
  async sh(script, title) {
    const r = await exec("sh", ["-c", script], { on: this.p.on }).catch((e) => ({ code: 1, stderr: String(e) }));
    if (r.code !== 0) notify({ title, body: r.stderr || r.stdout, level: "error" });
    return r.code === 0;
  }

  // New File / New Folder / Rename: Files shows an inline name row (shared "files.edit").
  create(kind) {
    this.close();
    const { path, dir } = this.p;
    setShared("files.edit", kind === "rename" ? { kind, path } : { kind, folder: dir ? path : parent(path) });
  }

  openEditor(path) {
    const { space, on } = this.p, tab = (shared("editor.tabs") ?? {})[`${space}|${path}`];
    if (tab) run("tab.select", { id: tab });
    else run("tab.new", { name: base(path), space, mod: "file-editor", props: { file: path, on, space } });
  }

  copy(text, cx) { cx.write_to_clipboard(text); this.close(); }

  duplicate(cx) {
    const p = this.p.path, dot = this.p.dir ? -1 : base(p).lastIndexOf(".");
    const stem = dot > 0 ? p.slice(0, p.length - base(p).length + dot) : p, ext = dot > 0 ? base(p).slice(dot) : "";
    // "x copy.ts", then "x copy 2.ts", ... first free name.
    const script = `i=1; t=${q(stem + " copy" + ext)}; while [ -e "$t" ]; do i=$((i+1)); t=${q(stem + " copy ")}"$i"${q(ext)}; done; cp -R ${q(p)} "$t"`;
    cx.spawn(async () => { await this.sh(script, `Could not duplicate ${base(p)}`); this.close(); });
  }

  // Remote file or folder -> ~/Downloads here, as a my-files transfer job (progress and Cancel in the Files panel).
  download() {
    const { path, on } = this.p;
    this.close();
    setShared("files.job", { mode: "down", machine: on, src: path, dest: `${home()}/Downloads`, label: `↓ ${base(path)}` });
  }

  // Calculate Size: my-files runs du (this popup closes before it finishes) and shows the size by the folder.
  calcSize() { setShared("files.size", { on: this.p.on ?? null, path: this.p.path }); this.close(); }

  // Copy for Paste: a file or folder on any machine; Paste copies it into the target folder, through this
  // computer when the machines differ (transfer.sh), with cp when they are the same.
  mark() { setShared("files.clip", { on: this.p.on ?? null, path: this.p.path }); this.close(); }

  paste(cx) {
    const clip = shared("files.clip"), { path, dir, on } = this.p, folder = dir ? path : parent(path);
    this.close();
    if (!clip) return;
    const from = clip.on ?? null, to = on ?? null, label = `${base(clip.path)} → ${base(folder)}`;
    if (from === to) {
      cx.spawn(async () => { await this.sh(`t=${q(folder)}/${q(base(clip.path))}; [ ! -e "$t" ] || { echo "\${t##*/} already exists" >&2; exit 1; }; cp -R -p ${q(clip.path)} "$t"`, `Could not paste ${base(clip.path)}`); });
    } else if (!from) setShared("files.job", { mode: "up", machine: to, src: clip.path, dest: folder, label: `↑ ${label}` });
    else if (!to) setShared("files.job", { mode: "down", machine: from, src: clip.path, dest: folder, label: `↓ ${label}` });
    else setShared("files.job", { mode: "cross", machine: from, src: clip.path, dest: `${to}:${folder}`, label: `⇄ ${label}` });
  }

  openIn(app, cx) {
    this.close();
    cx.spawn(async () => { await this.sh(`open -a ${q(app.app)} ${q(this.p.path)}`, `Could not open in ${app.name}`); });
  }

  reveal(cx) { this.close(); cx.spawn(async () => { await this.sh(`open -R ${q(this.p.path)}`, "Could not reveal"); }); }

  render(cx) {
    const t = theme(), { path, root, dir, on } = this.p, local = !on;
    // set: on hover enter, open (true) or close (false) the submenu; rows hit-test exactly where the pointer is.
    const row = (id, icon, label, action, opts = {}) => h_flex().id(id).h(30).px(10).gap(10).items_center().rounded(6)
      .when(!opts.disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => action(cx)))
      .when(Boolean(opts.selected), (el) => el.bg(t.hover))
      .when(opts.set !== undefined, (el) => el.on_hover((h, cx) => { if (h && this.sub !== opts.set) { this.sub = opts.set; cx.notify(); } }))
      .text_color(opts.disabled ? t.dim : opts.danger ? t.ansi1 : t.foreground)
      .child(svg(icon).size(15).flex_none())
      .child(div().flex_1().child(label))
      .when(Boolean(opts.hint), (el) => el.child(div().text_size(11).text_color(t.dim).child(opts.hint)));
    const sep = () => div().h(1).mx(6).my(4).bg(t.border);
    // frame:"none" popup: we draw each panel's card; the submenu sits beside the main menu.
    const card = (id, ...kids) => v_flex().id(id).w(MENU_W).flex_none().p(5).bg(t.popover).border_1().border_color(t.border).rounded(10).shadow_lg().children(kids.filter(Boolean));
    const clip = shared("files.clip");

    // Hovering Open in opens the submenu, any other main row closes it; separators and the submenu keep it.
    const rel = root && path.startsWith(root + "/") ? path.slice(root.length + 1) : base(path);
    const main = card("file-menu-main",
      row("new-file", I("file-plus"), "New File", () => this.create("file"), { set: false }),
      row("new-folder", I("folder-plus"), "New Folder", () => this.create("folder"), { set: false }),
      sep(),
      row("copy-path", I("copy"), "Copy Path", (cx) => this.copy(path, cx), { set: false }),
      row("copy-rel", I("copy"), "Copy Relative Path", (cx) => this.copy(rel, cx), { set: false }),
      row("duplicate", I("duplicate"), "Duplicate", (cx) => this.duplicate(cx), { set: false }),
      row("download", I("download"), "Download", () => this.download(), { disabled: local, hint: local ? "Remote only" : null, set: false }),
      row("open-in", I("open-in"), "Open in", (cx) => { this.sub = true; cx.notify(); }, { hint: "›", selected: this.sub, set: true }),
      row("reveal", I("reveal"), "Reveal in Finder", (cx) => this.reveal(cx), { disabled: !local, hint: local ? null : "Local only", set: false }),
      sep(),
      row("copy", I("copy"), "Copy", () => this.mark(), { hint: "for Paste", set: false }),
      row("paste", I("duplicate"), clip ? `Paste ${base(clip.path)}` : "Paste", (cx) => this.paste(cx), { disabled: !clip, hint: clip && (clip.on ?? null) !== (on ?? null) ? (clip.on ?? "this Mac") : null, set: false }),
      dir ? row("size", I("app"), "Calculate Size", () => this.calcSize(), { set: false }) : null,
      sep(),
      row("rename", I("rename"), "Rename", () => this.create("rename"), { set: false }),
      row("delete", I("delete"), "Delete", () => { this.close(); openOverlay({ mod: "file-dialog", kind: "dialog", width: 560, props: { kind: "delete", path, dir, on, space: this.p.space } }); }, { danger: true, set: false }));
    const apps = card("file-menu-apps",
      // Hidden submenu is still laid out: ignore its clicks until it shows.
      ...this.apps.map((a, i) => row(`app-${i}`, a.icon ?? I("app"), a.name, (cx) => this.sub && this.openIn(a, cx), { disabled: !local, hint: local ? null : "Local only" })),
      sep(), row("apps-custom", I("rename"), "Customize apps…", () => { if (!this.sub) return; this.close(); this.openEditor(`${appHome()}/file-editor.json`); }));

    // Fixed-size root (both columns, always): the popup is sized by content, so adding the submenu
    // used to resize and move it, the pointer left Open in, the submenu closed, and it looped.
    // The submenu column is always laid out and only hidden, so nothing moves.
    return h_flex().id("file-menu").track_focus(this.handle).w(MENU_W * 2 + 4).items_start().gap(4).text_size(13)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } })
      .child(main)
      .child(div().pt(OPEN_IN_TOP).when(!this.sub, (el) => el.invisible()).child(apps));
  }
}
