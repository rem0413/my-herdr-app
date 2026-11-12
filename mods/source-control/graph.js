import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle, InputState, Input, Popover, h_resizable, v_resizable, resizable_panel } from "gpui-base";
import { spaces, panes, focused, exec, theme, settings, props, run, shared, setShared, window } from "herdr";
import { treeRows } from "./git.js";

// Same folder resolution as the shipped Changes panel: the focused pane's repo.
// Mod panes have no cwd: keep the last terminal's folder (per copy) instead of jumping to the space folder.
function location(self) {
  if (props()?.folder) return { cwd: props().folder, on: props().on ?? null };
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  const cwd = pane?.cwd || f?.cwd;
  if (cwd) return (self.last = { cwd, on });
  return self.last ?? { cwd: space?.folder, on };
}
const key = (self) => JSON.stringify(location(self));
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
const LIMIT = 2000, ROW = 26, LANE = 18, CURVES = 48, ICON = "mods/source-control/";
const SEP = "\x1f";
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const base = (p) => p.replace(/\/+$/, "").split("/").pop() || p;

// Assigns each commit a lane (c.col) and the edges leaving its dot for the next row (c.out: lane a here to lane b
// there, colored by `lane`). Rows come in topo order, so a commit's children are always above it.
export function layoutGraph(commits) {
  const lanes = []; // lanes[i] = hash expected next in lane i, or null
  let width = 0, prev = null, edges = [];
  const free = () => { const i = lanes.indexOf(null); return i < 0 ? lanes.push(null) - 1 : i; };
  for (const c of commits) {
    let col = lanes.indexOf(c.hash);
    if (col < 0) col = free();
    // The previous row's edges end here: into this dot if their lane was waiting for it, else straight on.
    if (prev) c.in = prev.out = edges.map(({ a, lane }) => ({ a, b: lanes[lane] === c.hash ? col : lane, lane }));
    else c.in = [];
    const was = lanes.map((h) => h !== null && h !== c.hash);
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === c.hash) lanes[i] = null;
    lanes[col] = c.parents[0] ?? null;
    edges = [];
    for (let i = 0; i < lanes.length; i++) if (lanes[i] !== null && i !== col && was[i]) edges.push({ a: i, lane: i });
    if (lanes[col] !== null) edges.push({ a: col, lane: col });
    for (const p of c.parents.slice(1)) {
      let i = lanes.indexOf(p);
      if (i < 0) { i = free(); lanes[i] = p; }
      edges.push({ a: col, lane: i });
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    c.col = col; c.out = [];
    width = Math.max(width, col + 1, lanes.length);
    prev = c;
  }
  // Past the last loaded commit, open lanes run straight off the bottom.
  if (prev) prev.out = edges.map(({ a, lane }) => ({ a, b: lane, lane }));
  return width;
}

function parseLog(stdout) {
  return stdout.split("\0").map((s) => s.replace(/^\n/, "")).filter(Boolean).map((line) => {
    const [hash, parents, author, time, refs, subject] = line.split(SEP);
    return {
      hash, parents: parents ? parents.split(" ") : [], author, time: Number(time), subject,
      refs: refs ? refs.split(", ").map((r) => r.trim()).filter(Boolean) : [],
    };
  });
}

function ago(sec) {
  const d = Date.now() / 1000 - sec;
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))}m`;
  if (d < 86400) return `${Math.round(d / 3600)}h`;
  if (d < 86400 * 30) return `${Math.round(d / 86400)}d`;
  const t = new Date(sec * 1000), y = new Date().getFullYear();
  return t.getFullYear() === y ? `${MON[t.getMonth()]} ${t.getDate()}` : `${MON[t.getMonth()]} '${String(t.getFullYear()).slice(2)}`;
}

