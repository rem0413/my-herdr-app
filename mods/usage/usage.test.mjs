// Run: node mods/usage/usage.test.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, symlink, readlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { priceFor, costOf, parseRows, rollup, report } from "./lib/rollup.js";
import { claudeLimits, codexLimits, current, level } from "./lib/limits.js";
import * as fmt from "./lib/format.js";
import * as P from "./lib/prefs.js";
import { barModel, cardModel, sessionView, sessionOnBar, planLabel, segment } from "./lib/view.js";
import * as S from "./lib/stats.js";
import * as Hist from "./lib/history.js";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const pricing = JSON.parse(await readFile(join(here, "pricing.json"), "utf8")).models;
let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

await test("priceFor matches exact ids and date or context suffixes, never newer versions", () => {
  assert.equal(priceFor("claude-opus-5-5", pricing), pricing["claude-opus-5-5"]);
  assert.equal(priceFor("claude-haiku-4-5-20251001", pricing), pricing["claude-haiku-4-5"]);
  assert.equal(priceFor("claude-opus-5-5[1m]", pricing), pricing["claude-opus-5-5"]);
  assert.equal(priceFor("claude-opus-4-20250514", pricing), pricing["claude-opus-4"]);
  assert.equal(priceFor("claude-opus-5-6", pricing), null);
  assert.equal(priceFor("gpt-6.2-sol", pricing), null);
  assert.equal(priceFor("<synthetic>", pricing), null);
});

await test("costOf prices every token class, cache write durations and long prompts", () => {
  const e = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6, cacheWrite1h: 1e6, prompt: 0 };
  close(costOf(e, pricing["claude-opus-5-5"]), 4 + 20 + 0.2 + 5 + 8);
  close(costOf({ ...e, prompt: 50000 }, pricing["claude-haiku-5-5"]), 0.1 + 0.5 + 0.01 + 0.125 + 0.2);
  close(costOf({ ...e, prompt: 100001 }, pricing["claude-haiku-5-5"]), 0.5 + 2.5 + 0.05 + 0.625 + 1);
  const codex = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 0, cacheWrite1h: 0 };
  close(costOf({ ...codex, prompt: 272000 }, pricing["gpt-6.1-sol"]), 2 + 10 + 0.1);
  close(costOf({ ...codex, prompt: 272001 }, pricing["gpt-6.1-sol"]), 4 + 15 + 0.2);
  assert.equal(costOf(e, null), null);
});

const C = (ts, session, model, key, input, output, extra = {}) =>
  ["C", ts, session, model, extra.entry ?? "cli", extra.side ?? 0, key, input, output, extra.read ?? 0, extra.w5 ?? 0, extra.w1 ?? 0].join("\t");
const X = (ts, session, model, key, input, output, kind, extra = {}) =>
  ["X", ts, session, model, extra.origin ?? "Codex Desktop", extra.thread ?? "user", key, input, output, extra.read ?? 0, 0, extra.prompt ?? input, kind].join("\t");

await test("parseRows dedupes Claude responses and prefers Codex records over deltas", () => {
  const text = [
    C("2026-11-10T00:00:00Z", "s1", "claude-opus-5-5", "m1:r1", 10, 20),
    C("2026-11-10T00:00:01Z", "s1", "claude-opus-5-5", "m1:r1", 10, 20),
    C("2026-11-10T00:00:02Z", "s1", "claude-opus-5-5", "m2:r2", 1, 2, { side: 1 }),
    C("2026-11-10T00:00:03Z", "s1", "<synthetic>", "m3:r3", 0, 0),
    X("2026-11-10T00:00:00Z", "x1", "gpt-6.1-sol", "resp1", 100, 5, "R"),
    X("2026-11-10T00:00:00Z", "x1", "gpt-6.1-sol", "resp1", 100, 5, "R"),
    X("2026-11-10T00:00:00Z", "x1", "gpt-6.1-sol", "", 100, 5, "T"),
    X("2026-11-10T00:00:00Z", "x2", "gpt-6-sol", "", 7, 1, "T", { origin: "codex_cli_rs", thread: "subagent" }),
    "W\tzstd not found",
    "",
  ].join("\n");
  const { entries, warnings } = parseRows(text);
  assert.deepEqual(warnings, ["zstd not found"]);
  assert.equal(entries.filter((e) => e.provider === "claude").length, 2);
  assert.deepEqual(entries.filter((e) => e.provider === "codex").map((e) => [e.session, e.input]), [["x1", 100], ["x2", 7]]);
  assert.equal(entries.find((e) => e.session === "x2").agent, "codex_cli_rs · subagent");
  assert.equal(entries.find((e) => e.key === undefined && e.output === 2).agent, "cli · subagent");
});

