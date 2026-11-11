// Add a space: pick a host (this computer or a connected machine), then browse its folders,
// clone a Git repo, or create an empty project there. Opened by the Spaces sidebar's +.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle, Popup } from "gpui-base";
import { theme, props, closeOverlay, openOverlay, run, exec, hc, home, machines, readTextFile, shared, setShared } from "herdr";

const LOCATIONS = "add-space.locations"; // { [host or ""]: parent folder for clones/new projects }
const MAX_ROWS = 400;
const icon = (name, size = 16) => svg(`mods/workspace-chrome/${name}.svg`).size(size).flex_none();
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const key = (m) => m ?? "";
// owner/repo or a GitHub URL (cloned with gh), else any git URL; and the folder it lands in.
function source(text) {
  const t = text.trim().replace(/\/+$/, "");
  const m = /^(?:https?:\/\/github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(t);
  if (m) return { gh: `${m[1]}/${m[2]}`, name: m[2] };
  return { url: t, name: t.split(/[/:]/).pop()?.replace(/\.git$/, "") ?? "" };
}
// Lists a folder's subfolders on the host: first line its real path, then one name per line.
const LIST = 'cd -- "$1" 2>/dev/null || exit 3; pwd; for f in .* *; do [ "$f" = . ] || [ "$f" = .. ] || { [ -d "$f" ] && printf "%s\\n" "$f"; }; done; exit 0';

const ACTIONS = [
  { id: "browse", icon: "folder", title: "Browse folder", hint: "Existing Git repository or folder on this host" },
  { id: "clone", icon: "git-branch", title: "Clone from URL", hint: "Clone a remote Git repository" },
  { id: "create", icon: "plus", title: "Create new project", hint: "Start from an empty folder" },
];

export default class AddSpace extends View {
  init(_props, cx) {
    this.host = props()?.machine ?? null; // null: this computer
    this.homes = { "": home() };
    this.step = "start"; this.at = 0; this.error = ""; this.busy = false; this.hostOpen = false;
    this.dir = null; this.dirs = []; this.loading = false;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.scroll = ScrollHandle.new();
    this.hostFocus = cx.focus_handle(); this.hostAt = 0; this.ssh = null; this.connecting = null;
    const field = (placeholder, onSubmit) => {
      const s = InputState.new({ placeholder });
      s.on("change", (_e, cx) => { this.error = ""; if (this.step === "browse") this.at = 0; cx.notify(); });
      s.on("submit", (_e, cx) => onSubmit(cx));
      return s;
    };
    this.filter = field("Type to filter or enter a path…", (cx) => this.submitFilter(cx));
    this.url = field("https://github.com/owner/repo, owner/repo, or git@…", (cx) => this.clone(cx));
    this.name = field("my-project", (cx) => this.create(cx));
    this.location = field("Where projects go, e.g. ~/Projects", (cx) => (this.step === "clone" ? this.clone(cx) : this.create(cx)));
    this.syncLocation();
  }

  close() { closeOverlay(props()?.overlay); }

  on() { return this.host ?? undefined; }

  hostReady(m) { return m === null || machines().find((x) => x.name === m)?.layout === "ready"; }

  async hostHome() {
    const k = key(this.host);
    if (!this.homes[k]) {
      const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.on() });
      if (r.code !== 0 || !r.stdout) throw new Error(`Can't reach ${this.host}: ${(r.stderr || "no home folder").trim()}`);
      this.homes[k] = r.stdout;
    }
    return this.homes[k];
  }

  // ~ shown for the host's home, expanded back before use.
  tilde(p) { const h = this.homes[key(this.host)]; return h && p?.startsWith(h) ? `~${p.slice(h.length)}` : p ?? ""; }
  expand(p) { const h = this.homes[key(this.host)] ?? "~"; return p === "~" ? h : p.startsWith("~/") ? h + p.slice(1) : p; }

  syncLocation() {
    const saved = (shared(LOCATIONS) ?? {})[key(this.host)];
    this.location.set_value(saved ? this.tilde(saved) : "~/Projects");
  }

  pickHost(m, cx) {
    this.hostOpen = false;
    if (m === this.host) return cx.notify();
    this.host = m; this.error = ""; this.dir = null; this.dirs = [];
    this.syncLocation();
    if (this.step === "browse") this.load(null, cx);
    cx.notify();
  }

  go(id, cx) {
    if (!this.hostReady(this.host)) { this.error = `${this.host} isn't connected.`; return cx.notify(); }
    this.error = ""; this.step = id; this.at = 0;
    if (id === "browse") { this.filter.set_value(""); this.filter.focus(); this.load(this.dir, cx); }
    else (id === "clone" ? this.url : this.name).focus();
    cx.notify();
  }

  back(cx) { this.step = "start"; this.error = ""; this.busy = false; this.handle.focus(); cx.notify(); }

  // ---- browse ----

  load(dir, cx) {
    this.loading = true; cx.notify();
    const host = this.host;
    cx.spawn(async (cx) => {
      try {
        const target = dir ?? (await this.hostHome());
        const r = await exec("sh", ["-c", LIST, "sh", target], { on: host ?? undefined });
        if (host !== this.host) return;
        if (r.code === 3) throw new Error(`Can't open ${this.tilde(target)}.`);
        if (r.code !== 0) throw new Error((r.stderr || "Couldn't list it").trim());
        const [real, ...names] = r.stdout.split("\n").filter(Boolean);
        this.dir = real;
        // Regular folders first, hidden ones after; each alphabetical.
        const rank = (n) => `${n.startsWith(".") ? 1 : 0}${n.toLowerCase()}`;
        this.dirs = names.sort((a, b) => rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0);
        this.at = 0; this.filter.set_value(""); this.error = "";
      } catch (e) { this.error = String(e?.message ?? e); }
      this.loading = false;
      this.scroll.scroll_to_item(0);
      cx.notify();
    });
  }

  join(name) { return this.dir === "/" ? `/${name}` : `${this.dir}/${name}`; }
  up(cx) { if (this.dir && this.dir !== "/") this.load(this.dir.replace(/\/[^/]+$/, "") || "/", cx); }

  shown() {
    const f = this.filter.value().trim().toLowerCase();
    if (f.startsWith("/") || f.startsWith("~")) return [];
    return (f ? this.dirs.filter((d) => d.toLowerCase().includes(f)) : this.dirs).slice(0, MAX_ROWS);
  }

  submitFilter(cx) {
    const f = this.filter.value().trim();
    if (f.startsWith("/") || f.startsWith("~")) return this.load(this.expand(f), cx);
    const pick = this.shown()[this.at];
    if (pick) this.load(this.join(pick), cx);
  }

  open(folder) {
    this.close();
    run("space.new", { folder, machine: key(this.host) });
  }

  // ---- clone / create (on the host) ----

  async parent() {
    await this.hostHome();
    const dir = this.expand(this.location.value().trim().replace(/\/+$/, ""));
    if (!dir) throw new Error("Choose where projects go first.");
    const r = await exec("mkdir", ["-p", dir], { on: this.on() }).catch(() => null);
    if (r?.code !== 0) throw new Error(`Can't use ${this.tilde(dir)}: ${(r?.stderr ?? "").trim() || "not writable"}`);
    setShared(LOCATIONS, { ...(shared(LOCATIONS) ?? {}), [key(this.host)]: dir });
    return dir;
  }

  async free(path) {
    const r = await exec("test", ["-e", path], { on: this.on() }).catch(() => null);
    return r?.code !== 0;
  }

  // The clone runs in the new space's terminal: progress shows, no exec time limit,
  // and it ends in a shell inside the repo.
  clone(cx) {
    if (this.busy) return;
    const src = source(this.url.value());
    if (!src.name || (!src.gh && !src.url)) { this.error = "Enter a Git URL or owner/repo."; return cx.notify(); }
    this.busy = true; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const dir = await this.parent(), dest = `${dir}/${src.name}`;
        if (!(await this.free(dest))) throw new Error(`${this.tilde(dest)} already exists. Use Browse folder to open it.`);
        const cmd = src.gh ? `gh repo clone ${q(src.gh)} ${q(src.name)}` : `git clone ${q(src.url)} ${q(src.name)}`;
        this.close();
        run("space.new", { folder: dir, machine: key(this.host), argv: ["sh", "-c", `${cmd} && cd ${q(src.name)}; exec "\${SHELL:-sh}" -l`] });
      } catch (e) { this.error = String(e?.message ?? e); this.busy = false; cx.notify(); }
    });
  }

  create(cx) {
    if (this.busy) return;
    const name = this.name.value().trim();
    if (!name || /[/\\]/.test(name)) { this.error = "Enter a folder name (no slashes)."; return cx.notify(); }
    this.busy = true; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const dir = await this.parent(), dest = `${dir}/${name}`;
        if (!(await this.free(dest))) throw new Error(`${this.tilde(dest)} already exists. Use Browse folder to open it.`);
        const r = await exec("sh", ["-c", 'mkdir "$1" && git -C "$1" init -q', "sh", dest], { on: this.on() });
        if (r.code !== 0) throw new Error((r.stderr || "Couldn't create it").trim());
        this.open(dest);
      } catch (e) { this.error = String(e?.message ?? e); this.busy = false; cx.notify(); }
    });
  }

  key(e, cx) {
    const n = this.step === "start" ? ACTIONS.length : this.step === "browse" ? this.shown().length : 0;
    if (!n || (e.key !== "down" && e.key !== "up" && !(e.key === "enter" && this.step === "start"))) {
      if (this.step === "browse" && e.keystroke === "cmd-enter" && this.dir) { cx.stop_propagation(); this.open(this.dir); }
      return;
    }
    if (e.key === "enter") return this.go(ACTIONS[this.at].id, cx);
    this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n;
    if (this.step === "browse") this.scroll.scroll_to_item(this.at);
    cx.stop_propagation();
    cx.notify();
  }

  // ---- drawing ----
  // Dense desktop scale (Herdr zoom multiplies it): type 11/12/13/14, spacing on a 4px grid,
  // controls 26–28px, one solid primary action per step.

  title(t, text, sub) {
    return v_flex().gap(2).pr(24)
      .when(this.step !== "start", (el) => el.child(h_flex().id("as-back").mb(6).gap(2).items_center().text_size(11.5).text_color(t.muted)
        .cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.back(cx))
        .child(icon("chevron-left", 11)).child("Back")))
      .child(div().text_size(14).font_semibold().text_color(t.foreground).child(text))
      .when(Boolean(sub), (el) => el.child(div().text_size(12).text_color(t.muted).child(sub)));
  }

  closeButton(t) {
    return div().id("as-close").absolute().top(12).right(12).size(22).flex().items_center().justify_center().rounded(5)
      .text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip("Close (Esc)").on_click(() => this.close()).child(icon("x", 12));
  }

  input(t, id, state, lead) {
    return h_flex().id(id).h(28).px(8).gap(6).items_center().rounded(6).border_1().border_color(t.input).bg(t.background)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .when(Boolean(lead), (el) => el.child(div().text_color(t.dim).child(icon(lead, 12))))
      .child(Input.new(state).flex_1().h_full().text_size(12.5).text_color(t.foreground));
  }

  label(t, text) { return div().text_size(11.5).font_medium().text_color(t.muted).child(text); }

  button(t, id, text, onClick, { solid = false, enabled = true } = {}) {
    return h_flex().id(id).h(28).px(12).flex_none().items_center().rounded(6).text_size(12.5).font_medium().border_1()
      .bg(solid ? t.foreground : t.raised).border_color(solid ? t.foreground : t.border).text_color(solid ? t.background : t.foreground)
      .when(!enabled, (el) => el.opacity(0.45))
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => onClick(cx)))
      .child(text);
  }

  footer(t, primary) {
    return h_flex().pt(4).justify_end().gap(6).child(this.button(t, "as-cancel", "Cancel", () => this.close())).child(primary);
  }

  errorLine(t) {
    return div().text_size(12).text_color(t.blocked).child(this.error);
  }

  // Named Host entries in ~/.ssh/config not yet added as machines.
  // ponytail: top-level file only, no Include; machine-add (Add remote host) covers the rest.
  loadSsh(cx) {
    cx.spawn(async (cx) => {
      const [text, ls] = await Promise.all([readTextFile(`${home()}/.ssh/config`).catch(() => ""), hc(["machine", "ls", "--json"]).catch(() => null)]);
      let added = [];
      try { added = JSON.parse(ls?.stdout || "{}").machines ?? []; } catch {}
      const taken = new Set(added.flatMap((m) => [m.name, m.target, m.host]));
      this.ssh = [...new Set((text ?? "").split("\n").flatMap((l) => /^\s*host\s+(.+)$/i.exec(l)?.[1].split(/\s+/).slice(0, 1) ?? []))]
        .filter((h) => h && !/[*?!]/.test(h) && !taken.has(h));
      cx.notify();
    });
  }

  toggleHosts(cx) {
    if (!this.hostOpen && Date.now() - (this.closedAt ?? 0) < 300) return; // the press that just closed it
    this.hostOpen = !this.hostOpen; this.hostAt = 0;
    if (this.hostOpen) { this.loadSsh(cx); this.hostFocus.focus(); } else this.handle.focus();
    cx.notify();
  }

  addMachine(alias, cx) {
    if (this.connecting) return;
    this.connecting = alias; this.error = ""; cx.notify();
    cx.spawn(async (cx) => {
      const r = await hc(["machine", "add", alias, "--json"]).catch((e) => ({ code: 1, stderr: String(e), stdout: "" }));
      this.connecting = null;
      if (r.code === 0) {
        let name = alias;
        try { name = JSON.parse(r.stdout).name ?? alias; } catch {}
        this.ssh = this.ssh.filter((h) => h !== alias);
        this.pickHost(name, cx);
      } else {
        // Passwords, host keys, missing herdr-core: machine-add explains what to run.
        this.hostOpen = false;
        this.error = `Couldn't connect ${alias}. Use Add remote host for the steps it needs.`;
        cx.notify();
      }
    });
  }

  hostEntries() {
    const mine = machines().map((m) => m.name).filter((n) => n !== null);
    return [
      { id: "local", m: null, title: "This computer", sub: "Local" },
      ...mine.map((m) => ({ id: m, m, title: m, sub: this.hostReady(m) ? "Connected" : "Offline" })),
      ...(this.ssh ?? []).map((h) => ({ id: `ssh-${h}`, ssh: h, title: h, sub: "SSH" })),
      { id: "add", title: "Add remote host…", act: () => openOverlay({ mod: "machine-add", kind: "dialog", width: 560 }) },
    ];
  }

  activateHost(e, cx) {
    if (e.act) { this.hostOpen = false; this.handle.focus(); cx.notify(); return e.act(); }
    if (e.ssh) return this.addMachine(e.ssh, cx);
    this.handle.focus();
    this.pickHost(e.m, cx);
  }

  hostKey(ev, cx) {
    const list = this.hostEntries();
    if (ev.key === "down" || ev.key === "up") this.hostAt = (this.hostAt + (ev.key === "down" ? 1 : list.length - 1)) % list.length;
    else if (ev.key === "enter") this.activateHost(list[this.hostAt], cx);
    else if (ev.key === "escape") { this.hostOpen = false; this.handle.focus(); }
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // One line per host: name, then a quiet status on the right (Connect for ssh-config hosts).
  hostPicker(t) {
    const ready = this.hostReady(this.host);
    const trigger = h_flex().id("as-host").h(26).pl(8).pr(6).gap(6).items_center().rounded(6).border_1()
      .border_color(this.hostOpen ? t.input : t.border).bg(this.hostOpen ? t.hover : t.background)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.toggleHosts(cx))
      .child(div().size(6).rounded(3).bg(ready ? t.ansi2 : t.blocked))
      .child(div().text_size(12.5).font_medium().text_color(t.foreground).child(this.host ?? "This computer"))
      .child(div().text_size(11.5).text_color(t.muted).child(ready ? "Connected" : "Offline"))
      .child(div().text_color(t.dim).child(svg("mods/add-space/chevrons.svg").size(11)));
    const item = (e, i) => {
      const on = i === this.hostAt, chosen = !e.act && !e.ssh && e.m === this.host;
      const right = e.ssh ? (this.connecting === e.ssh ? "Connecting…" : on ? "Connect" : e.sub) : e.sub;
      return h_flex().id(`as-host-${e.id}`).h(26).px(6).gap(6).items_center().rounded(5).cursor_pointer()
        .when(on, (el) => el.bg(t.hover))
        .on_hover((h, cx) => { if (h && this.hostAt !== i) { this.hostAt = i; cx.notify(); } })
        .on_click((_e, cx) => this.activateHost(e, cx))
        .child(div().w(12).flex_none().text_color(t.foreground).when(chosen || !!e.act, (el) => el.child(icon(e.act ? "plus" : "check", 11))))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(e.ssh ? t.muted : t.foreground).child(e.title))
        .when(Boolean(right), (el) => el.child(div().flex_none().text_size(11).text_color(e.ssh && on ? t.foreground : t.dim).child(right)));
    };
    const list = this.hostEntries();
    const menu = v_flex().id("as-hosts").w(240).max_h(220).mt(4).p(4).rounded(8).border_1().border_color(t.input)
      .bg(t.raised).shadow_lg().overflow_y_scrollbar()
      .track_focus(this.hostFocus).on_key_down((e, cx) => this.hostKey(e, cx))
      .on_mouse_down_out((_e, cx) => { this.hostOpen = false; this.closedAt = Date.now(); this.handle.focus(); cx.notify(); })
      .children(list.slice(0, -1).map((e, i) => item(e, i)))
      .child(div().h(1).mx(2).my(4).bg(t.border)).child(item(list.at(-1), list.length - 1));
    return h_flex().gap(8).items_center()
      .child(div().text_size(12).text_color(t.muted).child("Host"))
      .child(Popup.new("as-host-popup", trigger).anchor("top_left").when(this.hostOpen, (el) => el.content(menu)));
  }

  row(t, a, i, last) {
    const on = i === this.at, ok = this.hostReady(this.host);
    return h_flex().id(`as-${a.id}`).px(12).py(8).gap(10).items_center().cursor_pointer()
      .bg(on ? t.hover : t.background).when(!last, (el) => el.border_b_1().border_color(t.border))
      .when(!ok, (el) => el.opacity(0.45))
      .on_hover((h, cx) => { if (h && this.at !== i) { this.at = i; cx.notify(); } })
      .on_click((_e, cx) => this.go(a.id, cx))
      .child(div().size(26).flex_none().flex().items_center().justify_center().rounded(6).bg(t.raised).text_color(t.foreground).child(icon(a.icon, 13)))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(12.5).font_medium().text_color(t.foreground).child(a.title))
        .child(div().truncate().text_size(11.5).text_color(t.muted).child(a.hint)))
      .when(on, (el) => el.child(div().text_size(11).text_color(t.dim).child("↵")));
  }

  start(t) {
    const card = (rows) => v_flex().rounded(8).border_1().border_color(t.border).overflow_hidden().children(rows);
    return v_flex().gap(12)
      .child(this.title(t, "Add a space"))
      .child(this.hostPicker(t))
      .child(card([this.row(t, ACTIONS[0], 0, true)]))
      .child(v_flex().gap(6)
        .child(div().text_size(10.5).font_semibold().text_color(t.dim).child("OTHER WAYS TO ADD"))
        .child(card(ACTIONS.slice(1).map((a, i) => this.row(t, a, i + 1, i === ACTIONS.length - 2)))))
      .when(Boolean(this.error), (el) => el.child(this.errorLine(t)));
  }

  crumbs(t) {
    const parts = (this.dir ?? "").split("/").filter(Boolean);
    const nav = (id, tip, child, onClick) => div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(onClick).child(child);
    const crumb = (label, path, last) => div().id(`as-crumb-${path}`).flex_none().px(2).text_size(12)
      .text_color(last ? t.foreground : t.muted).when(last, (el) => el.font_medium())
      .cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.load(path, cx)).child(label);
    const sep = () => div().flex_none().text_size(11).text_color(t.dim).child("/");
    // Long paths keep their tail: the folders nearest the current one.
    const shownParts = parts.length > 4 ? parts.slice(-4) : parts, skip = parts.length - shownParts.length;
    const items = [crumb(skip ? "…" : "/", skip ? `/${parts.slice(0, skip).join("/")}` : "/", parts.length === 0)];
    shownParts.forEach((p, i) => { if (i || skip) items.push(sep()); items.push(crumb(p, `/${parts.slice(0, skip + i + 1).join("/")}`, i === shownParts.length - 1)); });
    return h_flex().gap(2).items_center().overflow_hidden()
      .child(nav("as-up", "Parent folder", icon("chevron-left", 12), (_e, cx) => this.up(cx)))
      .child(nav("as-home", "Home", icon("monitor", 12), (_e, cx) => cx.spawn(async (cx) => this.load(await this.hostHome(), cx))))
      .child(div().w(1).h(14).mx(4).bg(t.border))
      .children(items);
  }

  browse(t) {
    const list = this.shown();
    const note = (text) => div().p(12).text_size(12).text_color(t.dim).child(text);
    const body = this.loading ? note("Loading…")
      : list.length === 0 ? note(this.filter.value().trim() ? "Press Enter to go to that path." : "No folders here.")
      : v_flex().size_full().p(4).overflow_y_scrollbar().track_scroll(this.scroll).children(list.map((d, i) => {
        const on = i === this.at;
        return h_flex().id(`as-dir-${d}`).h(26).flex_none().px(8).gap(8).items_center().rounded(5).cursor_pointer()
          .when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.load(this.join(d), cx))
          .child(div().text_color(t.muted).child(icon("folder", 12)))
          .child(div().flex_1().truncate().text_size(12.5).text_color(t.foreground).child(d))
          .child(div().text_color(t.dim).child(icon("chevron-right", 10)));
      }));
    return v_flex().gap(10)
      .child(this.title(t, "Browse folder", `On ${this.host ?? "this computer"}. Open folders, then choose the one to use.`))
      .child(this.crumbs(t))
      .child(this.input(t, "as-filter", this.filter, "search"))
      .child(div().h(240).rounded(8).border_1().border_color(t.border).bg(t.background).overflow_hidden().child(body))
      .when(Boolean(this.error), (el) => el.child(this.errorLine(t)))
      .child(h_flex().pt(4).gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(this.tilde(this.dir) || "…"))
        .child(this.button(t, "as-cancel", "Cancel", () => this.close()))
        .child(this.button(t, "as-select", "Open here", () => this.open(this.dir), { solid: true, enabled: Boolean(this.dir) && !this.loading })));
  }

  field(t, label, child, help) {
    return v_flex().gap(4).child(this.label(t, label)).child(child)
      .when(Boolean(help), (el) => el.child(div().text_size(11).text_color(t.dim).child(help)));
  }

  form(t, title, sub, field, preview, action, busyText, run) {
    return v_flex().gap(12)
      .child(this.title(t, title, sub))
      .child(field)
      .child(this.field(t, `Location on ${this.host ?? "this computer"}`, this.input(t, "as-location", this.location), preview || "Remembered per host."))
      .when(Boolean(this.error), (el) => el.child(this.errorLine(t)))
      .child(this.footer(t, this.button(t, "as-go", this.busy ? busyText : action, run, { solid: true, enabled: !this.busy })));
  }

  render() {
    const t = theme();
    const loc = this.location.value().trim().replace(/\/+$/, "");
    let content;
    if (this.step === "browse") content = this.browse(t);
    else if (this.step === "clone") {
      const src = source(this.url.value());
      content = this.form(t, "Clone from URL", "Clones into a new space.",
        this.field(t, "Git URL", this.input(t, "as-url", this.url)),
        src.name && loc ? `→ ${loc}/${src.name}` : "", "Clone", "Cloning…", (cx) => this.clone(cx));
    } else if (this.step === "create") {
      const name = this.name.value().trim();
      content = this.form(t, "Create new project", "An empty folder with a fresh Git repository.",
        this.field(t, "Name", this.input(t, "as-name", this.name)),
        name && loc ? `→ ${loc}/${name}` : "", "Create", "Creating…", (cx) => this.create(cx));
    } else content = this.start(t);
    return v_flex().id("add-space").relative().track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().p(16).bg(t.popover).text_size(12.5)
      .child(content)
      .child(this.closeButton(t));
  }
}
