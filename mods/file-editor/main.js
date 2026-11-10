// One file per tab: props { file, on, space, icon, preview }. my-files opens it with tab.new and reuses the tab.
// shared("editor.tabs"): { "<space>|<file>": tabId } (openers find the tab),
// shared("editor.state"): { tabId: { dirty, git, icon } } (tabs-graph and pane-drop draw the dot and git letter),
// shared("editor.preview"): { space: tabId }: that space's preview tab (italic), replaced by the next
//   single-click open. Editing, Keep, or a double-click (file row or tab) promotes it: removes it from the map.
// shared("editor.keep"): "<space>|<file>" a double-click asked to keep before its tab registered.
// shared("editor.wrap"): soft wrap on or off, for every tab.
//
// Text opens in the editor; Markdown and SVG also have a rendered Preview. Pictures (png, jpg, gif, webp,
// bmp, ico, tif) show with Fit/zoom. image() only loads files inside the app folder, so pictures (and the
// SVG preview) are copied to data/file-editor/ (a remote one through base64) and removed when the tab closes.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { readTextFile, writeTextFile, exec, props, panes, spaces, theme, settings, shared, setShared, notify, appHome, window, run } from "herdr";
import { language, syntaxFor } from "./lang.js";

const base = (p) => p.split(/[\\/]/).pop();
const dir = (p) => p.slice(0, p.length - base(p).length - 1) || "/";
const ICON = "mods/file-editor";
const PICTURE = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?)$/i;
const SVG = /\.svg$/i;
const MARKDOWN = /\.(md|markdown|mdx)$/i;
const CACHE = "data/file-editor";
const PLAIN_AT = 150 * 1024;     // larger: no highlighting or folding (they re-parse per keystroke)
const READ_MAX = 1024 * 1024;    // readTextFile's limit; larger files show their first MB, read-only
const MD_PREVIEW_MAX = 300 * 1024; // larger Markdown opens in Code view
const REMOTE_PICTURE_MAX = 6 * 1024 * 1024; // base64 must fit exec's 8 MiB output
const ZOOMS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 8];
const LANG_NAME = { js: "JavaScript", json: "JSON", yaml: "YAML", html: "HTML", xml: "XML", css: "CSS", python: "Python", rust: "Rust",
  go: "Go", bash: "Shell", sql: "SQL", java: "Java", c: "C", lua: "Lua", ruby: "Ruby", text: "Text", markdown: "Markdown", md: "Markdown" };
const kb = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const hash = (s) => { let h = 5381; for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0; return h.toString(36); };

// One exec per poll: "<mtime> <size> <writable>" (or "missing"), then the git porcelain XY of the file.
const STAT = `f="$1"; if [ ! -e "$f" ]; then echo missing; exit 0; fi
s=$(stat -c '%Y %s' "$f" 2>/dev/null || stat -f '%m %z' "$f"); w=0; [ -w "$f" ] && w=1; echo "$s $w"
cd "$(dirname "$f")" 2>/dev/null && git --no-optional-locks -c core.fsmonitor=false status --porcelain=v1 -- "$(basename "$f")" 2>/dev/null | head -1 | cut -c1-2`;
async function stat(path, on) {
  const r = await exec("sh", ["-c", STAT, "stat", path], { on, timeout: 10000 });
  const [head = "", xy = ""] = r.stdout.split("\n");
  if (head === "missing") return { missing: true };
  const [mtime, size, w] = head.split(" ");
  const git = !xy.trim() ? "" : xy === "??" ? "U" : xy.includes("U") ? "!" : xy.includes("A") ? "A" : xy.includes("D") ? "D" : "M";
  return { stamp: `${mtime} ${size}`, size: Number(size), writable: w === "1", git };
}

