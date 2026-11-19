// Headless: reads agents' in-process children (OMP, Claude Code, Codex) on every machine
// and publishes them as shared "agents.children", with any discovery error as
// "agents.children.error". Docked in a 0px block so it runs from start, whatever is shown.

import { View, div } from "gpui-kit";
import { agents, panes, shared, setShared, checking } from "herdr";
import { OmpChildren } from "./omp.js";
import { NativeChildren } from "./native.js";

export default class AgentChildren extends View {
  init(_props, cx) {
    if (checking()) return;
    this.omp = new OmpChildren(cx);
    this.native = new NativeChildren(() => this.share());
  }

  // Agents, plus panes running an agent program that never reported a status
  // (an older version, or one inside tmux): the readers pick theirs by program.
  list() {
    const list = agents();
    const listed = new Set(list.map((a) => a.address));
    const quiet = panes()
      .filter((p) => p.terminal && !listed.has(p.terminal))
      .map((p) => ({ address: p.terminal, app: null, program: p.program }));
    return [...list, ...quiet];
  }

  share() {
    const omp = agents().find((a) => a.app === "omp" || a.program?.key === "omp")?.program ?? null;
    const children = [
      ...this.omp.nodes.map(({ transcript, ...n }) => ({ ...n, program: n.program ?? omp })),
      ...this.native.nodes,
    ];
    const signature = JSON.stringify(children.map((n) => [n.address, n.parent, n.name, n.status]));
    if (signature !== this.signature) {
      this.signature = signature;
      setShared("agents.children", children);
    }
    const error = this.omp.error ?? this.native.error ?? null;
    if (error !== (shared("agents.children.error") ?? null)) setShared("agents.children.error", error);
  }

  render(cx) {
    if (this.omp) {
      const list = this.list();
      this.omp.update(list, cx);
      this.native.update(list, cx);
      this.share();
    }
    return div();
  }
}
