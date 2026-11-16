// One file per tab: props { file, on, space, icon, preview }. my-files opens it with tab.new and reuses the tab.
// shared("editor.tabs"): { "<space>|<file>": tabId } (openers find the tab),
// shared("editor.state"): { tabId: { dirty, git, icon } } (tabs-graph and pane-drop draw the dot and git letter),
// shared("editor.preview"): { space: tabId }: that space's preview tab (italic), replaced by the next
//   single-click open. Editing, Keep, or a double-click (file row or tab) promotes it: removes it from the map.
// shared("editor.keep"): "<space>|<file>" a double-click asked to keep before its tab registered.
// shared("editor.wrap"): soft wrap on or off, for every tab.
//
// Text opens in the editor; Markdown and SVG also have a rendered Preview. Pictures (png, jpg, gif, webp,
// bmp, ico, tif) show with Fit/zoom; PDFs one page at a time (macOS PDFKit renders the page to PNG). image() only
// loads files inside the app folder, so pictures, PDF pages (and the SVG preview) are copied to data/file-editor/
// (a remote one through base64) and removed when the tab closes.
// Animated GIF, WebP and APNG (macOS) are split into PNG frames by ImageIO and played while the tab shows.
// Audio plays through ffplay (ffmpeg) in the background: play/pause, seek, volume. CSV/TSV have a Table
// view; HTML has Open in browser (GPUI has no web view, so no in-pane rendering).
import { View, div, svg, image, uniform_list } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { readTextFile, writeTextFile, exec, props, panes, spaces, theme, settings, shared, setShared, notify, appHome, window, run } from "herdr";
import { language, syntaxFor } from "./lang.js";
import { parseCsv, delimiterFor } from "./csv.js";

const base = (p) => p.split(/[\\/]/).pop();
const ICON = "mods/file-editor";
const PICTURE = /\.(png|apng|jpe?g|gif|webp|bmp|ico|tiff?)$/i;
const ANIMATED = /\.(gif|webp|a?png)$/i;   // may hold several frames
const AUDIO = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|aiff?)$/i;
const CSV = /\.(csv|tsv)$/i;
const HTML = /\.html?$/i;
const SVG = /\.svg$/i;
const PDF = /\.pdf$/i;
const MARKDOWN = /\.(md|markdown|mdx)$/i;
const CSV_MAX_ROWS = 5000;
const ANIM_SPEEDS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
const ANIM_BAR = 40;            // px under an animation for its play / scrub / speed controls
const FRAME_PIXELS_MAX = 400e6;  // width × height × frames written as PNG; longer animations stop early
const FRAMES_MAX = 1000;
const CACHE = "data/file-editor";
const PLAIN_AT = 150 * 1024;     // larger: no highlighting or folding (they re-parse per keystroke)
const READ_MAX = 1024 * 1024;    // readTextFile's limit; larger files show their first MB, read-only
const MD_PREVIEW_MAX = 300 * 1024; // larger Markdown opens in Code view
const ZOOMS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 8];
const LANG_NAME = { js: "JavaScript", json: "JSON", yaml: "YAML", html: "HTML", xml: "XML", css: "CSS", python: "Python", rust: "Rust",
  go: "Go", bash: "Shell", sql: "SQL", java: "Java", c: "C", lua: "Lua", ruby: "Ruby", text: "Text", markdown: "Markdown", md: "Markdown" };
