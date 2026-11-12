// Sums over the report's hourly buckets: any time window, local days for the
// chart. Pure; days follow the runtime's local time zone.

const HOUR_MS = 3600000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const dayLabel = (ms) => {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
};

// { tokens, cost, unpriced } of the hours in [from, to) (ms). Hours are whole, so
// a window that starts mid-hour includes that hour: an estimate, labelled as one.
export function sumBetween(hours, from, to = Infinity) {
  const out = { tokens: 0, cost: 0, unpriced: 0 };
  const a = Math.floor(from / HOUR_MS);
  const b = to === Infinity ? Infinity : Math.ceil(to / HOUR_MS);
  for (const [k, v] of Object.entries(hours ?? {})) {
    const h = Number(k);
    if (h < a || h >= b) continue;
    out.tokens += v[0];
    out.cost += v[1];
    out.unpriced += v[2] ?? 0;
  }
  return out;
}

export function localMidnight(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// The last `days` local days, oldest first, each { start, label, tokens, cost, unpriced }.
export function daily(hours, now, days) {
  const out = [];
  let start = localMidnight(now);
  const starts = [];
  for (let i = 0; i < days; i++) {
    starts.unshift(start);
    // Step back through noon so a daylight-saving day still lands on its midnight.
    start = localMidnight(start - 12 * HOUR_MS);
  }
  starts.forEach((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : localMidnight(s + 36 * HOUR_MS);
    out.push({ start: s, label: dayLabel(s), ...sumBetween(hours, s, end) });
  });
  return out;
}

// When a limit window began (ms), from its reset time and length; null when unknown.
export function windowStart(w) {
  if (!w || w.resetsAt == null || !w.duration) return null;
  return (w.resetsAt - w.duration) * 1000;
}

export function windowRange(w) {
  const from = windowStart(w);
  if (from == null) return "";
  const at = (ms) => {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${dayLabel(ms)} ${hh}:${mm}`;
  };
  return `${at(from)} – ${at(w.resetsAt * 1000)}`;
}
