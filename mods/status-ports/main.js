import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, exec } from "herdr";

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.ports = null;
    this.countPorts(cx);
    cx.timer.every(5000, (cx) => this.countPorts(cx));
  }

  // Distinct listening TCP ports (lsof -F n lines are "n<addr>:<port>").
  countPorts(cx) {
    cx.spawn(async (cx) => {
      const r = await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "n"]).catch(() => null);
      if (!r) return;
      const ports = new Set(r.stdout.split("\n").filter((l) => l[0] === "n").map((l) => l.slice(l.lastIndexOf(":") + 1)));
      if (ports.size !== this.ports) { this.ports = ports.size; cx.notify(); }
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

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(h_flex().id("ports").gap(6).items_center().rounded(4).px(4).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("mod.open", { name: "ports" }))
        .child(svg("mods/workspace-chrome/server.svg").size(13)).child(this.ports === null ? "ports" : `${this.ports} ports`))
      .child(div().flex_1())
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