// Remote save: refuse if the file changed since opened, then write through a temp file in
// arg-sized chunks (exec has no stdin; NUL is already rejected on load).
async function writeRemote(path, text, expected, on) {
  if ((await readTextFile(path, { on })) !== expected) throw new Error("Changed on disk since it was opened. Reload it first.");
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

// SVG viewBox size, and a copy whose root width/height are large: the host rasterizes an SVG at its
// own width/height, so a 24×24 icon shown at 400 px would be blurry.
function bigSvg(text) {
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!tag) return null;
  const num = (name) => Number(new RegExp(`\\s${name}\\s*=\\s*["']?\\s*([\\d.]+)`, "i").exec(tag)?.[1]);
  const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
  const w = vb ? Number(vb[1]) : num("width") || 300, h = vb ? Number(vb[2]) : num("height") || 150;
  const k = Math.max(1, 1600 / Math.max(w, h));
  const sized = tag.replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/<svg\b/i, `<svg width="${Math.round(w * k)}" height="${Math.round(h * k)}"${vb ? "" : ` viewBox="0 0 ${w} ${h}"`}`);
  return { w, h, text: text.replace(tag, sized) };
}

export default class FileEditor extends View {
  init(_p, cx) {
    const p = props() ?? {};
    this.file = p.file; this.on = p.on ?? null; this.space = p.space; this.icon = p.icon ?? null;
    this.wantPreview = Boolean(p.preview);
    this.kind = PICTURE.test(this.file ?? "") ? "picture" : "text";
    this.mode = "code";          // "preview" for Markdown and SVG (set on load)
    this.zoom = "fit";
    this.dirty = false;
    this.wrap = shared("editor.wrap") === true;
    if (!this.file) return;
    this.load(cx);
    // Disk and git: every 3 s while the window is in front and this tab shows, else every 30 s.
    this.polled = Date.now();
    cx.timer.every(3000, (cx) => {
      const shown = spaces().some((s) => s.tabs.some((t) => t.id === this.tab && t.active));
      if ((window()?.active && shown) || Date.now() - this.polled > 30000) this.poll(cx);
    });
    // file-dialog's Save on "Unsaved changes": save this tab, then close it.
    cx.timer.every(150, (cx) => {
      const req = shared("editor.saveClose");
      if (!req || req.tab !== this.tab || req.at === this.savedCloseAt) return;
      this.savedCloseAt = req.at;
      setShared("editor.saveClose", null);
      this.save(cx, () => run("tab.close", { id: this.tab, confirmed: true }));
    });
  }

  async close() {
    this.state?.release();
    this.publish({ drop: true });
    this.promote();
    await this.unstage();
  }

  // tab.new focuses the new pane, so the first render finds its tab there.
  register() {
    if (this.tab) return;
    this.tab = panes().find((p) => p.mod === "file-editor" && p.focused)?.tab;
    if (!this.tab) return;
    const key = `${this.space}|${this.file}`;
    setShared("editor.tabs", { ...(shared("editor.tabs") ?? {}), [key]: this.tab });
    if (this.wantPreview && shared("editor.keep") !== key) setShared("editor.preview", { ...(shared("editor.preview") ?? {}), [this.space]: this.tab });
    if (shared("editor.keep") === key) setShared("editor.keep", null);
    this.publish();
  }

  isPreview() { return Boolean(this.tab) && (shared("editor.preview") ?? {})[this.space] === this.tab; }
  promote() {
    if (!this.isPreview()) return;
    const map = { ...(shared("editor.preview") ?? {}) };
    delete map[this.space];
    setShared("editor.preview", map);
  }

  publish({ drop } = {}) {
    if (!this.tab) return;
    const all = { ...(shared("editor.state") ?? {}) };
    if (drop) delete all[this.tab]; else all[this.tab] = { dirty: this.dirty, git: this.git ?? "", icon: this.icon };
    const before = JSON.stringify((shared("editor.state") ?? {})[this.tab] ?? null);
    if (before !== JSON.stringify(all[this.tab] ?? null)) setShared("editor.state", all);
  }

