// Usage: Claude Code and Codex rate limits in the status bar. Hovering shows a
// card with every window, the focused agent's session and, behind the gear,
// settings for what the bar shows. Clicking opens 7-day / 30-day token and
// cost rollups per model and agent.
//
// One mod, two roles. In a layout block it is the bar and card: it keeps the
// limits fresh in shared state. Opened as a popup (props().view === "report")
// it scans local session logs for the rollups.
//
// Data: Claude limits and sessions from Claude Code's statusLine
// (helpers/statusline.sh), Codex limits from `codex app-server`, session
// numbers and rollups from local session logs. No token or credential is read.
import { View, div, image, svg } from "gpui-kit";
import { HoverCard, h_flex, v_flex } from "gpui-base";
import {
  exec, theme, props, shared, setShared, appHome, home, focused,
  readTextFile, writeTextFile, watchFolder, closeOverlay, run,
} from "herdr";
import { claudeLimits, codexLimits } from "./lib/limits.js";
import { report, RANGES, PROVIDERS } from "./lib/rollup.js";
import { barModel, cardModel, sessionView, sessionOnBar } from "./lib/view.js";
import * as P from "./lib/prefs.js";
import * as fmt from "./lib/format.js";
import * as S from "./lib/stats.js";
import * as H from "./lib/history.js";

const MOD = "usage";
const K_LIMITS = "usage.limits";         // { claude, codex }: lib/limits.js shape
const K_REPORT = "usage.report";         // lib/rollup.js report()
const K_PREFS = "usage.prefs";           // lib/prefs.js, once the person changes something
const K_ASK = "usage.ask";               // epoch ms: something asks the bar to refetch
const K_STATUSLINE = "usage.statusline"; // "installed" | "missing" | "error"
const CODEX_EVERY = 5 * 60;              // s
const CODEX_MISSING_EVERY = 60 * 60;     // s, when codex isn't installed
const SESSION_EVERY = 10 * 1000;         // ms, at most this often on hover or file changes
const REPORT_STALE = 5 * 60 * 1000;      // ms, the report rescans older data on open
const COOLDOWN = 30 * 1000;              // ms, between Codex probes
const CARD_W = 380;
// Each provider keeps one color in charts and meters, in light and dark themes.
const PROVIDER_COLOR = { claude: "#d97757", codex: "#6b8afd" };
const AGENTS = { "claude-code": "claude", codex: "codex" }; // Herdr's app name → session.sh

const nowSec = () => Math.floor(Date.now() / 1000);
const dataDir = () => `${appHome()}/data/usage`;
const helper = (name) => `${appHome()}/mods/${MOD}/helpers/${name}`;
const icon = (name) => `mods/${MOD}/icons/${name}.svg`;
const historyPath = () => `${dataDir()}/history.json`;
const limitsOf = () => shared(K_LIMITS) ?? {};
const prefs = () => P.effective(shared(K_PREFS), props());
const savePrefs = (p) => setShared(K_PREFS, p);

function levelColor(lv, t) {
  if (lv === "hot") return t.ansi1 ?? t.blocked;
  if (lv === "warn") return t.ansi3 ?? t.done;
  if (lv === "none") return t.dim;
  return t.foreground;
}

// Bars are green while fine, like the text they sit next to turns amber and red.
const fillColor = (lv, t) => (lv === "ok" ? (t.ansi2 ?? t.working) : levelColor(lv, t));

function setLimits(id, next) {
  const all = limitsOf();
  if (JSON.stringify(all[id]) !== JSON.stringify(next)) setShared(K_LIMITS, { ...all, [id]: next });
}

function bar(width, fill, color, t) {
  const w = Math.max(0, Math.min(1, fill ?? 0));
  return div().relative().w(width).h(6).rounded(4).bg(t.raised).flex_none()
    .child(div().absolute().left(0).top(0).h(6).rounded(4).w(Math.round(width * w)).bg(color));
}

const keyValues = (text) => Object.fromEntries(String(text ?? "").trim().split(/\s+/)
  .map((kv) => kv.split("=")).filter((kv) => kv.length === 2));

export default class Usage extends View {
  init(_props, cx) {
    // Opened as an overlay (mod.open), it is the report; in a layout block, the bar.
    this.report = props()?.overlay != null;
    return this.report ? this.initReport(cx) : this.initBar(cx);
  }

  // ---------- bar: keeps the limits and the focused session fresh ----------