const kb = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const clock = (sec) => { const s = Math.floor(sec); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
// The system's default app for a local file (a browser for HTML).
const openExternal = (file) => {
  const p = window()?.platform;
  const [cmd, args] = p === "macos" ? ["open", [file]] : p === "windows" ? ["cmd", ["/c", "start", "", file]] : ["xdg-open", [file]];
  exec(cmd, args).then((r) => { if (r.code !== 0) throw new Error(r.stderr.trim() || `${cmd} failed`); })
    .catch((e) => notify({ title: `Cannot open ${base(file)}`, body: String(e?.message ?? e), level: "error" }));
};
const hash = (s) => { let h = 5381; for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0; return h.toString(36); };

// `osascript -l JavaScript -e RENDER_SCRIPT <pdf> <page> <png>`: one page as PNG on white, longest edge at most 2048 px,
// scale at most 2, rotation-aware (boundsForBox ignores /Rotate). Prints one JSON line {pages,page,width,height} or {error}.
// Adapted from filer-pro preview/pdf.js (MIT).
const RENDER_SCRIPT = `ObjC.import("PDFKit"); ObjC.import("AppKit");
function run(argv) {
  const [src, pageArg, out] = argv;
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(src));
  if (doc.isNil()) return JSON.stringify({ error: "broken" });
  if (doc.isLocked) return JSON.stringify({ error: "locked" });
  const pages = Number(doc.pageCount);
  if (pages < 1) return JSON.stringify({ error: "empty" });
  const n = Math.min(Math.max(1, +pageArg || 1), pages), page = doc.pageAtIndex(n - 1);
  const box = page.boundsForBox($.kPDFDisplayBoxCropBox), turned = Number(page.rotation) % 180 !== 0;
  const w = turned ? box.size.height : box.size.width, h = turned ? box.size.width : box.size.height;
  const scale = Math.min(2, 2048 / Math.max(w, h)), pw = Math.max(1, Math.round(w * scale)), ph = Math.max(1, Math.round(h * scale));
  const img = page.thumbnailOfSizeForBox($.NSMakeSize(pw, ph), $.kPDFDisplayBoxCropBox);
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, pw, ph, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  $.NSColor.whiteColor.setFill;
  $.NSRectFill($.NSMakeRect(0, 0, pw, ph));
  img.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, pw, ph), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
  $.NSGraphicsContext.restoreGraphicsState;
  const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  if (png.isNil() || !png.writeToFileAtomically(out, true)) return JSON.stringify({ error: "write" });
  return JSON.stringify({ pages, page: n, width: pw, height: ph });
}`;
const PDF_ERRORS = { locked: "PDF is password-protected", empty: "PDF has no pages", broken: "Cannot read this PDF", write: "Cannot write the page image" };

// `osascript -l JavaScript -e FRAMES_SCRIPT <image> <out-prefix> <max-frames> <max-pixels>`: every frame of an
// animated GIF/WebP/APNG as <out-prefix><i>.png (ImageIO composites each one). Prints {count, delays} (ms per
// frame written) or {count: 1} for a still image. Delays of 10 ms or less play at 100 ms, as browsers do.
const FRAMES_SCRIPT = `ObjC.import("ImageIO"); ObjC.import("AppKit");
function run(argv) {
  const [src, prefix, maxFrames, maxPixels] = argv;
  const isrc = $.CGImageSourceCreateWithURL($.NSURL.fileURLWithPath(src), $());
  if (!isrc) return JSON.stringify({ error: "broken" });
  const count = Number($.CGImageSourceGetCount(isrc));
  if (count <= 1) return JSON.stringify({ count });
  const fm = $.NSFileManager.defaultManager, cancel = prefix + "cancel";
  const cancelled = () => {
    if (!fm.fileExistsAtPath(cancel)) return false;
    for (let j = 0; j <= delays.length; j++) fm.removeItemAtPathError(prefix + j + ".png", $());
    fm.removeItemAtPathError(cancel, $());
    return true;
  };
  const delays = [];
  for (let i = 0; i < count && i < +maxFrames; i++) {
    if (cancelled()) return JSON.stringify({ error: "cancelled" });
    const p = ObjC.deepUnwrap(ObjC.castRefToObject($.CGImageSourceCopyPropertiesAtIndex(isrc, i, $()))) || {};
    if (delays.length && (p.PixelWidth || 1) * (p.PixelHeight || 1) * (i + 1) > +maxPixels) break;
    const d = p["{GIF}"] || p["{PNG}"] || p["{WebP}"] || {};
    const s = d.UnclampedDelayTime || d.DelayTime || 0;
    const rep = $.NSBitmapImageRep.alloc.initWithCGImage($.CGImageSourceCreateImageAtIndex(isrc, i, $()));
    const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
    if (png.isNil() || !png.writeToFileAtomically(prefix + i + ".png", true)) return JSON.stringify({ error: "write" });
    delays.push(s > 0.011 ? Math.round(s * 1000) : 100);
  }
  if (cancelled()) return JSON.stringify({ error: "cancelled" });
  return JSON.stringify({ count, delays });
}`;

// One exec per poll: "<mtime> <size> <writable>" (or "missing"), then the git porcelain XY of the file.
const STAT = `f="$1"; if [ ! -e "$f" ]; then echo missing; exit 0; fi
s=$(stat -c '%Y %s' "$f" 2>/dev/null || stat -f '%m %z' "$f"); w=0; [ -w "$f" ] && w=1; echo "$s $w"
cd "$(dirname "$f")" 2>/dev/null && git --literal-pathspecs --no-optional-locks -c core.fsmonitor=false status --porcelain=v1 -- "$(basename "$f")" 2>/dev/null | head -1 | cut -c1-2`;
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
  const sh = async (script, ...args) => {
    const r = await exec("sh", ["-c", script, "save", ...args], { on });
    if (r.code !== 0) throw new Error(r.stderr || "write failed");
    return r.stdout;
  };
  // The temp sits beside the link's target, so the final mv replaces the target, not the link.
  const real = (await sh('readlink -f "$1" 2>/dev/null || printf %s "$1"', path)).trim() || path;
  const tmp = `${real}.herdr-save`;
  // cp -p gives the temp the file's permissions; then the mv swaps it in whole, so a dropped
  // connection never leaves the original half written.
  await sh('cp -p "$1" "$2" && : > "$2"', real, tmp);
  for (let i = 0, j; i < text.length; i = j) {
    j = Math.min(i + 30000, text.length);
    if (j < text.length && /[\uD800-\uDBFF]/.test(text[j - 1])) j--; // never split an emoji's surrogate pair
    await sh('printf %s "$2" >> "$1"', tmp, text.slice(i, j));
  }
  await sh('mv -f "$1" "$2"', tmp, real);
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
    const f = this.file ?? "";
    this.kind = PICTURE.test(f) ? "picture" : PDF.test(f) ? "pdf" : AUDIO.test(f) ? "audio" : "text";
    this.page = 1;
    // pdf: arrow/page keys turn pages; audio: space plays, arrows seek; animation: space pauses.
    if (this.kind !== "text") { this.handle = cx.focus_handle(); this.handle.focus(); }
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

  // Closing has about 250 ms before this script's tasks are cancelled, so one shell does all the cleanup and
  // starts first: stop the audio, leave markers for work still running outside (a remote copy, frame extraction:
  // they see them and clean up after themselves), and remove the copies and frames already here.
  async close() {
    this.closed = true;
    this.animTask?.cancel();
    const marks = [this.fetching && `${this.fetching}.cancel`, this.framing && `${this.framing}-fcancel`].filter(Boolean);
    const paths = [this.staged && `${appHome()}/${this.staged}`, this.pdfCopy, this.audioCopy].filter(Boolean);
    const cleanup = exec("sh", ["-c", `[ -n "$1" ] && kill "$1" 2>/dev/null; shift
while [ "$1" != "--" ]; do : > "$1"; shift; done; shift
for p; do rm -f "$p" "$p"-f*.png; done; exit 0`, "close", String(this.audio?.pid ?? ""), ...marks, "--", ...paths]).catch(() => null);
    this.state?.release();
    this.publish({ drop: true });
    this.promote();
    await cleanup;
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
        if (this.kind === "picture") { await this.stagePicture(s.size); cx.notify(); return await this.stageFrames(cx); }
        if (this.kind === "pdf") return await this.stagePdf(s.size);
        if (this.kind === "audio") return await this.stageAudio(s.size);
        let text;
        this.truncated = s.size > READ_MAX;
        if (this.truncated) text = (await exec("head", ["-c", String(READ_MAX), this.file], { on: this.on })).stdout;
        else text = await readTextFile(this.file, { on: this.on });
        if (text === null) { this.error = "This file is no longer on disk"; return; }
        if (text.includes("\0")) { this.error = "Binary file · no text view"; return; }
        // Invalid UTF-8 arrives as U+FFFD: saving would replace those bytes, so such files open read-only.
        this.lossy = text.includes("\uFFFD");
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
          if (CSV.test(this.file)) this.mode = "preview";
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
      readonly: this.truncated || this.writable === false || this.lossy,
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
    await exec("sh", ["-c", 'mkdir -p "$1"; find "$1" -type f -mtime +1 -delete 2>/dev/null; exit 0', "sweep", `${appHome()}/${CACHE}`]);
    const rel = `${CACHE}/${hash(`${this.on}|${this.file}`)}-${Date.now().toString(36)}.${this.file.split(".").pop().toLowerCase()}`;
    const dst = `${appHome()}/${rel}`;
    if (this.on) await this.fetchRemote(dst);
    else {
      const c = await exec("cp", [this.file, dst]);
      if (c.code !== 0) throw new Error(c.stderr.trim() || "cannot copy it");
      await this.dropIfClosed(dst);
    }
    // Pixel size for 100% and the zoom steps (sips: macOS; without it, Fit only).
    const s = await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", dst]).catch(() => null);
    const w = Number(/pixelWidth:\s*(\d+)/.exec(s?.stdout ?? "")?.[1]), h = Number(/pixelHeight:\s*(\d+)/.exec(s?.stdout ?? "")?.[1]);
    this.dims = w > 0 && h > 0 ? { w, h } : null;
    this.staged = rel;
  }

  // `hc exec --on` streams the remote bytes unchanged straight into a file here (exec's own output is text and
  // capped at 8 MiB, writeTextFile at 1 MiB). A failed copy leaves nothing behind.
  // Closing the tab cancels this task but not the copy, so close() leaves <dst>.cancel and the shell drops the copy.
  async fetchRemote(dst) {
    this.fetching = dst;
    try {
      const r = await exec("sh", ["-c", `if hc exec --on "$1" cat -- "$2" > "$3.part"; then
  if [ -e "$3.cancel" ]; then rm -f "$3.part" "$3.cancel"; exit 1; fi; mv -f "$3.part" "$3"
else c=$?; rm -f "$3.part" "$3.cancel"; exit $c; fi`, "fetch", this.on, this.file, dst], { timeout: 600000 });
      if (r.code !== 0) throw new Error(r.stderr.trim() || "cannot copy it from that machine");
    } finally { this.fetching = null; }
    await this.dropIfClosed(dst);
  }

  // The tab closed while a copy was coming: close() had nothing to remove yet, so remove it now and stop loading.
  async dropIfClosed(path) {
    if (!this.closed) return;
    await exec("rm", ["-f", path]).catch(() => null);
    throw new Error("closed");
  }

  // Animated pictures (macOS): frames beside the staged copy as <staged>-f<i>.png, removed with it.
  // Still pictures, other platforms or an ImageIO failure keep the plain image (its first frame).
  async stageFrames(cx) {
    if (!this.staged || !ANIMATED.test(this.file) || window()?.platform !== "macos") return;
    const staged = this.staged;
    this.framing = `${appHome()}/${staged}`;
    const r = await exec("osascript", ["-l", "JavaScript", "-e", FRAMES_SCRIPT, `${appHome()}/${staged}`, `${appHome()}/${staged}-f`,
      String(FRAMES_MAX), String(FRAME_PIXELS_MAX)], { timeout: 120000 }).catch(() => null);
    this.framing = null;
    const line = r?.stdout.split("\n").map((l) => l.trim()).find((l) => l.startsWith("{"));
    let out = null;
    try { out = line ? JSON.parse(line) : null; } catch { out = null; }
    // Closed or reloaded meanwhile: unstage already ran, so drop the frames written after it.
    if (this.staged !== staged) return exec("sh", ["-c", 'rm -f "$1"-f*.png', "frames", `${appHome()}/${staged}`]).catch(() => null);
    if (!(out?.delays?.length > 1)) return;
    this.anim = { frames: out.delays.map((_, i) => `${staged}-f${i}.png`), delays: out.delays, count: out.count, i: 0, playing: true, speed: 1 };
    this.animate(cx);
  }

  // One frame per tick at that frame's own delay, only while this tab shows; paused, no timer runs.
  animate(cx) {
    this.animTask?.cancel();
    const a = this.anim;
    if (!a?.playing) return;
    const shown = () => spaces().some((s) => s.tabs.some((t) => t.id === this.tab && t.active));
    const tick = (cx) => {
      if (this.anim !== a || !a.playing) return;
      const visible = shown();
      if (visible) { a.i = (a.i + 1) % a.frames.length; cx.notify(); }
      this.animTask = cx.timer.after(visible ? this.frameDelay(a) : 500, tick);
    };
    this.animTask = cx.timer.after(this.frameDelay(a), tick);
  }

  frameDelay(a) { return Math.max(20, a.delays[a.i] / a.speed); }

  toggleAnim(cx) {
    if (!this.anim) return;
    this.anim.playing = !this.anim.playing;
    this.animate(cx);
    cx.notify();
  }

  stepFrame(by, cx) {
    const a = this.anim;
    if (!a) return;
    a.playing = false; this.animTask?.cancel();
    a.i = (a.i + by + a.frames.length) % a.frames.length;
    cx.notify();
  }

  // Scrubbing pauses on that frame; a press that started while playing resumes on release.
  seekFrame(frac, cx) {
    const a = this.anim;
    if (!a) return;
    if (!this.scrub) this.scrub = { resume: a.playing };
    a.playing = false; this.animTask?.cancel();
    const i = Math.min(a.frames.length - 1, Math.floor(frac * a.frames.length));
    if (i !== a.i) { a.i = i; cx.notify(); }
  }

  endScrub(cx) {
    const resume = this.scrub?.resume;
    this.scrub = null;
    if (resume && this.anim) { this.anim.playing = true; this.animate(cx); cx.notify(); }
  }

  setSpeed(by, cx) {
    const a = this.anim;
    if (!a) return;
    const at = ANIM_SPEEDS.indexOf(a.speed);
    const next = ANIM_SPEEDS[Math.min(ANIM_SPEEDS.length - 1, Math.max(0, at + by))];
    if (next === a.speed) return;
    a.speed = next;
    this.animate(cx);
    cx.notify();
  }

  // ---- audio (ffprobe for facts, ffplay -nodisp to play; seeking or a new volume restarts it at the position)

  async stageAudio(size) {
    this.stopAudio();
    let src = this.file;
    if (this.on) {
      // A reload fetches a fresh copy: drop the previous one first (and anything left over from a day ago).
      await exec("sh", ["-c", 'mkdir -p "$1"; find "$1" -type f -mtime +1 -delete 2>/dev/null; [ -n "$2" ] && rm -f "$2"; exit 0', "sweep", `${appHome()}/${CACHE}`, this.audioCopy ?? ""]);
      this.audioCopy = `${appHome()}/${CACHE}/${hash(`${this.on}|${this.file}`)}-${Date.now().toString(36)}.${this.file.split(".").pop().toLowerCase()}`;
      await this.fetchRemote(this.audioCopy);
      src = this.audioCopy;
    }
    const r = await exec("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries",
      "format=duration,bit_rate:stream=codec_name,sample_rate,channels", "-of", "json", src]).catch(() => null);
    if (!r || r.code === 127) { this.error = "Audio playback needs ffmpeg (brew install ffmpeg)"; return; }
    let info = null;
    try { info = JSON.parse(r.stdout); } catch { info = null; }
    const st = info?.streams?.[0];
    if (r.code !== 0 || !st) { this.error = "Cannot read this audio file"; return; }
    const duration = Number(info.format?.duration);
    this.audio = { src, duration: duration > 0 ? duration : null, codec: st.codec_name, rate: Number(st.sample_rate),
      channels: Number(st.channels), bitrate: Number(info.format?.bit_rate), pos: 0, playing: false, volume: this.audio?.volume ?? 80, pid: null };
  }

  audioPos() {
    const a = this.audio;
    if (!a) return 0;
    const pos = a.playing && a.pid ? a.pos + (Date.now() - a.startedAt) / 1000 : a.pos;
    return a.duration ? Math.min(pos, a.duration) : pos;
  }

  stopAudio() {
    const a = this.audio;
    this.audioGen = (this.audioGen ?? 0) + 1;
    this.audioTask?.cancel(); this.audioTask = null;
    if (!a) return;
    if (a.playing) a.pos = this.audioPos();
    if (a.pid) exec("kill", [String(a.pid)]).catch(() => null);
    a.pid = null; a.playing = false;
  }

  playAudio(cx, at) {
    const a = this.audio;
    if (!a) return;
    let from = Math.max(0, at ?? this.audioPos());
    if (a.duration && from >= a.duration - 0.05) from = 0;
    this.stopAudio();
    a.pos = from; a.playing = true;
    const gen = this.audioGen;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", 'command -v ffplay >/dev/null || exit 127; ffplay -nodisp -autoexit -loglevel quiet -ss "$2" -volume "$3" "$1" </dev/null >/dev/null 2>&1 & echo $!',
        "play", a.src, from.toFixed(2), String(a.volume)]).catch(() => null);
      const pid = r?.code === 0 ? Number(r.stdout.trim()) : 0;
      if (gen !== this.audioGen) { if (pid) exec("kill", [String(pid)]).catch(() => null); return; }
      if (!pid) {
        a.playing = false;
        notify({ title: "Cannot play audio", body: "ffplay did not start (brew install ffmpeg)", level: "error" });
        return cx.notify();
      }
      a.pid = pid; a.startedAt = Date.now();
      // The time display, the end of the file, and ffplay quitting on its own.
      let n = 0;
      this.audioTask = cx.timer.every(500, (cx) => {
        if (gen !== this.audioGen) return;
        if (a.duration && this.audioPos() >= a.duration) { this.stopAudio(); a.pos = 0; return cx.notify(); }
        if (++n % 4 === 0) cx.spawn(async (cx) => {
          const alive = await exec("kill", ["-0", String(pid)]).catch(() => null);
          if (gen === this.audioGen && alive?.code !== 0) { this.stopAudio(); if (a.duration && a.pos >= a.duration - 1) a.pos = 0; cx.notify(); }
        });
        cx.notify();
      });
      cx.notify();
    });
  }

  toggleAudio(cx) {
    if (!this.audio) return;
    if (this.audio.playing) { this.stopAudio(); cx.notify(); } else this.playAudio(cx);
  }

  seekAudio(seconds, cx) {
    const a = this.audio;
    if (!a) return;
    const to = Math.max(0, a.duration ? Math.min(seconds, a.duration) : seconds);
    if (a.playing) this.playAudio(cx, to); else { a.pos = to; cx.notify(); }
  }

  setVolume(v, cx) {
    const a = this.audio;
    if (!a) return;
    a.volume = Math.round(Math.min(100, Math.max(0, v)));
    if (a.playing) this.playAudio(cx); else cx.notify();
  }

  // Local PDFs render from the file itself; remote ones from a copy (fetched again on every load: the stamp changed).
  async stagePdf(size) {
    if (window()?.platform !== "macos") { this.error = "PDF preview needs macOS"; return; }
    await exec("sh", ["-c", 'mkdir -p "$1"; find "$1" -type f -mtime +1 -delete 2>/dev/null; exit 0', "sweep", `${appHome()}/${CACHE}`]);
    if (this.on) {
      if (this.pdfCopy) await exec("rm", ["-f", this.pdfCopy]).catch(() => null);
      this.pdfCopy = `${appHome()}/${CACHE}/${hash(`${this.on}|${this.file}`)}-${Date.now().toString(36)}.pdf`;
      await this.fetchRemote(this.pdfCopy);
    }
    await this.renderPage(this.page);
  }

  // Render page n, then drop the previous page's PNG.
  async renderPage(n) {
    const src = this.pdfCopy ?? this.file;
    const rel = `${CACHE}/${hash(`${this.on}|${this.file}`)}-p${n}-${Date.now().toString(36)}.png`;
    const r = await exec("osascript", ["-l", "JavaScript", "-e", RENDER_SCRIPT, src, String(n), `${appHome()}/${rel}`], { timeout: 30000 });
    const line = r.stdout.split("\n").map((l) => l.trim()).find((l) => l.startsWith("{"));
    let out = null;
    try { out = line ? JSON.parse(line) : null; } catch { out = null; }
    if (out?.error) { this.error = `${PDF_ERRORS[out.error] ?? out.error} · no preview`; return; }
    if (!(out?.pages >= 1 && out.width >= 1 && out.height >= 1)) throw new Error((r.stderr || r.stdout).trim().split("\n")[0] || "cannot render it");
    await this.unstage();
    this.page = out.page; this.pages = out.pages;
    this.dims = { w: out.width / 2, h: out.height / 2 };
    this.staged = rel;
  }

  goPage(n, cx) {
    if (this.kind !== "pdf" || !this.pages || this.rendering) return;
    n = Math.min(Math.max(1, n), this.pages);
    if (n === this.page) return;
    this.rendering = true;
    cx.spawn(async (cx) => {
      try { await this.renderPage(n); } catch (e) { this.error = `Cannot open: ${e?.message ?? e}`; }
      finally { this.rendering = false; cx.notify(); }
    });
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
    this.animTask?.cancel(); this.animTask = null; this.anim = null;
    if (!this.staged) return Promise.resolve();
    const path = `${appHome()}/${this.staged}`;
    this.staged = null;
    return exec("sh", ["-c", 'rm -f "$1" "$1"-f*.png', "unstage", path]).catch(() => null);
  }

  scale() {
    if (this.zoom !== "fit") return this.zoom;
    if (!this.dims || !this.view) return 1;
    const fit = Math.min(this.view.width / this.dims.w, Math.max(1, this.view.height - (this.anim ? ANIM_BAR : 0)) / this.dims.h);
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
    if (this.lossy) return;
    if (this.saving) return;
    const text = this.state.value();
    this.saving = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (this.on) await writeRemote(this.file, text, this.original, this.on);
        else await writeTextFile(this.file, text, this.original);
        // Typing during the write stays unsaved (and keeps the tab open for a save-and-close).
        this.original = text; this.dirty = this.state.value() !== text; this.conflict = false; this.lines = text.split("\n").length;
        const s = await stat(this.file, this.on).catch(() => null);
        if (s && !s.missing) { this.stamp = s.stamp; this.size = s.size; this.git = s.git; }
        this.publish();
        if (!this.dirty) then?.();
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
    if (this.kind !== "text" || text == null) { cx.write_to_clipboard(this.file); notify({ title: "Copied path", body: this.file, timeout: 2000 }); return; }
    cx.write_to_clipboard(text);
    notify({ title: `Copied ${base(this.file)}`, body: `${this.lines ?? 0} lines`, timeout: 2000 });
  }

  // ---- view

  button(t, id, icon, tip, onClick, { on = false, accent = false, disabled = false } = {}) {
    return div().id(id).flex_none().h(24).px(6).flex().items_center().rounded(6).tooltip(tip)
      .bg(accent ? t.accent : on ? t.selected : t.background)
      .text_color(accent ? t.accent_foreground : on ? t.foreground : disabled ? t.dim : t.muted)
      .when(!disabled, (el) => el.hover((s) => s.bg(accent ? t.accent : t.hover).text_color(accent ? t.accent_foreground : t.foreground))
        .on_click((_e, cx) => onClick(cx)))
      .child(typeof icon === "string" && icon.endsWith(".svg") ? svg(`${ICON}/${icon}`).size(14) : div().text_size(12).child(icon));
  }

  toolbar(t) {
    const pdf = this.kind === "pdf", audio = this.kind === "audio", picture = this.kind === "picture" || pdf || audio;
    const svgFile = SVG.test(this.file), md = MARKDOWN.test(this.file), csv = CSV.test(this.file), anim = this.anim;
    const showsPicture = (picture && !audio) || (svgFile && this.mode === "preview");
    const a = this.audio;
    const info = pdf
      ? [this.pages && `${this.pages} page${this.pages === 1 ? "" : "s"}`, this.size != null && kb(this.size)]
      : audio
      ? [a?.duration && clock(a.duration), a?.codec, a?.rate > 0 && `${(a.rate / 1000).toFixed(1)} kHz`,
        a?.channels > 0 && (a.channels === 1 ? "mono" : a.channels === 2 ? "stereo" : `${a.channels} ch`),
        a?.bitrate > 0 && `${Math.round(a.bitrate / 1000)} kbps`, this.size != null && kb(this.size)]
      : picture
      ? [this.dims && `${this.dims.w}×${this.dims.h}`, anim && `${anim.frames.length}${anim.count > anim.frames.length ? ` of ${anim.count}` : ""} frames`,
        this.size != null && kb(this.size)]
      : [csv && this.csv?.rows.length > 0 && `${this.csv.rows.length - 1}${this.csv.truncated ? "+" : ""} rows`, this.lines != null && `${this.lines} lines`,
        LANG_NAME[this.lang] ?? this.lang, this.size != null && kb(this.size)];
    const notes = [this.on, this.truncated && `showing first ${kb(READ_MAX)} · read-only`, !this.truncated && this.plain && "large · no highlighting", this.lossy && "not valid UTF-8 · read-only",
      this.writable === false && "read-only", this.saving && "Saving…"].filter(Boolean);
    const seg = (id, icon, label, mode) => h_flex().id(id).h(22).px(8).gap(5).items_center().rounded(4).text_size(11)
      .bg(this.mode === mode ? t.selected : t.background).text_color(this.mode === mode ? t.foreground : t.muted)
      .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.setMode(mode, cx))
      .child(svg(`${ICON}/${icon}`).size(13)).child(label);
    const canZoom = Boolean(this.dims);
    return h_flex().id("fe-bar").h(36).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border).bg(t.background).text_size(11)
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child([...info, ...notes].filter(Boolean).join(" · ")))
      .when(this.isPreview(), (el) => el.child(this.button(t, "fe-keep", "pin.svg", "Keep this tab open (double-click its tab or file does the same)", () => this.promote())))
      .when(svgFile || md || csv, (el) => el.child(h_flex().flex_none().p(1).gap(1).rounded(6).border_1().border_color(t.border)
        .child(csv ? seg("fe-preview", "table.svg", "Table", "preview") : seg("fe-preview", "eye.svg", "Preview", "preview"))
        .child(seg("fe-code", "code.svg", "Code", "code"))))
      .when(HTML.test(this.file) && !this.on, (el) => el.child(this.button(t, "fe-browser", "external.svg", "Open in browser", () => openExternal(this.file))))
      .when(pdf && Boolean(this.pages), (el) => el
        .child(this.button(t, "fe-prev", "‹", "Previous page (← / Page Up)", (cx) => this.goPage(this.page - 1, cx), { disabled: this.page <= 1 }))
        .child(div().flex_none().px(4).text_color(t.muted).child(`${this.page} / ${this.pages}`))
        .child(this.button(t, "fe-next", "›", "Next page (→ / Page Down)", (cx) => this.goPage(this.page + 1, cx), { disabled: this.page >= this.pages })))
      .when(showsPicture, (el) => el
        .child(this.button(t, "fe-fit", "Fit", "Fit the pane", (cx) => { this.zoom = "fit"; cx.notify(); }, { on: this.zoom === "fit" }))
        .child(this.button(t, "fe-zout", "−", "Zoom out (⌘ + wheel)", (cx) => this.step(-1, cx), { disabled: !canZoom }))
        .child(div().w(42).flex_none().text_center().text_color(t.muted).child(canZoom ? `${Math.round(this.scale() * 100)}%` : ""))
        .child(this.button(t, "fe-zin", "+", "Zoom in (⌘ + wheel)", (cx) => this.step(1, cx), { disabled: !canZoom }))
        .child(this.button(t, "fe-100", "1:1", "Actual size", (cx) => { this.zoom = 1; cx.notify(); }, { on: this.zoom === 1, disabled: !canZoom })))
      .when(!showsPicture && !(csv && this.mode === "preview") && Boolean(this.state), (el) => el.child(this.button(t, "fe-wrap", "wrap.svg", `Wrap long lines (⌥Z) · ${this.wrap ? "on" : "off"}`, (cx) => this.toggleWrap(cx), { on: this.wrap })))
      .child(this.button(t, "fe-copy", "copy.svg", picture ? "Copy path" : "Copy file text", (cx) => this.copy(cx)))
      .child(this.button(t, "fe-reload", "refresh.svg", this.dirty ? "Reload from disk (drops your edits)" : "Reload from disk", (cx) => { this.dirty = false; this.publish(); this.load(cx); }))
      .when(!picture, (el) => el.child(this.truncated || this.writable === false || this.lossy
        ? this.button(t, "fe-lock", "lock.svg", "Read-only", () => {}, { disabled: true })
        : this.button(t, "fe-save", "save.svg", this.dirty ? "Save (⌘S)" : "Saved", (cx) => this.save(cx), { accent: this.dirty, disabled: !this.dirty })));
  }

  pictureBody(t, svgFile) {
    if (!this.staged) return div().flex_1().p(16).text_color(t.dim).child(this.svgError ?? "Loading…");
    const s = this.scale();
    const w = this.dims ? this.dims.w * s : this.view?.width ?? 400, h = this.dims ? this.dims.h * s : this.view?.height ?? 300;
    // SVGs often draw with currentColor (black when no color is set): give them a light canvas.
    // An animation shows its current frame; the next one sits underneath at 1 px so it is loaded before its turn.
    const a = this.anim, src = a ? a.frames[a.i] : this.staged;
    const pic = div().flex_none().relative().when(svgFile, (el) => el.bg("#f5f5f5").rounded(6))
      .when(Boolean(a), (el) => el.child(image(a.frames[(a.i + 1) % a.frames.length]).absolute().top(0).left(0).w(1).h(1).opacity(0.01)))
      .child(image(src).w(w).h(h));
    const wheel = (e, cx) => {
      if (!(e.modifiers.platform || e.modifiers.control) || !this.dims) return;
      cx.stop_propagation();
      this.step(e.delta.y > 0 ? 1 : -1, cx);
    };
    const area = this.zoom === "fit"
      ? div().id("fe-pic").flex_1().min_h(0).p(10).flex().items_center().justify_center().overflow_hidden().on_scroll_wheel(wheel).child(pic)
      : div().id("fe-pic").flex_1().min_h(0).p(10).overflow_scroll().on_scroll_wheel(wheel).child(pic);
    return a ? v_flex().flex_1().min_h(0).child(area).child(this.animBar(t, a)) : area;
  }

  // Play/pause, a frame scrubber (press and drag), the frame and its time, and the playback speed.
  animBar(t, a) {
    const n = a.frames.length;
    const at = a.delays.slice(0, a.i).reduce((s, d) => s + d, 0), total = a.delays.reduce((s, d) => s + d, 0);
    const pick = (e, cx) => {
      const width = e.bounds?.width, x = e.local_position?.x;
      if (width > 0 && x != null) this.seekFrame(Math.min(0.9999, Math.max(0, x / width)), cx);
    };
    const thumb = n > 1 ? a.i / (n - 1) : 0;
    const scrubber = div().id("fe-scrub").flex_1().min_w(0).h(24).flex().items_center().cursor_pointer()
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); pick(e, cx); })
      .on_mouse_move((e, cx) => { if (this.scrub) pick(e, cx); })
      .on_mouse_up("left", (_e, cx) => this.endScrub(cx))
      .on_hover((hovered, cx) => { if (!hovered && this.scrub) this.endScrub(cx); })
      .child(div().w_full().h(4).rounded(2).bg(t.border).relative()
        .child(div().h_full().rounded(2).bg(t.accent).relative().w(`${(thumb * 100).toFixed(2)}%`)
          .child(div().absolute().top(-4).right(-6).size(12).rounded_full().bg(t.accent).border_2().border_color(t.background))));
    const sec = (ms) => `${(ms / 1000).toFixed(2)}s`;
    return h_flex().id("fe-anim-bar").h(ANIM_BAR).flex_none().px(10).gap(8).items_center().border_t(1).border_color(t.border)
      .bg(t.surface).text_size(11).text_color(t.muted)
      .child(this.button(t, "fe-anim", a.playing ? "pause.svg" : "play.svg", a.playing ? "Pause (Space)" : "Play (Space)", (cx) => this.toggleAnim(cx)))
      .child(this.button(t, "fe-fprev", "‹", "Previous frame (←)", (cx) => this.stepFrame(-1, cx)))
      .child(this.button(t, "fe-fnext", "›", "Next frame (→)", (cx) => this.stepFrame(1, cx)))
      .child(div().w(72).flex_none().text_center().child(`${a.i + 1} / ${n}`))
      .child(scrubber)
      .child(div().w(96).flex_none().text_center().text_color(t.dim).child(`${sec(at)} / ${sec(total)}`))
      .child(this.button(t, "fe-slower", "−", "Slower ([)", (cx) => this.setSpeed(-1, cx), { disabled: a.speed <= ANIM_SPEEDS[0] }))
      .child(div().id("fe-speed").w(40).flex_none().text_center().cursor_pointer().tooltip("Reset speed")
        .text_color(a.speed === 1 ? t.muted : t.accent).on_click((_e, cx) => { a.speed = 1; this.animate(cx); cx.notify(); })
        .child(`${a.speed}×`))
      .child(this.button(t, "fe-faster", "+", "Faster (])", (cx) => this.setSpeed(1, cx), { disabled: a.speed >= ANIM_SPEEDS[ANIM_SPEEDS.length - 1] }));
  }

  // A seek or volume bar: a press anywhere sets that fraction.
  bar(t, id, frac, onPick) {
    return div().id(id).flex_1().min_w(0).h(18).flex().items_center().cursor_pointer()
      .on_mouse_down("left", (e, cx) => {
        const width = e.bounds?.width, x = e.local_position?.x;
        if (width > 0 && x != null) onPick(Math.min(1, Math.max(0, x / width)), cx);
      })
      .child(div().w_full().h(4).rounded(2).bg(t.border)
        .child(div().h_full().rounded(2).bg(t.accent).w(`${(Math.min(1, Math.max(0, frac)) * 100).toFixed(2)}%`)));
  }

  audioBody(t) {
    const a = this.audio;
    if (!a) return div().flex_1().p(16).text_color(t.dim).child("Loading…");
    const pos = this.audioPos();
    return div().flex_1().min_h(0).flex().items_center().justify_center().p(24).child(
      v_flex().w_full().max_w(560).gap(14).p(20).rounded(10).border_1().border_color(t.border).bg(t.surface)
        .child(h_flex().gap(12).items_center()
          .child(div().size(44).flex_none().rounded(8).bg(t.raised).flex().items_center().justify_center().text_color(t.accent)
            .child(svg(`${ICON}/music.svg`).size(22)))
          .child(v_flex().min_w(0).flex_1()
            .child(div().truncate().text_size(14).font_semibold().child(base(this.file)))
            .child(div().truncate().text_size(11).text_color(t.dim).child([a.codec, a.duration && clock(a.duration)].filter(Boolean).join(" · ")))))
        .child(h_flex().gap(10).items_center()
          .child(div().id("fe-play").size(32).flex_none().rounded_full().flex().items_center().justify_center()
            .bg(t.accent).text_color(t.accent_foreground).hover((s) => s.opacity(0.9)).tooltip(a.playing ? "Pause (Space)" : "Play (Space)")
            .on_click((_e, cx) => this.toggleAudio(cx)).child(svg(`${ICON}/${a.playing ? "pause" : "play"}.svg`).size(14)))
          .child(div().flex_none().text_size(11).text_color(t.muted).child(clock(pos)))
          .child(a.duration ? this.bar(t, "fe-seek", pos / a.duration, (f, cx) => this.seekAudio(f * a.duration, cx)) : div().flex_1())
          .child(div().flex_none().text_size(11).text_color(t.dim).child(a.duration ? clock(a.duration) : "")))
        .child(h_flex().gap(8).items_center().text_size(11).text_color(t.muted)
          .child(svg(`${ICON}/volume.svg`).size(14).flex_none())
          .child(div().w(140).flex_none().flex().child(this.bar(t, "fe-volume", a.volume / 100, (f, cx) => this.setVolume(f * 100, cx))))
          .child(div().w(36).flex_none().child(`${a.volume}%`))
          .child(div().flex_1().text_right().text_color(t.dim).child("Space play · ← → 5 s"))));
  }

  // CSV/TSV as a table: the first row is the header; columns sized from the first 200 rows.
  csvBody(t) {
    const text = this.state.value();
    if (this.csvText !== text) {
      this.csvText = text;
      this.csv = parseCsv(text, delimiterFor(this.file, text), CSV_MAX_ROWS);
      const cols = Math.max(0, ...this.csv.rows.map((r) => r.length));
      this.csvWidths = Array.from({ length: cols }, (_, c) => {
        let n = 0;
        for (const r of this.csv.rows.slice(0, 200)) n = Math.max(n, (r[c] ?? "").length);
        return Math.min(360, Math.max(56, n * 7.5 + 20));
      });
    }
    const { rows, truncated } = this.csv;
    if (!rows.length) return div().flex_1().p(16).text_color(t.dim).child("Empty file");
    const widths = this.csvWidths, numW = Math.max(40, String(rows.length).length * 8 + 16);
    const total = numW + widths.reduce((s, w) => s + w, 0);
    const row = (cells, i, header) => h_flex().h(26).w(total).flex_none().text_size(12)
      .bg(header ? t.surface : i % 2 ? t.background : t.canvas).when(header, (el) => el.font_semibold().border_b(1).border_color(t.border))
      .child(div().w(numW).flex_none().px(8).text_right().text_color(t.dim).child(header ? "" : String(i)))
      .children(widths.map((w, c) => div().w(w).flex_none().px(8).truncate().border_l(1).border_color(t.border)
        .child((cells[c] ?? "").replace(/\s+/g, " "))));
    // A virtual list needs a definite height: the pane's, less the toolbar, header and footer.
    const listH = Math.max(26, (this.view?.height ?? 300) + 20 - 26 - (truncated ? 24 : 0));
    return v_flex().flex_1().min_h(0)
      .child(div().id("fe-csv").flex_1().min_h(0).overflow_x_scroll().child(v_flex().w(total)
        .child(row(rows[0], 0, true))
        .child(div().w(total).h(listH).child(uniform_list("fe-csv-rows", rows.length - 1, (i) => String(i),
          (range) => { const out = []; for (let i = range.start; i < range.end; i++) out.push(row(rows[i + 1], i + 1, false)); return out; })
          .size_full()))))
      .when(truncated, (el) => el.child(div().h(24).flex_none().px(10).flex().items_center().border_t(1).border_color(t.border)
        .text_size(11).text_color(t.dim).child(`Showing the first ${CSV_MAX_ROWS} rows · Code shows the whole file`)));
  }

  render(cx) {
    this.register();
    const t = theme();
    const svgFile = SVG.test(this.file ?? "");
    let body;
    if (this.error) body = div().flex_1().p(16).text_color(t.dim).child(this.error);
    else if (this.kind === "audio") body = this.audioBody(t);
    else if (this.kind !== "text" || (svgFile && this.mode === "preview")) body = this.pictureBody(t, svgFile);
    else if (!this.state) body = div().flex_1().p(16).text_color(t.dim).child(this.file ? "Loading…" : "No file");
    else if (this.mode === "preview" && CSV.test(this.file)) body = this.csvBody(t);
    else if (this.mode === "preview") {
      body = div().id("fe-md").flex_1().min_h(0).overflow_y_scrollbar()
        .child(h_flex().w_full().justify_center().child(div().w_full().max_w(860).px(28).py(20).text_size(13)
          .child(TextView.markdown(`fe-md-${this.file}`, this.state.value()).selectable(true))));
    } else body = Editor.new(this.state).flex_1().min_h(0);

    return v_flex().id("file-editor").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .when(Boolean(this.handle), (el) => el.track_focus(this.handle).on_mouse_down("left", () => this.handle.focus()))
      .on_key_down((e, cx) => {
        if (e.keystroke === "cmd-s" || e.keystroke === "ctrl-s") { this.save(cx); cx.stop_propagation(); }
        else if (e.keystroke === "alt-z" && this.state) { this.toggleWrap(cx); cx.stop_propagation(); }
        else if (this.kind === "pdf" && ["left", "right", "pageup", "pagedown"].includes(e.keystroke)) {
          this.goPage(this.page + (e.keystroke === "left" || e.keystroke === "pageup" ? -1 : 1), cx); cx.stop_propagation();
        }
        else if (this.kind === "audio" && this.audio && ["space", "left", "right"].includes(e.keystroke)) {
          if (e.keystroke === "space") this.toggleAudio(cx);
          else this.seekAudio(this.audioPos() + (e.keystroke === "left" ? -5 : 5), cx);
          cx.stop_propagation();
        }
        else if (this.anim && ["space", "left", "right", "[", "]"].includes(e.keystroke)) {
          if (e.keystroke === "space") this.toggleAnim(cx);
          else if (e.keystroke === "[" || e.keystroke === "]") this.setSpeed(e.keystroke === "[" ? -1 : 1, cx);
          else this.stepFrame(e.keystroke === "left" ? -1 : 1, cx);
          cx.stop_propagation();
        }
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
        .when(!this.gone, (el) => el.child(div().id("fe-reload-banner").px(8).py(2).rounded(6).bg(t.raised).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.dirty = false; this.publish(); this.load(cx); }).child("Reload, drop my edits")))))
      .child(body);
  }
}