  // Disk changed and this tab is clean: reload in place. Dirty: say so, Reload discards the edits.
  poll(cx) {
    if (this.polling || this.saving) return;
    this.polling = true; this.polled = Date.now();
    cx.spawn(async (cx) => {
      try {
        const s = await stat(this.file, this.on);
        if (s.git !== undefined && s.git !== this.git) { this.git = s.git; this.publish(); }
        if (s.missing) { if (!this.gone) { this.gone = true; cx.notify(); } return; }
        if (this.gone) { this.gone = false; this.load(cx); return; }
        if (this.stamp && s.stamp !== this.stamp) {
          if (this.dirty) { if (!this.conflict) { this.conflict = true; cx.notify(); } }
          else this.load(cx);
        }
        cx.notify();
      } catch { /* machine away: keep what is shown */ }
      finally { this.polling = false; }
    });
  }

  load(cx) {
    this.error = null; this.conflict = false; this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const s = await stat(this.file, this.on);
        if (s.missing) { this.error = "This file is no longer on disk"; return; }
        this.stamp = s.stamp; this.size = s.size; this.writable = s.writable; this.git = s.git; this.publish();
        if (this.kind === "picture") return await this.stagePicture(s.size);
        let text;
        this.truncated = s.size > READ_MAX;
        if (this.truncated) text = (await exec("head", ["-c", String(READ_MAX), this.file], { on: this.on })).stdout;
        else text = await readTextFile(this.file, { on: this.on });
        if (text === null) { this.error = "This file is no longer on disk"; return; }
        if (text.includes("\0")) { this.error = "Binary file · no text view"; return; }
        if (!this.cfg) {
          const cfgText = await readTextFile(`${appHome()}/file-editor.json`).catch(() => null);
          try { this.cfg = cfgText ? JSON.parse(cfgText) : {}; } catch (e) { this.cfg = {}; notify({ title: "file-editor.json is invalid", body: String(e), level: "error" }); }
        }
        this.original = text;
        this.lines = text.split("\n").length;
        this.plain = text.length > PLAIN_AT;
        this.lang = this.plain ? "text" : MARKDOWN.test(this.file) ? "markdown" : language(this.file, text, this.cfg.languages);
        this.dirty = false; this.publish();
        this.makeState(text);
        if (this.mode === "code" && !this.modeSet) {
          if (MARKDOWN.test(this.file) && text.length <= MD_PREVIEW_MAX) this.mode = "preview";
          if (SVG.test(this.file)) this.mode = "preview";
          this.modeSet = true;
        }
        if (SVG.test(this.file) && this.mode === "preview") await this.stageSvg(text);
      } catch (e) { this.error = `Cannot open: ${e?.message ?? e}`; }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // A new editor for `text`, with the current wrap. The old one (and its undo history) is dropped.
  makeState(text) {
    this.state?.release();
    const t = theme();
    const fallback = { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 };
    const lang = this.lang === "markdown" ? "text" : this.lang;
    this.state = EditorState.new({ language: lang, folding: !this.plain, value: text, soft_wrap: this.wrap,
      readonly: this.truncated || this.writable === false,
      font_family: settings().font_family, font_size: 13, syntax: { ...fallback, ...syntaxFor(lang, this.cfg) } });
    // ponytail: no full-text compare per keystroke (slow on big files); undo back to original stays dirty.
    this.state.on("change", (_e, cx) => {
      if (this.dirty) return;
      this.dirty = true; this.promote(); this.publish(); cx.notify();
    });
  }

  // ---- pictures

