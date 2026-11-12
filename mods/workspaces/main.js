// Workspace tree: spaces nested under a parent of your choosing (worktrees nest under
// their checkout until you pick one), pinned entries that stay listed, closed, after their
// last tab goes, and a right-click menu (pin, parent, rename, worktrees, close).
// Grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch (a closed entry opens a new shell where it was), drag to reorder.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, machines, panes, agents, knownAgents, focused, run, openOverlay, closeOverlay, props, exec, hc, theme, shared, setShared, watchFolder, window, layout } from "herdr";
import { EMPTY, canParent, flatten, reconcile, setColor, setParent, startReopen, toggleFold, togglePin } from "./tree.js";
import { PRStatusObserver, prAppearance } from "./pr-status.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ depth }) => (depth > 0 ? 28 : 30);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Tag colors a space can take. Green when unset. Keys stay the stored ids ("ansi1"),
// drawn in fixed vivid hex (macOS Finder tag style): theme ANSI is too dark on chrome.
// Each color is one tag; its name lives in shared("workspace.tags") ({ ansi1: "bugs" }).
const COLORS = [["Green", "ansi2"], ["Red", "ansi1"], ["Yellow", "ansi3"], ["Blue", "ansi4"], ["Magenta", "ansi5"], ["Cyan", "ansi6"]];
const HEX = { ansi2: "#4ce16a", ansi1: "#fe4f55", ansi3: "#ffd23f", ansi4: "#3d9bff", ansi5: "#c86bff", ansi6: "#3fd8e6" };
const DEFAULT_COLOR = "ansi2";
const colorOf = (entry) => entry?.color ?? DEFAULT_COLOR;
const tagName = (key) => shared("workspace.tags")?.[key] || COLORS.find(([, k]) => k === key)?.[0] || key;
const colorDot = (t, key) => div().size(7).rounded(4).flex_none().bg(HEX[key] ?? t.dim);
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };

