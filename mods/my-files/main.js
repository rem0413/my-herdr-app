// A lazy file browser for the focused pane's folder; clicking a file opens it in the file-editor tab.
// Rows are plain retained elements (hover is native; a virtual list re-runs JS per frame and stutters).
// Icons are Material Icon Theme (icons.js); file sizes come with the listing, folder sizes from the menu's
// Calculate Size (shared "files.size" request, run here: the menu popup is gone before du finishes).
// Search (header field) matches every file under the root (git ls-files, else find), cached per root.
// Drop files from Finder onto the tree: copied here, uploaded to a remote machine (transfer.sh job).
// Jobs (upload, download, machine-to-machine copy): shared "files.jobs", started by this mod or file-menu.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, hc, watchFolder, theme, settings, window, run, shared, setShared, readTextFile, appHome, notify, openOverlay } from "herdr";
import { iconFor } from "./icons.js";
import { matchFiles, bytes, parseListing } from "./search.js";

const ME = "mods/my-files";
const ROW = 26, SHOW_MATCHES = 200; // plain rows: keep search results bounded so each render stays cheap
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const base = (p) => p.split("/").pop();

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

// One tab per file (file-editor, which also shows pictures and previews Markdown/SVG/PDF), reused through
// shared("editor.tabs"). A single click opens a preview tab (italic) that the next single click replaces;
// a double click keeps it (shared "editor.preview" lists each space's preview tab, file-editor owns it).
// Two open files with one name get "folder/name" tabs.
function tabName(space, path) {
  const name = path.split("/").pop();
  const open = new Set(spaces().find(s => s.id === space)?.tabs.map(x => x.id));
  const clash = Object.entries(shared("editor.tabs") ?? {})
    .some(([k, id]) => open.has(id) && k.startsWith(`${space}|`) && k !== `${space}|${path}` && k.endsWith(`/${name}`));
  return clash ? path.split("/").slice(-2).join("/") : name;
}
function openFile(space, path, on, icon, { keep = false } = {}) {
  const key = `${space}|${path}`;
  const live = (id) => id && spaces().some(s => s.id === space && s.tabs.some(x => x.id === id));
  const previewTab = (shared("editor.preview") ?? {})[space];
  const tab = (shared("editor.tabs") ?? {})[key];
  const keepIt = () => {
    const map = { ...(shared("editor.preview") ?? {}) };
    if (map[space] === tab) { delete map[space]; setShared("editor.preview", map); }
    else if (!live(tab)) setShared("editor.keep", key); // its tab is still opening: keep it when it registers
  };
  if (live(tab)) { run("tab.select", { id: tab }); if (keep) keepIt(); return; }
  // A clean preview tab gives way to the new one (file-editor promotes it on the first edit).
  const prev = live(previewTab) && (shared("editor.state") ?? {})[previewTab];
  if (prev && !prev.dirty) run("tab.close", { id: previewTab, confirmed: true });
  run("tab.new", { name: tabName(space, path), space, mod: "file-editor", props: { file: path, on, space, icon, preview: !keep } });
}
// The file whose editor tab is shown in that space.
function shownFile(space) {
  const tab = spaces().find(s => s.id === space)?.tabs.find(x => x.active)?.id;
  const hit = Object.entries(shared("editor.tabs") ?? {}).find(([, id]) => id === tab);
  return hit && hit[0].slice(space.length + 1);
}
const PER_FOLDER = 500, TOTAL = 5000, INDEX_MAX = 100000, INDEX_AGE = 30000;

// Kinds and names, then the sizes of the regular files (one stat call), parsed by parseListing.
const LIST = `d=$1; n=0; shift
for p in "$d"/* "$d"/.[!.]* "$d"/..?*; do
  [ -e "$p" ] || [ -L "$p" ] || continue
  name=\${p##*/}; [ "$name" = .git ] && continue
  if [ -d "$p" ]; then k=d; elif [ -f "$p" ]; then k=f; set -- "$@" "$p"; else k=o; fi
  printf '%s\\0%s\\0' "$k" "$name"; n=$((n+1)); [ "$n" -gt ${PER_FOLDER} ] && break
done
test -d "$d" || exit 1
[ $# -eq 0 ] && exit 0
if stat -c %s / >/dev/null 2>&1; then stat -L -c %s -- "$@"; else stat -L -f %z -- "$@"; fi 2>/dev/null | while read -r s; do printf 's\\0%s\\0' "$s"; done
exit 0`;