  async stagePicture(size) {
    await this.unstage();
    if (this.on && size > REMOTE_PICTURE_MAX) { this.error = `Remote pictures up to ${kb(REMOTE_PICTURE_MAX)} open here (this one is ${kb(size)}).`; return; }
    await exec("sh", ["-c", 'mkdir -p "$1"; find "$1" -type f -mtime +1 -delete 2>/dev/null; exit 0', "sweep", `${appHome()}/${CACHE}`]);
    const rel = `${CACHE}/${hash(`${this.on}|${this.file}`)}-${Date.now().toString(36)}.${this.file.split(".").pop().toLowerCase()}`;
    const dst = `${appHome()}/${rel}`;
    if (this.on) {
      // exec has no binary output: base64 there, decode here.
      const r = await exec("sh", ["-c", 'base64 < "$1"', "base64", this.file], { on: this.on, timeout: 60000 });
      if (r.code !== 0) throw new Error(r.stderr.trim() || "cannot read it");
      await writeTextFile(`${dst}.b64`, r.stdout, null);
      const d = await exec("sh", ["-c", 'base64 -d < "$1" > "$2"; c=$?; rm -f "$1"; exit $c', "b64", `${dst}.b64`, dst]);
      if (d.code !== 0) throw new Error(d.stderr.trim() || "cannot decode it");
    } else {
      const c = await exec("cp", [this.file, dst]);
      if (c.code !== 0) throw new Error(c.stderr.trim() || "cannot copy it");
    }
    // Pixel size for 100% and the zoom steps (sips: macOS; without it, Fit only).
    const s = await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", dst]).catch(() => null);
    const w = Number(/pixelWidth:\s*(\d+)/.exec(s?.stdout ?? "")?.[1]), h = Number(/pixelHeight:\s*(\d+)/.exec(s?.stdout ?? "")?.[1]);
    this.dims = w > 0 && h > 0 ? { w, h } : null;
    this.staged = rel;
  }

  async stageSvg(text) {
    await this.unstage();
    const big = bigSvg(text);
    if (!big) { this.svgError = "Not an SVG the preview can draw"; return; }
    this.svgError = null;
    const rel = `${CACHE}/${hash(`${this.on}|${this.file}`)}-${Date.now().toString(36)}.svg`;
    await exec("mkdir", ["-p", `${appHome()}/${CACHE}`]);
    await writeTextFile(`${appHome()}/${rel}`, big.text, null);
    this.dims = { w: big.w, h: big.h };
    this.staged = rel;
  }

  unstage() {
    if (!this.staged) return Promise.resolve();
    const path = `${appHome()}/${this.staged}`;
    this.staged = null;
    return exec("rm", ["-f", path]).catch(() => null);
  }

  scale() {
    if (this.zoom !== "fit") return this.zoom;
    if (!this.dims || !this.view) return 1;
    const fit = Math.min(this.view.width / this.dims.w, this.view.height / this.dims.h);
    return SVG.test(this.file) ? fit : Math.min(1, fit); // a raster never blows up past its pixels to fit
  }

  step(direction, cx) {
    if (!this.dims) return;
    const now = this.scale();
    const next = direction > 0 ? ZOOMS.find((z) => z > now + 1e-6) : [...ZOOMS].reverse().find((z) => z < now - 1e-6);
    if (next) { this.zoom = next; cx.notify(); }
  }

  // ---- actions

