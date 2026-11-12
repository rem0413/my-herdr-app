// Rate-limit windows from Claude Code's statusLine payload and Codex's app-server
// reply, in one shape: { status, plan, at, windows: [{ id, short, long, percent, resetsAt }] }.
// Pure: no herdr imports, so node can test it.

function epoch(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e12 ? Math.floor(v / 1000) : v;
  if (typeof v === "string" && v) {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }
  return null;
}

const CLAUDE_NAMES = {
  five_hour: ["5h", "5-hour"],
  seven_day: ["wk", "Weekly"],
  spend_limit: ["$", "Spend limit"],
};

// Seconds in each Claude window, to place it in time (start = resets_at - duration).
const CLAUDE_DURATIONS = { five_hour: 5 * 3600, seven_day: 7 * 86400 };

const nameOf = (id) => CLAUDE_NAMES[id] ?? [id.replace(/_/g, " "), id.replace(/_/g, " ")];

// helpers/statusline.sh writes {"at": epoch s, "payload": <statusLine JSON>}.
export function claudeLimits(text) {
  if (!text) return { status: "missing", plan: null, at: null, windows: [] };
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { status: "error", message: "Unreadable statusLine data", plan: null, at: null, windows: [] };
  }
  const rl = doc?.payload?.rate_limits ?? {};
  const windows = [];
  for (const [id, w] of Object.entries(rl)) {
    const percent = w?.used_percentage ?? w?.utilization;
    if (typeof percent !== "number") continue;
    const [short, long] = nameOf(id);
    windows.push({ id, short, long, percent, resetsAt: epoch(w.resets_at), duration: CLAUDE_DURATIONS[id] ?? null });
  }
  return { status: windows.length ? "ok" : "empty", plan: null, at: epoch(doc?.at), windows };
}

function codexWindow(limitId, limitName, slot, w) {
  if (!w || typeof w.usedPercent !== "number") return null;
  const mins = Number(w.windowDurationMins) || null;
  const short = mins === 300 ? "5h" : mins === 10080 ? "wk" : mins ? `${Math.round(mins / 60)}h` : slot;
  const long = mins === 300 ? "5-hour" : mins === 10080 ? "Weekly" : mins ? `${Math.round(mins / 60)}-hour` : slot;
  const prefix = limitId === "codex" ? "" : `${limitName || limitId} `;
  return { id: `${limitId}:${slot}`, short: prefix + short, long: prefix + long, percent: w.usedPercent,
    resetsAt: epoch(w.resetsAt), duration: mins ? mins * 60 : null };
}

// helpers/codex-limits.sh prints the JSON-RPC reply to `account/rateLimits/read`.
export function codexLimits(text, now) {
  let msg = null;
  for (const line of String(text ?? "").split("\n")) {
    try {
      const m = JSON.parse(line);
      if (m?.id === 2) msg = m;
    } catch {}
  }
  if (!msg) return { status: "error", message: "No reply from codex app-server", plan: null, at: now, windows: [] };
  if (msg.error) return { status: "error", message: String(msg.error.message ?? "Codex error"), plan: null, at: now, windows: [] };
  const r = msg.result ?? {};
  const byId = r.rateLimitsByLimitId ?? (r.rateLimits ? { [r.rateLimits.limitId ?? "codex"]: r.rateLimits } : {});
  const ids = Object.keys(byId).sort((a, b) => (a === "codex" ? -1 : b === "codex" ? 1 : a.localeCompare(b)));
  const windows = ids.flatMap((id) => [
    codexWindow(id, byId[id]?.limitName, "primary", byId[id]?.primary),
    codexWindow(id, byId[id]?.limitName, "secondary", byId[id]?.secondary),
  ]).filter(Boolean);
  const plan = r.rateLimits?.planType ?? byId[ids[0]]?.planType ?? null;
  return { status: windows.length ? "ok" : "empty", plan, at: now, windows };
}

// A window past its reset is unknown until a new reading arrives.
export function current(w, now) {
  return w.resetsAt != null && now >= w.resetsAt ? null : w.percent;
}

export function level(percent) {
  if (percent == null) return "none";
  if (percent >= 90) return "hot";
  if (percent >= 70) return "warn";
  return "ok";
}
