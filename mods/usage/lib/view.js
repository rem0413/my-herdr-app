// What the bar and the hover card show, from limits, prefs and the focused
// session. Pure: main.js only turns these models into elements.
import { PROVIDERS } from "./rollup.js";
import { current, level } from "./limits.js";
import { providerOn } from "./prefs.js";
import * as fmt from "./format.js";

export function planLabel(plan) {
  if (!plan) return null;
  return String(plan).split(/[_\s-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

// One window as the bar and card show it. Level always follows what is used.
export function segment(w, prefs, now) {
  const used = current(w, now);
  const shown = used == null ? null : prefs.showRemaining ? Math.max(0, 100 - used) : used;
  const lv = level(used);
  const showReset = used != null && w.resetsAt != null && (lv === "warn" || lv === "hot" || prefs.showResetTime);
  return {
    id: w.id,
    short: w.short,
    long: w.long,
    level: lv,
    fill: shown == null ? 0 : shown / 100,
    text: fmt.percent(shown),
    detail: shown == null ? "—" : prefs.showRemaining ? `${fmt.percent(shown)} left` : fmt.percent(shown),
    left: w.resetsAt == null ? "" : used == null ? "reset" : fmt.span(w.resetsAt - now),
    reset: showReset ? fmt.span(w.resetsAt - now) : "",
  };
}

const updated = (l, now) => (l?.at == null ? "" : `updated ${fmt.ago(l.at, now)}`);

// Bar: providers switched on that have something to say.
export function barModel(limits, prefs, now) {
  const groups = [];
  for (const p of PROVIDERS) {
    const l = limits?.[p.id];
    if (!providerOn(prefs, p.id) || !l || l.status === "missing") continue;
    const segments = (l.windows ?? []).map((w) => segment(w, prefs, now));
    if (!segments.length && l.status !== "error") continue;
    groups.push({ id: p.id, icon: p.icon, name: p.name, failed: l.status === "error", segments });
  }
  return { groups, empty: groups.length === 0 };
}

// Card: every provider and every window, whatever the bar shows.
export function cardModel(limits, prefs, now, statusLine) {
  return PROVIDERS.map((p) => {
    const l = limits?.[p.id] ?? { status: "missing", windows: [] };
    let status;
    if (l.status === "missing") {
      status = p.id === "claude"
        ? (statusLine === "installed" ? "waiting for a Claude response" : "statusLine not connected")
        : "not installed";
    } else if (l.status === "error") {
      status = l.message ?? "error";
    } else {
      status = updated(l, now);
    }
    return {
      id: p.id, icon: p.icon, name: p.name, plan: planLabel(l.plan), status,
      failed: l.status === "error", rows: (l.windows ?? []).map((w) => segment(w, prefs, now)),
    };
  });
}

// The focused agent's session: { app, title, model, tokens, window, calls, compactions }.
export function sessionView(s) {
  if (!s) return null;
  const pct = s.window ? Math.min(100, (s.tokens / s.window) * 100) : null;
  const usedPct = s.percent ?? pct;
  const stats = [];
  if (s.tokens != null) stats.push(s.window ? `${fmt.tokens(s.tokens)} of ${fmt.tokens(s.window)} tokens` : `${fmt.tokens(s.tokens)} tokens`);
  if (s.calls != null) stats.push(`${s.calls} call${s.calls === 1 ? "" : "s"}`);
  if (s.compactions) stats.push(`${s.compactions} compaction${s.compactions === 1 ? "" : "s"}`);
  return {
    title: [s.title, s.model].filter(Boolean).join(" · "),
    context: { fill: usedPct == null ? null : usedPct / 100, level: level(usedPct), text: fmt.percent(usedPct) },
    stats: stats.join(" · "),
  };
}

// Session numbers chosen for the bar, in a fixed order.
export function sessionOnBar(s, prefs) {
  if (!s) return [];
  const v = sessionView(s);
  const out = [];
  if (prefs.session.includes("context") && v.context.fill != null) out.push({ text: `ctx ${v.context.text}`, level: v.context.level });
  if (prefs.session.includes("calls") && s.calls != null) out.push({ text: `${s.calls} calls`, level: "ok" });
  if (prefs.session.includes("compactions") && s.compactions != null) out.push({ text: `${s.compactions} cmp`, level: "ok" });
  return out;
}
