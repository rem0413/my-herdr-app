// One file per tab: props { file, on, space }. my-files opens it with tab.new and reuses the tab.
// shared("editor.tabs"): { "<space>|<file>": tabId } (openers find the tab),
// shared("editor.state"): { tabId: { dirty, git } } (tabs-graph draws the dot and git letter).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { readTextFile, writeTextFile, exec, props, panes, theme, settings, shared, setShared, notify, appHome, run } from "herdr";
import { language, syntaxFor } from "./lang.js";

const base = (p) => p.split(/[\\/]/).pop();
const dir = (p) => p.slice(0, p.length - base(p).length - 1) || "/";

// Remote save: refuse if the file changed since opened, then write through a temp file in
// arg-sized chunks (exec has no stdin; NUL is already rejected on load).
async function writeRemote(path, text, expected, on) {
  if ((await readTextFile(path, { on })) !== expected) throw new Error("Changed on disk since it was opened. Reopen it to reload.");
  const tmp = `${path}.herdr-save`;
  const sh = async (script, ...args) => {
    const r = await exec("sh", ["-c", script, "save", ...args], { on });
    if (r.code !== 0) throw new Error(r.stderr || "write failed");
  };
  await sh(': > "$1"', tmp);
  for (let i = 0; i < text.length; i += 30000) await sh('printf %s "$2" >> "$1"', tmp, text.slice(i, i + 30000));
  // cat > keeps the file's permissions and owner.
  await sh('cat "$1" > "$2" && rm -f "$1"', tmp, path);
}

// Git letter as Files shows it: U untracked, A added, M modified, D deleted, ! conflict, "" clean.
async function gitMark(path, on) {
  const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--", base(path)], { cwd: dir(path), on }).catch(() => null);
  const xy = r?.code === 0 ? r.stdout.slice(0, 2) : "";
  return !xy ? "" : xy === "??" ? "U" : xy.includes("U") ? "!" : xy.includes("A") ? "A" : xy.includes("D") ? "D" : "M";
}

export default class FileEditor extends View {
  init(_p, cx) {
    const p = props() ?? {};
    this.file = p.file; this.on = p.on ?? null; this.space = p.space; this.icon = p.icon ?? null;
    this.dirty = false;
    if (this.file) { this.load(cx); this.refreshGit(cx); cx.timer.every(5000, (cx) => this.refreshGit(cx)); }
    // file-dialog's Save on "Unsaved changes": save this tab, then close it.
    cx.timer.every(150, (cx) => {
      const req = shared("editor.saveClose");
      if (!req || req.tab !== this.tab || req.at === this.savedCloseAt) return;
      this.savedCloseAt = req.at;
      setShared("editor.saveClose", null);
      this.save(cx, () => run("tab.close", { id: this.tab, confirmed: true }));
    });
  }

  close() { this.state?.release(); this.publish({ drop: true }); }

  // tab.new focuses the new pane, so the first render finds its tab there.
  register() {
    if (this.tab) return;
    this.tab = panes().find((p) => p.mod === "file-editor" && p.focused)?.tab;
    if (!this.tab) return;
    setShared("editor.tabs", { ...(shared("editor.tabs") ?? {}), [`${this.space}|${this.file}`]: this.tab });
    this.publish();
  }

  publish({ drop } = {}) {
    if (!this.tab) return;
    const all = { ...(shared("editor.state") ?? {}) };
    if (drop) delete all[this.tab]; else all[this.tab] = { dirty: this.dirty, git: this.git ?? "", icon: this.icon };
    const before = JSON.stringify((shared("editor.state") ?? {})[this.tab] ?? null);
    if (before !== JSON.stringify(all[this.tab] ?? null)) setShared("editor.state", all);
  }

  refreshGit(cx) {
    cx.spawn(async (cx) => {
      const git = await gitMark(this.file, this.on);
      if (git !== this.git) { this.git = git; this.publish(); cx.notify(); }
    });
  }

  load(cx) {
    cx.spawn(async (cx) => {
      try {
        const [text, cfgText] = await Promise.all([readTextFile(this.file, { on: this.on }), readTextFile(`${appHome()}/file-editor.json`).catch(() => null)]);
        let cfg = {};
        try { cfg = cfgText ? JSON.parse(cfgText) : {}; } catch (e) { notify({ title: "file-editor.json is invalid", body: String(e), level: "error" }); }
        if (text === null) this.error = "File not found";
        else if (text.includes("\0")) this.error = "Binary file · cannot edit";
        else {
          const t = theme();
          // ponytail: >150 KB opens as plain text without folding; highlighting re-parses per keystroke and lags.
          this.plain = text.length > 150000;
          this.original = text;
          const lang = this.plain ? "text" : language(this.file, text, cfg.languages);
          const fallback = { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 };
          this.state = EditorState.new({ language: lang, folding: !this.plain, value: text,
            font_family: settings().font_family, font_size: 13, syntax: { ...fallback, ...syntaxFor(lang, cfg) } });
          // ponytail: no full-text compare per keystroke (slow on big files); undo back to original stays dirty.
          this.state.on("change", (_e, cx) => { if (!this.dirty) { this.dirty = true; this.publish(); cx.notify(); } });
        }
      } catch (e) { this.error = `Cannot open: ${e}`; }
      cx.notify();
    });
  }

  // then: runs after a successful save (or at once when there is nothing to save).
  save(cx, then) {
    if (!this.state || !this.dirty) return then?.();
    if (this.saving) return;
    const text = this.state.value();
    this.saving = true;
    cx.spawn(async (cx) => {
      try {
        if (this.on) await writeRemote(this.file, text, this.original, this.on);
        else await writeTextFile(this.file, text, this.original);
        this.original = text; this.dirty = false; this.publish();
        then?.();
        this.refreshGit(cx);
      } catch (e) {
        notify({ title: `Not saved: ${base(this.file)}`, body: String(e), level: "error" });
      }
      this.saving = false;
      cx.notify();
    });
  }

  render(cx) {
    this.register();
    const t = theme();
    // Name, folder, git letter and unsaved dot are in the pane header (pane-drop); only notes here.
    const note = [this.plain && "large file · no highlighting", this.on, this.saving && "Saving…"].filter(Boolean).join(" · ");
    return v_flex().id("file-editor").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => { if (e.keystroke === "cmd-s" || e.keystroke === "ctrl-s") { this.save(cx); cx.stop_propagation(); } })
      .when(Boolean(note), (el) => el.child(div().h(22).flex_none().px(12).flex().items_center().text_size(11).text_color(t.dim).border_b(1).border_color(t.border).child(note)))
      .child(this.state ? Editor.new(this.state).flex_1().min_h(0)
        : div().p(12).text_color(t.dim).child(this.error ?? (this.file ? "Loading…" : "No file")));
  }
}
