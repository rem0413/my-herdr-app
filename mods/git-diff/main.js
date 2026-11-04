import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { exec, theme, settings, props } from "herdr";
import { pairRows } from "./diff.js";

// One file of one commit, side by side: parent on the left, commit on the right.
// props: { repo, on, hash, path }. Opened as a tab by git-graph.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
const ROW = 20;

export default class GitDiff extends View {
  init(_props, cx) {
    this.rows = []; this.error = null;
    const { repo, on, hash, path } = props() ?? {};
    if (!hash || !path) { this.error = "Open a file from Git Graph"; return; }
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", [...READ, "diff-tree", "--root", "-m", "--first-parent", "-p", "--no-commit-id", "--no-color", "--no-ext-diff", hash, "--", path], { cwd: repo, on });
        if (r.code !== 0) this.error = r.stderr.trim() || "git diff-tree failed";
        else if (/^Binary files /m.test(r.stdout)) this.error = "Binary file · no text diff";
        else {
          // ponytail: caps at 5000 rows; long files beyond that are cut.
          this.rows = pairRows(r.stdout).slice(0, 5000);
          if (!this.rows.length) this.error = "No text diff";
        }
      } catch (e) { this.error = String(e); }
      cx.notify();
    });
  }

  side(s, t, left) {
    const bg = !s ? t.raised : s.kind === "-" ? t.ansi1 + "26" : s.kind === "+" ? t.ansi2 + "26" : null;
    return h_flex().flex_1().min_w(0).h(ROW).items_center().when(Boolean(bg), (e) => e.bg(bg))
      .when(left, (e) => e.border_r(1).border_color(t.border))
      .child(div().w(48).flex_none().pr(4).text_right().text_color(t.dim).child(s ? String(s.n) : ""))
      .child(div().w(14).flex_none().text_color(s?.kind === "-" ? t.ansi1 : t.ansi2).child(s && s.kind !== " " ? s.kind : ""))
      // ponytail: long lines truncate; add horizontal scroll if needed.
      .child(div().flex_1().min_w(0).truncate().whitespace_nowrap().child(s ? s.text || " " : ""));
  }

  row(r, t) {
    if (r.gap) return div().w_full().h(ROW).flex_none().bg(t.chrome).border_y(1).border_color(t.border);
    return h_flex().w_full().h(ROW).flex_none().child(this.side(r.l, t, true)).child(this.side(r.r, t, false));
  }

  render() {
    const t = theme(), { hash, path } = props() ?? {}, short = (hash ?? "").slice(0, 8);
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
