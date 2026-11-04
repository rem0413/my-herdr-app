import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { exec, theme, settings, props, shared, setShared, panes } from "herdr";
import { pairRows } from "./diff.js";

// One file of one commit, side by side: parent on the left, commit on the right.
// git-graph opens one tab of this and reuses it: the tab shows shared("git-diff.preview") ({repo, on, hash, path}).
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
const ROW = 20, DEL = "#f85149", ADD = "#3fb950";

export default class GitDiff extends View {
  init(_props, cx) {
    this.rows = []; this.error = null;
    // Tell git-graph which tab this is so later clicks reuse it. Mod panes don't get their own pane id,
    // so just after opening (tab.new focuses it) take the focused git-diff pane's tab.
    cx.timer.after(150, () => {
      const tab = panes().find((p) => p.mod === "git-diff" && p.focused)?.tab;
      if (tab) setShared("git-diff.previewTab", tab);
    });
  }

  target() { return shared("git-diff.preview"); }

  load(target, cx) {
    const { repo, on, hash, path } = target ?? {};
    this.loaded = JSON.stringify(target ?? null); this.rows = []; this.error = null;
    if (!hash || !path) { this.error = "Open a file from Git Graph"; return; }
    const want = this.loaded;
    cx.spawn(async (cx) => {
      let rows = [], error = null;
      try {
        const r = await exec("git", [...READ, "diff-tree", "--root", "-m", "--first-parent", "-p", "--no-commit-id", "--no-color", "--no-ext-diff", hash, "--", path], { cwd: repo, on });
        if (r.code !== 0) error = r.stderr.trim() || "git diff-tree failed";
        else if (/^Binary files /m.test(r.stdout)) error = "Binary file · no text diff";
        else {
          // ponytail: caps at 5000 rows; long files beyond that are cut.
          rows = pairRows(r.stdout).slice(0, 5000);
          if (!rows.length) error = "No text diff";
        }
      } catch (e) { error = String(e); }
      if (want !== this.loaded) return; // another file was picked meanwhile
      this.rows = rows; this.error = error;
      cx.notify();
    });
  }

  side(s, t, left) {
    // Fixed red/green like VS Code: theme ansi colors are too muted to read as removed/added.
    const bg = !s ? t.raised : s.kind === "-" ? DEL + "40" : s.kind === "+" ? ADD + "40" : null;
    return h_flex().flex_1().min_w(0).h(ROW).items_center().when(Boolean(bg), (e) => e.bg(bg))
      .when(left, (e) => e.border_r(1).border_color(t.border))
      .child(div().w(48).flex_none().pr(4).text_right().text_color(s && s.kind !== " " ? t.foreground : t.dim).child(s ? String(s.n) : ""))
      .child(div().w(14).flex_none().font_semibold().text_color(s?.kind === "-" ? DEL : ADD).child(s && s.kind !== " " ? s.kind : ""))
      // ponytail: long lines truncate; add horizontal scroll if needed.
      .child(div().flex_1().min_w(0).truncate().whitespace_nowrap().child(s ? s.text || " " : ""));
  }

  row(r, t) {
    if (r.gap) return div().w_full().h(ROW).flex_none().bg(t.chrome).border_y(1).border_color(t.border);
    return h_flex().w_full().h(ROW).flex_none().child(this.side(r.l, t, true)).child(this.side(r.r, t, false));
  }

  render(cx) {
    const target = this.target();
    if (JSON.stringify(target ?? null) !== this.loaded) this.load(target, cx);
    const t = theme(), { hash, path } = target ?? {}, short = (hash ?? "").slice(0, 8);
    return v_flex().size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .child(h_flex().flex_none().h(30).px(12).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome).text_size(12)
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(path ?? ""))
        .child(div().flex_none().text_color(t.muted).child(`${short}^ ↔ ${short}`)))
      .child(this.error || !this.rows.length
        ? div().p(12).text_size(12).text_color(t.dim).child(this.error ?? "Loading diff…")
        : div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
          .child(v_virtual_list("gd-rows", this.rows.length, ROW, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((r) => this.row(r, t))).size_full())
          .child(Scrollbar.vertical("gd-rows").viewport_from_layout().absolute().inset_0()));
  }
}
