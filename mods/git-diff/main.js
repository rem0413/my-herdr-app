import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { exec, theme, settings, shared, setShared, panes, run, window } from "herdr";
import { pairRows, unifiedRows, countPatch } from "./diff.js";

// The diff preview tab. source-control opens one tab of this and reuses it; it shows
// shared("git-diff.preview"):
//   { repo, on, hash, path?, subject?, author?, time? }  a commit (path: one file, else every file)
//   { repo, on, path, worktree: true, untracked? }       HEAD ↔ working tree of one file
// shared("git-diff.mode") is "split" (default) or "unified"; source-control toggles it too.
const ADD = () => theme().ansi2 ?? "#3fb950", DEL = () => theme().ansi1 ?? "#f85149";
const READ = ["--literal-pathspecs", "--no-optional-locks", "-c", "core.fsmonitor=false"];
const ROW = 20, ICON = "mods/source-control/";
// A virtual list needs one row height: every row, file headers too, is ROW tall.
// Working-tree target without a path: every tracked change (HEAD ↔ working tree).

function ago(sec) {
  const d = Date.now() / 1000 - sec;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : `${Math.round(d / 86400)}d`;
}

// One patch of possibly many files -> { file } header rows + that file's rows.
function build(patch, unified) {
  const rows = [];
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    if (!chunk.trim()) continue;
    const name = /^\+\+\+ b\/(.+)$/m.exec(chunk)?.[1] ?? /^--- a\/(.+)$/m.exec(chunk)?.[1] ?? /^diff --git a\/.+ b\/(.+)$/m.exec(chunk)?.[1] ?? "";
    rows.push({ file: name });
    if (/^Binary files /m.test(chunk)) { rows.push({ note: "Binary file · no text diff" }); continue; }
    const body = unified ? unifiedRows(chunk) : pairRows(chunk);
    rows.push(...(body.length ? body : [{ note: "No text changes" }]));
  }
  return rows;
}

export default class GitDiff extends View {
  init(_props, cx) {
    this.rows = []; this.error = null; this.patch = "";
    // Tell openers which tab this is so later clicks reuse it. Mod panes don't get their own pane id,
    // so just after opening (tab.new focuses it) take the focused git-diff pane's tab.
    cx.timer.after(150, () => {
      const tab = panes().find((p) => p.mod === "git-diff" && p.focused)?.tab;
      if (tab) { this.tab = tab; setShared("git-diff.previewTab", tab); }
    });
    // A working-tree diff changes under us: reload it now and then.
    cx.timer.every(4000, (cx) => { if (this.target()?.worktree && window()?.active !== false) this.load(this.target(), cx); });
  }

  target() { return shared("git-diff.preview"); }
  mode() { return shared("git-diff.mode") === "unified" ? "unified" : "split"; }

  load(target, cx) {
    const { repo, on, hash, path, worktree, untracked } = target ?? {};
    const want = JSON.stringify(target ?? null);
    if (want !== this.loaded) { this.loaded = want; this.rows = []; this.patch = ""; this.error = null; }
    if (!repo || (!hash && !worktree)) { this.error = "Open a file from Source Control or Git Graph"; return; }
    cx.spawn(async (cx) => {
      let patch = "", error = null;
      try {
        const args = worktree
          ? (untracked ? ["diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", path]
            : ["diff", "HEAD", "--no-color", "--no-ext-diff", ...(path ? ["--", path] : [])])
          : ["diff-tree", "--root", "-m", "--first-parent", "-p", "--no-commit-id", "--no-color", "--no-ext-diff", hash, ...(path ? ["--", path] : [])];
        let r = await exec("git", [...READ, ...args], { cwd: repo, on });
        // No commit yet: HEAD is missing, so show a new file whole, or everything staged.
        if (worktree && !untracked && r.code !== 0)
          r = await exec("git", [...READ, ...(path ? ["diff", "--no-index", "--no-color", "--", "/dev/null", path] : ["diff", "--cached", "--no-color"])], { cwd: repo, on });
        // --no-index exits 1 when the files differ.
        if (r.code !== 0 && !(r.code === 1 && r.stdout)) error = r.stderr.trim() || "git diff failed";
        else if (!r.stdout.trim()) error = "No changes";
        // ponytail: a patch past exec's 8 MiB cap fails as a whole; add per-file paging if that hurts.
        else patch = r.stdout;
      } catch (e) { error = String(e); }
      if (want !== this.loaded) return; // another file was picked meanwhile
      if (patch === this.patch && error === this.error) return;
      this.patch = patch; this.error = error; this.built = null;
      cx.notify();
    });
  }

  rowsFor(mode) {
    if (this.built !== mode) {
      // ponytail: caps at 5000 rows; long diffs beyond that are cut.
      this.rows = this.patch ? build(this.patch, mode === "unified").slice(0, 5000) : [];
      this.built = mode;
    }
    return this.rows;
  }