await test("rollup filters by range and groups tokens, sessions and cost per model and agent", () => {
  const now = Date.parse("2026-11-12T00:00:00Z");
  const text = [
    C("2026-11-11T00:00:00Z", "s1", "claude-opus-5-5", "a:1", 1e6, 0),
    C("2026-11-01T00:00:00Z", "s2", "claude-opus-5-5", "b:2", 1e6, 0),
    C("2026-11-11T00:00:00Z", "s3", "mystery-model", "c:3", 500, 0, { entry: "sdk-cli" }),
    X("2026-11-11T00:00:00Z", "x1", "gpt-6.1-sol", "r1", 0, 1e6, "R"),
  ].join("\n");
  const rep = report(text, pricing, now);
  const [claude7, codex7] = rep.ranges["7d"];
  assert.equal(claude7.total.requests, 2);
  assert.equal(claude7.total.sessions, 2);
  assert.equal(claude7.total.tokens, 1e6 + 500);
  close(claude7.total.cost, 4);
  assert.equal(claude7.total.unpriced, 500);
  assert.deepEqual(claude7.models.map((m) => m.name), ["claude-opus-5-5", "mystery-model"]);
  assert.deepEqual(claude7.agents.map((a) => a.name), ["cli", "sdk-cli"]);
  close(codex7.total.cost, 10);
  assert.equal(rep.ranges["30d"][0].total.requests, 3);
  assert.equal(rollup([], 0, pricing)[1].total.tokens, 0);
});

await test("claudeLimits reads the statusLine payload and tolerates schema drift", () => {
  const text = JSON.stringify({ at: 1000, payload: { rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 2000 },
    seven_day: { utilization: 91, resets_at: "1970-01-01T01:00:00Z" },
    other: { note: "no percent" },
  } } });
  const l = claudeLimits(text);
  assert.equal(l.status, "ok");
  assert.equal(l.at, 1000);
  assert.deepEqual(l.windows.map((w) => [w.short, w.percent, w.resetsAt]), [["5h", 23.5, 2000], ["wk", 91, 3600]]);
  assert.equal(claudeLimits(null).status, "missing");
  assert.equal(claudeLimits("{").status, "error");
  assert.equal(claudeLimits(JSON.stringify({ at: 1, payload: {} })).status, "empty");
});

await test("codexLimits reads app-server replies, extra limits and errors", () => {
  const reply = JSON.stringify({ id: 2, result: { rateLimits: { planType: "team" }, rateLimitsByLimitId: {
    other: { limitId: "other", limitName: "Spark", primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 5 } },
    codex: { limitId: "codex", primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 9 },
      secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 99 } },
  } } });
  const l = codexLimits(`{"id":1,"result":{}}\n${reply}\n`, 7);
  assert.equal(l.status, "ok");
  assert.equal(l.plan, "team");
  assert.deepEqual(l.windows.map((w) => w.short), ["5h", "wk", "Spark 5h"]);
  assert.equal(codexLimits("", 7).status, "error");
  assert.equal(codexLimits('{"id":2,"error":{"message":"nope"}}', 7).message, "nope");
});

await test("windows past their reset read as unknown; levels at 70 and 90", () => {
  assert.equal(current({ percent: 40, resetsAt: 100 }, 99), 40);
  assert.equal(current({ percent: 40, resetsAt: 100 }, 100), null);
  assert.equal(current({ percent: 40, resetsAt: null }, 1e12), 40);
  assert.deepEqual([null, 69.9, 70, 89, 90].map(level), ["none", "ok", "warn", "warn", "hot"]);
});