// A program's icon from Herdr's program table; it follows what runs in the pane now.
function progIcon(p, size, color) {
  if (!p?.icon) return svg("mods/workspace-chrome/terminal.svg").size(size).flex_none().text_color(color);
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// An agent's state, as the agents list draws it.
function statusMark(t, s) {
  if (s === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
  if (s === "blocked") return div().flex_none().px(5).h(16).rounded(4).bg(t.blocked + "26").text_size(10).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
  if (s === "done") return div().size(7).mx(3).flex_none().rounded(4).bg(t.done);
  return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
}

// One step of a tree line in front of a tab row: down from the row above, then right.
function rail(t, last) {
  return div().relative().w(10).h(26).flex_none()
    .child(div().absolute().left(0).top(0).w(1.5).bg(t.input).when(last, (el) => el.h(13)).when(!last, (el) => el.bottom(0)))
    .child(div().absolute().left(0).top(12).w(9).h(1.5).bg(t.input));
}

// Spaces | Agents tabs over the sidebar-lists stack; the agents mod draws the same bar.
export function listTabs(t, on, agentKeys = new Set()) {
  const asleep = shared("hibernate.sleeping") ?? {};
  // Matches the agents list: reporting agents plus panes running an agent that never reported.
  const spaceOf = new Map(spaces().flatMap((s) => s.tabs.map((tab) => [tab.id, s.id])));
  const reported = agents().filter((a) => !asleep[a.space]);
  const listed = new Set(reported.map((a) => a.address));
  const silent = panes().filter((p) => p.terminal && agentKeys.has(p.program?.key) && !p.status && !listed.has(p.terminal) && spaceOf.has(p.tab) && !asleep[spaceOf.get(p.tab)]);
  const count = reported.length + silent.length;
  const tab = (id, label, n) => h_flex().id(`lists-tab-${id}`).h(24).px(10).gap(5).items_center().rounded(6).cursor_pointer()
    .text_size(12).font_medium().text_color(on === id ? t.foreground : t.dim)
    .when(on === id, (el) => el.bg(t.selected))
    .when(on !== id, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
    .on_click(() => run("layout.select", { stack: "sidebar-lists", child: id }))
    .child(label)
    .when(n > 0, (el) => el.child(div().px(5).h(16).rounded(4).bg(t.raised).text_size(10).text_color(t.muted).flex().items_center().child(String(n))));
  return h_flex().gap(2).child(tab("spaces", "Spaces", 0)).child(tab("agents", "Agents", count));
}

// A closed entry comes back as a new space (a fresh shell) where it was, on its machine.
// The tree adopts that space into the same entry, so its parent, children and pin stay.
function reopen(state, entry) {
  const args = { machine: entry.machine ?? "" };
  if (entry.folder) args.folder = entry.folder;
  if (entry.named) args.name = entry.name;
  setShared("workspace.tree", startReopen(state, entry.id));
  run("space.new", args);
}

// The + buttons open the Add a space dialog (browse / clone / create, on any connected host).
const addSpace = (machine = null) => openOverlay({ mod: "add-space", kind: "dialog", width: 420, props: { machine } });

export default class Spaces extends View {
  init(_props, cx) {
    // The right-click menu is this mod opened as a popup: no lists to keep.
    if (props()?.menu) {
      this.at = 0;
      this.menuView = "main";
      this.handle = cx.focus_handle();
      this.handle.focus();
      return;
    }
    // Program keys of known agents, to count panes running one that never reported.
    this.agentKeys = new Set();
    cx.spawn(async (cx) => {
      try { this.agentKeys = new Set((await knownAgents()).map((a) => a.key)); cx.notify(); } catch {}
    });
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    // PRs of each space's checkout via local `gh`; Git runs on the space's machine.
    this.pr = new PRStatusObserver();
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`). Every render looks too
    // (spaces, panes and agents redraw it); this timer catches the fallback and new spaces.
    cx.timer.every(1000, (cx) => this.checkNew(cx, true));
  }

  // `notify`: false from render, which must not ask for another render.
  checkNew(cx, notify) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const ps = panes();
    const due = this.due(now, sp, ps);
    if (due.size) this.refreshGit(due, cx);
    // GitHub is asked only while the window is in front, like the git fallback.
    if (window()?.active) this.pr.refresh(sp.map((s) => ({ machine: s.machine ?? null, folder: place(s, ps), branch: this.git[where(s, ps)]?.branch ?? null })), cx);
    if (notify && sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window()?.active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      // Forget places no space is in any more, so their repos stop being watched below.
      const live = new Set(Object.values(this.at));
      for (const k of Object.keys(this.git)) if (!live.has(k)) delete this.git[k], delete this.checked[k], this.unsure.delete(k);
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      // A git too old for --path-format (before 2.31), or a failed look: no repo to name or watch.
      if (top.code !== 0 || common.code !== 0 || !repo) {
        this.unsure.add(key);
        this.git[key] ??= null;
        return;
      }
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(r) {
    // A popup is as tall as its items; height is only the most.
    const git = r.g ? (r.g.linked ? "linked" : "main") : null;
    openOverlay({ mod: "workspaces", kind: "popup", width: 220, height: 340, props: { menu: { entry: r.entry.id, space: r.w?.id ?? null, git } } });
  }

  // [label, icon, action, hint] for the popup.
  menuItems() {
    const { menu } = props();
    const state = shared("workspace.tree") ?? EMPTY;
    const entry = state.entries.find((e) => e.id === menu.entry);
    if (!entry) return [];
    const done = (next) => {
      closeOverlay(props().overlay);
      if (next) setShared("workspace.tree", next);
    };
    if (this.menuView === "parent") {
      return [
        ["Top level", "layers", () => done(setParent(state, entry.id, null))],
        ...state.entries
          .filter((e) => e.id !== entry.id && canParent(state.entries, entry.id, e.id))
          .map((e) => [e.name, "chevron-right", () => done(setParent(state, entry.id, e.id)), e.folder ? base(e.folder) : ""]),
      ];
    }
    if (this.menuView === "color") {
      return COLORS.map(([, key]) => [tagName(key), `color:${key}`, () => done(setColor(state, entry.id, key === DEFAULT_COLOR ? null : key)), colorOf(entry) === key ? "✓" : ""]);
    }
    const worktree = (action) => () => {
      closeOverlay(props().overlay);
      openOverlay({ mod: "worktree", kind: "dialog", ...(action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }), props: { space: menu.space, action } });
    };
    return [
      ...(menu.space ? [] : [["Open", "terminal", () => { closeOverlay(props().overlay); reopen(state, entry); }]]),
      [entry.pinned ? "Unpin" : "Pin", entry.pinned ? "pin-off" : "pin", () => done(togglePin(state, entry.id))],
      ["Set parent…", "git-branch", () => { this.menuView = "parent"; this.at = 0; }],
      ["Tag…", `color:${colorOf(entry)}`, () => { this.menuView = "color"; this.at = 0; }, tagName(colorOf(entry))],
      ["Rename tag…", "square-pen", () => this.editTag(colorOf(entry))],
      ...(menu.space ? [["Rename", "square-pen", () => { closeOverlay(props().overlay); run("space.rename", { id: menu.space }); }]] : []),
      ...(menu.git ? [["New worktree", "git-branch", worktree("new")], ["Open worktree", "git-branch", worktree("open")]] : []),
      ...(menu.git === "linked" ? [["Remove worktree", "git-branch", worktree("remove")]] : []),
      ...(menu.space ? [["Close", "x", () => { closeOverlay(props().overlay); run("space.close", { id: menu.space }); }]] : []),
    ];
  }

  // Inline rename of one color's tag name, inside the popup.
  editTag(key) {
    this.menuView = "tag";
    this.tagKey = key;
    this.tagInput = InputState.new({ value: shared("workspace.tags")?.[key] ?? "" });
    this.tagInput.on("submit", () => {
      const tags = { ...(shared("workspace.tags") ?? {}) };
      const name = this.tagInput.value().trim();
      if (name) tags[key] = name; else delete tags[key];
      setShared("workspace.tags", tags);
      closeOverlay(props().overlay);
    });
    this.tagInput.focus();
  }

  renderMenu() {
    const t = theme();
    if (this.menuView === "tag") {
      return v_flex().id("workspace-tag").w_full().min_h(0).p(8).gap(6).bg(t.popover).text_size(12)
        .on_key_down((e) => { if (e.key === "escape") closeOverlay(props().overlay); })
        .child(h_flex().gap(7).items_center().text_color(t.dim).child(colorDot(t, this.tagKey)).child("Tag name · Enter saves"))
        .child(Input.new(this.tagInput).h(30).px(8).rounded(8).border_1().border_color(t.accent).bg(t.background).text_size(13).text_color(t.foreground));
    }
    const list = this.menuItems();
    const pick = (i, cx) => {
      list[i]?.[2]();
      cx.notify();
    };
    return v_flex()
      .id("workspace-menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => {
        const n = list.length || 1;
        if (e.key === "down") this.at = (this.at + 1) % n;
        else if (e.key === "up") this.at = (this.at + n - 1) % n;
        else if (e.key === "enter") return pick(this.at, cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .child(
        v_flex().max_h(320).overflow_y_scrollbar().children(
          list.map((it, i) =>
            h_flex()
              .id(`wm-${i}`)
              .h(31)
              .flex_none()
              .px(8)
              .gap(9)
              .rounded(8)
              .items_center()
              .text_color(t.foreground)
              .when(i === this.at, (el) => el.bg(t.selected))
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => pick(i, cx))
              .child(it[1].startsWith("color:") ? colorDot(t, it[1].slice(6)).mx(4) : svg(`mods/workspace-chrome/${it[1]}.svg`).size(14).flex_none().text_color(t.muted))
              .child(div().flex_1().min_w(0).truncate().child(it[0]))
              .child(div().max_w(80).flex_none().truncate().text_size(11).text_color(t.dim).child(it[3] ?? "")),
          ),
        ),
      );
  }

  // Tree state: shared("workspace.tree"), kept in step with the live spaces.
  syncTree() {
    const ps = panes();
    const live = spaces().map((s) => ({ id: s.id, name: s.name, named: s.named, machine: s.machine, folder: place(s, ps) }));
    const saved = shared("workspace.tree") ?? EMPTY;
    // A machine that can't be read is not "no spaces": never forget entries on it.
    const readable = (m) => {
      const k = machines().find((x) => x.name === m);
      return k ? k.layout === "ready" : m === null;
    };
    this.tree = reconcile(saved, live, readable);
    if (JSON.stringify(this.tree) !== JSON.stringify(saved)) setShared("workspace.tree", this.tree);
  }

  // Rows in display order: the saved tree, a worktree under its checkout unless a parent
  // was chosen by hand. A space is listed once its git is known (see `shown`).
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null })).filter((r) => this.shown.has(r.w.id));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const entryOf = (id) => this.tree.entries.find((e) => e.space === id);
    const auto = {};
    for (const r of list) {
      if (!nested(r)) continue;
      const host = list.find((h) => !nested(h) && h.g && !h.g.linked && h.g.repo === r.g.repo);
      const a = entryOf(r.w.id), b = host && entryOf(host.w.id);
      if (a && b) auto[a.id] = b.id;
    }
    const byId = new Map(list.map((r) => [r.w.id, r]));
    const live = new Set(sp.map((w) => w.id));
    const rows = flatten(this.tree, live, auto)
      .filter(({ entry }) => !live.has(entry.space) || byId.has(entry.space))
      .map(({ entry, depth, kids, closed }) => {
        const r = byId.get(entry.space);
        return { ...r, entry, depth, kids, closed, machine: r?.w.machine ?? entry.machine ?? null };
      });
    // Agents own their fold state: publish complete hierarchy, not only visible rows.
    const expanded = { ...this.tree, entries: this.tree.entries.map(e => ({ ...e, folded: false })) };
    const published = flatten(expanded, live, auto).map(({ entry, depth, closed }) => ({
      id: entry.id, space: entry.space, parent: entry.manual ? entry.parent : (auto[entry.id] ?? entry.parent),
      depth, name: entry.name, machine: entry.machine, closed,
    }));
    if (JSON.stringify(shared("workspace.rows")) !== JSON.stringify(published)) setShared("workspace.rows", published);
    return rows;
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    // A child shows its top-level ancestor's tag; the header filter keeps one tag's rows.
    let root = DEFAULT_COLOR;
    const rows = this.ordered()
      .map((r) => ({ ...r, tag: r.depth > 0 ? root : (root = colorOf(r.entry)) }))
      .filter((r) => (!collapsed || !r.closed) && (!this.tagFilter || r.tag === this.tagFilter));
    const ps = panes(), all = agents();
    const draw = (r) => (collapsed ? [this.compact(r, t)] : r.closed ? [this.closedRow(r, t)] : [this.row(r, t), ...this.tabRows(r, t, ps, all)]);
    const remote = [...new Set([...rows.map(r => r.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : rows.flatMap(draw);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => r.machine === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const folded = this.folded.has(m);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 2 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none())
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); addSpace(m); }).child("+")))
          .child(div().size(6).rounded(4).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(8).gap(7).items_center().rounded(8)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => addSpace(m))
        .child(svg("mods/workspace-chrome/plus.svg").size(12)).when(!collapsed, el => el.child("New space there"));
      if (!collapsed && rebuilt) return [head];
      // Rows sit one step in from their machine header.
      const inset = el => collapsed ? el : v_flex().flex_none().pl(12).child(el);
      return [head, ...(folded ? [] : mine.length ? mine.flatMap(r => draw(r).map(inset)) : [inset(loading(m) ? loadingRow(m) : empty)])];
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_start()
      .items_center()
      .text_size(11)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  // A space's tabs under its row: the program in front now (its icon follows what runs:
  // a shell, lazygit, nvim, an agent), the tab's name, then its agents' state.
  tabRows({ w, depth, entry }, t, ps, all) {
    if (entry.folded || shared("hibernate.sleeping")?.[w.id]) return [];
    const shownTab = w.active ? focused()?.tab : null;
    const tabs = (w.tabs ?? []).filter((tab) => !tab.settled);
    return tabs.map((tab, i) => {
      const mine = ps.filter((p) => p.tab === tab.id);
      const lead = mine.find((p) => p.program?.agent) ?? mine.find((p) => p.focused) ?? mine[0];
      const status = all.filter((a) => a.tab === tab.id).reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      const lit = tab.id === shownTab;
      const prog = lead?.mod ? null : lead?.program?.name;
      // Like the agents list: the program's own title when it tells something (not a path, host or its name).
      const live = (lead?.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
      const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== lead?.program?.key;
      const detail = lead?.mod ? null : telling ? live : prog;
      return h_flex()
        .id(`tab-${tab.id}`)
        .h(26)
        .flex_none()
        // The rail sits under the space's icon.
        .pl(depth > 0 ? 38 + 14 * depth : 31)
        .pr(8)
        .gap(7)
        .items_center()
        .rounded(8)
        .when(lit, (el) => el.bg(t.raised))
        .when(!lit, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click(() => { run("space.select", { id: w.id }); run("tab.select", { id: tab.id }); })
        .child(rail(t, i === tabs.length - 1))
        .child(progIcon(lead?.program, 14, t.dim))
        .child(div().flex_shrink(0).max_w(130).truncate().text_size(12).text_color(lit ? t.foreground : t.muted).child(tab.name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(detail && detail !== tab.name ? detail : ""))
        .when(Boolean(status), (el) => el.child(statusMark(t, status)));
    });
  }

  // The checkout's newest PR at the row's right: icon and number in its state's color.
  // Cmd-click (Ctrl elsewhere) opens it; a plain click still selects the space.
  prBadge(w, t, ps) {
    const folder = place(w, ps);
    const entry = this.pr.entries.get(JSON.stringify([w.machine ?? null, folder]));
    const pr = entry?.branch === (this.git[where(w, ps)]?.branch ?? null) ? entry.prs[0] : null;
    if (!pr) return null;
    const look = prAppearance(pr, t);
    const url = pr.url || `https://github.com/${pr.repository}/pull/${pr.number}`;
    const link = (e) => (window().platform === "macos" ? e.modifiers?.platform : e.modifiers?.control || e.modifiers?.platform);
    return h_flex()
      .id(`pr-${w.id}`)
      .flex_none()
      .gap(3)
      .items_center()
      .text_size(11)
      .text_color(look.color)
      .tooltip(`${pr.repository}#${pr.number} · ${look.label}${entry.error ? " (may be stale)" : ""}\n${pr.title}\n${window().platform === "macos" ? "Cmd" : "Ctrl"}-click to open`)
      .on_mouse_down("left", (e, cx) => { if (link(e)) cx.stop_propagation(); })
      .on_mouse_up("left", (e, cx) => { if (link(e)) cx.stop_propagation(); })
      .on_click((e, cx) => { if (!link(e)) return; cx.stop_propagation(); cx.open_url(url); })
      .child(svg(`mods/workspaces/pr-${look.icon}.svg`).size(13).flex_none())
      .child(`#${pr.number}`);
  }

  // Folded, it says how many tabs the space has (closed entries: none to count).
  chevron(entry, t, tabs = 0) {
    return h_flex().id(`fold-${entry.id}`).flex_none().h(18).px(3).gap(3).items_center().rounded(4).text_size(11).text_color(t.dim)
      .hover(s => s.bg(t.hover).text_color(t.foreground))
      .when(entry.folded && tabs > 0, el => el.tooltip(`${tabs} tab${tabs > 1 ? "s" : ""}`))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); setShared("workspace.tree", toggleFold(this.tree, entry.id)); })
      .when(entry.folded && tabs > 0, el => el.child(String(tabs)))
      .child(svg(`mods/workspace-chrome/chevron-${entry.folded ? "right" : "down"}.svg`).size(11));
  }

  // One button, two states: moon puts the space's programs to sleep (hibernate mod), sun wakes them.
  // Remote spaces can't sleep. Shown while asleep, otherwise on hover or when the space is selected.
  sleepToggle(w, asleep, t) {
    if (w.machine) return div();
    return div().id(`sleep-${w.id}`).flex_none().p(2).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
      .text_color(asleep ? t.accent : t.dim)
      .tooltip(asleep ? "Wake: resume its programs" : "Sleep: stop its programs, keep the shells")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); setShared("hibernate.request", { nonce: Date.now(), action: asleep ? "wake" : "sleep", space: w.id }); })
      .child(svg(`mods/hibernate/${asleep ? "sun" : "moon"}.svg`).size(12));
  }

  row(r, t) {
    const { w, i, g, entry, depth, kids } = r;
    const on = w.active;
    const nest = depth > 0;
    const asleep = Boolean(shared("hibernate.sleeping")?.[w.id]);
    const icon = "mods/workspaces/space.svg";
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ depth }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === entry.id && this.over !== entry.id, el => el.opacity(0.5))
      .when(this.pressed !== null && this.pressed !== entry.id && this.over === entry.id, el => this.parentDrop ? el.bg(t.selected).border(1).border_color(t.accent) : el.child(div().absolute().left(0).right(0).h(2).bg(t.accent).when(this.afterDrop, line => line.bottom(0)).when(!this.afterDrop, line => line.top(0))))
      .on_mouse_down("left", (_e, cx) => this.startDrag(entry, cx))
      .on_mouse_move((e, cx) => this.hoverParent(entry.id, cx, e))
      .on_hover((over, cx) => { if (over) this.hovered = w.id; else if (this.hovered === w.id) this.hovered = null; cx.notify(); })
      .on_mouse_up("left", (_e, cx) => this.releaseDrag(r, cx))
      .on_mouse_down("right", () => this.menu(r))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(nest, el => el.pl(8 + 15 + 14 * depth))
          .when(!nest, el => el.child(colorDot(t, colorOf(entry))))
          .child(svg(icon).size(16).flex_none().text_color(t.muted))
          .child(div().flex_shrink(0).max_w(150).truncate().text_color(asleep ? t.dim : t.foreground).child(w.name))
          .child(g ? this.gitTail(g, nest, w.name, t) : div().flex_1())
          .when(Boolean(g), el => el.child(this.prBadge(w, t, panes()) ?? div()))
          .when(asleep || on || this.hovered === w.id, el => el.child(this.sleepToggle(w, asleep, t)))
          .when(entry.pinned, el => el.child(svg("mods/workspace-chrome/pin.svg").size(12).flex_none().text_color(t.dim)))
          .when(kids > 0 || (w.tabs ?? []).some((tab) => !tab.settled), el => el.child(this.chevron(entry, t, (w.tabs ?? []).filter((tab) => !tab.settled).length))),
      );
  }

  startDrag(entry, cx) {
    cx.stop_propagation();
    this.pressed = entry.id;
    this.over = entry.id;
    this.parentDrop = false;
    this.hoverToken = (this.hoverToken ?? 0) + 1;
    cx.notify();
  }

  hoverParent(parent, cx, event) {
    cx.stop_propagation();
    if (this.pressed === null) return;
    const target = this.tree.entries.find(e => e.id === parent);
    const source = this.tree.entries.find(e => e.id === this.pressed);
    const valid = parent === null || (target && source && target.machine === source.machine && parent !== source.id);
    const over = valid ? parent : undefined;
    const after = event ? event.local_position.y > event.bounds.height / 2 : false;
    if (this.over !== over || this.afterDrop !== after) {
      this.over = over;
      this.afterDrop = after;
      this.parentDrop = false;
      const token = this.hoverToken = (this.hoverToken ?? 0) + 1;
      if (parent && valid && canParent(this.tree.entries, this.pressed, parent)) {
        cx.timer.after(700, later => {
          if (this.pressed && this.over === parent && this.hoverToken === token) {
            this.parentDrop = true;
            later.notify();
          }
        });
      }
      cx.notify();
    }
  }

  releaseDrag(r, cx) {
    cx.stop_propagation();
    const id = this.pressed;
    const nesting = this.parentDrop;
    const after = this.afterDrop;
    this.pressed = null;
    this.over = null;
    this.hoverToken = (this.hoverToken ?? 0) + 1;
    if (id === r.entry.id) {
      if (r.closed) {
        // A closed parent kept for its children goes to its first live one; "Open" in the menu starts a shell.
        const rows = shared("workspace.rows") ?? [];
        const at = rows.findIndex((x) => x.id === r.entry.id);
        const live = new Set(spaces().map((s) => s.id));
        let kid = null;
        for (let i = at + 1; at >= 0 && i < rows.length && rows[i].depth > rows[at].depth; i++) if (live.has(rows[i].space)) { kid = rows[i].space; break; }
        if (kid) run("space.select", { id: kid });
        else reopen(this.tree, r.entry);
      }
      else run("space.select", { id: r.w.id });
    } else if (id) {
      const saved = shared("workspace.tree") ?? this.tree;
      const source = saved.entries.find(e => e.id === id);
      if (!source || source.machine !== r.entry.machine) return;
      const parent = nesting ? r.entry.id : (r.entry.manual ? r.entry.parent : (shared("workspace.rows") ?? []).find(e => e.id === r.entry.id)?.parent ?? r.entry.parent);
      if (!canParent(saved.entries, id, parent)) return;
      const next = setParent(saved, id, parent);
      const moved = next.entries.find(e => e.id === id);
      next.entries = next.entries.filter(e => e.id !== id);
      const at = next.entries.findIndex(e => e.id === r.entry.id);
      if (at < 0) return cx.notify();
      next.entries.splice(at + (after || nesting ? 1 : 0), 0, moved);
      if (nesting) next.entries = next.entries.map(e => e.id === parent ? { ...e, folded: false } : e);
      setShared("workspace.tree", next);
    }
    cx.notify();
  }

  releaseRoot(cx) {
    cx.stop_propagation();
    if (this.pressed) setShared("workspace.tree", setParent(shared("workspace.tree") ?? this.tree, this.pressed, null));
    this.pressed = null;
    this.over = null;
    cx.notify();
  }

  // A pinned entry (or a parent of a shown one) with no space: click opens a new shell where it was.
  closedRow(r, t) {
    const { entry, depth, kids } = r;
    const nest = depth > 0;
    return h_flex()
      .id(`closed-${entry.id}`)
      .h(rowHeight({ depth }))
      .flex_none()
      .px(8)
      .gap(9)
      .items_center()
      .rounded(8)
      .opacity(0.55)
      .hover((s) => s.bg(t.hover))
      .when(this.pressed !== null && this.pressed !== entry.id && this.over === entry.id, el => this.parentDrop ? el.bg(t.selected).border(1).border_color(t.accent) : el.border_t(2).border_color(t.accent))
      .on_mouse_down("left", (_e, cx) => this.startDrag(entry, cx))
      .on_mouse_move((e, cx) => this.hoverParent(entry.id, cx, e))
      .on_mouse_up("left", (_e, cx) => this.releaseDrag(r, cx))
      .on_mouse_down("right", () => this.menu(r))
      .when(nest, el => el.pl(8 + 15 + 14 * depth))
      .when(!nest, el => el.child(colorDot(t, colorOf(entry))))
      .child(svg("mods/workspaces/space.svg").size(16).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(entry.name))
      .when(entry.pinned, el => el.child(svg("mods/workspace-chrome/pin.svg").size(12).flex_none().text_color(t.dim)))
      .when(kids > 0, el => el.child(this.chevron(entry, t)));
  }

  compact({ w, i }, t) {
    return h_flex()
      .id(`space-${w.id}`)
      .h(26)
      .flex_none()
      .justify_center()
      .gap(4)
      .when(w.active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().text_color(tone(t, w.status)).child(glyph(w.status)));
  }

  // A foldable "Tags" list under the header: pick one tag to keep only its spaces, "All Tags" shows every space.
  tagFilters(t) {
    const used = new Set((shared("workspace.tree") ?? EMPTY).entries.filter((e) => !e.parent).map(colorOf));
    if (this.tagFilter && !used.has(this.tagFilter)) this.tagFilter = null;
    const folded = localStorage.getItem("tags.folded") === "1";
    const item = (id, on, icon, label, pick) => h_flex().id(id).h(28).flex_none().px(8).gap(10).items_center().rounded(8)
      .text_size(13).text_color(t.foreground).when(on, el => el.bg(t.selected)).when(!on, el => el.hover(s => s.bg(t.hover)))
      .on_click((_e, cx) => { this.tagFilter = pick; cx.notify(); })
      .child(icon).child(div().flex_1().min_w(0).truncate().child(label));
    const all = h_flex().size(14).flex_none().items_center()
      .child(div().size(10).rounded(6).border_1().border_color(t.muted))
      .child(div().size(10).rounded(6).border_1().border_color(t.muted).ml(-6));
    return v_flex().flex_none().px(8).pb(6)
      .child(h_flex().id("tags-head").h(26).px(8).items_center().justify_between().text_size(11).text_color(t.dim).cursor_pointer()
        .on_click((_e, cx) => { localStorage.setItem("tags.folded", folded ? "0" : "1"); cx.notify(); })
        .child("Tags").child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11)))
      .when(!folded, el => el
        .children(COLORS.filter(([, key]) => used.has(key)).map(([, key]) =>
          item(`tag-filter-${key}`, this.tagFilter === key, colorDot(t, key).size(12).rounded(6).mx(1), tagName(key), this.tagFilter === key ? null : key)))
        .child(item("tag-filter-all", !this.tagFilter, all, "All Tags…", null)));
  }

  render(cx) {
    if (props()?.menu) return this.renderMenu();
    this.checkNew(cx, false);
    this.syncTree();
    const t = theme();
    const collapsed = narrow();
    // Herdr's shared space colors: every mod drawing space avatars reads and fills "space.colors".
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(36).pl(8).pr(10).items_center().justify_between().text_size(11).text_color(t.dim).border_b_1().border_color(t.border)
        .when(!collapsed, el => el.child(listTabs(t, "spaces", this.agentKeys)))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => addSpace()).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .child(v_flex().flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_move((_e, cx) => this.hoverParent(null, cx))
        .on_mouse_up("left", (_e, cx) => { if (this.pressed) this.releaseRoot(cx); })
        .children(this.grouped(t, collapsed)))
      // Last: sits just above the Agents panel below this block.
      .when(!collapsed, el => el.child(this.tagFilters(t).pt(6).border_t_1().border_color(t.border)));
  }
}