  initBar(cx) {
    this.width = 0;
    this.view = "limits";      // the card: "limits" | "settings"
    this.leftAt = 0;           // ms, when the pointer last left the bar or card
    this.codexAt = 0;
    this.codexBusy = false;
    this.claudePlan = null;
    this.terminal = null;      // the focused terminal `session` belongs to
    this.session = null;       // { app, title, model, tokens, window, percent, calls, compactions }
    this.sessionAt = 0;
    this.sessionBusy = false;
    this.busy = false;         // statusLine connect/disconnect
    this.seenAsk = shared(K_ASK) ?? 0;
    this.history = null;       // lib/history.js, once read
    this.historyText = null;   // what the file held when last read or written
    this.historyDirty = false;
    cx.spawn(async (cx) => {
      this.historyText = await readTextFile(historyPath()).catch(() => null);
      this.history = H.parse(this.historyText);
      const r = await exec("sh", [helper("session.sh"), "plan"]).catch(() => null);
      this.claudePlan = r?.code === 0 ? r.stdout.trim() : null;
      // Claude's config folder, as the helpers find it (CLAUDE_CONFIG_DIR, else ~/.claude).
      const d = await exec("sh", ["-c", 'printf %s "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"']).catch(() => null);
      this.claudeDir = (d?.code === 0 && d.stdout.trim()) || `${home()}/.claude`;
      this.refreshAll(cx);
    });
    cx.timer.every(60 * 1000, (cx) => this.tick(cx));
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", `${dataDir()}/sessions`]).catch(() => null);
      // Session payloads of ended sessions are no use after a week.
      await exec("find", [`${dataDir()}/sessions`, "-type", "f", "-mtime", "+7", "-delete"]).catch(() => null);
      // The statusLine script writes here; a failed watch leaves the minute timer.
      for (;;) {
        try {
          await watchFolder(dataDir());
        } catch {
          return;
        }
        await this.loadClaude();
        if (Date.now() - this.sessionAt >= SESSION_EVERY) this.readSession(cx);
        cx.notify();
      }
    });
  }

  // Asked again within the cooldown, Codex keeps its last reading.
  refreshAll(cx) {
    cx.spawn(async (cx) => {
      await this.loadClaude();
      await this.checkStatusLine();
      cx.notify();
    });
    if ((nowSec() - this.codexAt) * 1000 >= COOLDOWN) this.fetchCodex(cx);
    this.readSession(cx);
  }

  tick(cx) {
    const missing = limitsOf().codex?.status === "missing";
    if (nowSec() - this.codexAt >= (missing ? CODEX_MISSING_EVERY : CODEX_EVERY)) this.fetchCodex(cx);
    cx.spawn(async (cx) => {
      await this.loadClaude();
      await this.saveHistory();
      cx.notify(); // reset countdowns move every minute
    });
  }

  async loadClaude() {
    const text = await readTextFile(`${dataDir()}/claude-statusline.json`).catch(() => null);
    this.keep("claude", { ...claudeLimits(text), plan: this.claudePlan });
  }

  // Publishes a provider's limits and records the reading for the history charts.
  keep(id, next) {
    setLimits(id, next);
    if (this.history && H.record(this.history, id, next, nowSec())) this.historyDirty = true;
  }

  // At most once a minute. This copy is the only writer; a stale write rereads and retries.
  async saveHistory() {
    if (!this.historyDirty || !this.history) return;
    const text = JSON.stringify(this.history);
    try {
      await writeTextFile(historyPath(), text, this.historyText);
      this.historyText = text;
      this.historyDirty = false;
    } catch {
      this.historyText = await readTextFile(historyPath()).catch(() => null);
    }
  }

  async checkStatusLine() {
    const r = await exec("sh", [helper("statusline-install.sh"), "status"]).catch(() => null);
    const state = r?.code === 0 ? r.stdout.trim() : "error";
    if (shared(K_STATUSLINE) !== state) setShared(K_STATUSLINE, state);
  }

  fetchCodex(cx) {
    if (this.codexBusy) return;
    this.codexBusy = true;
    this.codexAt = nowSec();
    cx.spawn(async (cx) => {
      const prev = limitsOf().codex;
      let next;
      try {
        const r = await exec("sh", [helper("codex-limits.sh")], { timeout: 30000 });
        next = r.code === 127
          ? { status: "missing", plan: null, at: nowSec(), windows: [] }
          : codexLimits(r.stdout, nowSec());
      } catch (e) {
        next = { status: "error", message: String(e?.message ?? e), plan: null, at: nowSec(), windows: [] };
      }
      // A failed read keeps the last windows, marked by the status.
      if (next.status === "error" && prev?.windows?.length) next = { ...prev, status: "error", message: next.message };
      this.codexBusy = false;
      this.keep("codex", next);
      cx.notify();
    });
  }

  // Focused terminal → its agent's process → that process's session. Any step
  // failing means no session block: another session's numbers would be worse.
  readSession(cx) {
    if (this.sessionBusy) return;
    const terminal = this.terminal;
    this.sessionAt = Date.now();
    if (!terminal) {
      this.session = null;
      return;
    }
    this.sessionBusy = true;
    cx.spawn(async (cx) => {
      let next = null;
      try {
        next = await this.loadSession(terminal);
      } catch {
        next = null;
      } finally {
        this.sessionBusy = false;
      }
      if (terminal !== this.terminal) {
        this.readSession(cx); // focus moved on while this was reading
        return;
      }
      this.session = next;
      cx.notify();
    });
  }

  async loadSession(terminal) {
    // A terminal on another machine ("<machine>/t7"): its pid means nothing to this computer's helpers and files.
    if (terminal.includes("/")) return null;
    const info = JSON.parse((await exec("hc", ["get", terminal])).stdout);
    const app = AGENTS[info.status?.app];
    const pid = info.foreground?.pid;
    if (!app || !Number.isInteger(pid)) return null;
    const folder = String(info.cwd ?? "").split("/").filter(Boolean).pop() ?? "";
    if (app === "codex") {
      const r = await exec("sh", [helper("session.sh"), "codex", String(pid)]);
      if (r.code !== 0) return null;
      const kv = keyValues(r.stdout);
      return { app, title: folder, model: kv.model || null, tokens: Number(kv.tokens) || 0,
        window: Number(kv.window) || null, calls: Number(kv.calls), compactions: null };
    }
    const meta = JSON.parse((await readTextFile(`${this.claudeDir ?? `${home()}/.claude`}/sessions/${pid}.json`)) ?? "null");
    const sid = meta?.sessionId;
    if (!sid || !/^[0-9A-Za-z-]+$/.test(sid)) return null;
    const doc = JSON.parse((await readTextFile(`${dataDir()}/sessions/${sid}.json`)) ?? "null");
    const p = doc?.payload;
    if (!p) return null;
    const cw = p.context_window ?? {};
    const u = cw.current_usage ?? {};
    const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const counts = p.transcript_path
      ? keyValues((await exec("sh", [helper("session.sh"), "claude", p.transcript_path])).stdout)
      : {};
    return {
      app, title: p.session_name || folder, model: p.model?.display_name ?? null, tokens,
      window: cw.context_window_size ?? null, percent: typeof cw.used_percentage === "number" ? cw.used_percentage : null,
      calls: counts.calls != null ? Number(counts.calls) : null,
      compactions: counts.compactions != null ? Number(counts.compactions) : null,
    };
  }

  ask() {
    setShared(K_ASK, Date.now());
  }

  hover(on, cx) {
    if (!on) {
      this.leftAt = Date.now();
      return;
    }
    // Coming back after the card closed starts on the limits again.
    if (Date.now() - this.leftAt > 1000) this.view = "limits";
    if (Date.now() - this.sessionAt >= SESSION_EVERY) this.readSession(cx);
    cx.notify();
  }

  // mod.open shows the dialog from mod.json's `overlay`; Herdr keeps one and closes it
  // when asked again. The palette and keys can open it the same way.
  openReport() {
    run("mod.open", { name: MOD });
  }

  statusLine(action, cx) {
    if (this.busy) return;
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("sh", [helper("statusline-install.sh"), action]).catch((e) => ({ code: 1, stderr: String(e) }));
      this.busy = false;
      this.statusError = r.code === 0 ? null : (r.stderr || "statusLine change failed").trim();
      setShared(K_STATUSLINE, r.code === 0 ? r.stdout.trim() : "error");
      cx.notify();
    });
  }

  iconButton(id, name, label, onClick, t, enabled = true) {
    return div().id(id).size(24).rounded(6).flex().flex_none().items_center().justify_center().tooltip(label)
      .when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => onClick(cx)))
      .child(svg(icon(name)).size(14).text_color(enabled ? t.muted : t.dim));
  }

  // Rough width of the bar's limits, to drop the small bars first when short of room.
  barWidth(model, extra, bars) {
    return model.groups.reduce((w, g) => w + 24 + (bars ? 38 : 0)
      + g.segments.reduce((a, s) => a + 7 * (s.short.length + s.text.length + (s.reset ? s.reset.length + 1 : 0)) + 16, 0), 80 + extra);
  }

  group(g, showBars, t) {
    const first = g.segments[0];
    const parts = [];
    g.segments.forEach((s, i) => {
      if (i > 0) parts.push(div().text_color(t.dim).child("·"));
      parts.push(h_flex().gap(3).items_center().flex_none()
        .child(div().whitespace_nowrap().text_color(levelColor(s.level === "ok" ? "ok" : s.level, t)).child(`${s.short} ${s.text}`))
        .when(s.reset !== "", (e) => e.child(div().whitespace_nowrap().text_color(t.dim).child(s.reset))));
    });
    if (!parts.length) parts.push(div().text_color(t.dim).child(g.failed ? "error" : "—"));
    return h_flex().id(`ul-${g.id}`).gap(6).items_center().flex_none().opacity(g.failed ? 0.55 : 1)
      .child(image(g.icon).size(14))
      .when(showBars && first != null, (e) => e.child(bar(32, first.fill, first.level === "ok" ? t.muted : levelColor(first.level, t), t)))
      .child(h_flex().gap(4).items_center().children(parts));
  }

  renderBar() {
    const t = theme();
    const pr = prefs();
    const now = nowSec();
    const model = barModel(limitsOf(), pr, now);
    const numbers = sessionOnBar(this.session, pr);
    const numbersWidth = numbers.reduce((w, n) => w + 7 * n.text.length + 12, numbers.length ? 16 : 0);
    const showBars = pr.showBars && (!this.width || this.barWidth(model, numbersWidth, true) <= this.width);
    const content = h_flex().id("ul-content").gap(10).items_center().flex_none()
      .on_hover((on, cx) => this.hover(on, cx))
      .child(div().flex_none().text_color(t.dim).child(pr.showRemaining ? "Remaining" : "Used"));
    if (numbers.length) {
      content.child(h_flex().gap(10).items_center().flex_none()
        .children(numbers.map((n) => div().whitespace_nowrap().text_color(levelColor(n.level, t)).child(n.text))));
      if (!model.empty) content.child(div().w(1).h(14).bg(t.border).flex_none());
    }
    if (model.empty) content.child(svg(icon("gauge")).size(14).text_color(t.dim));
    model.groups.forEach((g) => content.child(this.group(g, showBars, t)));
    // Refresh sits right after the limits, so a narrow block never clips it.
    return h_flex().id("root").size_full().pl(12).pr(6).gap(4).items_center().overflow_hidden()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .on_size_change((size, cx) => { this.width = size.width; cx.notify(); })
      .child(HoverCard.new("ul-card").anchor("bottom_left").open_delay(350).close_delay(300)
        .trigger(content)
        .content(this.view === "settings" ? this.settings(t) : this.card(t)))
      .child(this.iconButton("ul-bar-refresh", "refresh", "Refresh now", () => this.ask(), t));
  }

  // ---------- hover card ----------

  shell(t) {
    return v_flex().id("ul-card-body").w(CARD_W).p(14).gap(14).rounded(10).border(1).border_color(t.border)
      .bg(t.popover).shadow_lg().text_size(12).text_color(t.foreground)
      .on_hover((on, cx) => this.hover(on, cx));
  }

  card(t) {
    const pr = prefs();
    const now = nowSec();
    const body = this.shell(t);
    for (const g of cardModel(limitsOf(), pr, now, shared(K_STATUSLINE))) {
      body.child(v_flex().gap(7)
        .child(h_flex().gap(6).items_center()
          .child(image(g.icon).size(15))
          .child(div().flex_none().font_semibold().child(g.name))
          .when(g.plan != null, (e) => e.child(div().flex_none().px(5).rounded(4).bg(t.raised).text_size(10).text_color(t.accent).child(g.plan)))
          .child(div().flex_1())
          .child(div().min_w(0).truncate().text_size(11).text_color(g.failed ? levelColor("hot", t) : t.dim).child(g.status)))
        .children(g.rows.map((r) => h_flex().gap(10).items_center()
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(r.long))
          .child(bar(110, r.fill, fillColor(r.level, t), t))
          .child(div().w(pr.showRemaining ? 66 : 40).flex_none().flex().justify_end().whitespace_nowrap()
            .text_color(r.level === "ok" ? t.foreground : levelColor(r.level, t)).child(r.detail))
          .child(div().w(50).flex_none().flex().justify_end().whitespace_nowrap().text_size(11).text_color(t.dim).child(r.left)))));
    }
    const s = sessionView(this.session);
    if (s) {
      body.child(v_flex().gap(4).pt(12).border_t(1).border_color(t.border)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_none().font_semibold().child("This session"))
          .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(s.title))
          .when(s.context.fill != null, (e) => e.child(bar(60, s.context.fill, fillColor(s.context.level, t), t)))
          .when(s.context.fill != null, (e) => e.child(div().flex_none().whitespace_nowrap()
            .text_color(s.context.level === "ok" ? t.foreground : levelColor(s.context.level, t)).child(`ctx ${s.context.text}`))))
        .when(s.stats !== "", (e) => e.child(div().text_size(11).text_color(t.dim).child(s.stats))));
    }
    return body.child(h_flex().gap(2).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim)
        .child("Claude statusLine, codex app-server, local session logs."))
      .child(this.iconButton("ul-report", "chart", "7-day / 30-day usage", () => this.openReport(), t))
      .child(this.iconButton("ul-refresh", "refresh", "Refresh now", () => this.ask(), t))
      .child(this.iconButton("ul-settings", "gear", "Settings", (cx) => { this.view = "settings"; cx.notify(); }, t)));
  }

  check(id, on, label, onToggle, t, indent = 0, extra = null) {
    return h_flex().id(id).gap(8).items_center().pl(indent).py(3).px(4).rounded(4).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { onToggle(); cx.notify(); })
      .child(div().size(13).flex_none().rounded(4).border(1).border_color(on ? t.accent : t.input).bg(on ? t.accent : t.popover)
        .flex().items_center().justify_center().text_size(10).text_color(t.accent_foreground).child(on ? "✓" : ""))
      .children(label)
      .when(extra != null, (e) => e.child(div().flex_1().min_w(0).flex().justify_end().text_size(11).text_color(t.dim).truncate().child(extra)));
  }

  settings(t) {
    const pr = prefs();
    const all = limitsOf();
    const rows = PROVIDERS.map((p) => {
      const l = all[p.id];
      const reason = !l || l.status === "missing" ? (p.id === "claude" ? "no data yet" : "not installed")
        : l.status === "error" ? (l.message ?? "error") : null;
      return this.check(`p-${p.id}`, P.providerOn(pr, p.id), [image(p.icon).size(13), div().child(p.name)],
        () => savePrefs(P.toggleProvider(prefs(), p.id)), t, 0, reason);
    });
    const option = (id, key, label) => this.check(id, pr[key], [div().child(label)], () => savePrefs(P.toggle(prefs(), key)), t);
    const connected = shared(K_STATUSLINE) === "installed";
    return this.shell(t)
      .child(h_flex().gap(6).items_center().h(24)
        .child(this.iconButton("ul-back", "back", "Back to limits", (cx) => { this.view = "limits"; cx.notify(); }, t))
        .child(div().font_semibold().child("Settings")))
      .child(div().text_size(11).text_color(t.dim).child("What the bar shows. The card always shows everything."))
      .child(v_flex().gap(1).children(rows))
      .child(div().h(1).flex_none().bg(t.border))
      .child(v_flex().gap(1)
        .child(option("opt-bars", "showBars", "Show bars"))
        .child(option("opt-remaining", "showRemaining", "Show remaining instead of used"))
        .child(option("opt-reset", "showResetTime", "Always show time to reset")))
      .child(div().h(1).flex_none().bg(t.border))
      .child(v_flex().gap(1)
        .child(div().font_semibold().pb(3).child("This session on the bar"))
        .children(P.SESSION_ROWS.map((r) => this.check(`s-${r.id}`, pr.session.includes(r.id), [div().child(r.label)],
          () => savePrefs(P.toggleSession(prefs(), r.id)), t))))
      .child(div().h(1).flex_none().bg(t.border))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).text_size(11).text_color(this.statusError ? levelColor("hot", t) : t.dim)
          .child(this.statusError ?? (connected
            ? "Claude statusLine connected; your previous statusLine still runs after it."
            : "Connect Claude Code's statusLine for live Claude limits. Your current statusLine keeps running.")))
        .child(div().id("ul-statusline").px(8).py(3).rounded(6).flex_none().cursor_pointer().text_size(11)
          .bg(connected ? t.raised : t.solid).text_color(connected ? t.foreground : t.solid_foreground)
          .hover((s) => s.opacity(0.85))
          .on_click((_e, cx) => this.statusLine(connected ? "uninstall" : "install", cx))
          .child(this.busy ? "…" : connected ? "Disconnect" : "Connect")));
  }

  // ---------- report dialog: Overview and one tab per provider ----------

  initReport(cx) {
    this.range = "30d";
    this.tab = "overview";
    this.metric = "cost";
    this.historyWindow = {};   // provider → chosen window id for the history chart
    try {
      this.range = localStorage.getItem("usage.range") || "30d";
      this.tab = localStorage.getItem("usage.tab") || "overview";
      this.metric = localStorage.getItem("usage.metric") || "cost";
    } catch {}
    this.scanning = false;
    this.error = null;
    this.history = H.parse(null);
    this.loadHistory(cx);
    cx.timer.every(60 * 1000, (cx) => this.loadHistory(cx));
    const rep = shared(K_REPORT);
    if (!rep || !rep.hours || Date.now() - rep.at > REPORT_STALE) this.scan(cx);
  }

  loadHistory(cx) {
    cx.spawn(async (cx) => {
      this.history = H.parse(await readTextFile(historyPath()).catch(() => null));
      cx.notify();
    });
  }

  scan(cx) {
    if (this.scanning) return;
    this.scanning = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", [helper("scan.sh")], { timeout: 120000 });
        const pricing = JSON.parse((await readTextFile(`${appHome()}/mods/${MOD}/pricing.json`)) ?? "{}");
        setShared(K_REPORT, report(r.stdout, pricing.models ?? {}, Date.now()));
        if (r.code !== 0) this.error = r.stdout.split("\t").slice(1).join(" ").trim() || r.stderr.trim();
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.scanning = false;
      cx.notify();
    });
  }

  remember(key, value, cx) {
    this[key] = value;
    try {
      localStorage.setItem(`usage.${key}`, value);
    } catch {}
    cx.notify();
  }

  costText(b) {
    return b.unpriced && !b.cost ? "—" : `${b.unpriced ? "≥" : ""}${fmt.money(b.cost)}`;
  }

  // ----- building blocks -----

  segmented(id, options, chosen, onPick, t, size = 10.5) {
    return h_flex().id(id).p(2).gap(2).rounded(6).bg(t.raised).flex_none()
      .children(options.map((o) => {
        const on = chosen === o.id;
        return h_flex().id(`${id}-${o.id}`).gap(4).items_center().px(7).py(2).rounded(4).cursor_pointer()
          .text_size(size).text_color(on ? t.foreground : t.muted)
          .when(on, (e) => e.bg(t.popover).shadow_sm())
          .when(!on, (e) => e.hover((s) => s.text_color(t.foreground)))
          .on_click((_e, cx) => onPick(o.id, cx))
          .when(o.img != null, (e) => e.child(image(o.img).size(12)))
          .when(o.glyph != null, (e) => e.child(svg(o.glyph).size(12).text_color(on ? t.foreground : t.muted)))
          .child(div().whitespace_nowrap().child(o.label));
      }));
  }

  section(title, t, right = null) {
    return v_flex().gap(10).p(12).rounded(8).bg(t.surface).border(1).border_color(t.border)
      .when(title != null, (e) => e.child(h_flex().items_center().gap(8).min_h(20)
        .child(div().text_size(10).font_semibold().text_color(t.dim).child(title.toUpperCase()))
        .child(div().flex_1())
        .when(right != null, (r) => r.child(right))));
  }

  kpi(label, sum, sub, t) {
    return v_flex().flex_1().flex_basis(0).min_w(0).gap(2).px(10).py(8).rounded(8).bg(t.popover).border(1).border_color(t.border)
      .child(div().text_size(10).text_color(t.dim).truncate().child(label))
      .child(div().text_size(15).font_semibold().child(sum ? this.costText(sum) : "—"))
      .child(div().text_size(10).text_color(t.muted).truncate().child(sub));
  }

  kpiRows(cells, t) {
    const rows = [];
    for (let i = 0; i < cells.length; i += 3) {
      const row = h_flex().gap(8).items_stretch();
      for (let j = i; j < i + 3; j++) row.child(cells[j] ? this.kpi(...cells[j], t) : div().flex_1().flex_basis(0).px(10).border(1).border_color("#00000000"));
      rows.push(row);
    }
    return v_flex().gap(8).children(rows);
  }

  meter(fill, color, t, h = 5) {
    const pct = Math.max(0, Math.min(100, Math.round((fill ?? 0) * 100)));
    return h_flex().w_full().h(h).rounded(h / 2).bg(t.raised).overflow_hidden()
      .child(div().h(h).rounded(h / 2).w(`${pct}%`).bg(color));
  }

  providerTitle(g, t, size = 13) {
    return h_flex().gap(10).items_center()
      .child(div().size(22).rounded(6).bg(t.raised).flex().flex_none().items_center().justify_center()
        .child(image(g.icon).size(13)))
      .child(v_flex().min_w(0)
        .child(h_flex().gap(8).items_center()
          .child(div().text_size(size).font_semibold().child(g.name))
          .when(g.plan != null, (e) => e.child(div().px(5).rounded(4).bg(t.raised).text_size(10).text_color(t.accent).child(g.plan))))
        .child(div().text_size(10).truncate().text_color(g.failed ? levelColor("hot", t) : t.dim).child(g.status)));
  }

  limitRows(g, t) {
    const color = PROVIDER_COLOR[g.id];
    return v_flex().gap(10).children(g.rows.map((r) => v_flex().gap(4)
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(r.long))
        .child(div().flex_none().font_semibold().text_color(r.level === "ok" ? t.foreground : levelColor(r.level, t))
          .child(prefs().showRemaining ? r.detail : r.detail === "—" ? "—" : `${r.detail} used`))
        .child(div().flex_none().text_size(10).text_color(t.dim)
          .child(r.left === "" ? "" : r.left === "reset" ? "· reset" : `· resets in ${r.left}`)))
      .child(this.meter(r.fill, r.level === "ok" ? color : levelColor(r.level, t), t))));
  }

  // Columns on a light grid: values 0..max, `stack` gives each column's colored parts.
  columnsChart(id, cols, t, { height = 80, max, yLabel, stack, tooltip, marks = [] }) {
    const grid = [1, 0.5, 0].map((f) => div().absolute().left(0).top(Math.round((1 - f) * height)).w_full().h(1).bg(t.border));
    const lines = marks.map((m) => div().absolute().left(0).top(Math.round((1 - m.at) * height)).w_full().h(1).bg(m.color).opacity(0.55));
    return h_flex().gap(8).items_start()
      .child(v_flex().id(`${id}-plot`).flex_1().min_w(0).relative().h(height)
        .children(grid).children(lines)
        .child(h_flex().absolute().left(0).top(0).w_full().h(height).gap(3).items_end()
          .children(cols.map((c, i) => {
            const parts = stack(c);
            const total = parts.reduce((a, p) => a + p.value, 0);
            const col = v_flex().id(`${id}-c${i}`).flex_1().h_full().justify_end().tooltip(tooltip(c));
            if (!total) return col.child(div().h(2).rounded(2).bg(t.raised));
            const inner = v_flex().w_full().rounded_t(3).overflow_hidden();
            [...parts].reverse().forEach((p) => {
              if (p.value > 0) inner.child(div().w_full().h(Math.max(2, Math.round((p.value / max) * height))).bg(p.color));
            });
            return col.child(inner);
          }))))
      .child(v_flex().w(36).flex_none().h(height).justify_between().text_size(10).text_color(t.dim)
        .child(div().flex().justify_end().child(yLabel(max)))
        .child(div().flex().justify_end().child(yLabel(max / 2)))
        .child(div().flex().justify_end().child(yLabel(0))));
  }

  axis(labels, t) {
    return h_flex().pr(44).text_size(10).text_color(t.dim)
      .child(div().flex_1().child(labels[0] ?? ""))
      .child(div().flex_1().flex().justify_center().child(labels[1] ?? ""))
      .child(div().flex_1().flex().justify_end().child(labels[2] ?? ""));
  }

  legend(items, t) {
    return h_flex().gap(12).text_size(10).text_color(t.muted)
      .children(items.map((it) => h_flex().gap(6).items_center()
        .child(div().size(7).rounded(2).bg(it.color)).child(it.label)));
  }

  dailyChart(id, providers, rep, t) {
    const now = Date.now();
    const series = providers.map((p) => ({ ...p, days: S.daily(rep?.hours?.[p.id] ?? {}, now, 30) }));
    const days = series[0]?.days ?? [];
    const value = (d) => (this.metric === "cost" ? d.cost : d.tokens);
    const totals = days.map((_, i) => series.reduce((a, s) => a + value(s.days[i]), 0));
    const max = Math.max(...totals, 0) || 1;
    const label = (v) => (this.metric === "cost" ? fmt.money(v) : fmt.tokens(v));
    const cols = days.map((d, i) => ({ i, label: d.label }));
    const toggle = this.segmented(`${id}-metric`, [{ id: "cost", label: "Cost" }, { id: "tokens", label: "Tokens" }], this.metric,
      (v, cx) => this.remember("metric", v, cx), t, 10);
    return this.section(`Daily ${this.metric}, last 30 days`, t, toggle)
      .child(this.columnsChart(id, cols, t, {
        max,
        yLabel: (v) => (v ? label(v) : "0"),
        stack: (c) => series.map((s) => ({ value: value(s.days[c.i]), color: PROVIDER_COLOR[s.id] })),
        tooltip: (c) => `${c.label}: ${series.map((s) => `${s.name} ${this.costText(s.days[c.i])} · ${fmt.tokens(s.days[c.i].tokens)}`).join("  ·  ")}`,
      }))
      .child(this.axis([days[0]?.label, days[15]?.label, days[29]?.label], t))
      .when(series.length > 1, (e) => e.child(this.legend(series.map((s) => ({ label: s.name, color: PROVIDER_COLOR[s.id] })), t)));
  }

  historyChart(g, t) {
    const windows = (limitsOf()[g.id]?.windows ?? []).filter((w) => w.duration);
    if (!windows.length) return null;
    const chosen = windows.find((w) => w.id === this.historyWindow[g.id]) ?? windows[0];
    const short = chosen.duration <= 6 * 3600;
    const step = short ? 3600 : 86400;
    const count = short ? 48 : 30;
    const end = short ? Math.ceil(nowSec() / 3600) * 3600 : Math.floor(S.localMidnight(Date.now() + 86400000) / 1000);
    const cols = H.columns(this.history.series[`${g.id}:${chosen.id}`], end, step, count);
    const color = PROVIDER_COLOR[g.id];
    const when = (s) => {
      const d = new Date(s * 1000);
      return short ? `${S.dayLabel(s * 1000)} ${String(d.getHours()).padStart(2, "0")}:00` : S.dayLabel(s * 1000);
    };
    const picker = this.segmented(`hist-${g.id}`, windows.map((w) => ({ id: w.id, label: w.long })), chosen.id,
      (v, cx) => { this.historyWindow[g.id] = v; cx.notify(); }, t, 10);
    const recorded = cols.some((c) => c.value != null);
    return this.section(`${chosen.long} usage, last ${short ? "48 hours" : "30 days"}`, t, picker)
      .child(this.columnsChart(`hist-${g.id}-${chosen.id}`, cols, t, {
        height: 64,
        max: 100,
        yLabel: (v) => `${Math.round(v)}%`,
        stack: (c) => [{ value: c.value ?? 0, color: c.value == null ? t.raised : c.value >= 90 ? levelColor("hot", t) : c.value >= 70 ? levelColor("warn", t) : color }],
        tooltip: (c) => `${when(c.from)}: ${c.value == null ? "no reading" : `${c.value}% used (highest)`}`,
        marks: [{ at: 0.7, color: levelColor("warn", t) }, { at: 0.9, color: levelColor("hot", t) }],
      }))
      .child(this.axis([when(cols[0].from), when(cols[Math.floor(count / 2)].from), when(cols[count - 1].from)], t))
      .when(!recorded, (e) => e.child(div().text_size(10).text_color(t.dim)
        .child("No readings yet. Herdr records one whenever the limits change, so this fills in as you work.")));
  }

  table(title, rows, total, t) {
    return v_flex().gap(8)
      .child(h_flex().text_size(10).font_semibold().text_color(t.dim)
        .child(div().flex_1().child(title.toUpperCase()))
        .child(div().w(60).flex().justify_end().child("TOKENS"))
        .child(div().w(64).flex().justify_end().child("COST")))
      .children(rows.map((r) => v_flex().id(`row-${title}-${r.name}`).gap(4)
        .tooltip(`${r.requests} requests · ${r.sessions} sessions · in ${fmt.tokens(r.input)} · out ${fmt.tokens(r.output)} · cache read ${fmt.tokens(r.cacheRead)} · cache write ${fmt.tokens(r.cacheWrite)}`)
        .child(h_flex().items_center()
          .child(div().flex_1().min_w(0).truncate().child(r.name))
          .child(div().w(60).flex_none().flex().justify_end().text_color(t.muted).child(fmt.tokens(r.tokens)))
          .child(div().w(64).flex_none().flex().justify_end().font_semibold().child(this.costText(r))))
        .child(this.meter(total ? r.tokens / total : 0, t.input, t, 2))));
  }

  // ----- tabs -----

  header(t) {
    const tabs = [{ id: "overview", label: "Overview", glyph: icon("chart") }, ...PROVIDERS.map((p) => ({ id: p.id, label: p.name, img: p.icon }))];
    const rep = shared(K_REPORT);
    return h_flex().gap(12).items_center().px(14).pt(10).pb(9).border_b(1).border_color(t.border)
      .child(v_flex().min_w(0)
        .child(div().text_size(13).font_semibold().child("Usage"))
        .child(div().text_size(10).text_color(t.dim).truncate()
          .child(this.scanning ? "Scanning local logs…" : rep ? `Logs scanned ${fmt.ago(Math.floor(rep.at / 1000), nowSec())}` : "Not scanned yet")))
      .child(div().flex_1())
      .child(this.segmented("tabs", tabs, this.tab, (v, cx) => this.remember("tab", v, cx), t, 11))
      .child(this.iconButton("ul-rescan", "refresh", this.scanning ? "Scanning…" : "Rescan logs and refresh limits",
        (cx) => { setShared(K_ASK, Date.now()); this.scan(cx); }, t, !this.scanning))
      .child(this.iconButton("ul-close", "close", "Close", () => props()?.overlay && closeOverlay(props().overlay), t));
  }

  overviewTab(rep, t) {
    const now = Date.now();
    const all = {};
    for (const p of PROVIDERS) {
      for (const [h, v] of Object.entries(rep?.hours?.[p.id] ?? {})) {
        const b = (all[h] ??= [0, 0, 0]);
        b[0] += v[0];
        b[1] += v[1];
        b[2] += v[2] ?? 0;
      }
    }
    const tok = (s) => `${fmt.tokens(s.tokens)} tokens`;
    const cells = [
      ["Today", S.sumBetween(all, S.localMidnight(now))],
      ["Last 7 days", S.sumBetween(all, now - 7 * 86400000)],
      ["Last 30 days", S.sumBetween(all, now - 30 * 86400000)],
    ].map(([label, s]) => [label, s, tok(s)]);
    const body = v_flex().gap(12).child(this.kpiRows(cells, t));
    const groups = cardModel(limitsOf(), prefs(), nowSec(), shared(K_STATUSLINE));
    const cards = h_flex().gap(8).items_stretch();
    for (const g of groups) {
      const hours = rep?.hours?.[g.id] ?? {};
      const d = S.sumBetween(hours, S.localMidnight(now));
      const m = S.sumBetween(hours, now - 30 * 86400000);
      cards.child(v_flex().id(`ov-${g.id}`).flex_1().flex_basis(0).min_w(0).gap(10).p(12).rounded(8).bg(t.surface).border(1).border_color(t.border)
        .cursor_pointer().hover((s) => s.border_color(t.input))
        .on_click((_e, cx) => this.remember("tab", g.id, cx))
        .child(this.providerTitle(g, t, 12))
        .child(g.rows.length ? this.limitRows(g, t) : div().text_size(10).text_color(t.dim).child("No limits to show."))
        .child(div().flex_1())
        .child(h_flex().gap(8).pt(8).border_t(1).border_color(t.border)
          .child(v_flex().flex_1().child(div().text_size(10).text_color(t.dim).child("TODAY"))
            .child(div().font_semibold().child(this.costText(d))))
          .child(v_flex().flex_1().child(div().text_size(10).text_color(t.dim).child("30 DAYS"))
            .child(div().font_semibold().child(`${this.costText(m)} · ${fmt.tokens(m.tokens)}`)))));
    }
    return body.child(cards).child(this.dailyChart("daily-all", PROVIDERS, rep, t));
  }

  providerTab(id, rep, t) {
    const g = cardModel(limitsOf(), prefs(), nowSec(), shared(K_STATUSLINE)).find((c) => c.id === id);
    const limits = limitsOf()[id];
    const hours = rep?.hours?.[id] ?? {};
    const now = Date.now();
    const tok = (s) => `${fmt.tokens(s.tokens)} tokens`;
    const cells = [["Today", S.sumBetween(hours, S.localMidnight(now))]];
    for (const w of limits?.windows ?? []) {
      const from = S.windowStart(w);
      if (from != null && from <= now) cells.push([`This ${w.long.toLowerCase()} window`, S.sumBetween(hours, from), S.windowRange(w)]);
    }
    cells.push(["Last 7 days", S.sumBetween(hours, now - 7 * 86400000)], ["Last 30 days", S.sumBetween(hours, now - 30 * 86400000)]);
    const body = v_flex().gap(12)
      .child(this.section(null, t)
        .child(h_flex().items_center().child(this.providerTitle(g, t)))
        .when(g.rows.length > 0, (e) => e.child(this.limitRows(g, t))))
      .child(this.kpiRows(cells.map(([label, s, sub]) => [label, s, sub ?? tok(s)]), t))
      .child(this.dailyChart(`daily-${id}`, PROVIDERS.filter((p) => p.id === id), rep, t));
    const hist = this.historyChart(g, t);
    if (hist) body.child(hist);
    const range = rep?.ranges?.[this.range]?.find((p) => p.id === id);
    const picker = this.segmented(`range-${id}`, RANGES.map((r) => ({ id: r.id, label: r.label })), this.range,
      (v, cx) => this.remember("range", v, cx), t, 10);
    const breakdown = this.section("Breakdown", t, picker);
    if (range?.total.requests) {
      breakdown
        .child(div().text_size(10).text_color(t.dim)
          .child(`${range.total.requests} requests · ${range.total.sessions} sessions · in ${fmt.tokens(range.total.input)} · out ${fmt.tokens(range.total.output)} · cache read ${fmt.tokens(range.total.cacheRead)} · write ${fmt.tokens(range.total.cacheWrite)}`))
        .child(this.table("Models", range.models, range.total.tokens, t))
        .child(this.table("Agents", range.agents, range.total.tokens, t));
    } else {
      breakdown.child(div().text_size(10).text_color(t.dim).child("No usage in this range."));
    }
    return body.child(breakdown);
  }

  renderReport() {
    const t = theme();
    const rep = shared(K_REPORT);
    const content = this.tab === "overview" ? this.overviewTab(rep, t) : this.providerTab(this.tab, rep, t);
    return v_flex().id("root").size_full().bg(t.popover).text_size(11).text_color(t.foreground)
      .child(this.header(t))
      .child(v_flex().id("ul-scroll").flex_1().min_h(0).overflow_y_scrollbar().px(14).py(12).gap(12)
        .child(content)
        .when(Boolean(rep?.warnings?.length), (e) => e.child(div().text_size(10).text_color(levelColor("warn", t)).child(rep.warnings.join(" · "))))
        .when(this.error != null, (e) => e.child(div().text_size(10).text_color(levelColor("hot", t)).child(this.error)))
        .child(div().text_size(10).text_color(t.dim)
          .child("Estimated from local Claude Code and Codex logs at API list prices (mods/usage/pricing.json), not what a subscription is billed. "
            + "Windows count whole hours. — means no price; ≥ includes unpriced tokens.")));
  }

  render(cx) {
    if (this.report) return this.renderReport();
    const terminal = focused()?.terminal ?? null;
    if (terminal !== this.terminal) {
      this.terminal = terminal;
      this.session = null;
      this.readSession(cx);
    }
    const ask = shared(K_ASK) ?? 0;
    if (ask !== this.seenAsk) {
      this.seenAsk = ask;
      this.refreshAll(cx);
    }
    return this.renderBar();
  }
}
