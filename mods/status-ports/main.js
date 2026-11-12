import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, knownAgents, panes, theme, run, window, keys, shared, setShared } from "herdr";
import { scan, SHARED_KEY, RESCAN_KEY } from "./scan.js";

const SCAN_MS = 4000;

// Scans ports for every space on every machine and publishes them in shared "ports.scan"
// (the `ports` popup draws them). The count is ports that belong to a space.
export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.scanning = false;
    this.rescan = shared(RESCAN_KEY);
    this.scan(cx);
    // Only while the window is in front: nobody reads the count otherwise.
    cx.timer.every(SCAN_MS, (cx) => window()?.active && this.scan(cx));
    // Program keys of known agents, to count panes running one that never reported.
    this.agentKeys = new Set();
    cx.spawn(async (cx) => {
      try { this.agentKeys = new Set((await knownAgents()).map((a) => a.key)); cx.notify(); } catch {}
    });
  }

  // Publishes only real changes: setShared redraws every mod.
  scan(cx) {
    if (this.scanning) return;
    this.scanning = true;
    cx.spawn(async () => {
      try {
        const next = await scan(shared(SHARED_KEY));
        if (JSON.stringify(next) !== JSON.stringify(shared(SHARED_KEY))) setShared(SHARED_KEY, next);
      } catch (e) { console.warn(`status-ports: ${e}`); }
      finally { this.scanning = false; }
    });
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render(cx) {
    // The popup asks for a scan now (its refresh button, or right after it opens).
    const ask = shared(RESCAN_KEY);
    if (ask !== this.rescan) { this.rescan = ask; this.scan(cx); }
    const t = theme();
    const space = spaces().find(s => s.active);
    // Matches the agents list: reporting agents plus panes running an agent that never reported.
    const asleep = shared("hibernate.sleeping") ?? {};
    const spaceOf = new Map(spaces().flatMap((s) => s.tabs.map((tab) => [tab.id, s.id])));
    const reported = agents().filter((a) => !asleep[a.space]);
    const listed = new Set(reported.map((a) => a.address));
    const silent = panes().filter((p) => p.terminal && this.agentKeys.has(p.program?.key) && !p.status && !listed.has(p.terminal) && spaceOf.has(p.tab) && !asleep[spaceOf.get(p.tab)]);
    const list = [...reported, ...silent];
    const rows = shared(SHARED_KEY)?.rows;
    const mine = rows?.filter(r => r.space).length;
    const other = rows ? rows.length - mine : 0;
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(h_flex().id("ports").gap(6).items_center().rounded(4).px(4).hover(s => s.bg(t.hover).text_color(t.foreground))
        .tooltip(`${mine ?? 0} in your spaces · ${other} other processes`)
        .on_click(() => run("mod.open", { name: "ports" }))
        .child(svg("mods/workspace-chrome/server.svg").size(13))
        .child(div().when(mine > 0, el => el.text_color(t.foreground)).child(rows ? `${mine} port${mine === 1 ? "" : "s"}` : "ports")))
      .child(div().flex_1())
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