await test("format", () => {
  assert.deepEqual([0, 999, 1500, 12000, 2.5e6, 3e9].map(fmt.tokens), ["0", "999", "1.5K", "12K", "2.5M", "3.0B"]);
  assert.deepEqual([null, 0, 0.001, 3.456, 1234.5].map(fmt.money), ["—", "$0", "<$0.01", "$3.46", "$1,235"]);
  assert.deepEqual([59, 3600 + 600, 2 * 86400 + 3600].map(fmt.span), ["0m", "1h 10m", "2d 1h"]);
  assert.equal(fmt.ago(100, 130), "just now");
});

await test("prefs: layout props preset, saved choices win, toggles round-trip", () => {
  const d = P.effective(undefined, undefined);
  assert.deepEqual(d, P.DEFAULTS);
  const preset = P.effective(undefined, { showRemaining: true, align: "left" });
  assert.equal(preset.showRemaining, true);
  assert.equal(P.effective({ showRemaining: false }, { showRemaining: true }).showRemaining, false);
  const p = P.toggleProvider(d, "codex");
  assert.equal(P.providerOn(p, "codex"), false);
  assert.equal(P.providerOn(P.toggleProvider(p, "codex"), "codex"), true);
  assert.equal(P.providerOn(p, "claude"), true);
  assert.deepEqual(P.toggleSession(P.toggleSession(d, "calls"), "context").session, ["calls", "context"]);
  assert.equal(P.toggle(d, "showBars").showBars, false);
});

await test("view: bar hides switched-off providers, shows reset when hot or asked", () => {
  const now = 1000;
  const limits = {
    claude: { status: "ok", plan: "team_standard", at: 940, windows: [
      { id: "five_hour", short: "5h", long: "5-hour", percent: 38, resetsAt: now + 9660 },
      { id: "seven_day", short: "wk", long: "Weekly", percent: 92, resetsAt: now + 3600 },
    ] },
    codex: { status: "missing", windows: [] },
  };
  const m = barModel(limits, P.DEFAULTS, now);
  assert.deepEqual(m.groups.map((g) => g.id), ["claude"]);
  assert.deepEqual(m.groups[0].segments.map((s) => [s.short, s.text, s.level, s.reset]), [["5h", "38%", "ok", ""], ["wk", "92%", "hot", "1h"]]);
  assert.equal(barModel(limits, P.toggleProvider(P.DEFAULTS, "claude"), now).empty, true);
  const remaining = segment(limits.claude.windows[0], { ...P.DEFAULTS, showRemaining: true, showResetTime: true }, now);
  assert.deepEqual([remaining.text, remaining.detail, remaining.level, remaining.reset], ["62%", "62% left", "ok", "2h 41m"]);
  const card = cardModel(limits, P.DEFAULTS, now, "installed");
  assert.deepEqual(card.map((g) => [g.name, g.plan, g.status]), [["Claude Code", "Team Standard", "updated 1m ago"], ["Codex", null, "not installed"]]);
  assert.equal(cardModel({}, P.DEFAULTS, now, "missing")[0].status, "statusLine not connected");
  assert.equal(planLabel("plus"), "Plus");
});

await test("view: session block and the numbers chosen for the bar", () => {
  const s = { title: "storefront", model: "Opus 5.5", tokens: 88000, window: 200000, percent: null, calls: 23, compactions: 1 };
  const v = sessionView(s);
  assert.equal(v.title, "storefront · Opus 5.5");
  assert.deepEqual([v.context.text, v.context.level], ["44%", "ok"]);
  assert.equal(v.stats, "88K of 200K tokens · 23 calls · 1 compaction");
  assert.equal(sessionView({ ...s, percent: 91 }).context.level, "hot");
  assert.equal(sessionView(null), null);
  assert.deepEqual(sessionOnBar(s, P.DEFAULTS), []);
  assert.deepEqual(sessionOnBar(s, { ...P.DEFAULTS, session: ["compactions", "context"] }).map((n) => n.text), ["ctx 44%", "1 cmp"]);
});