function fmtDate(sec) {
  const d = new Date(sec * 1000), p = (n) => String(n).padStart(2, "0");
  return `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default class GitGraph extends View {
  init(props, cx) {
    // Source Control passes shown: false while its History tab is not in front.
    this.shown = props?.shown !== false;
    this.commits = []; this.width = 1; this.files = []; this.repos = []; this.branches = []; this.remotes = [];
    this.view = localStorage.getItem("graph.view") ?? "list"; this.collapsed = new Set();
    this.branch = null; this.showRemote = true; this.gen = 0; this.query = ""; this.matches = []; this.match = 0;
    this.scroll = VirtualListScrollHandle.new();
    this.colW = { date: 130, author: 110, commit: 76, ...JSON.parse(localStorage.getItem("graph.cols") ?? "{}") };
    this.find = InputState.new({ placeholder: "Find message, author or hash" });
    this.find.on("change", (_e, cx) => { this.query = this.find.value(); this.computeMatches(); this.jump(0); cx.notify(); });
    this.find.on("submit", (_e, cx) => { this.jump(this.match + 1); cx.notify(); });
    this.refresh(cx);
    cx.timer.every(15000, (cx) => {
      if (window()?.active === false) return;
      if (this.shown) this.refresh(cx); else this.stale = true; // refreshed when shown again
    });
  }

  update(props) { this.shown = props?.shown !== false; }

  git(args, repo = this.repo) { return exec("git", [...READ, ...args], { cwd: repo, on: this.on }); }

  // rediscover: re-read the repo list (superproject + submodules); force: run even while a load is in flight.
  refresh(cx, { rediscover = false, force = false } = {}) {
    if (this.loading && !force) return;
    const { cwd, on } = location(this), context = key(this);
    if (context !== this.context) {
      this.context = context; this.repo = null; this.repos = []; this.commits = []; this.branch = null;
      this.selected = null; this.files = []; this.error = null; rediscover = true;
    }
    if (!cwd) return;
    const gen = ++this.gen;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        if (rediscover || !this.repo) {
          const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
          if (gen !== this.gen) return;
          if (top.code !== 0) { this.error = "Not a git repository"; this.commits = []; this.repos = []; return; }
          const here = top.stdout.trim();
          let root = here;
          for (;;) {
            const s = await exec("git", ["rev-parse", "--show-superproject-working-tree"], { cwd: root, on });
            const up = s.stdout.trim();
            if (s.code !== 0 || !up) break;
            root = up;
          }
          const sub = await exec("git", ["submodule", "status", "--recursive"], { cwd: root, on });
          const repos = [{ path: root, name: base(root) }];
          for (const line of sub.stdout.split("\n")) {
            const m = /^.[0-9a-f]+ (.+?)(?: \(.*\))?$/.exec(line);
            if (m && line[0] !== "-") repos.push({ path: `${root}/${m[1]}`, name: m[1] }); // "-": not initialized
          }
          if (gen !== this.gen) return;
          this.on = on; this.repos = repos;
          if (!repos.some((r) => r.path === this.repo)) this.repo = here;
        }
        await this.loadRepo(gen);
      } catch (e) { if (gen === this.gen) this.error = String(e); }
      finally { if (gen === this.gen) { this.loading = false; cx.notify(); } }
    });
  }

  async loadRepo(gen) {
    const repo = this.repo;
    const [refs, rem, head] = await Promise.all([
      this.git(["for-each-ref", "--format=%(refname:short)%09%(refname)", "refs/heads", "refs/remotes"]),
      this.git(["remote"]),
      this.git(["rev-parse", "HEAD"]),
    ]);
    const branches = refs.stdout.split("\n").filter(Boolean).map((l) => l.split("\t"))
      .filter(([, full]) => full && !full.endsWith("/HEAD"))
      .map(([name, full]) => ({ name, remote: full.startsWith("refs/remotes/") }));
    if (this.branch && !branches.some((b) => b.name === this.branch)) this.branch = null;
    const sel = this.branch ? [this.branch] : this.showRemote ? ["--exclude=refs/stash", "--all"] : ["--branches", "--tags", "HEAD"];
    const r = await this.git(["log", ...sel, "--topo-order", "-n", String(LIMIT), "-z", `--format=%H${SEP}%P${SEP}%an${SEP}%at${SEP}%D${SEP}%s`, "--"]);
    if (gen !== this.gen || repo !== this.repo) return;
    if (r.code !== 0) { this.error = r.stderr.trim() || "git log failed"; this.commits = []; return; }
    this.branches = branches; this.remotes = rem.stdout.split("\n").filter(Boolean); this.head = head.stdout.trim();
    const commits = parseLog(r.stdout);
    for (const c of commits) c.labels = this.labels(c.refs);
    this.width = layoutGraph(commits) || 1;
    this.commits = commits; this.error = null;
    this.computeMatches();
    if (this.selected && !commits.some((c) => c.hash === this.selected)) { this.selected = null; this.files = []; }
  }

  // Merges "main" + "origin/main" into one label, like vscode-git-graph.
  labels(refs) {
    const remoteOf = (n) => this.remotes.find((r) => n.startsWith(r + "/"));
    let head = null;
    const local = [], remote = [], tags = [];
    for (const r of refs) {
      if (r === "HEAD") continue;
      if (r.startsWith("HEAD -> ")) { head = r.slice(8); local.push(head); }
      else if (r.startsWith("tag: ")) tags.push(r.slice(5));
      else if (remoteOf(r)) { if (!r.endsWith("/HEAD")) remote.push(r); }
      else local.push(r);
    }
    const used = new Set(), out = [];
    for (const l of local) {
      const rs = remote.filter((x) => x.slice(remoteOf(x).length + 1) === l);
      rs.forEach((x) => used.add(x));
      out.push({ kind: "branch", name: l, head: l === head, remotes: this.showRemote ? rs.map(remoteOf) : [] });
    }
    if (this.showRemote) for (const x of remote) if (!used.has(x)) out.push({ kind: "remote", name: x });
    for (const tag of tags) out.push({ kind: "tag", name: tag });
    return out;
  }

  computeMatches() {
    const q = this.query.trim().toLowerCase();
    this.matches = q ? this.commits.flatMap((c, i) =>
      (c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.hash.startsWith(q)) ? [i] : []) : [];
    if (this.match >= this.matches.length) this.match = 0;
  }

  jump(k) {
    const n = this.matches.length;
    if (!n) return;
    this.match = ((k % n) + n) % n;
    this.scroll.scroll_to_item(this.matches[this.match], "center");
  }

  select(hash, cx) {
    if (this.selected === hash) { this.selected = null; this.files = []; cx.notify(); return; }
    this.selected = hash; this.files = []; this.collapsed = new Set(); this.body = ""; this.note = null;
    cx.spawn(async (cx) => {
      const [msg, names] = await Promise.all([
        this.git(["show", "-s", "--format=%an <%ae>%n%ad%n%n%B", hash]),
        this.git(["diff-tree", "--root", "-m", "--first-parent", "-r", "--no-commit-id", "--name-status", "-z", hash]),
      ]);
      if (this.selected !== hash) return;
      this.body = msg.stdout.trim();
      const parts = names.stdout.split("\0").filter(Boolean), files = [];
      for (let i = 0; i < parts.length;) {
        const status = parts[i++][0];
        if (status === "R" || status === "C") { i++; files.push({ status, path: parts[i++] }); }
        else files.push({ status, path: parts[i++] });
      }
      this.files = files;
      cx.notify();
    });
    cx.notify();
  }

  // One preview tab: the first click opens it, later clicks load another file into it (no new tabs).
  // git-diff records the preview tab's id in shared("git-diff.previewTab") when it starts.
  openFile(path, cx) {
    const name = base(path), tab = shared("git-diff.previewTab"), alive = tab && spaces().some((s) => s.tabs.some((x) => x.id === tab));
    try {
      setShared("git-diff.preview", { repo: this.repo, on: this.on, hash: this.selected, path });
      if (alive) { run("tab.rename", { id: tab, name }); run("tab.select", { id: tab }); }
      else run("tab.new", { name, mod: "git-diff" });
    } catch (e) { this.note = String(e); cx.notify(); }
  }

  // Writes (checkout, fetch) skip READ: they are meant to touch .git.
  write(args, done, cx) {
    if (this.busy) return;
    this.busy = args[0]; this.note = null;
    cx.spawn(async (cx) => {
      try {
        // Fetch can outlast exec's 30 s default.
        const r = await exec("git", args, { cwd: this.repo, on: this.on, ...(args[0] === "fetch" ? { timeout: 600000 } : {}) });
        this.note = r.code === 0 ? done : (r.stderr || r.stdout).trim().split("\n").pop();
      } catch (e) { this.note = String(e); }
      this.busy = null;
      this.refresh(cx, { force: true }); cx.notify();
    });
    cx.notify();
  }

  laneColor(i, t) { const c = [t.accent, t.ansi2, t.ansi5, t.ansi3, t.ansi6, t.ansi1, t.ansi4]; return c[i % c.length]; }

  // Each edge runs dot-to-dot across two rows: this row draws the lower half of its outgoing edges and the upper
  // half of the previous row's (c.in). A lane change is one cubic S-curve with vertical ends, split at its
  // midpoint into pre-drawn halves: curves/{b,t}{r,l}{s}.svg (bottom/top half, rightward/leftward, s lanes).
  // ponytail: jumps wider than CURVES lanes reuse the widest curve, stretched.
  graphCell(c, t, w) {
    const mid = ROW / 2, x = (i) => i * LANE + LANE / 2 + 4, els = [], color = (i) => this.laneColor(i, t);
    const half = ({ a, b, lane }, upper) => {
      const y = upper ? 0 : mid;
      if (a === b) return els.push(div().absolute().left(x(a) - 1).top(y).w(2).h(mid).bg(color(lane)));
      const s = Math.min(Math.abs(b - a), CURVES), hw = (Math.abs(b - a) * LANE) / 2;
      const from = upper ? (x(a) + x(b)) / 2 : x(a), to = upper ? x(b) : (x(a) + x(b)) / 2;
      // Each half SVG has 2px padding on every side so round caps overlap the neighbouring half instead of leaving a gap.
      els.push(svg(`${ICON}curves/${upper ? "t" : "b"}${b > a ? "r" : "l"}${s}.svg`).absolute()
        .left(Math.min(from, to) - 2).top(y - 2).w(hw + 4).h(mid + 4).text_color(color(lane)));
    };
    for (const e of c.in) half(e, true);
    for (const e of c.out) half(e, false);
    const head = c.hash === this.head, dot = color(c.col);
    els.push(div().absolute().left(x(c.col) - 5).top(mid - 5).w(10).h(10).rounded_full().bg(head ? t.background : dot).border_2().border_color(dot));
    return div().relative().flex_none().w(w).h(ROW).overflow_hidden().children(els);
  }

  refLabel(l, color, t) {
    const icon = l.kind === "tag" ? "tag.svg" : "branch.svg", c = l.kind === "tag" ? t.ansi3 : color;
    return h_flex().flex_none().h(18).items_center().rounded(4).overflow_hidden().border_1().border_color(c).text_size(11)
      .child(div().h_full().px(4).flex().items_center().bg(c).text_color(t.background).child(svg(ICON + icon).size(11)))
      .child(div().px(5).when(Boolean(l.head), (e) => e.font_semibold()).child(l.name))
      .children((l.remotes ?? []).map((r) => div().h_full().px(5).flex().items_center().border_l(1).border_color(c).italic().text_color(t.muted).child(r)));
  }

  // Column widths: graph/date/author/commit are draggable (header edges) and saved; description takes the rest.
  // Narrow panels drop commit, then author, then shorten the date, so the description keeps >= 140px.
  layoutCols() {
    const width = this.size?.width ?? 0, w = this.colW;
    const graph = Math.max(40, Math.min(w.graph ?? Math.max(56, this.width * LANE + 10), width * 0.6));
    const room = width - graph - 8 - 140;
    const commit = room >= w.date + w.author + w.commit, author = room >= w.date + w.author;
    const date = room >= w.date ? w.date : 60;
    return { graph, date, short: date < w.date, author: author ? w.author : 0, commit: commit ? w.commit : 0 };
  }

  // Rendered inside v_virtual_list: no handlers here (clicks go through on_item_click).
  commitRow(c, i, t, cols) {
    const hit = this.matches.includes(i), current = hit && this.matches[this.match] === i;
    const cell = (w) => div().flex_none().w(w).px(6).truncate().text_color(t.muted);
    return h_flex().w_full().h(ROW).flex_none().items_center().pr(8)
      .when(this.selected === c.hash, (e) => e.bg(t.selected))
      .when(hit && this.selected !== c.hash, (e) => e.bg(t.accent + (current ? "40" : "1c")))
      .child(this.graphCell(c, t, cols.graph))
      .child(h_flex().flex_1().min_w(0).px(6).gap(6).items_center().overflow_hidden()
        .children(c.labels.map((l) => this.refLabel(l, this.laneColor(c.col, t), t)))
        .child(div().flex_1().min_w(40).truncate().when(c.parents.length > 1, (e) => e.text_color(t.muted))
          .when(c.labels.some((l) => l.head), (e) => e.font_semibold()).child(c.subject || "")))
      .child(cell(cols.date).when(cols.short, (e) => e.text_right().text_size(11)).child(cols.short ? ago(c.time) : fmtDate(c.time)))
      .when(cols.author > 0, (e) => e.child(cell(cols.author).child(c.author)))
      .when(cols.commit > 0, (e) => e.child(cell(cols.commit).text_color(t.dim).font_family(settings().font_family ?? "JetBrains Mono").child(c.hash.slice(0, 8))));
  }

  header(t, cols) {
    // A 6px grip on a column's edge; dragging it sets that column's width.
    const grip = (col, w, left) => div().id(`gg-grip-${col}`).absolute().top(0).h_full().w(6).left(left).cursor_col_resize()
      .hover((s) => s.bg(t.accent + "55"))
      .on_mouse_down("left", (e, cx) => { this.drag = { col, x: e.position.x, w, sign: col === "graph" ? 1 : -1 }; cx.stop_propagation(); cx.notify(); });
    const head = (label, w, col) => div().relative().flex_none().w(w).h_full().flex().items_center().justify_center().px(6).border_l(1).border_color(t.border)
      .child(div().truncate().child(label)).when(Boolean(col), (e) => e.child(grip(col, w, -3)));
    return h_flex().flex_none().h(28).pr(8).items_center().border_b(1).border_color(t.border).font_semibold().text_color(t.muted)
      .child(div().relative().flex_none().w(cols.graph).h_full().flex().items_center().justify_center().child(div().truncate().child("Graph")).child(grip("graph", cols.graph, cols.graph - 3)))
      .child(div().flex_1().min_w(0).h_full().flex().items_center().justify_center().border_l(1).border_color(t.border).child(div().truncate().child("Description")))
      .child(head("Date", cols.date, cols.short ? null : "date"))
      .when(cols.author > 0, (e) => e.child(head("Author", cols.author, "author")))
      .when(cols.commit > 0, (e) => e.child(head("Commit", cols.commit, "commit")));
  }

  dragTo(x, cx) {
    const d = this.drag;
    if (!d) return;
    const min = { graph: 40, date: 70, author: 50, commit: 50 }[d.col];
    this.colW[d.col] = Math.max(min, Math.min(600, Math.round(d.w + d.sign * (x - d.x))));
    cx.notify();
  }

  endDrag(cx) {
    if (!this.drag) return;
    this.drag = null;
    localStorage.setItem("graph.cols", JSON.stringify(this.colW));
    cx.notify();
  }

  dropdown(id, text, items, current, pick, t) {
    return Popover.new(id).open(this.menu === id).on_open_change((open, cx) => { this.menu = open ? id : null; cx.notify(); })
      .trigger(h_flex().id(`${id}-trigger`).h(26).min_w(120).max_w(240).px(8).gap(6).items_center().rounded(6).cursor_pointer()
        .bg(t.surface).border_1().border_color(this.menu === id ? t.accent : t.input)
        .child(div().flex_1().min_w(0).truncate().child(text)).child(svg(ICON + "chevron-down.svg").size(12).text_color(t.muted)))
      .content(v_flex().id(`${id}-list`).w(280).max_h(340).overflow_y_scrollbar().p(4).mt(4).bg(t.popover).border_1().border_color(t.border).rounded(8).shadow_md()
        .children(items.map((it, k) => it.header
          ? div().px(8).pt(6).pb(2).text_size(10).text_color(t.dim).child(it.header)
          : h_flex().id(`${id}-${k}`).h(26).flex_none().px(6).gap(6).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.menu = null; pick(it.value, cx); })
            .child(div().w(14).flex_none().when(it.value === current, (e) => e.child(svg(ICON + "check.svg").size(12).text_color(t.accent))))
            .child(div().flex_1().min_w(0).truncate().text_color(it.dim ? t.muted : t.foreground).child(it.label)))));
  }

  iconButton(id, icon, title, onClick, t, { active = false, spin = false, pulse = false } = {}) {
    const glyph = svg(ICON + icon).size(15);
    return div().id(id).w(26).h(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(active || pulse ? t.foreground : t.muted).when(active, (e) => e.bg(t.selected))
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => onClick(cx))
      .child(spin ? glyph.spin(900) : pulse ? div().loop("opacity", { from: 0.25, to: 1, period: 900 }).child(glyph) : glyph);
  }

  reload(cx, change) {
    change();
    this.selected = null; this.files = []; this.commits = [];
    this.refresh(cx, { force: true });
    cx.notify();
  }

  toolbar(t) {
    const repoName = this.repos.find((r) => r.path === this.repo)?.name ?? (this.repo ? base(this.repo) : "—");
    const local = this.branches.filter((b) => !b.remote), remote = this.branches.filter((b) => b.remote);
    const branchItems = [{ label: "Show All", value: null },
      ...(local.length ? [{ header: "LOCAL" }] : []), ...local.map((b) => ({ label: b.name, value: b.name })),
      ...(this.showRemote && remote.length ? [{ header: "REMOTE" }, ...remote.map((b) => ({ label: b.name, value: b.name, dim: true }))] : [])];
    const label = (s) => div().flex_none().text_color(t.muted).font_semibold().child(s);
    return h_flex().flex_none().flex_wrap().px(10).py(6).gap_x(12).gap_y(6).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(h_flex().gap(6).items_center().child(label("Repo:"))
        .child(this.dropdown("gg-repo", repoName, this.repos.map((r) => ({ label: r.name, value: r.path })), this.repo,
          (v, cx) => this.reload(cx, () => { this.repo = v; this.branch = null; }), t)))
      .child(h_flex().gap(6).items_center().child(label("Branches:"))
        .child(this.dropdown("gg-branch", this.branch ?? "Show All", branchItems, this.branch,
          (v, cx) => this.reload(cx, () => { this.branch = v; }), t)))
      .child(h_flex().id("gg-remote").gap(6).items_center().cursor_pointer()
        .on_click((_e, cx) => this.reload(cx, () => { this.showRemote = !this.showRemote; if (this.branches.find((b) => b.name === this.branch)?.remote) this.branch = null; }))
        .child(div().w(14).h(14).flex_none().flex().items_center().justify_center().rounded(4).border_1()
          .border_color(this.showRemote ? t.accent : t.input).when(this.showRemote, (e) => e.bg(t.accent).text_color(t.accent_foreground).child(svg(ICON + "check.svg").size(10))))
        .child(div().child("Show Remote Branches")))
      .child(div().flex_1())
      .child(h_flex().gap(2).items_center()
        .child(this.iconButton("gg-find", "search.svg", "Find", (cx) => {
          this.finding = !this.finding;
          if (this.finding) this.find.focus(); else { this.find.set_value(""); this.query = ""; this.matches = []; }
          cx.notify();
        }, t, { active: this.finding }))
        .child(this.iconButton("gg-fetch", "pull.svg", "Fetch", (cx) => this.write(["fetch", "--all", "--prune"], "Fetched", cx), t, { pulse: this.busy === "fetch" }))
        .child(this.iconButton("gg-refresh", "refresh.svg", "Refresh", (cx) => this.refresh(cx, { rediscover: true, force: true }), t, { spin: this.loading })));
  }

  findBar(t) {
    const n = this.matches.length;
    return h_flex().flex_none().h(34).px(10).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().id("gg-find-input").flex_1().min_w(0).h(26).px(8).flex().items_center().rounded(6).border_1().border_color(t.accent)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.find).h_full().text_size(12).text_color(t.foreground)))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(this.query ? (n ? `${this.match + 1} of ${n}` : "No results") : ""))
      .child(div().id("gg-prev").px(6).cursor_pointer().text_color(t.muted).hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.jump(this.match - 1); cx.notify(); }).child("↑"))
      .child(div().id("gg-next").px(6).cursor_pointer().text_color(t.muted).hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.jump(this.match + 1); cx.notify(); }).child("↓"));
  }

  details(t, cols) {
    const c = this.commits.find((x) => x.hash === this.selected);
    if (!c) return null;
    const branches = c.labels.filter((l) => l.kind === "branch" && !l.head).map((l) => l.name);
    const color = (s) => (s === "A" ? t.ansi2 : s === "D" ? t.ansi1 : s === "R" ? t.ansi5 : t.blocked);
    return v_flex().size_full().min_h(0)
      .child(h_flex().flex_none().h(34).px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().font_family(settings().font_family ?? "JetBrains Mono").child(c.hash.slice(0, 10)))
        .child(div().flex_1().min_w(0).truncate().child(c.subject))
        .children(branches.map((b) => div().id(`co-${b}`).px(8).h(22).flex().items_center().rounded(6).border_1().border_color(t.border)
          .text_size(11).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.write(["checkout", b], `Checked out ${b}`, cx)).child(`Checkout ${b}`)))
        .child(div().id("close-details").px(6).cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => this.select(c.hash, cx)).child("✕")))
      .child(h_resizable("gg-details").flex_1().min_h(0)
        .child(resizable_panel().size(cols.graph + 200).size_range(120, 900).child(div().id("commit-body").size_full().overflow_y_scrollbar().p(10)
          .text_size(12).text_color(t.muted).whitespace_normal().child(this.body || "…")))
        .child(resizable_panel().size_range(160).child(this.fileList(t, color))));
  }

  fileList(t, color) {
    const tree = this.view === "tree";
    const rows = tree ? treeRows(this.files, this.collapsed) : this.files.map((f) => ({ file: f, name: base(f.path), depth: 0 }));
    return v_flex().size_full().min_w(0)
      .child(h_flex().flex_none().h(30).px(8).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().text_size(11).text_color(t.dim).child(`${this.files.length} files`))
        // One toggle: shows the icon of the view it switches to.
        .child(this.iconButton("gg-view", tree ? "list.svg" : "tree.svg", tree ? "List" : "Tree", (cx) => {
          this.view = tree ? "list" : "tree"; localStorage.setItem("graph.view", this.view); cx.notify();
        }, t)))
      .child(v_flex().id("commit-files").flex_1().min_h(0).overflow_y_scrollbar().p(4)
        .children(rows.map((r) => {
          const row = h_flex().id(`f-${r.dir ? "d:" + r.path : r.file.path}`).h(24).flex_none().pl(8 + r.depth * 14).pr(8).gap(6)
            .items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover));
          if (r.dir) return row.on_click((_e, cx) => { this.collapsed.has(r.key) ? this.collapsed.delete(r.key) : this.collapsed.add(r.key); cx.notify(); })
            .child(svg(`${ICON}chevron-${this.collapsed.has(r.key) ? "right" : "down"}.svg`).size(12).text_color(t.muted))
            .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(r.name));
          const f = r.file, dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/") + 1) : "";
          return row.on_click((_e, cx) => this.openFile(f.path, cx))
            .child(div().w(12).flex_none().text_size(11).text_color(color(f.status)).child(f.status))
            .child(h_flex().flex_1().min_w(0).text_size(12)
              .when(!tree && Boolean(dir), (e) => e.child(div().min_w(0).truncate().text_color(t.dim).child(dir)))
              .child(div().flex_none().max_w(260).truncate().child(r.name)));
        })));
  }

  render(cx) {
    if (key(this) !== this.context || this.stale) { this.stale = false; this.refresh(cx); }
    const t = theme(), cols = this.layoutCols();
    const list = div().size_full().min_h(0).relative()
      .when(this.commits.length > 0, (e) => e
        .child(v_virtual_list("gg-commits", this.commits.length, ROW, (i) => this.commits[i].hash,
          (range) => this.commits.slice(range.start, range.end).map((c, k) => this.commitRow(c, range.start + k, t, cols)))
          .track_scroll(this.scroll).on_item_click((hash, cx) => this.select(hash, cx)).size_full())
        .child(Scrollbar.vertical("gg-commits").viewport_from_layout().absolute().inset_0()))
      .when(!this.commits.length, (e) => e.child(div().p(12).text_color(t.dim)
        .child(this.error || (this.loading ? "Loading history…" : "No folder"))));
    const details = this.selected ? this.details(t, cols) : null;
    return v_flex().id("git-graph").on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .on_mouse_move((e, cx) => this.dragTo(e.position.x, cx))
      .on_mouse_up("left", (_e, cx) => this.endDrag(cx))
      .on_mouse_down("left", (_e, cx) => this.endDrag(cx)) // a release outside the panel never reaches us
      .when(Boolean(this.drag), (e) => e.cursor_col_resize())
      .size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(12)
      .child(this.toolbar(t))
      .when(Boolean(this.finding), (e) => e.child(this.findBar(t)))
      .when(Boolean(this.note), (e) => e.child(div().flex_none().px(12).py(4).text_size(11).text_color(t.muted).truncate().border_b(1).border_color(t.border).child(this.note)))
      .child(this.header(t, cols))
      .child(details
        // Drag the divider to resize the details pane; GPUI keeps the sizes under "gg-split".
        ? v_resizable("gg-split").flex_1().min_h(0)
          .child(resizable_panel().size_range(80).child(list))
          .child(resizable_panel().size(260).size_range(120).child(details))
        : div().flex_1().min_h(0).child(list));
  }
}
