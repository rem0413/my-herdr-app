// Agents in grouped (by workspace tree) or priority views; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, knownAgents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout } from "herdr";
import { OmpChildren } from "./omp.js";
import { NativeChildren } from "./native.js";

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

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function lead(tab, all = panes()) {
  const mine = all.filter(p => p.tab === tab.id && p.terminal);
  return mine.find(p => p.program?.agent) ?? mine.find(p => p.focused) ?? mine[0];
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}
// Panes running a known agent program (Claude Code, Codex, ...) that never reported a
// status aren't in agents(): an older version, or one started inside tmux. Listed with
// status "unknown" so they don't silently vanish.
// Program.agent is only true once a status was reported, so match the known-agents table.
function unreported(listed, agentKeys) {
  const tabs = new Map(spaces().flatMap((s) => s.tabs.map((tab, i) => [tab.id, { space: s, tab, index: i + 1 }])));
  const pinned = new Set(terminals().filter((t) => t.labels?.["herdr.pinned"]).map((t) => t.address));
  return panes()
    .filter((p) => p.terminal && agentKeys.has(p.program?.key) && !p.status && !listed.has(p.terminal) && tabs.has(p.tab))
    .map((p) => {
      const { space, tab, index } = tabs.get(p.tab);
      return {
        address: p.terminal, pane: p.pane, space: space.id, space_name: space.name,
        tab: tab.id, tab_index: index, tab_name: tab.name,
        status: "unknown", app: null, program: p.program, title: p.title,
        seq: 0, pinned: pinned.has(p.terminal), focused: p.focused,
      };
    });
}

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
// Pixels each workspace nesting level indents its group and rows.
const INDENT = 12;

// Workspace rows in tree order: {id, space, parent, depth, name}. The workspaces mod
// publishes workspace.rows; without it, derive from workspace.tree (saved order and parents).
function workspaceRows() {
  const rows = shared("workspace.rows");
  // Closed rows stay: they own no agents but keep the chain to live descendants.
  if (Array.isArray(rows) && rows.length) return rows;
  const entries = (shared("workspace.tree")?.entries ?? []).filter((e) => e.space != null);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const depth = (e) => {
    const seen = new Set([e.id]);
    let d = 0;
    for (let p = byId.get(e.parent); p && !seen.has(p.id); p = byId.get(p.parent)) { seen.add(p.id); d++; }
    return d;
  };
  const kids = (id) => entries.filter((e) => e.parent === id);
  const out = [];
  const visit = (e) => {
    if (out.some((r) => r.id === e.id)) return;
    out.push({ id: e.id, space: e.space, parent: e.parent, depth: depth(e), name: e.name });
    kids(e.id).forEach(visit);
  };
  entries.filter((e) => !byId.has(e.parent)).forEach(visit);
  return out;
}

