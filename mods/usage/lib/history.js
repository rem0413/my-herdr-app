// Limit readings over time, for the history charts. Stored by the bar in
// data/usage/history.json as { v: 1, series: { "<provider>:<window>": [[epoch s, percent], ...] } }.
// Pure.

export const KEEP = 31 * 86400;   // s
const SAME_EVERY = 15 * 60;       // s: an unchanged value is recorded at most this often

export function parse(text) {
  try {
    const doc = JSON.parse(text);
    if (doc?.v === 1 && doc.series && typeof doc.series === "object") return doc;
  } catch {}
  return { v: 1, series: {} };
}

// Adds one reading per window of a provider's limits ({ at, windows }). Returns
// whether anything changed. Readings are timed by when the source took them.
export function record(history, provider, limits, now) {
  if (!limits || limits.status !== "ok" || limits.at == null) return false;
  let changed = false;
  for (const w of limits.windows ?? []) {
    if (typeof w.percent !== "number") continue;
    const key = `${provider}:${w.id}`;
    const s = (history.series[key] ??= []);
    const last = s[s.length - 1];
    const value = Math.round(w.percent * 10) / 10;
    if (last && limits.at <= last[0]) continue;
    if (last && last[1] === value && limits.at - last[0] < SAME_EVERY) continue;
    s.push([limits.at, value]);
    changed = true;
  }
  for (const [key, s] of Object.entries(history.series)) {
    const keep = s.filter((p) => p[0] >= now - KEEP);
    if (keep.length !== s.length) {
      changed = true;
      if (keep.length) history.series[key] = keep;
      else delete history.series[key];
    }
  }
  return changed;
}

// `count` columns of `step` seconds ending at `end`: the highest reading in each,
// or null where nothing was read.
export function columns(points, end, step, count) {
  const start = end - step * count;
  const out = Array.from({ length: count }, (_, i) => ({ from: start + i * step, value: null }));
  for (const [t, v] of points ?? []) {
    if (t < start || t >= end) continue;
    const c = out[Math.floor((t - start) / step)];
    if (c.value == null || v > c.value) c.value = v;
  }
  return out;
}
