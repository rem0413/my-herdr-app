// Turns helpers/scan.sh rows into 7d / 30d rollups per provider, model and agent.
// Pure: no herdr imports, so node can test it.

export const PROVIDERS = [
  { id: "claude", name: "Claude Code", icon: "icons/claude.svg" },
  { id: "codex", name: "Codex", icon: "icons/codex.svg" },
];

const num = (s) => {
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// A model id matches a price key exactly, or with a date or bracket suffix
// (claude-haiku-4-5-20251001, claude-opus-5-5[1m]); never a newer version.
export function priceFor(model, models) {
  if (!model || !models) return null;
  if (models[model]) return models[model];
  let best = null;
  for (const key of Object.keys(models)) {
    if (!model.startsWith(key)) continue;
    const rest = model.slice(key.length);
    if (!/^(-\d{8}|\[)/.test(rest)) continue;
    if (!best || key.length > best.length) best = key;
  }
  return best ? models[best] : null;
}

// USD for one response, or null when the model has no price.
export function costOf(e, price) {
  if (!price) return null;
  const tier = price.long && e.prompt > price.long.above ? { ...price, ...price.long } : price;
  const write5m = tier.cacheWrite5m ?? tier.cacheWrite ?? tier.input;
  const write1h = tier.cacheWrite1h ?? write5m;
  const cacheRead = tier.cacheRead ?? tier.input;
  return (e.input * tier.input + e.output * tier.output + e.cacheRead * cacheRead
    + e.cacheWrite * write5m + e.cacheWrite1h * write1h) / 1e6;
}

function claudeAgent(entrypoint, sidechain) {
  const base = entrypoint || "unknown";
  return sidechain === "1" ? `${base} · subagent` : base;
}

function codexAgent(originator, thread) {
  const base = originator || "unknown";
  return thread && thread !== "user" ? `${base} · ${thread}` : base;
}

// Rows → entries, deduped. Codex token_count deltas (T) only count for sessions
// that logged no per-response record (R).
export function parseRows(text) {
  const entries = [];
  const warnings = [];
  const seen = new Set();
  const recorded = new Set();
  const deltas = [];
  for (const line of String(text ?? "").split("\n")) {
    const f = line.split("\t");
    if (f[0] === "W") {
      warnings.push(f.slice(1).join(" "));
      continue;
    }
    if (f[0] === "C" && f.length >= 12) {
      const key = f[6];
      if (key !== ":" && seen.has(`C${key}`)) continue;
      seen.add(`C${key}`);
      const e = {
        provider: "claude", ts: Date.parse(f[1]), session: f[2], model: f[3], agent: claudeAgent(f[4], f[5]),
        input: num(f[7]), output: num(f[8]), cacheRead: num(f[9]), cacheWrite: num(f[10]), cacheWrite1h: num(f[11]),
      };
      e.prompt = e.input + e.cacheRead + e.cacheWrite + e.cacheWrite1h;
      entries.push(e);
    } else if (f[0] === "X" && f.length >= 13) {
      const kind = f[12];
      const e = {
        provider: "codex", ts: Date.parse(f[1]), session: f[2], model: f[3], agent: codexAgent(f[4], f[5]),
        input: num(f[7]), output: num(f[8]), cacheRead: num(f[9]), cacheWrite: num(f[10]), cacheWrite1h: 0,
        // A delta sums several requests, so it can't be priced as one long prompt.
        prompt: kind === "R" ? num(f[11]) : 0,
      };
      if (kind === "R") {
        if (f[6] && seen.has(`X${f[6]}`)) continue;
        if (f[6]) seen.add(`X${f[6]}`);
        recorded.add(e.session);
        entries.push(e);
      } else {
        deltas.push(e);
      }
    }
  }
  for (const e of deltas) if (!recorded.has(e.session)) entries.push(e);
  return { entries: entries.filter((e) => Number.isFinite(e.ts) && tokens(e) > 0), warnings };
}

export const tokens = (t) => t.input + t.output + t.cacheRead + t.cacheWrite + (t.cacheWrite1h ?? 0);

function bucket(name) {
  return { name, requests: 0, sessions: new Set(), input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0 };
}

function add(b, e, cost) {
  b.requests += 1;
  if (e.session) b.sessions.add(e.session);
  b.input += e.input;
  b.output += e.output;
  b.cacheRead += e.cacheRead;
  b.cacheWrite += e.cacheWrite + e.cacheWrite1h;
  if (cost == null) b.unpriced += tokens(e);
  else b.cost += cost;
}

function plain(b) {
  const { sessions, ...rest } = b;
  return { ...rest, sessions: sessions.size, tokens: tokens(rest) };
}

const byTokens = (a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name);

// Every provider, with entries at or after `since` (ms).
export function rollup(entries, since, models) {
  return PROVIDERS.map((p) => {
    const total = bucket(p.name);
    const byModel = new Map();
    const byAgent = new Map();
    for (const e of entries) {
      if (e.provider !== p.id || e.ts < since) continue;
      const cost = costOf(e, priceFor(e.model, models));
      add(total, e, cost);
      if (!byModel.has(e.model)) byModel.set(e.model, bucket(e.model));
      add(byModel.get(e.model), e, cost);
      if (!byAgent.has(e.agent)) byAgent.set(e.agent, bucket(e.agent));
      add(byAgent.get(e.agent), e, cost);
    }
    return {
      id: p.id, name: p.name, icon: p.icon, total: plain(total),
      models: [...byModel.values()].map(plain).sort(byTokens),
      agents: [...byAgent.values()].map(plain).sort(byTokens),
    };
  });
}

export const RANGES = [
  { id: "7d", label: "7 days", days: 7 },
  { id: "30d", label: "30 days", days: 30 },
];

const HOUR_MS = 3600000;

// Per provider, epoch hour → [tokens, cost, unpriced tokens], for the last 31 days:
// enough to sum any window or local day without rescanning.
export function hourly(entries, since, models) {
  const out = Object.fromEntries(PROVIDERS.map((p) => [p.id, {}]));
  for (const e of entries) {
    if (e.ts < since || !out[e.provider]) continue;
    const h = Math.floor(e.ts / HOUR_MS);
    const b = (out[e.provider][h] ??= [0, 0, 0]);
    const cost = costOf(e, priceFor(e.model, models));
    b[0] += tokens(e);
    if (cost == null) b[2] += tokens(e);
    else b[1] += cost;
  }
  return out;
}

// Both ranges at once: the report switches between them without rescanning.
export function report(text, models, now) {
  const { entries, warnings } = parseRows(text);
  const out = { at: now, warnings, ranges: {}, hours: hourly(entries, now - 31 * 86400000, models) };
  for (const r of RANGES) out.ranges[r.id] = rollup(entries, now - r.days * 86400000, models);
  return out;
}