async function directory(path, on) {
  if (!on && window()?.platform === "windows") {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Reparse points keep directory attributes even when dangling; check their target.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; size=$(if ($_.PSIsContainer) { $null } else { $_.Length }); dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replaceAll("'", "''") + "'"]);
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  }
  const r = await exec("sh", ["-c", LIST, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  return parseListing(r.stdout);
}

// Every file under the root, relative to it: git's view when it is a repo (tracked + untracked, not ignored).
const INDEX = `if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git -c core.quotepath=off ls-files -co --exclude-standard -z
else find . \\( -name .git -o -name node_modules \\) -prune -o -type f -print0; fi | head -c 7000000`;

// A transfer.sh job in a core terminal (outlives this panel); file-menu starts them the same way.
async function startJob(mode, machine, src, dest, label) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const status = `${appHome()}/data/my-files/jobs/${id}.status`;
  await exec("mkdir", ["-p", `${appHome()}/data/my-files/jobs`]);
  const r = await hc(["run", "--bg", "--no-parent", "--rm", "--json", "--", "sh", `${appHome()}/${ME}/transfer.sh`, mode, machine, src, dest, status]);
  if (r.code !== 0) throw new Error(r.stderr || "Cannot start the transfer");
  const term = JSON.parse(r.stdout).address;
  setShared("files.jobs", [...(shared("files.jobs") ?? []), { id, term, status, mode, label, state: "running", bytes: 0, total: 0 }]);
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.icons = new Map(); this.dirSizes = new Map(); // dirSizes: absolute folder path -> bytes or "…"
    this.search = InputState.new({ placeholder: "Search files…" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value(); this.ensureIndex(cx); cx.notify(); });
    this.search.on("submit", (_e, cx) => { const f = this.results?.files[0]; if (f) this.openRel(f, true); });
    this.query = "";
    this.refresh(cx);
    // Local folders refresh on watch; remote ones every 10 s while the window is in front.
    cx.timer.every(10000, cx => { if ((this.on || !this.watched) && window()?.active !== false) this.refresh(cx); });
    this.loadConfig(cx);
    cx.timer.every(2000, cx => this.loadConfig(cx));
    // file-menu asks through shared state: "files.edit" (New File / New Folder / Rename, the input needs
    // a callback cx), "files.size" ({ on, path }: Calculate Size) and "files.job" ({ mode, machine, src, dest, label }).
    cx.timer.every(100, cx => {
      const req = shared("files.edit");
      if (req && JSON.stringify(req) !== JSON.stringify(this.editReq)) this.startEdit(req, cx);
      const size = shared("files.size");
      if (size) { setShared("files.size", null); this.calcSize(size, cx); }
      const job = shared("files.job");
      if (job) {
        setShared("files.job", null);
        cx.spawn(async () => startJob(job.mode, job.machine, job.src, job.dest, job.label)
          .catch(e => notify({ title: `${job.label} failed`, body: String(e?.message ?? e), level: "error" })));
      }
    });
    cx.timer.every(500, cx => this.pollJobs(cx));
  }

  // ~/.config/herdr-app/file-editor.json "icons" (file-editor reads the same file for syntax).
  loadConfig(cx) {
    cx.spawn(async cx => {
      const text = await readTextFile(`${appHome()}/file-editor.json`).catch(() => null);
      if (text === this.configText) return;
      this.configText = text;
      try { this.config = text ? JSON.parse(text) : {}; }
      catch (e) { notify({ title: "file-editor.json is invalid", body: String(e), level: "error" }); return; }
      this.icons.clear();
      cx.notify();
    });
  }

  icon(rel, dir, open) {
    const dark = settings().dark !== false, k = `${dark ? 1 : 0}${dir ? 1 : 0}${open ? 1 : 0}${rel}`;
    let hit = this.icons.get(k);
    if (!hit) { hit = iconFor(rel, dir, this.config, { open, dark }); this.icons.set(k, hit); }
    return hit;
  }

  // du on the folder's machine; the result shows next to the folder until the tree reloads it.
  calcSize({ on, path }, cx) {
    this.dirSizes.set(path, "…");
    cx.notify();
    cx.spawn(async cx => {
      const r = await exec("sh", ["-c", 'du -sk "$1" 2>/dev/null | cut -f1', "du", path], { on, timeout: 300000 }).catch(e => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
      const kb = Number(r.stdout.trim());
      if (r.stdout.trim() && kb >= 0) this.dirSizes.set(path, kb * 1024);
      else { this.dirSizes.delete(path); notify({ title: `Could not size ${base(path)}`, body: r.stderr.trim(), level: "error" }); }
      cx.notify();
    });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) { this.index = null; this.refresh(cx); } } }
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
    const { cwd, on, space } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on, space }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.watched = null; this.error = null; this.limited = false;
      this.loading = false; this.index = null;
    }
    // A change or a new place drops the index; an active search rebuilds it at once.
    this.ensureIndex(cx);
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        // Open folders load side by side; a failed subfolder (gone meanwhile) does not hide the rest.
        await this.loadFolder("", context);
        await Promise.all([...this.folders].map(path => this.loadFolder(path, context).catch(() => null)));
        if (!this.current(context)) return;
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          const repo = top.stdout.trim();
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2), mark = xy === "??" ? "U" : xy.includes("U") ? "!" : xy.includes("A") ? "A" : xy.includes("D") ? "D" : "M";
            const file = `${repo}/${entry.slice(3).replace(/\/$/, "")}`;
            marks[file] = mark;
            // Folders carry their contents' mark: one kind shows it, mixed shows M.
            for (let d = file.slice(0, file.lastIndexOf("/")); d.length > repo.length; d = d.slice(0, d.lastIndexOf("/")))
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

  // ---- search

  ensureIndex(cx) {
    if (!this.query.trim() || !this.root) return;
    const context = this.context;
    if (this.indexing || (this.index?.key === context.key && Date.now() - this.index.at < INDEX_AGE)) return;
    this.indexing = true;
    cx.spawn(async cx => {
      try {
        const r = await exec("sh", ["-c", INDEX], { cwd: context.cwd, on: context.on, timeout: 60000 });
        const files = r.stdout.split("\0").filter(Boolean).slice(0, INDEX_MAX).map(p => p.startsWith("./") ? p.slice(2) : p);
        if (this.context === context) this.index = { key: context.key, at: Date.now(), files, lower: files.map(f => f.toLowerCase()), capped: r.stdout.length >= 7000000 || files.length >= INDEX_MAX };
      } catch (e) { if (this.context === context) this.error = `Search: ${e?.message ?? e}`; }
      finally { this.indexing = false; this.memo = null; if (this.context !== context) this.ensureIndex(cx); cx.notify(); }
    });
  }

  clearSearch(cx) { this.search.set_value(""); this.query = ""; cx.notify(); }

  openRel(rel, keep) {
    openFile(this.context.space, `${this.root}/${rel}`, this.on, this.icon(rel, false, false), { keep });
  }

  // ---- inline edits (New File / New Folder / Rename), typed in a bar above the tree

  startEdit(req, cx) {
    this.editReq = req;
    cx.spawn(async cx => {
      const rel = (p) => p === this.root ? "" : p.startsWith(this.root + "/") ? p.slice(this.root.length + 1) : null;
      const folder = req.kind === "rename" ? req.path.slice(0, req.path.lastIndexOf("/")) : req.folder;
      const at = rel(folder);
      if (at === null) { setShared("files.edit", null); return; }
      if (at && !this.folders.has(at)) this.toggle(at, cx);
      const value = req.kind === "rename" ? base(req.path) : "";
      this.input?.release?.();
      this.input = InputState.new({ value, placeholder: req.kind === "folder" ? "Folder name" : "File name" });
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
    const dir = e.at ? `${this.root}/${e.at}` : this.root, target = `${dir}/${name}`;
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
      if (e.kind === "file") openFile(this.context.space, target, this.on, iconFor(name, false, this.config, { dark: settings().dark !== false }), { keep: true });
    });
  }

  editBar(t) {
    const e = this.edit, where = e.kind === "rename" ? `Rename ${base(e.path)}` : `New ${e.kind} in ${e.at || base(this.root)}/`;
    return v_flex().flex_none().px(10).py(6).gap(4).border_b(1).border_color(t.border)
      .child(div().text_size(11).text_color(t.dim).truncate().child(where))
      .child(Input.new(this.input).h(26).px(6).rounded(6).border_1().border_color(e.editError ? "#e06c75" : t.input).bg(t.background).text_size(13).text_color(t.foreground))
      .when(Boolean(e.editError), el => el.child(div().text_size(11).text_color("#e06c75").child(e.editError)));
  }

  // ---- drop, jobs

  drop(paths, cx) {
    if (!paths?.length || !this.root) return;
    const folder = this.root, on = this.on;
    cx.spawn(async cx => {
      for (const src of paths) {
        try {
          if (on) await startJob("up", on, src, folder, `↑ ${base(src)}`);
          else {
            const r = await exec("sh", ["-c", '[ ! -e "$2/${1##*/}" ] || { echo "${1##*/} already exists" >&2; exit 1; }; cp -R -p "$1" "$2/"', "drop", src, folder]);
            if (r.code !== 0) notify({ title: `Not copied: ${base(src)}`, body: r.stderr.trim(), level: "error" });
          }
        } catch (e) { notify({ title: `Not uploaded: ${base(src)}`, body: String(e?.message ?? e), level: "error" }); }
      }
      if (!on) this.refresh(cx);
    });
  }

  pollJobs(cx) {
    const jobs = shared("files.jobs") ?? [];
    if (!jobs.some(j => j.state === "running") && !jobs.some(j => j.ended && Date.now() - j.ended > 5000)) return;
    if (this.polling) return;
    this.polling = true;
    cx.spawn(async cx => {
      try {
        let changed = false;
        const next = [];
        for (const j of jobs) {
          if (j.ended) { if (Date.now() - j.ended > 5000) { changed = true; continue; } next.push(j); continue; }
          const text = await readTextFile(j.status).catch(() => null);
          const s = Object.fromEntries((text ?? "").split("\n").filter(Boolean).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
          let state = s.state ?? "running";
          // The terminal is gone without a final word: it was killed before its trap ran.
          if (state === "running" && Date.now() - (j.seen ?? 0) > 3000) {
            const alive = await hc(["ls", "--json"]).then(r => r.stdout.includes(`"${j.term}"`)).catch(() => true);
            if (!alive) state = j.cancel ? "cancelled" : "failed";
          }
          const n = { ...j, state, bytes: Number(s.bytes) || 0, total: Number(s.total) || 0, dest: s.dest || j.dest, msg: s.msg || j.msg, seen: state === "running" && Date.now() - (j.seen ?? 0) > 3000 ? Date.now() : j.seen };
          if (state !== "running") {
            n.ended = Date.now();
            exec("rm", ["-f", j.status]).catch(() => null);
            notify(state === "done" ? { title: `${j.label} done`, body: n.dest, level: "success", timeout: 3000 }
              : state === "cancelled" ? { title: `${j.label} cancelled`, timeout: 3000 } : { title: `${j.label} failed`, body: n.msg, level: "error" });
            if (j.mode !== "down" && this.on) this.refresh(cx);
          }
          if (JSON.stringify(n) !== JSON.stringify(j)) changed = true;
          next.push(n);
        }
        // Another copy may have changed the list meanwhile: keep jobs it added.
        const now = shared("files.jobs") ?? [];
        if (changed) setShared("files.jobs", [...next, ...now.filter(j => !jobs.some(o => o.id === j.id))]);
      } finally { this.polling = false; }
    });
  }

  cancelJob(job) {
    setShared("files.jobs", (shared("files.jobs") ?? []).map(j => j.id === job.id ? { ...j, cancel: true } : j));
    hc(["kill", job.term]).catch(() => null);
  }

  jobRows(t) {
    const jobs = shared("files.jobs") ?? [];
    return v_flex().flex_none().px(10).py(6).gap(6).border_t(1).border_color(t.border).text_size(11.5)
      .children(jobs.map(j => {
        const pct = j.total > 0 ? Math.min(100, Math.round(j.bytes / j.total * 100)) : 0;
        const color = j.state === "failed" ? "#e06c75" : j.state === "done" ? "#73c991" : t.accent;
        const info = j.state === "running" ? (j.total ? `${bytes(j.bytes)} / ${bytes(j.total)}` : "Packing…") : j.state;
        return v_flex().gap(3)
          .child(h_flex().gap(6).items_center()
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(j.label))
            .child(div().flex_none().text_color(t.dim).child(info))
            .when(j.state === "running", el => el.child(div().id(`job-x-${j.id}`).flex_none().cursor_pointer().text_color(t.dim).hover(s => s.text_color("#e06c75")).tooltip("Cancel")
              .on_click(() => this.cancelJob(j)).child(svg(`${ME}/circle-x.svg`).size(13)))))
          .child(h_flex().h(3).rounded(2).bg(t.border).overflow_hidden()
            .child(div().h_full().flex_grow(j.state === "running" ? pct : 100).bg(color))
            .child(div().h_full().flex_grow(j.state === "running" ? 100 - pct : 0)));
      }));
  }

  // ---- rows (plain data; drawn by the virtual list)

  flatten(prefix, depth, out) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path);
      out.push({ key: path, path, entry, depth, open });
      if (entry.dir && open) this.flatten(path, depth + 1, out);
    }
    return out;
  }

  sizeOf(row) {
    if (!row.entry.dir) return bytes(row.entry.size);
    const s = this.dirSizes.get(`${this.root}/${row.path}`);
    return s === "…" ? "…" : bytes(s);
  }

  rowMenu(path, dir) {
    return (_e, cx) => {
      cx.stop_propagation();
      openOverlay({ mod: "file-menu", kind: "popup", frame: "none", width: 510, height: 520,
        props: { path: `${this.root}/${path}`, root: this.root, dir, on: this.on, space: this.context.space } });
    };
  }

  treeRow(row, t) {
    const { entry, path, depth, open } = row, abs = `${this.root}/${path}`, mark = this.marks[abs];
    const active = !entry.dir && this.shown === abs, preview = active && this.previewShown;
    const color = mark === "U" || mark === "A" ? "#73c991" : mark === "D" || mark === "!" ? "#e06c75" : "#e5a54b";
    const icon = this.icon(path, entry.dir, open), size = this.showSizes ? this.sizeOf(row) : "";
    return h_flex().id(`f-${path}`).h(ROW).flex_none().pl(8 + depth * 16).pr(8).gap(6).items_center().rounded(6).cursor_pointer().hover(s => s.bg(t.hover))
      .when(active, el => el.bg(t.selected))
      .on_click((e, cx) => entry.dir ? this.toggle(path, cx) : this.openRel(path, e.click_count >= 2))
      .on_mouse_down("right", this.rowMenu(path, entry.dir))
      .child(entry.dir ? svg(`${ME}/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
      .child(icon.tint ? svg(icon.path).size(15).flex_none().text_color(entry.ignored ? t.dim : icon.color ?? t.muted)
        : image(icon.path).size(15).flex_none().when(entry.ignored, el => el.opacity(0.5)))
      .child(div().flex_1().min_w(0).truncate().text_color(entry.ignored || preview ? t.dim : mark ? color : t.foreground).when(entry.ignored || preview, el => el.italic()).child(entry.name))
      .when(Boolean(size), el => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(size)))
      .when(Boolean(mark), el => el.child(div().flex_none().w(10).text_size(11).text_color(color).child(mark)));
  }

  resultRow(rel, t) {
    const name = base(rel), dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "", icon = this.icon(rel, false, false);
    const active = this.shown === `${this.root}/${rel}`;
    return h_flex().id(`r-${rel}`).h(ROW).flex_none().px(8).gap(7).items_center().rounded(6).cursor_pointer().hover(s => s.bg(t.hover))
      .when(active, el => el.bg(t.selected))
      .on_click((e) => this.openRel(rel, e.click_count >= 2))
      .on_mouse_down("right", this.rowMenu(rel, false))
      .child(icon.tint ? svg(icon.path).size(15).flex_none().text_color(icon.color ?? t.muted) : image(icon.path).size(15).flex_none())
      .child(div().flex_none().max_w(220).truncate().text_color(t.foreground).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(dir));
  }

  headerButton(t, id, icon, tip, action) {
    return div().id(id).flex_none().p(4).rounded(5).cursor_pointer().text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip).on_click((_e, cx) => action(cx)).child(svg(`${ME}/${icon}`).size(13));
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    this.shown = shownFile(this.context.space);
    const shownTab = spaces().find(s => s.id === this.context.space)?.tabs.find(x => x.active)?.id;
    this.previewShown = Boolean(shownTab) && (shared("editor.preview") ?? {})[this.context.space] === shownTab;
    this.showSizes = this.config?.files?.sizes !== false;
    const req = shared("files.edit");
    // Cleared elsewhere (another copy committed or cancelled): drop the bar too.
    if (!req && this.edit && !this.editBusy) { this.edit = null; this.editReq = null; }

    const searching = Boolean(this.query.trim());
    let rows, empty;
    if (searching) {
      const idx = this.index;
      if (idx && (this.memo?.idx !== idx || this.memo.query !== this.query)) this.memo = { idx, query: this.query, res: matchFiles(idx.files, idx.lower, this.query, SHOW_MATCHES) };
      this.results = idx ? this.memo.res : { total: 0, files: [] };
      rows = this.results.files.map(f => this.resultRow(f, t));
      empty = !idx ? "Indexing files…" : rows.length ? null : "No matching files";
    } else {
      rows = this.flatten("", 0, []).map(r => this.treeRow(r, t));
      empty = rows.length ? null : this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder");
    }
    const note = searching ? (this.results.total > this.results.files.length ? `${this.results.total} matches, first ${this.results.files.length} shown` : this.index?.capped ? `Index limited to ${INDEX_MAX.toLocaleString()} files` : null)
      : this.limited ? `Limited to ${PER_FOLDER} entries per folder and ${TOTAL.toLocaleString()} total` : null;

    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .on_key_down((ev, cx) => { if (ev.key === "escape") { if (this.edit) this.cancelEdit(cx); else if (searching) this.clearSearch(cx); else return; cx.stop_propagation(); } })
      .on_drop((e, cx) => this.drop(e.paths, cx))
      .child(h_flex().h(38).flex_none().pl(12).pr(6).gap(2).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().pr(6).child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).tooltip(this.root ?? "").child(this.root?.split(/[\\/]/).pop() || "/"))
        .child(this.headerButton(t, "files-refresh", "refresh-cw.svg", "Refresh", cx => { this.index = null; this.refresh(cx); })))
      .child(h_flex().flex_none().px(8).py(6).border_b(1).border_color(t.border)
        .child(Input.new(this.search).flex_1().h(26).px(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground)))
      .when(Boolean(this.edit), el => el.child(this.editBar(t)))
      .child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(4).children(rows)
        .when(Boolean(empty), el => el.child(div().p(8).text_size(12).text_color(t.dim).child(empty))))
      .when(Boolean(note), el => el.child(div().flex_none().px(12).py(4).text_size(11).text_color(t.dim).child(note)))
      .when((shared("files.jobs") ?? []).length > 0, el => el.child(this.jobRows(t)));
  }
}