  num(n, t, kind) {
    return div().w(44).flex_none().pr(8).text_right().text_color(kind && kind !== " " ? t.foreground : t.dim).child(n == null ? "" : String(n));
  }

  bg(kind) { return kind === "-" ? DEL() + "30" : kind === "+" ? ADD() + "30" : null; }

  side(s, t, left) {
    const bg = !s ? null : this.bg(s.kind);
    return h_flex().flex_1().min_w(0).h(ROW).items_center().when(Boolean(bg), (e) => e.bg(bg)).when(!s, (e) => e.bg(t.raised))
      .when(left, (e) => e.border_r(1).border_color(t.border))
      .child(this.num(s?.n, t, s?.kind))
      // ponytail: long lines truncate; add horizontal scroll if needed.
      .child(div().flex_1().min_w(0).truncate().whitespace_nowrap().text_color(s?.kind === "-" ? DEL() : s?.kind === "+" ? ADD() : t.foreground).child(s ? s.text || " " : ""));
  }

  row(r, t, mode) {
    if (r.file !== undefined) return div().w_full().h(ROW).flex_none().px(12).flex().items_center().bg(t.chrome).border_y(1).border_color(t.border).font_semibold().truncate().child(r.file);
    if (r.hunk) return div().w_full().h(ROW).flex_none().px(12).flex().items_center().bg(t.raised).text_color(t.dim).truncate().child(r.hunk);
    if (r.note) return div().w_full().h(ROW).flex_none().px(12).flex().items_center().text_color(t.dim).child(r.note);
    if (mode === "split") return h_flex().w_full().h(ROW).flex_none().child(this.side(r.l, t, true)).child(this.side(r.r, t, false));
    const bg = this.bg(r.kind);
    return h_flex().w_full().h(ROW).flex_none().items_center().when(Boolean(bg), (e) => e.bg(bg))
      .child(this.num(r.o, t, r.kind)).child(this.num(r.n, t, r.kind))
      .child(div().w(14).flex_none().text_color(r.kind === "-" ? DEL() : ADD()).child(r.kind === " " ? "" : r.kind))
      .child(div().flex_1().min_w(0).truncate().whitespace_nowrap().text_color(r.kind === "-" ? DEL() : r.kind === "+" ? ADD() : t.foreground).child(r.text || " "));
  }

  toggle(id, icon, on, onClick, t) {
    return div().id(id).w(24).h(22).flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(on ? t.foreground : t.muted).when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => onClick(cx)).child(svg(ICON + icon).size(14));
  }

  render(cx) {
    const target = this.target();
    if (JSON.stringify(target ?? null) !== this.loaded) this.load(target, cx);
    const t = theme(), mode = this.mode(), rows = this.rowsFor(mode), { add, del } = countPatch(this.patch);
    const { repo, hash, path, subject, author, time, worktree } = target ?? {};
    const title = worktree ? path || "All changes" : subject || path || hash?.slice(0, 8) || "";
    const sub = worktree ? `Working tree · ${repo ?? ""}` : [hash && `Commit ${hash.slice(0, 8)}`, author, time && ago(time), repo].filter(Boolean).join(" · ");
    return v_flex().size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(12)
      .child(v_flex().flex_none().px(12).pt(8).pb(6).gap(2).border_b(1).border_color(t.border).bg(t.chrome)
        .child(h_flex().gap(8).items_center()
          .child(svg(ICON + (worktree ? "file.svg" : "commit.svg")).size(14).text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(13).child(title ?? ""))
          .child(div().text_color(ADD()).child(`+${add}`)).child(div().text_color(DEL()).child(`−${del}`))
          .child(h_flex().gap(2).p(2).rounded(6).border_1().border_color(t.border)
            .child(this.toggle("gd-unified", "unified.svg", mode === "unified", () => setShared("git-diff.mode", "unified"), t))
            .child(this.toggle("gd-split", "split.svg", mode === "split", () => setShared("git-diff.mode", "split"), t)))
          .child(div().id("gd-close").px(6).cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground))
            .on_click(() => { const tab = this.tab ?? shared("git-diff.previewTab"); if (tab) run("tab.close", { id: tab }); }).child("✕")))
        .child(div().text_size(11).text_color(t.dim).truncate().child(sub)))
      .when(mode === "split" && rows.length > 0, (e) => e.child(h_flex().flex_none().h(24).text_size(11).text_color(t.muted).border_b(1).border_color(t.border)
        .child(div().flex_1().px(12).flex().items_center().border_r(1).border_color(t.border).child("Before"))
        .child(div().flex_1().px(12).flex().items_center().child("After"))))
      .child(this.error || !rows.length
        ? div().p(12).text_color(t.dim).child(this.error ?? "Loading diff…")
        : div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono")
          .child(v_virtual_list("gd-rows", rows.length, ROW, (i) => String(i),
            (range) => rows.slice(range.start, range.end).map((r) => this.row(r, t, mode))).size_full())
          .child(Scrollbar.vertical("gd-rows").viewport_from_layout().absolute().inset_0()));
  }
}