await test("report keeps hourly buckets; stats sum windows and local days", () => {
  const H = 3600000;
  const now = new Date(2026, 10, 12, 13, 30).getTime(); // local time
  const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).toISOString();
  const text = [
    C(at(12, 9, 15), "s1", "claude-opus-5-5", "a:1", 0, 1e6),     // today: $20
    C(at(12, 9, 45), "s1", "claude-opus-5-5", "b:2", 0, 5e5),     // same hour: $10
    C(at(11, 23, 59), "s2", "claude-opus-5-5", "c:3", 0, 1e5),    // yesterday: $2
    C(at(12, 10), "s3", "mystery", "d:4", 7, 0),                  // unpriced
    X(at(12, 11), "x1", "gpt-6.1-sol", "r1", 0, 1e6, "R"),        // codex today: $10
    C(new Date(now - 40 * 86400000).toISOString(), "s4", "claude-opus-5-5", "e:5", 0, 1e6), // too old
  ].join("\n");
  const rep = report(text, pricing, now);
  assert.deepEqual(Object.keys(rep.hours), ["claude", "codex"]);
  const h9 = String(Math.floor(Date.parse(at(12, 9, 15)) / H));
  assert.equal(rep.hours.claude[h9][0], 1.5e6);
  close(rep.hours.claude[h9][1], 30);
  const today = S.sumBetween(rep.hours.claude, S.localMidnight(now));
  close(today.cost, 30);
  assert.equal(today.unpriced, 7);
  assert.equal(today.tokens, 1.5e6 + 7);
  close(S.sumBetween(rep.hours.claude, 0).cost, 32);
  // A window starting mid-hour counts that whole hour.
  close(S.sumBetween(rep.hours.claude, Date.parse(at(12, 9, 50))).cost, 30);
  const days = S.daily(rep.hours.claude, now, 3);
  assert.deepEqual(days.map((d) => d.label), ["Nov 10", "Nov 11", "Nov 12"]);
  assert.deepEqual(days.map((d) => Math.round(d.cost)), [0, 2, 30]);
  close(S.daily(rep.hours.codex, now, 1)[0].cost, 10);
  const w = { long: "Weekly", resetsAt: Math.floor(now / 1000) + 3600, duration: 7 * 86400 };
  assert.equal(S.windowStart(w), now + 3600000 - 7 * 86400000);
  assert.equal(S.windowStart({ resetsAt: 5 }), null);
  assert.match(S.windowRange(w), /^Nov 5 14:30 – Nov 12 14:30$/);
  assert.equal(claudeLimits(JSON.stringify({ at: 1, payload: { rate_limits: { five_hour: { used_percentage: 1, resets_at: 9 } } } })).windows[0].duration, 18000);
  assert.equal(codexLimits(JSON.stringify({ id: 2, result: { rateLimits: { limitId: "codex", primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 9 } } } }), 1).windows[0].duration, 18000);
});

await test("history records changed readings, thins repeats, prunes old ones and fills columns", () => {
  const h = Hist.parse("not json");
  assert.deepEqual(h, { v: 1, series: {} });
  const lim = (at, p5, pw) => ({ status: "ok", at, windows: [{ id: "five_hour", percent: p5 }, { id: "seven_day", percent: pw }] });
  const now = 10_000_000;
  assert.equal(Hist.record(h, "claude", lim(now, 10, 3), now), true);
  assert.equal(Hist.record(h, "claude", lim(now, 11, 3), now), false);          // same reading time
  assert.equal(Hist.record(h, "claude", lim(now + 60, 10, 3), now), false);     // unchanged within 15 min
  assert.equal(Hist.record(h, "claude", lim(now + 120, 12.34, 3), now), true);  // 5h changed
  assert.equal(Hist.record(h, "claude", lim(now + 1000, 12.34, 3), now), true); // weekly repeated after 15 min
  assert.deepEqual(h.series["claude:five_hour"], [[now, 10], [now + 120, 12.3]]);
  assert.deepEqual(h.series["claude:seven_day"], [[now, 3], [now + 1000, 3]]);
  assert.equal(Hist.record(h, "codex", { status: "error", at: now, windows: [{ id: "x", percent: 1 }] }, now), false);
  assert.equal(Hist.record(h, "claude", lim(now + 2000, 12.34, 3), now + Hist.KEEP + 500), true);
  // Kept from now + 500 on: earlier readings go.
  assert.deepEqual(h.series["claude:five_hour"], [[now + 2000, 12.3]]);
  assert.equal(Hist.parse(JSON.stringify(h)).series["claude:seven_day"].length, 2);
  const cols = Hist.columns([[100, 5], [130, 9], [250, 2], [400, 99]], 300, 100, 3);
  assert.deepEqual(cols.map((c) => [c.from, c.value]), [[0, null], [100, 9], [200, 2]]);
});

