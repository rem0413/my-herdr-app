import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Popover, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, settings, props, run, shared, setShared } from "herdr";
import { parseStatus, parseNumstat, checkState, treeRows, ago } from "./git.js";
import GitGraph from "./graph.js";

// Source control for the focused pane's repo: stage/unstage by checkbox, commit, push/pull,
// repo (superproject + submodules) and branch pickers, stashes. History is the git-graph mod, nested.
// Diffs open in the shared git-diff preview tab (see mods/git-diff/main.js).

// Mod panes (the diff tab) have no cwd: keep the last terminal's folder instead of jumping to the space folder.
let last = null;
function location() {
  if (props()?.folder) return { cwd: props().folder, on: props().on ?? null };
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  const cwd = pane?.cwd || f?.cwd;
  if (cwd) return (last = { cwd, on });
  return last ?? { cwd: space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git, so the folder watch doesn't wake itself.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const ICON = "mods/source-control/", SEP = "\x1f", ROW = 26, LIMIT = 2000, ADD = "#3fb950", DEL = "#f85149";
const base = (p) => p.replace(/\/+$/, "").split("/").pop() || p;

export default class SourceControl extends View {
  init(_props, cx) {
    this.tab = localStorage.getItem("tab") ?? "changes"; this.view = localStorage.getItem("view") ?? "tree";
    this.files = []; this.stashes = []; this.repos = []; this.branches = []; this.remotes = [];
    this.collapsed = new Set(); this.gen = 0; this.message = ""; this.query = "";
    this.msg = TextareaState.new({ placeholder: "Enter commit message", rows: 3 });
    this.msg.set_auto_grow(3, 8);
    this.msg.on("change", (_e, cx) => {
      const had = Boolean(this.message.trim());
      this.message = this.msg.value();
      if (had !== Boolean(this.message.trim())) cx.notify();
    });
    this.msg.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.msg.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.filter = InputState.new({ placeholder: "Find or create a branch" });
    this.filter.on("change", (_e, cx) => { this.query = this.filter.value(); cx.notify(); });
    this.filter.on("submit", (_e, cx) => { const first = this.branchItems()[0]; if (first) { this.menu = null; first.pick(cx); } });
    if (this.tab === "history") this.graph = cx.new(GitGraph);
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  git(args) { return exec("git", [...READ, ...args], { cwd: this.repo, on: this.on }); }

  // rediscover: re-read the repo list; force: run even while a load is in flight.
  refresh(cx, { rediscover = false, force = false } = {}) {
    if ((this.loading || this.busy) && !force) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.repo = null; this.repos = []; this.files = []; this.stashes = [];
      this.open = null; this.error = null; this.note = null; this.watched = null; rediscover = true;
    }
    if (!cwd) return;
    const gen = ++this.gen;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        if (rediscover || !this.repo) {
          const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
          if (gen !== this.gen) return;
          if (top.code !== 0) { this.error = "Not a git repository"; this.repo = null; this.files = []; this.repos = []; return; }
          const here = top.stdout.trim();
          let root = here;
          for (;;) {
            const s = await exec("git", ["rev-parse", "--show-superproject-working-tree"], { cwd: root, on });
            if (s.code !== 0 || !s.stdout.trim()) break;
            root = s.stdout.trim();
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
        await this.load(gen);
        this.watch(this.repo, cx);
      } catch (e) { if (gen === this.gen) this.error = String(e.message ?? e); }
      finally { if (gen === this.gen) { this.loading = false; cx.notify(); } }
    });
  }

  async load(gen) {
    const repo = this.repo, g = (a) => this.git(a);
    const [status, head, branch, refs, rem, stash, track] = await Promise.all([
      g(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]),
      g(["log", "-1", `--format=%H${SEP}%s`]),
      g(["symbolic-ref", "--short", "-q", "HEAD"]),
      g(["for-each-ref", "--format=%(refname:short)%09%(refname)", "refs/heads", "refs/remotes"]),
      g(["remote"]),
      g(["stash", "list", `--format=%gd${SEP}%s${SEP}%ct`]),
      g(["rev-list", "--left-right", "--count", "HEAD...@{u}"]),
    ]);
    if (status.code !== 0) throw new Error(status.stderr.trim() || "git status failed");
    const [hash = "", subject = ""] = head.code === 0 ? head.stdout.trim().split(SEP) : [];
    const stats = {};
    const nums = hash ? [g(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [g(["diff", "--cached", "--numstat", "-z", "--no-renames"]), g(["diff", "--numstat", "-z", "--no-renames"])];
    for (const r of await Promise.all(nums)) if (r.code === 0) parseNumstat(r.stdout, stats);
    const all = parseStatus(status.stdout);
    // ponytail: shows the first LIMIT changed files; page the list if huge trees matter.
    const files = all.slice(0, LIMIT).map((f) => Object.assign(f, stats[f.path] ?? {}));
    if (gen !== this.gen || repo !== this.repo) return;
    this.files = files; this.limited = all.length > LIMIT;
    this.head = { hash, subject };
    this.branch = branch.code === 0 ? branch.stdout.trim() : hash ? `(detached ${hash.slice(0, 7)})` : "";
    this.detached = branch.code !== 0;
    this.branches = refs.stdout.split("\n").filter(Boolean).map((l) => l.split("\t"))
      .filter(([, full]) => full && !full.endsWith("/HEAD"))
      .map(([name, full]) => ({ name, remote: full.startsWith("refs/remotes/") }));
    this.remotes = rem.stdout.split("\n").filter(Boolean);
    this.stashes = stash.stdout.split("\n").filter(Boolean).map((l) => { const [ref, s, time] = l.split(SEP); return { ref, subject: s, time: Number(time) }; });
    this.upstream = track.code === 0;
    [this.ahead, this.behind] = this.upstream ? track.stdout.trim().split(/\s+/).map(Number) : [0, 0];
    this.error = null;
    if (this.open?.path && !files.some((f) => f.path === this.open.path)) this.open = null;
  }

  // Local folders refresh on change; remote ones on the 10 s timer.
  watch(root, cx) {
    if (this.on || !root || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { if (this.watched === root) this.watched = null; }
    });
  }

  // Runs git writes in order; stops at the first failure and shows its message.
  act(label, steps, cx, done = null) {
    if (this.busy || !this.repo) return;
    const repo = this.repo, on = this.on;
    this.busy = label; this.note = null;
    cx.spawn(async (cx) => {
      let ok = true;
      try {
        for (const args of steps) {
          const r = await exec("git", args, { cwd: repo, on });
          if (r.code !== 0) { ok = false; this.note = (r.stderr || r.stdout).trim().split("\n").filter(Boolean).slice(-2).join(" "); break; }
        }
      } catch (e) { ok = false; this.note = String(e.message ?? e); }
      this.busy = null;
      if (ok && done) done();
      this.refresh(cx, { force: true });
      cx.notify();
    });
    cx.notify();
  }

  // A checkbox over a set of files: all staged -> unstage them, else stage them all.
  toggle(files, cx) {
    if (!files.length) return;
    const paths = files.map((f) => f.path);
    // ponytail: every path goes on one command line; batch it if a huge folder hits ARG_MAX.
    if (checkState(files) === "all") this.act("Unstaging", [this.head?.hash ? ["restore", "--staged", "--", ...paths] : ["rm", "--cached", "-r", "-q", "--", ...paths]], cx);
    else this.act("Staging", [["add", "--", ...paths]], cx);
  }

  pushArgs() { return this.upstream ? ["push"] : ["push", "-u", this.remotes[0] ?? "origin", this.branch]; }

  commit(mode, cx) {
    const message = this.message.trim();
    if ((!message && mode !== "amend") || !this.files.length && mode !== "amend") return;
    const staged = this.files.some((f) => f.staged !== "none");
    const steps = [];
    // Nothing staged: commit every change, like the old Changes panel.
    if (!staged && mode !== "amend") steps.push(["add", "-A"]);
    steps.push(mode === "amend" ? ["commit", "--amend", ...(message ? ["-m", message] : ["--no-edit"])] : ["commit", "-m", message]);
    if (mode === "push" && this.remotes.length) steps.push(this.pushArgs());
    this.act(mode === "amend" ? "Amending" : "Committing", steps, cx, () => { this.message = ""; this.msg.set_value(""); });
  }

  // One preview tab: the first click opens it, later clicks load another target into it.
  openDiff(preview, name) {
    this.open = preview;
    const tab = shared("git-diff.previewTab"), alive = tab && spaces().some((s) => s.tabs.some((x) => x.id === tab));
    setShared("git-diff.preview", { repo: this.repo, on: this.on, ...preview });
    if (alive) { run("tab.rename", { id: tab, name }); run("tab.select", { id: tab }); }
    else run("tab.new", { name, mod: "git-diff" });
  }

  setTab(tab, cx) {
    this.tab = tab; localStorage.setItem("tab", tab);
    // Created on first use: the graph polls git while it lives.
    if (tab === "history" && !this.graph) this.graph = cx.new(GitGraph);
    cx.notify();
  }

  // ---- pieces ----

  icon(name, size = 14) { return svg(ICON + name + ".svg").size(size); }

  button(id, icon, label, onClick, t, { active = false, disabled = false, compact = false } = {}) {
    return h_flex().id(id).h(26).px(compact || !label ? 0 : 7).when(compact || !label, (e) => e.w(26).justify_center()).gap(5).flex_none().items_center().rounded(6)
      .text_color(disabled ? t.dim : active ? t.foreground : t.muted).when(active, (e) => e.bg(t.selected))
      .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => onClick(cx)))
      .when(Boolean(icon), (e) => e.child(this.icon(icon)))
      .when(Boolean(label) && !compact, (e) => e.child(div().text_size(12).child(label)));
  }

  segment(t, ...buttons) { return h_flex().flex_none().gap(1).p(1).rounded(7).border_1().border_color(t.border).children(buttons); }

  check(id, state, files, t) {
    return div().id(id).w(14).h(14).flex_none().flex().items_center().justify_center().rounded(3).border_1()
      .border_color(state === "none" ? t.input : t.accent).text_color(t.accent)
      .when(state === "all", (e) => e.bg(t.accent).text_color(t.accent_foreground))
      .when(!this.busy, (e) => e.cursor_pointer())
      // mouse_down, not click: the row under it opens the diff on click.
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); if (!this.busy) this.toggle(files, cx); })
      .when(state !== "none", (e) => e.child(this.icon(state === "all" ? "check" : "minus", 10)));
  }

  pop(id, trigger, content) {
    return Popover.new(id).open(this.menu === id).on_open_change((open, cx) => { this.menu = open ? id : null; cx.notify(); })
      .trigger(trigger).content(content);
  }

  // items: { header } | { label, icon?, hint?, checked?, dim?, pick(cx) }
  menuList(id, items, t, w = 240, top = null) {
    return v_flex().id(`${id}-list`).w(w).max_h(360).overflow_y_scrollbar().p(4).mt(4).bg(t.popover).border_1().border_color(t.border).rounded(8).shadow_md().text_size(12)
      .when(Boolean(top), (e) => e.child(top))
      .children(items.map((it, k) => it.header
        ? div().px(8).pt(6).pb(2).text_size(10).text_color(t.dim).child(it.header)
        : h_flex().id(`${id}-${k}`).h(26).flex_none().px(6).gap(6).items_center().rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.menu = null; it.pick(cx); cx.notify(); })
          .child(div().w(14).flex_none().text_color(t.accent).when(Boolean(it.checked), (e) => e.child(this.icon("check", 12))).when(Boolean(it.icon) && !it.checked, (e) => e.text_color(t.muted).child(this.icon(it.icon, 12))))
          .child(div().flex_1().min_w(0).truncate().text_color(it.dim ? t.muted : t.foreground).child(it.label))
          .when(Boolean(it.hint), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(it.hint)))))
      .when(!items.length, (e) => e.child(div().px(8).py(6).text_color(t.dim).child("Nothing here")));
  }

  // A main action with a chevron menu beside it.
  splitButton(id, label, enabled, onMain, items, t, primary = false) {
    const fg = enabled ? (primary ? t.solid_foreground : t.foreground) : t.dim, bg = enabled && primary ? t.solid : t.surface;
    return h_flex().flex_none().h(28).rounded(6).border_1().border_color(t.border).bg(bg).text_color(fg).text_size(12).overflow_hidden()
      .child(h_flex().id(`${id}-main`).h_full().px(10).gap(5).items_center()
        .when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onMain(cx))).child(label))
      .child(div().w(1).h_full().bg(t.border))
      .child(this.pop(`${id}-menu`, div().id(`${id}-more`).h_full().w(24).flex().items_center().justify_center().cursor_pointer().hover((s) => s.bg(t.hover)).child(this.icon("chevron-down", 12)),
        this.menuList(`${id}-menu`, items, t, 200)));
  }

  branchItems() {
    const q = this.query.trim(), lq = q.toLowerCase(), hit = (b) => !lq || b.name.toLowerCase().includes(lq);
    const local = this.branches.filter((b) => !b.remote && hit(b)), remote = this.branches.filter((b) => b.remote && hit(b));
    const items = local.map((b) => ({ label: b.name, checked: b.name === this.branch, pick: (cx) => b.name !== this.branch && this.act("Checking out", [["checkout", b.name]], cx) }));
    for (const b of remote) {
      const remoteName = this.remotes.find((r) => b.name.startsWith(r + "/")), short = remoteName ? b.name.slice(remoteName.length + 1) : b.name;
      const exists = this.branches.some((x) => !x.remote && x.name === short);
      items.push({ label: b.name, dim: true, icon: "branch", pick: (cx) => this.act("Checking out", [exists ? ["checkout", short] : ["checkout", "--track", b.name]], cx) });
    }
    if (q && !this.branches.some((b) => !b.remote && b.name === q))
      items.unshift({ label: `Create branch "${q}"`, icon: "plus", pick: (cx) => this.act("Creating branch", [["checkout", "-b", q]], cx, () => { this.filter.set_value(""); this.query = ""; }) });
    return items;
  }

  // ---- regions ----

  header(t) {
    const tabBtn = (id, label) => div().id(`sc-tab-${id}`).flex_1().h_full().flex().items_center().justify_center().cursor_pointer()
      .border_b(2).border_color(this.tab === id ? t.accent : "#00000000").text_color(this.tab === id ? t.foreground : t.muted)
      .when(this.tab === id, (e) => e.font_semibold()).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => this.setTab(id, cx)).child(label);
    return h_flex().flex_none().h(38).border_b(1).border_color(t.border).text_size(13)
      .child(tabBtn("changes", `Changes (${this.files.length})`)).child(tabBtn("history", "History"));
  }

  toolbar(t) {
    const add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const compact = (this.size?.width ?? 400) < 400, mode = shared("git-diff.mode") === "unified" ? "unified" : "split";
    const allStaged = this.files.length > 0 && checkState(this.files) === "all", none = !this.files.length || Boolean(this.busy);
    const more = [
      { label: "Stash all changes", icon: "stash", pick: (cx) => this.act("Stashing", [["stash", "push", "--include-untracked"]], cx) },
      { label: "Fetch", icon: "pull", pick: (cx) => this.act("Fetching", [["fetch", "--all", "--prune"]], cx) },
      { label: "Pull", icon: "pull", pick: (cx) => this.act("Pulling", [["pull", "--ff-only"]], cx) },
      { label: "Refresh", icon: "refresh", pick: (cx) => this.refresh(cx, { rediscover: true, force: true }) },
    ];
    return h_flex().flex_none().h(38).px(8).gap(4).items_center().border_b(1).border_color(t.border)
      .child(this.button("sc-viewdiff", "diff", "View Diff", () => this.openDiff({ worktree: true }, "Changes"), t, { disabled: !this.files.length }))
      .child(div().flex_none().text_size(12).text_color(ADD).child(`+${add}`)).child(div().flex_none().text_size(12).text_color(DEL).child(`−${del}`))
      .child(div().flex_1())
      .child(this.segment(t,
        this.button("sc-tree", "tree", null, (cx) => { this.view = "tree"; localStorage.setItem("view", "tree"); cx.notify(); }, t, { active: this.view === "tree" }),
        this.button("sc-list", "list", null, (cx) => { this.view = "list"; localStorage.setItem("view", "list"); cx.notify(); }, t, { active: this.view === "list" })))
      .child(this.segment(t,
        this.button("sc-unified", "unified", null, () => setShared("git-diff.mode", "unified"), t, { active: mode === "unified" }),
        this.button("sc-split", "split", null, () => setShared("git-diff.mode", "split"), t, { active: mode === "split" })))
      .child(this.pop("sc-more", this.button("sc-more-btn", "refresh", null, () => {}, t), this.menuList("sc-more", more, t, 200)))
      .child(this.button("sc-stageall", allStaged ? "minus" : "plus", allStaged ? "Unstage All" : "Stage All", (cx) => this.toggle(this.files, cx), t, { disabled: none, compact }));
  }

  groupRow(id, label, files, count, t, withCheck = true) {
    const closed = this.collapsed.has(id);
    return h_flex().id(`sc-g-${id}`).h(ROW).flex_none().px(8).gap(6).items_center().rounded(6).cursor_pointer().text_color(t.muted)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { closed ? this.collapsed.delete(id) : this.collapsed.add(id); cx.notify(); })
      .child(this.icon(closed ? "chevron-right" : "chevron-down", 12)).child(div().flex_1().child(label))
      .when(withCheck, (e) => e.child(this.check(`sc-gc-${id}`, checkState(files), files, t)))
      .child(div().px(6).rounded(4).bg(t.raised).text_size(11).text_color(t.dim).child(String(count)));
  }

  fileRows(group, files, t) {
    if (this.collapsed.has(group)) return [];
    const tree = this.view === "tree";
    const rows = tree ? treeRows(files, this.collapsed, group) : files.map((f) => ({ file: f, key: `${group}:${f.path}`, name: base(f.path), depth: 0 }));
    const letterColor = (f) => f.letter === "D" || f.letter === "!" ? DEL : f.letter === "M" ? t.ansi3 : ADD;
    return rows.map((r) => {
      const row = h_flex().id(`sc-r-${r.key}`).h(ROW).flex_none().pl(28 + r.depth * 16).pr(8).gap(7).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover));
      if (r.dir) return row.on_click((_e, cx) => { this.collapsed.has(r.key) ? this.collapsed.delete(r.key) : this.collapsed.add(r.key); cx.notify(); })
        .child(this.check(`sc-c-${r.key}`, checkState(r.files), r.files, t))
        .child(div().text_color(t.muted).child(this.icon(this.collapsed.has(r.key) ? "chevron-right" : "chevron-down", 12)))
        .child(div().text_color(t.muted).child(this.icon("folder", 14)))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(r.name));
      const f = r.file, dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/") + 1) : "";
      const selected = this.open?.worktree && this.open.path === f.path;
      return row.when(selected, (e) => e.bg(t.selected))
        .on_click(() => this.openDiff({ worktree: true, path: f.path, untracked: f.untracked }, base(f.path)))
        .child(this.check(`sc-c-${r.key}`, f.staged, [f], t))
        .child(div().w(12).flex_none().text_size(11).font_semibold().text_color(letterColor(f)).child(f.letter))
        .child(h_flex().flex_1().min_w(0)
          .child(div().flex_none().max_w(260).truncate().when(f.letter === "D", (e) => e.line_through()).child(r.name))
          .when(!tree && Boolean(dir), (e) => e.child(div().min_w(0).ml(6).truncate().text_size(11).text_color(t.dim).child(dir))))
        .when(f.binary, (e) => e.child(div().text_size(11).text_color(t.dim).child("bin")))
        .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(ADD).child(`+${f.add}`)))
        .when(f.del > 0, (e) => e.child(div().text_size(11).text_color(DEL).child(`−${f.del}`)));
    });
  }

  changes(t) {
    const tracked = this.files.filter((f) => !f.untracked), untracked = this.files.filter((f) => f.untracked);
    const empty = !this.files.length && !this.stashes.length;
    return v_flex().id("sc-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).text_size(13)
      .when(tracked.length > 0, (e) => e.child(this.groupRow("tracked", "Tracked", tracked, tracked.length, t)).children(this.fileRows("tracked", tracked, t)))
      .when(untracked.length > 0, (e) => e.child(this.groupRow("untracked", "Untracked", untracked, untracked.length, t)).children(this.fileRows("untracked", untracked, t)))
      .when(this.limited, (e) => e.child(div().px(8).py(4).text_size(11).text_color(t.dim).child(`Showing the first ${LIMIT} changed files`)))
      .when(this.stashes.length > 0, (e) => e.child(this.groupRow("stashes", "Stashes", [], this.stashes.length, t, false))
        .when(!this.collapsed.has("stashes"), (e) => e.children(this.stashes.map((s) => h_flex().id(`sc-s-${s.ref}`).h(ROW).flex_none().pl(28).pr(8).gap(7).items_center().rounded(6)
          .hover((st) => st.bg(t.hover)).on_hover((h, cx) => { this.hoverStash = h ? s.ref : this.hoverStash === s.ref ? null : this.hoverStash; cx.notify(); })
          .child(div().text_color(t.muted).child(this.icon("stash")))
          .child(div().flex_1().min_w(0).truncate().child(s.subject))
          .child(this.hoverStash === s.ref
            ? h_flex().gap(2).child(this.button(`sc-sa-${s.ref}`, null, "Apply", (cx) => this.act("Applying stash", [["stash", "apply", s.ref]], cx), t))
              .child(this.button(`sc-sp-${s.ref}`, null, "Pop", (cx) => this.act("Popping stash", [["stash", "pop", s.ref]], cx), t))
            : div().text_size(11).text_color(t.dim).child(ago(s.time)))))))
      .when(empty, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.repo ? "No uncommitted changes" : "No folder"))));
  }

  footer(t) {
    const repoName = this.repos.find((r) => r.path === this.repo)?.name ?? (this.repo ? base(this.repo) : "—");
    const repoItems = this.repos.map((r) => ({ label: r.name, checked: r.path === this.repo, pick: (cx) => {
      this.repo = r.path; this.files = []; this.open = null; this.watched = null; this.refresh(cx, { force: true });
    } }));
    const canRemote = this.remotes.length > 0 && !this.detached && Boolean(this.head?.hash) && !this.busy;
    const pushLabel = !this.upstream ? "Publish" : this.behind > 0 && !this.ahead ? `↓${this.behind} Pull` : `${this.ahead ? `↑${this.ahead} ` : ""}${this.behind ? `↓${this.behind} ` : ""}Push`;
    const pushMain = (cx) => !this.upstream ? this.act("Publishing", [this.pushArgs()], cx)
      : this.behind > 0 && !this.ahead ? this.act("Pulling", [["pull", "--ff-only"]], cx) : this.act("Pushing", [this.pushArgs()], cx);
    const remoteItems = [
      { label: "Push", icon: "push", pick: (cx) => this.act("Pushing", [this.pushArgs()], cx) },
      { label: "Pull", icon: "pull", pick: (cx) => this.act("Pulling", [["pull", "--ff-only"]], cx) },
      { label: "Pull (rebase)", icon: "pull", pick: (cx) => this.act("Pulling", [["pull", "--rebase"]], cx) },
      { label: "Fetch", icon: "refresh", pick: (cx) => this.act("Fetching", [["fetch", "--all", "--prune"]], cx) },
    ];
    const canCommit = Boolean(this.message.trim() && this.files.length && this.repo && !this.busy);
    const staged = this.files.some((f) => f.staged !== "none");
    const commitItems = [
      { label: "Commit & Push", icon: "push", pick: (cx) => this.commit("push", cx) },
      { label: "Amend last commit", icon: "undo", pick: (cx) => this.commit("amend", cx) },
    ];
    const trigger = (id, text, bold) => h_flex().id(id).min_w(0).h(24).px(4).gap(3).items_center().rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
      .child(div().min_w(0).truncate().when(bold, (e) => e.font_semibold().text_color(t.foreground)).child(text)).child(this.icon("chevron-down", 11));
    const branchFind = div().id("sc-branch-find").mx(4).mb(4).h(28).px(8).flex().items_center().rounded(6).border_1().border_color(t.input)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.filter).h_full().text_size(12).text_color(t.foreground));
    return v_flex().flex_none().border_t(1).border_color(t.border)
      .child(v_flex().p(10).gap(8)
        .child(h_flex().gap(4).items_center().text_size(12).text_color(t.muted)
          .child(div().flex_none().child(this.icon("branch")))
          .child(this.pop("sc-repo", trigger("sc-repo-btn", repoName, false), this.menuList("sc-repo", repoItems, t, 260)))
          .child(div().flex_none().text_color(t.dim).child("/"))
          .child(this.pop("sc-branch", trigger("sc-branch-btn", this.branch || "—", true), this.menuList("sc-branch", this.branchItems(), t, 280, branchFind)))
          .child(div().flex_1())
          .when(this.remotes.length > 0, (e) => e.child(this.splitButton("sc-push", pushLabel, canRemote, pushMain, remoteItems, t))))
        .child(div().id("sc-message").w_full().min_h(64).px(10).py(8).rounded(8).border_1().border_color(this.typing ? t.accent : t.border).bg(t.surface).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_key_down((e, cx) => {
            if (e.key === "enter" && (e.modifiers.platform || e.modifiers.control)) { this.commit("commit", cx); cx.stop_propagation(); }
          })
          .child(Textarea.new(this.msg).w_full().text_size(12).text_color(t.foreground).font_family(settings().font_family ?? "JetBrains Mono")))
        .when(Boolean(this.note || this.busy), (e) => e.child(div().text_size(11).text_color(this.note ? DEL : t.muted).whitespace_normal().child(this.note || `${this.busy}…`)))
        .child(h_flex().items_center().gap(8)
          .child(div().flex_1().text_size(11).text_color(t.dim).truncate().child(this.files.length ? (staged ? "Commits staged files · ⌘↵" : "Nothing staged: commits all · ⌘↵") : ""))
          .child(this.splitButton("sc-commit", staged ? "Commit" : "Commit All", canCommit, (cx) => this.commit("commit", cx), commitItems, t, true))))
      .when(Boolean(this.head?.hash), (e) => e.child(h_flex().h(32).px(10).gap(6).items_center().border_t(1).border_color(t.border).text_size(12)
        .child(div().flex_none().text_color(t.dim).font_family(settings().font_family ?? "JetBrains Mono").child(this.head.hash.slice(0, 7)))
        .child(this.button("sc-copy", "copy", null, (cx) => cx.write_to_clipboard(this.head.hash), t))
        .child(div().flex_1().min_w(0).truncate().child(this.head.subject))
        .child(this.button("sc-undo", "undo", null, (cx) => this.act("Undoing last commit", [["reset", "--soft", "HEAD~1"]], cx, () => { this.message = this.head.subject; this.msg.set_value(this.head.subject); }), t, { disabled: Boolean(this.busy) }))
        .child(div().id("sc-history").w(26).h(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.setTab("history", cx)).child(svg("mods/git-graph/graph.svg").size(14)))));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme();
    return v_flex().id("source-control").size_full().min_h(0).overflow_hidden().rounded(10).border_1().border_color(t.border)
      .bg(t.background).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .child(this.header(t))
      .when(this.tab === "changes", (e) => e.child(this.toolbar(t)).child(this.changes(t)).child(this.footer(t)))
      // The graph follows the focused pane's repo itself; it has its own repo/branch pickers.
      .when(this.tab === "history" && Boolean(this.graph), (e) => e.child(div().flex_1().min_h(0).child(this.graph)));
  }
}
