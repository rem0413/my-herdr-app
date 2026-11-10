// A lazy file browser for the focused pane's folder; clicking a file opens it in the file-editor tab.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, window, run, shared, setShared, readTextFile, appHome, notify, openOverlay } from "herdr";
import { iconFor } from "./icons.js";

// A focused mod pane (the editor tab) keeps the last folder.
let last = {};
function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  if (pane?.mod) return last.space === space?.id ? last : last = { cwd: space?.folder, on: space?.machine ?? null, space: space?.id };
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return last = { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());

// One tab per file (file-editor), reused through shared("editor.tabs"). The tab gets its icon in props.
// Images open in image-viewer instead, reusing a viewer tab with the same name. The viewer reads
// local files only, so a remote image is first copied to /tmp/herdr-remote-img/<machine>/<path>.
// The viewer stages its own copy within seconds, so each remote open sweeps copies older than 1 hour.
// ponytail: reuse matches tab name (run() returns no tab id); same-named images in other folders reuse it. Track ids if that bites.
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?)$/i;
function openImage(space, file, name) {
  const tabs = spaces().find(s => s.id === space)?.tabs ?? [];
  const hit = panes().find(p => p.mod === "image-viewer" && tabs.some(x => x.id === p.tab && x.name === name));
  if (hit) run("tab.select", { id: hit.tab });
  else run("tab.new", { name, space, mod: "image-viewer", props: { file } });
}
function openFile(space, path, on, icon) {
  const name = path.split("/").pop();
  if (IMAGE.test(path)) {
    if (!on) return openImage(space, path, name);
    const dir = "/tmp/herdr-remote-img", local = `${dir}/${on}${path}`;
    const script = 'find "$4" -type f -mmin +60 -delete 2>/dev/null; find "$4" -type d -empty -delete 2>/dev/null; mkdir -p "$(dirname "$3")" && hc exec --on "$1" -- cat -- "$2" > "$3"';
    exec("sh", ["-c", script, "img", on, path, local, dir], { timeout: 60000 })
      .then(r => r.code === 0 ? openImage(space, local, name) : Promise.reject(new Error(r.stderr.trim() || "copy failed")))
      .catch(e => notify({ title: `Cannot open ${name} from ${on}`, body: String(e?.message ?? e), level: "error" }));
    return;
  }
  const tab = (shared("editor.tabs") ?? {})[`${space}|${path}`];
  if (tab && spaces().some(s => s.id === space && s.tabs.some(x => x.id === tab))) run("tab.select", { id: tab });
  else run("tab.new", { name, space, mod: "file-editor", props: { file: path, on, space, icon } });
}
// The file whose editor tab is shown in that space.
function shownFile(space) {
  const tab = spaces().find(s => s.id === space)?.tabs.find(x => x.active)?.id;
  const hit = Object.entries(shared("editor.tabs") ?? {}).find(([, id]) => id === tab);
  return hit && hit[0].slice(space.length + 1);
}
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  if (!on && window()?.platform === "windows") {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Reparse points keep directory attributes even when dangling; check their target.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replaceAll("'", "''") + "'"]);
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  }
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
    this.loadConfig(cx);
    cx.timer.every(2000, cx => this.loadConfig(cx));
    // New File / New Folder / Rename from file-menu (shared "files.edit"); InputState needs a callback cx.
    cx.timer.every(100, cx => { const req = shared("files.edit"); if (req && JSON.stringify(req) !== JSON.stringify(this.editReq)) this.startEdit(req, cx); });
  }

  // ~/.config/herdr-app/file-editor.json "icons" (file-editor reads the same file for syntax).
  loadConfig(cx) {
    cx.spawn(async cx => {
      const text = await readTextFile(`${appHome()}/file-editor.json`).catch(() => null);
      if (text === this.configText) return;
      this.configText = text;
      try { this.config = text ? JSON.parse(text) : {}; }
      catch (e) { notify({ title: "file-editor.json is invalid", body: String(e), level: "error" }); return; }
      cx.notify();
    });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (entries.length) {
      // Git handles nested rules, negations, global excludes and tracked files.
      const ignored = await exec("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z", "--", ...entries.map(entry => `:(literal)${entry.name}`)], { cwd: path ? `${root}/${path}` : root, on }).catch(() => null);
      const names = new Set(ignored?.code === 0 ? ignored.stdout.split("\0").map(name => name.replace(/\/$/, "")) : []);
      for (const entry of entries) entry.ignored = names.has(".") || names.has(entry.name);
    }
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on, space: location().space }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2), mark = xy === "??" ? "U" : xy.includes("U") ? "!" : xy.includes("A") ? "A" : xy.includes("D") ? "D" : "M";
            const file = `${top.stdout.trim()}/${entry.slice(3).replace(/\/$/, "")}`;
            marks[file] = mark;
            // Folders carry their contents' mark: one kind shows it, mixed shows M.
            for (let d = file.slice(0, file.lastIndexOf("/")); d.length > top.stdout.trim().length; d = d.slice(0, d.lastIndexOf("/")))
              marks[d] = !marks[d] || marks[d] === mark ? mark : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  // Inline name row for New File / New Folder (in that folder, after its entries) and Rename (in place).
  // The menu asks through shared("files.edit"); the input is made in a task (not legal in render).
  startEdit(req, cx) {
    this.editReq = req;
    cx.spawn(async cx => {
      const rel = (p) => p === this.root ? "" : p.startsWith(this.root + "/") ? p.slice(this.root.length + 1) : null;
      const folder = req.kind === "rename" ? req.path.slice(0, req.path.lastIndexOf("/")) : req.folder;
      const at = rel(folder);
      if (at === null) { setShared("files.edit", null); return; }
      if (at && !this.folders.has(at)) this.toggle(at, cx);
      const value = req.kind === "rename" ? req.path.split("/").pop() : "";
      this.input?.release?.();
      this.input = InputState.new({ value });
      const dot = value.lastIndexOf(".");
      if (value) this.input.set_selected_range({ start: 0, end: dot > 0 ? dot : value.length });
      this.input.on("submit", (_e, cx) => this.commitEdit(cx));
      this.input.on("blur", (_e, cx) => { if (this.edit && !this.editBusy) this.cancelEdit(cx); });
      this.edit = { ...req, at, editError: null };
      cx.notify();
      cx.timer.after(50, () => this.input?.focus());
    });
  }

  cancelEdit(cx) { this.edit = null; this.editReq = null; setShared("files.edit", null); cx.notify(); }

  commitEdit(cx) {
    const e = this.edit, name = this.input.value().trim();
    if (!e) return;
    if (!name || name === e.path?.split("/").pop()) return this.cancelEdit(cx);
    if (name.includes("/") || name === "." || name === "..") { e.editError = "No / in names"; cx.notify(); return; }
    const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`, dir = e.at ? `${this.root}/${e.at}` : this.root, target = `${dir}/${name}`;
    const script = e.kind === "file" ? `[ ! -e ${q(target)} ] && : > ${q(target)}`
      : e.kind === "folder" ? `[ ! -e ${q(target)} ] && mkdir ${q(target)}`
      : `[ ! -e ${q(target)} ] && mv ${q(e.path)} ${q(target)}`;
    this.editBusy = true;
    cx.spawn(async cx => {
      const r = await exec("sh", ["-c", script], { on: this.on }).catch(err => ({ code: 1, stderr: String(err) }));
      this.editBusy = false;
      if (r.code !== 0) { e.editError = r.stderr.trim() || `${name} already exists`; this.input.focus(); cx.notify(); return; }
      this.cancelEdit(cx);
      this.refresh(cx);
      if (e.kind === "file") openFile(this.context.space, target, this.on, iconFor(name, false, this.config));
    });
  }

  editRow(depth, t) {
    const e = this.edit;
    return v_flex().id("file-edit").flex_none()
      .child(h_flex().h(30).pl(8 + depth * 18).pr(4).gap(7).items_center()
        .child(div().w(12).flex_none())
        .child(svg(iconFor(this.input.value() || (e.kind === "folder" ? "x" : ""), e.kind === "folder", this.config).path).size(14).flex_none().text_color(t.muted))
        .child(Input.new(this.input).flex_1().h(26).px(6).rounded(6).border_1().border_color(e.editError ? "#e06c75" : t.input).bg(t.background).text_size(13).text_color(t.foreground)
          .on_key_down((ev, cx) => { if (ev.key === "escape") { this.cancelEdit(cx); cx.stop_propagation(); } })))
      .when(Boolean(e.editError), el => el.child(div().pl(8 + depth * 18 + 40).pb(4).text_size(11).text_color("#e06c75").child(e.editError)));
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      if (this.edit?.kind === "rename" && this.edit.path === `${this.root}/${path}`) { out.push(this.editRow(depth, t)); continue; }
      const active = !entry.dir && this.shown === `${this.root}/${path}`;
      const color = mark === "U" || mark === "A" ? "#73c991" : mark === "D" || mark === "!" ? "#e06c75" : "#e5a54b";
      // Ignored entries mute both the file-type icon and the name.
      const icon = iconFor(entry.name, entry.dir, this.config);
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .when(active, el => el.bg(t.selected))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : openFile(this.context.space, `${this.root}/${path}`, this.on, icon))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "file-menu", kind: "popup", frame: "none", width: 510, height: 420,
          props: { path: `${this.root}/${path}`, root: this.root, dir: entry.dir, on: this.on, space: this.context.space } }); })
        .child(entry.dir ? svg(`mods/my-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(icon.path).size(14).flex_none().text_color(entry.ignored ? t.dim : icon.color ?? t.muted))
        .child(div().flex_1().min_w(0).truncate().text_color(entry.ignored ? t.dim : mark ? color : t.foreground).when(entry.ignored, el => el.italic()).child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(color).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    // New entry row goes at the end of its folder's entries.
    if (this.edit && this.edit.kind !== "rename" && this.edit.at === prefix) out.push(this.editRow(depth, t));
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    this.shown = shownFile(this.context.space);
    const req = shared("files.edit");
    // Cleared elsewhere (another copy committed or cancelled): drop this row too.
    if (!req && this.edit && !this.editBusy) { this.edit = null; this.editReq = null; }
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.root?.split(/[\\/]/).pop() ?? "")))
      .child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))));
  }
}