  // then: runs after a successful save (or at once when there is nothing to save).
  save(cx, then) {
    if (!this.state || !this.dirty) return then?.();
    if (this.saving) return;
    const text = this.state.value();
    this.saving = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (this.on) await writeRemote(this.file, text, this.original, this.on);
        else await writeTextFile(this.file, text, this.original);
        this.original = text; this.dirty = false; this.conflict = false; this.lines = text.split("\n").length;
        const s = await stat(this.file, this.on).catch(() => null);
        if (s && !s.missing) { this.stamp = s.stamp; this.size = s.size; this.git = s.git; }
        this.publish();
        then?.();
      } catch (e) {
        notify({ title: `Not saved: ${base(this.file)}`, body: String(e?.message ?? e), level: "error" });
      }
      this.saving = false;
      cx.notify();
    });
  }

  setMode(mode, cx) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === "preview" && SVG.test(this.file)) cx.spawn(async (cx) => { await this.stageSvg(this.state?.value() ?? this.original ?? ""); cx.notify(); });
    cx.notify();
  }

  toggleWrap(cx) {
    this.wrap = !this.wrap;
    setShared("editor.wrap", this.wrap);
    if (this.state) {
      const text = this.state.value(), dirty = this.dirty;
      this.makeState(text);
      this.dirty = dirty;
    }
    cx.notify();
  }

  copy(cx) {
    const text = this.state?.value() ?? this.original;
    if (this.kind === "picture" || text == null) { cx.write_to_clipboard(this.file); notify({ title: "Copied path", body: this.file, timeout: 2000 }); return; }
    cx.write_to_clipboard(text);
    notify({ title: `Copied ${base(this.file)}`, body: `${this.lines ?? 0} lines`, timeout: 2000 });
  }

  // ---- view

  button(t, id, icon, tip, onClick, { on = false, accent = false, disabled = false } = {}) {
    return div().id(id).flex_none().h(24).px(6).flex().items_center().rounded(5).tooltip(tip)
      .bg(accent ? t.accent : on ? t.selected : t.background)
      .text_color(accent ? t.accent_foreground : on ? t.foreground : disabled ? t.dim : t.muted)
      .when(!disabled, (el) => el.hover((s) => s.bg(accent ? t.accent : t.hover).text_color(accent ? t.accent_foreground : t.foreground))
        .on_click((_e, cx) => onClick(cx)))
      .child(typeof icon === "string" && icon.endsWith(".svg") ? svg(`${ICON}/${icon}`).size(14) : div().text_size(12).child(icon));
  }

  toolbar(t) {
    const picture = this.kind === "picture", svgFile = SVG.test(this.file), md = MARKDOWN.test(this.file);
    const showsPicture = picture || (svgFile && this.mode === "preview");
    const info = picture
      ? [this.dims && `${this.dims.w}×${this.dims.h}`, this.size != null && kb(this.size)]
      : [this.lines != null && `${this.lines} lines`, LANG_NAME[this.lang] ?? this.lang, this.size != null && kb(this.size)];
    const notes = [this.on, this.truncated && `showing first ${kb(READ_MAX)} · read-only`, !this.truncated && this.plain && "large · no highlighting",
      this.writable === false && "read-only", this.saving && "Saving…"].filter(Boolean);
    const seg = (id, icon, label, mode) => h_flex().id(id).h(22).px(8).gap(5).items_center().rounded(4).text_size(11.5)
      .bg(this.mode === mode ? t.selected : t.background).text_color(this.mode === mode ? t.foreground : t.muted)
      .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.setMode(mode, cx))
      .child(svg(`${ICON}/${icon}`).size(13)).child(label);
    const canZoom = Boolean(this.dims);
    return h_flex().id("fe-bar").h(36).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border).bg(t.background).text_size(11.5)
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child([...info, ...notes].filter(Boolean).join(" · ")))
      .when(this.isPreview(), (el) => el.child(this.button(t, "fe-keep", "pin.svg", "Keep this tab open (double-click its tab or file does the same)", () => this.promote())))
      .when(svgFile || md, (el) => el.child(h_flex().flex_none().p(1).gap(1).rounded(5).border_1().border_color(t.border)
        .child(seg("fe-preview", "eye.svg", "Preview", "preview")).child(seg("fe-code", "code.svg", "Code", "code"))))
      .when(showsPicture, (el) => el
        .child(this.button(t, "fe-fit", "Fit", "Fit the pane", (cx) => { this.zoom = "fit"; cx.notify(); }, { on: this.zoom === "fit" }))
        .child(this.button(t, "fe-zout", "−", "Zoom out (⌘ + wheel)", (cx) => this.step(-1, cx), { disabled: !canZoom }))
        .child(div().w(42).flex_none().text_center().text_color(t.muted).child(canZoom ? `${Math.round(this.scale() * 100)}%` : ""))
        .child(this.button(t, "fe-zin", "+", "Zoom in (⌘ + wheel)", (cx) => this.step(1, cx), { disabled: !canZoom }))
        .child(this.button(t, "fe-100", "1:1", "Actual size", (cx) => { this.zoom = 1; cx.notify(); }, { on: this.zoom === 1, disabled: !canZoom })))
      .when(!showsPicture && Boolean(this.state), (el) => el.child(this.button(t, "fe-wrap", "wrap.svg", `Wrap long lines (⌥Z) · ${this.wrap ? "on" : "off"}`, (cx) => this.toggleWrap(cx), { on: this.wrap })))
      .child(this.button(t, "fe-copy", "copy.svg", picture ? "Copy path" : "Copy file text", (cx) => this.copy(cx)))
      .child(this.button(t, "fe-reload", "refresh.svg", this.dirty ? "Reload from disk (drops your edits)" : "Reload from disk", (cx) => { this.dirty = false; this.publish(); this.load(cx); }))
      .when(!picture, (el) => el.child(this.truncated || this.writable === false
        ? this.button(t, "fe-lock", "lock.svg", "Read-only", () => {}, { disabled: true })
        : this.button(t, "fe-save", "save.svg", this.dirty ? "Save (⌘S)" : "Saved", (cx) => this.save(cx), { accent: this.dirty, disabled: !this.dirty })));
  }

  pictureBody(t, svgFile) {
    if (!this.staged) return div().flex_1().p(16).text_color(t.dim).child(this.svgError ?? "Loading…");
    const s = this.scale();
    const w = this.dims ? this.dims.w * s : this.view?.width ?? 400, h = this.dims ? this.dims.h * s : this.view?.height ?? 300;
    // SVGs often draw with currentColor (black when no color is set): give them a light canvas.
    const pic = div().flex_none().when(svgFile, (el) => el.bg("#f5f5f5").rounded(6)).child(image(this.staged).w(w).h(h));
    const wheel = (e, cx) => {
      if (!(e.modifiers.platform || e.modifiers.control) || !this.dims) return;
      cx.stop_propagation();
      this.step(e.delta.y > 0 ? 1 : -1, cx);
    };
    return this.zoom === "fit"
      ? div().id("fe-pic").flex_1().min_h(0).p(10).flex().items_center().justify_center().overflow_hidden().on_scroll_wheel(wheel).child(pic)
      : div().id("fe-pic").flex_1().min_h(0).p(10).overflow_scroll().on_scroll_wheel(wheel).child(pic);
  }

  render(cx) {
    this.register();
    const t = theme();
    const svgFile = SVG.test(this.file ?? "");
    let body;
    if (this.error) body = div().flex_1().p(16).text_color(t.dim).child(this.error);
    else if (this.kind === "picture" || (svgFile && this.mode === "preview")) body = this.pictureBody(t, svgFile);
    else if (!this.state) body = div().flex_1().p(16).text_color(t.dim).child(this.file ? "Loading…" : "No file");
    else if (this.mode === "preview") {
      body = div().id("fe-md").flex_1().min_h(0).overflow_y_scrollbar()
        .child(h_flex().w_full().justify_center().child(div().w_full().max_w(860).px(28).py(20).text_size(14)
          .child(TextView.markdown(`fe-md-${this.file}`, this.state.value()).selectable(true))));
    } else body = Editor.new(this.state).flex_1().min_h(0);

    return v_flex().id("file-editor").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        if (e.keystroke === "cmd-s" || e.keystroke === "ctrl-s") { this.save(cx); cx.stop_propagation(); }
        else if (e.keystroke === "alt-z" && this.state) { this.toggleWrap(cx); cx.stop_propagation(); }
      })
      // The picture area: the pane minus the toolbar and padding. Sizes come zoomed; w()/h() are not.
      .on_size_change((size, cx) => {
        const z = Number(settings()?.zoom) > 0 ? Number(settings().zoom) : 1;
        const view = { width: Math.max(1, size.width / z - 20), height: Math.max(1, size.height / z - 36 - 20) };
        if (!this.view || this.view.width !== view.width || this.view.height !== view.height) { this.view = view; cx.notify(); }
      })
      .when(Boolean(this.file), (el) => el.child(this.toolbar(t)))
      .when(Boolean(this.gone) || Boolean(this.conflict), (el) => el.child(h_flex().h(30).flex_none().px(12).gap(10).items_center()
        .bg(t.blocked + "22").border_b(1).border_color(t.border).text_size(12)
        .child(div().flex_1().text_color(t.foreground).child(this.gone ? "This file was deleted or moved on disk." : "Changed on disk while you were editing."))
        .when(!this.gone, (el) => el.child(div().id("fe-reload-banner").px(8).py(2).rounded(5).bg(t.raised).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.dirty = false; this.publish(); this.load(cx); }).child("Reload, drop my edits")))))
      .child(body);
  }
}