const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle", 0: "No status" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// Spaces | Agents tabs over the sidebar-lists stack; same bar as the workspaces mod.
function listTabs(t, count) {
  const tab = (id, label, n) => h_flex().id(`lists-tab-${id}`).h(24).px(10).gap(5).items_center().rounded(6).cursor_pointer()
    .text_size(12).font_medium().text_color(id === "agents" ? t.foreground : t.dim)
    .when(id === "agents", (el) => el.bg(t.selected))
    .when(id !== "agents", (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
    .on_click(() => run("layout.select", { stack: "sidebar-lists", child: id }))
    .child(label)
    .when(n > 0, (el) => el.child(div().px(5).h(16).rounded(4).bg(t.raised).text_size(10).text_color(t.muted).flex().items_center().child(String(n))));
  return h_flex().gap(2).child(tab("spaces", "Spaces", 0)).child(tab("agents", "Agents", count));
}

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.sortMenu) return;
    this.folded = new Set();
    this.expandedAgents = new Set();
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Map(); // address -> when terminal.pin was last asked
    cx.timer.every(30000, (cx) => cx.notify());
    this.omp = new OmpChildren(cx);
    this.native = new NativeChildren(() => this.share());
    // Program keys of known agents, to list panes running one that never reported.
    this.agentKeys = new Set();
    cx.spawn(async (cx) => {
      try { this.agentKeys = new Set((await knownAgents()).map((a) => a.key)); cx.notify(); } catch {}
    });
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      // Asked again after a while: a pin the core never echoed (a failed write) isn't lost.
      if (Date.now() - (this.migratingPins.get(address) ?? 0) > 10000) {
        this.migratingPins.set(address, Date.now());
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  // In-process children (OMP, Claude Code, Codex) for other mods, such as the Spaces list:
  // shared "agents.children", written only when it changes.
  share() {
    const omp = agents().find((a) => a.app === "omp" || a.program?.key === "omp")?.program ?? null;
    const children = [
      ...this.omp.nodes.map(({ transcript, ...n }) => ({ ...n, program: n.program ?? omp })),
      ...this.native.nodes,
    ];
    const signature = JSON.stringify(children.map((n) => [n.address, n.parent, n.name, n.status]));
    if (signature === this.sharedChildren) return;
    this.sharedChildren = signature;
    setShared("agents.children", children);
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  // Looking at a done agent makes it idle; it stays with Done until you leave
  // it rather than drop away under you. Any other change moves it at once.
  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    // Arriving, or any change but done turning idle, sets what it was.
    if (!same || cur.status !== "idle") this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  rank(a) {
    const sawDone = a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? RANK.done : RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(13)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(8)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }


  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown, compact, indent = 0) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const program = k.program ?? (k.transcript ? agents().find(a => a.app === "omp" || a.program?.key === "omp")?.program : null);
    const pic = icon(program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39 + indent)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12)
      .when(on, (el) => el.bg(t.raised))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: st }, compact));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(6).bg(t.blocked + "26").text_size(10).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    if (a.status === "unknown") return div().w(13).flex_none().text_size(10).font_bold().text_color(t.unknown ?? t.dim).flex().justify_center().child("?");
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  render(cx) {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    const collapsed = narrow();
    const sort = sortOf();
    // A hibernated space (hibernate mod) has no agents to show until it wakes.
    const asleep = shared("hibernate.sleeping") ?? {};
    let list = agents().filter((a) => !asleep[a.space]);
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    list = [...list, ...unreported(this.listed, this.agentKeys).filter((a) => !asleep[a.space])];
    this.omp.update(list, cx);
    this.native.update(list, cx);
    this.share();
    const all = [...terminals(), ...this.omp.nodes, ...this.native.nodes];
    this.migratePins(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    this.hold(list);
    const byPriority = sort.id === "priority";
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned);
    list = [...pinned, ...rest];

    // Groups in display order: Pinned, then priority sections or the workspace tree.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned, under: pinned, depth: 0 }] : [];
    if (byPriority) {
      // Sorted by rank, so neighbours make a section.
      for (const a of rest) {
        const r = a.status === "unknown" ? rankOf(a) : rankOf(a) || RANK.idle;
        const id = `sec-${r}`;
        if (groups.at(-1)?.id === id) groups.at(-1).members.push(a), groups.at(-1).under.push(a);
        else groups.push({ id, label: SECTION[r], status: SECTION_STATUS[r], members: [a], under: [a], depth: 0 });
      }
    } else {
      const bySpace = new Map();
      for (const a of rest) bySpace.set(a.space, [...(bySpace.get(a.space) ?? []), a]);
      const tree = workspaceRows();
      const parentOf = new Map(tree.map((r) => [r.id, r.parent]));
      // Each row's agents plus those of every workspace under it; an ancestor with none of its own still shows.
      const under = new Map();
      for (const r of tree) {
        const mine = bySpace.get(r.space) ?? [];
        const seen = new Set();
        for (let id = r.id; id && !seen.has(id); id = parentOf.get(id)) {
          seen.add(id);
          under.set(id, [...(under.get(id) ?? []), ...mine]);
        }
      }
      for (const r of tree) {
        if (!under.get(r.id)?.length) continue;
        const members = bySpace.get(r.space) ?? [];
        bySpace.delete(r.space);
        groups.push({ id: `sp-${r.space}`, label: r.name || members[0]?.space_name || "", status: null, members, under: under.get(r.id), depth: r.depth ?? 0 });
      }
      // Spaces not yet published (e.g. newly connected machines) remain reachable as flat groups.
      for (const members of bySpace.values()) groups.push({ id: `sp-${members[0].space}`, label: members[0].space_name || "", status: null, members, under: members, depth: 0 });
      list = groups.flatMap((g) => g.members);
    }
    setAgentOrder(list.map((a) => a.address));

    const withKids = (a, i, indent = 0) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const r = row(a, i, subs, indent);
      if (!this.expandedAgents.has(a.address)) return [r];
      return [r, ...subs.map((s) => this.subRow(t, s, shown, byPriority, indent))];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = this.expandedAgents.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.expandedAgents.delete(a.address) : this.expandedAgents.add(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    const tabs = spaces().flatMap(s => s.tabs);
    const label = (a) => {
      const tab = tabs.find(tab => tab.id === a.tab);
      return tab ? title(tab, lead(tab)) : a.title || a.program?.name || "";
    };
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    const row = (a, i, subs = [], indent = 0) => {
      const pic = icon(a.program, 16, t.foreground);
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = a.pinned;
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("terminal.pin", { terminal: a.address, pinned: !isPinned });
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      // Under a space header the space goes without saying; an automatic tab number says nothing.
      // Without a space header above (priority, pinned) the row names its space.
      const full = byPriority || isPinned;
      const name = full ? a.space_name || label(a) : more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
      return h_flex()
        .id(`ag-${a.address}`)
        .pl(8 + indent)
        .pr(8)
        .h(30)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(9)
        .when(a.focused, (el) => el.bg(t.selected))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .when(Boolean(pic), el => el.child(div().id(`agent-fold-${a.address}`)
          .when(subs.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.expandedAgents.has(a.address) ? this.expandedAgents.delete(a.address) : this.expandedAgents.add(a.address);
            cx.notify();
          })).child(pic)))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().min_w(0).max_w(full && more ? 120 : 200).truncate().text_color(idle ? t.muted : t.foreground).child(name))
          .when(full && Boolean(more), el => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`\u00b7 ${more}`))))
        .when(Boolean(machine), el => el.child(div().text_size(10).text_color(t.dim).child(machine)))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
        .when(this.hovered === a.address, el => el.child(pin))
        .when(this.hovered !== a.address && Boolean(when), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
        .child(this.status(t, a, byPriority && !isPinned));
    };

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = g.under.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      return h_flex()
        .id(g.id)
        .pl(8 + g.depth * INDENT)
        .pr(8)
        .pt(8)
        .h(30)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .font_medium()
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .child(div().truncate().text_color(t[g.status] ?? t.dim).child(g.label))
        .when(byPriority || !open, (el) => el.child(div().text_color(t.dim).child(String(open ? g.members.length : g.under.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    const rows = [];
    if (collapsed) list.forEach((a, i) => rows.push(...withKids(a, i)));
    else {
      // A folded group hides its members and every group nested under it.
      let cut = null;
      for (const g of groups) {
        if (cut !== null && g.depth > cut) continue;
        cut = null;
        rows.push(header(g));
        if (this.folded.has(g.id)) cut = g.depth;
        else rows.push(...g.members.flatMap((a, i) => withKids(a, i, g.depth * INDENT)));
      }
    }

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .pl(8)
            .pr(10)
            .h(36)
            .flex_none()
            .items_center()
            .justify_between()
            .border_b_1()
            .border_color(t.border)
            .child(listTabs(t, list.length))
            .child(
              div()
                .id("ag-sort")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => openOverlay({ mod: "workspace-agents", kind: "popup", width: 200, height: 140, props: { sortMenu: true } }))
                .tooltip(`Sort agents: ${sort.label}`)
                .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14)),
            ),
        ),
      )
      .when(Boolean(this.omp.error ?? this.native.error) && !collapsed, el => el.child(h_flex().px(12).gap(8).items_center()
        .child(div().flex_1().text_size(11).text_color(t.blocked).child(this.omp.error ?? this.native.error))
        .child(div().id("dismiss-omp-error").px(6).py(4).cursor_pointer().text_color(t.muted)
          .tooltip("Dismiss subagent discovery error")
          .on_click((_event, cx) => { this.omp.error = null; this.native.error = null; cx.notify(); })
          .child("×"))))
      .when(list.length === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("always").children(rows))
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .h(28)
            .items_center()
            .justify_center()
            .child(
              div()
                .id("collapse")
                .text_size(13)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(toggleSidebar)
                .child("»"),
            ),
        ),
      );
  }
}