// The helpers find data/usage from their own path, so they run from a copy.
const root = await mkdtemp(join(tmpdir(), "herdr-usage-test-"));
const helpers = join(root, "app", "mods", "usage", "helpers");
await cp(join(here, "helpers"), helpers, { recursive: true });
const data = join(root, "app", "data", "usage");
const sh = (script, args = [], env = {}, input) => new Promise((resolve) => {
  const child = execFile("sh", [join(helpers, script), ...args], { env: { ...process.env, ...env } },
    (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  child.stdin.end(input ?? "");
});

try {
  await test("scan.sh emits deduped-ready rows from Claude and Codex logs", async () => {
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    await mkdir(join(claude, "projects", "p", "s1", "subagents"), { recursive: true });
    const msg = (id, side, usage) => JSON.stringify({ type: "assistant", timestamp: "2026-11-11T00:00:00Z", sessionId: "s1",
      isSidechain: side, entrypoint: "cli", requestId: `req_${id}`, message: { id: `msg_${id}`, model: "claude-opus-5-5", usage } });
    await writeFile(join(claude, "projects", "p", "s1.jsonl"), [
      JSON.stringify({ type: "user", message: { content: "secret prompt" } }),
      msg("a", false, { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 10,
        cache_creation: { ephemeral_1h_input_tokens: 4, ephemeral_5m_input_tokens: 6 } }),
      "{broken json",
    ].join("\n"));
    await writeFile(join(claude, "projects", "p", "s1", "subagents", "agent-1.jsonl"),
      msg("b", true, { input_tokens: 5, output_tokens: 6 }) + "\n");
    await mkdir(join(codex, "sessions", "2026", "11", "11"), { recursive: true });
    const line = (type, payload) => JSON.stringify({ timestamp: "2026-11-11T00:00:00Z", type, payload });
    const tc = (total) => line("event_msg", { type: "token_count", info: { total_token_usage: total } });
    await writeFile(join(codex, "sessions", "2026", "11", "11", "rollout-1.jsonl"), [
      line("session_meta", { id: "x1", originator: "codex_cli_rs", thread_source: "user" }),
      line("turn_context", { model: "gpt-6.1-sol" }),
      tc({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 5, total_tokens: 105 }),
      tc({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 5, total_tokens: 105 }),
      tc({ input_tokens: 300, cached_input_tokens: 140, output_tokens: 15, total_tokens: 315 }),
    ].join("\n"));
    const r = await sh("scan.sh", [], { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes("secret"));
    const rows = r.stdout.trim().split("\n").map((l) => l.split("\t")).sort();
    assert.deepEqual(rows.filter((f) => f[0] === "C").map((f) => f.slice(4)), [
      ["cli", "0", "msg_a:req_a", "1", "2", "3", "6", "4"],
      ["cli", "1", "msg_b:req_b", "5", "6", "0", "0", "0"],
    ]);
    assert.deepEqual(rows.filter((f) => f[0] === "X").map((f) => [f[2], f[3], f[4], f[7], f[8], f[9], f[12]]), [
      ["x1", "gpt-6.1-sol", "codex_cli_rs", "100", "10", "100", "T"], // second delta: 200 in, 100 cached
      ["x1", "gpt-6.1-sol", "codex_cli_rs", "60", "5", "40", "T"],    // first total; the repeat adds nothing
    ]);
  });

  await test("statusline.sh stores rate limits, throttles, and passes the previous statusLine through", async () => {
    await mkdir(data, { recursive: true });
    await writeFile(join(data, "statusline-prev.sh"), "cat >/dev/null; printf 'prev-line'\n");
    const payload = JSON.stringify({ model: { id: "m" }, rate_limits: { five_hour: { used_percentage: 12, resets_at: 9 } } });
    const r = await sh("statusline.sh", [], {}, payload);
    assert.equal(r.stdout, "prev-line");
    const stored = JSON.parse(await readFile(join(data, "claude-statusline.json"), "utf8"));
    assert.equal(stored.payload.rate_limits.five_hour.used_percentage, 12);
    const again = payload.replace("12", "13");
    await sh("statusline.sh", [], {}, again);
    assert.equal(JSON.parse(await readFile(join(data, "claude-statusline.json"), "utf8")).payload.rate_limits.five_hour.used_percentage, 12);
    const plain = await sh("statusline.sh", [], {}, JSON.stringify({ model: {} }));
    assert.equal(plain.stdout, "prev-line");
    const s = JSON.parse(await readFile(join(data, "sessions", "abc-1.json"), "utf8").catch(() => "null"));
    assert.equal(s, null);
    await sh("statusline.sh", [], {}, JSON.stringify({ session_id: "abc-1", context_window: { used_percentage: 44 } }));
    await sh("statusline.sh", [], {}, JSON.stringify({ session_id: "../evil", context_window: {} }));
    const kept = JSON.parse(await readFile(join(data, "sessions", "abc-1.json"), "utf8"));
    assert.equal(kept.payload.context_window.used_percentage, 44);
    await assert.rejects(readFile(join(data, "evil.json")));
  });

  await test("session.sh counts Claude prompts and compactions, reads the plan, refuses other paths", async () => {
    const cfg = join(root, "cc-session");
    const t = join(cfg, "projects", "p", "s.jsonl");
    await mkdir(dirname(t), { recursive: true });
    await writeFile(t, [
      { type: "user", message: { content: "hi" } },
      { type: "user", message: { content: [{ type: "text", text: "do it" }] } },
      { type: "user", message: { content: [{ type: "tool_result", content: "x" }] } },
      { type: "user", isMeta: true, message: { content: "meta" } },
      { type: "user", isSidechain: true, message: { content: "sub" } },
      { type: "system", subtype: "compact_boundary" },
      { type: "user", isCompactSummary: true, message: { content: "summary" } },
    ].map((l) => JSON.stringify(l)).join("\n"));
    await writeFile(join(cfg, ".claude.json"), JSON.stringify({ oauthAccount: { seatTier: "max_20x", emailAddress: "x@y" } }));
    const env = { CLAUDE_CONFIG_DIR: cfg };
    assert.equal((await sh("session.sh", ["claude", t], env)).stdout.trim(), "calls=2 compactions=1");
    assert.equal((await sh("session.sh", ["claude", join(root, "elsewhere.jsonl")], env)).code, 1);
    assert.equal((await sh("session.sh", ["plan"], env)).stdout.trim(), "max_20x");
    assert.equal((await sh("session.sh", ["codex", "not-a-pid"], env)).code, 1);
  });

  await test("statusline-install.sh chains, is idempotent, keeps symlinks and restores", async () => {
    const cfg = join(root, "cc");
    await mkdir(cfg, { recursive: true });
    const real = join(root, "dotfiles-settings.json");
    await writeFile(real, JSON.stringify({ theme: "dark", statusLine: { type: "command", command: "echo orca", padding: 1 } }));
    await symlink(real, join(cfg, "settings.json"));
    const env = { CLAUDE_CONFIG_DIR: cfg };
    assert.equal((await sh("statusline-install.sh", ["status"], env)).stdout.trim(), "missing");
    assert.equal((await sh("statusline-install.sh", ["install"], env)).stdout.trim(), "installed");
    assert.equal((await sh("statusline-install.sh", ["install"], env)).stdout.trim(), "installed");
    const s = JSON.parse(await readFile(real, "utf8"));
    assert.equal(s.theme, "dark");
    assert.equal(s.statusLine.padding, 1);
    assert.equal(s.statusLine.command, `sh '${helpers}/statusline.sh'`);
    assert.equal((await readFile(join(data, "statusline-prev.sh"), "utf8")).trim(), "echo orca");
    assert.ok((await lstat(join(cfg, "settings.json"))).isSymbolicLink());
    assert.equal(await readlink(join(cfg, "settings.json")), real);
    assert.equal((await sh("statusline-install.sh", ["uninstall"], env)).stdout.trim(), "missing");
    assert.equal(JSON.parse(await readFile(real, "utf8")).statusLine.command, "echo orca");
    const empty = join(root, "cc-empty");
    await mkdir(empty);
    await sh("statusline-install.sh", ["install"], { CLAUDE_CONFIG_DIR: empty });
    await sh("statusline-install.sh", ["uninstall"], { CLAUDE_CONFIG_DIR: empty });
    assert.deepEqual(JSON.parse(await readFile(join(empty, "settings.json"), "utf8")), {});
  });
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`${passed} passed`);
