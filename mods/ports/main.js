// Listening TCP ports on this machine, grouped by space. A port belongs to a space when its process
// was started from one of that space's Herdr terminals (HC_TERMINAL_ID in its environment), else when
// it runs inside the space's folder. Only Herdr-started ports can be killed; the rest are view-only.
// Opened with `mod.open ports` (cmd-alt-p). Only processes lsof can see (yours) are listed.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, spaces, panes, terminals, home, theme, settings, props, closeOverlay, notify } from "herdr";

const ICON = "mods/workspace-chrome";
const LIST_MAX = 440; // px at zoom 1; past this the list scrolls

// lsof -F output: "p<pid>", "c<command>", "n<addr:port>" lines, one process block at a time.
function parseListeners(text) {
	const rows = new Map();
	let pid = 0;
	let command = "";
	for (const line of text.split("\n")) {
		const kind = line[0];
		const value = line.slice(1);
		if (kind === "p") pid = Number(value);
		else if (kind === "c") command = value;
		else if (kind === "n") {
			const port = Number(value.slice(value.lastIndexOf(":") + 1));
			const key = `${pid}:${port}`;
			if (!rows.has(key)) rows.set(key, { pid, port, command, address: value.replace(/^\*/, "0.0.0.0") });
		}
	}
	return [...rows.values()].sort((a, b) => a.port - b.port);
}

function parseCwds(text) {
	const cwd = {};
	let pid = 0;
	for (const line of text.split("\n")) {
		if (line[0] === "p") pid = Number(line.slice(1));
		else if (line[0] === "n") cwd[pid] = line.slice(1);
	}
	return cwd;
}

// `/bin/ps -E` appends each process's environment to its command line. Herdr terminals export
// HC_TERMINAL_ID, and children inherit it even after nohup or disown.
// ponytail: a command line literally containing "HC_TERMINAL_ID=" would be misread; fine for a viewer.
function parseOrigins(text) {
	const origin = {};
	for (const line of text.split("\n")) {
		const m = line.match(/^\s*(\d+)\s.*?\bHC_TERMINAL_ID=(\S+)/);
		if (m) origin[Number(m[1])] = m[2];
	}
	return origin;
}

// A terminal's space: its herdr.space label, else the space of the tab its pane is in.
function spaceOfTerminal(address) {
	const term = terminals().find((x) => x.address === address);
	const label = term?.labels?.["herdr.space"];
	if (label) return label;
	const pane = panes().find((p) => p.terminal === address);
	return pane && spaces().find((s) => s.tabs.some((t) => t.id === pane.tab))?.id;
}

// Each local space's folders: its own and its terminals' live ones. "/" and home would claim everything.
function spaceRoots() {
	const skip = new Set(["/", home()]);
	return spaces().filter((s) => !s.machine).map((s) => {
		const tabs = new Set(s.tabs.map((t) => t.id));
		const dirs = [s.folder, ...panes().filter((p) => tabs.has(p.tab)).map((p) => p.cwd)];
		return { space: s, roots: [...new Set(dirs)].filter((d) => d && !skip.has(d)) };
	});
}

const inside = (dir, root) => dir === root || dir?.startsWith(root + "/");

export default class Ports extends View {
	init(_props, cx) {
		this.ports = [];
		this.cwd = {};
		this.origin = {}; // pid -> Herdr terminal address it was started from
		this.error = null;
		this.externalOpen = false;
		this.scope = "all"; // "all", a space id, or "external"
		this.confirming = null; // `${pid}:${port}` awaiting kill confirmation
		this.filter = "";
		this.input = InputState.new({ placeholder: "Filter port, process, pid…" });
		this.input.on("change", (_e, cx) => { this.filter = this.input.value(); cx.notify(); });
		this.input.focus();
		cx.timer.after(600, () => this.input.focus());
		this.handle = cx.focus_handle();
		this.refresh(cx);
		cx.timer.every(3000, (cx) => this.refresh(cx));
	}

	refresh(cx) {
		cx.spawn(async (cx) => {
			try {
				const r = await exec("lsof", ["-nP", "+c", "0", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]);
				// lsof exits 1 when nothing listens.
				this.ports = parseListeners(r.stdout);
				this.error = r.code > 1 ? r.stderr.trim() : null;
				const pids = [...new Set(this.ports.map((p) => p.pid))];
				if (pids.length) {
					const [c, e] = await Promise.all([
						exec("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-F", "pn"]),
						exec("/bin/ps", ["-E", "-ww", "-o", "pid=,command=", "-p", pids.join(",")]),
					]);
					this.cwd = parseCwds(c.stdout);
					this.origin = parseOrigins(e.stdout);
				}
			} catch (e) {
				this.error = String(e);
			}
			cx.notify();
		});
	}

	kill(row, cx) {
		cx.spawn(async (cx) => {
			const r = await exec("kill", [String(row.pid)]).catch((e) => ({ code: 1, stderr: String(e) }));
			if (r.code !== 0) notify({ title: `Couldn't kill ${row.command} (${row.pid})`, body: r.stderr.trim(), level: "error" });
			else notify({ title: `Killed ${row.command} on :${row.port}`, level: "success", timeout: 3000 });
			this.refresh(cx);
		});
	}

	iconButton(id, icon, t, action, danger = false) {
		return div().id(id).p(4).rounded(5).text_color(t.muted)
			.hover((s) => s.bg(t.hover).text_color(danger ? t.blocked : t.foreground))
			.on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
			.child(svg(icon.includes("/") ? icon : `${ICON}/${icon}.svg`).size(14));
	}

	// killable: started from a Herdr terminal. Ports only matched by folder, and other apps'
	// ports (Postgres, Discord...), are view-only.
	portRow(row, t, mono, card) {
		const terminal = this.origin[row.pid];
		const killable = !!terminal;
		const url = `http://localhost:${row.port}`;
		const key = `${row.pid}:${row.port}`;
		const confirming = this.confirming === key;
		const pill = (id, label, bg, fg, action) => div().id(id).px(10).py(3).rounded(5).bg(bg).text_color(fg).text_size(11.5)
			.hover((s) => s.opacity(0.85))
			.on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
			.child(label);
		return h_flex().id(`port-${key}`).px(12).py(8).gap(12).items_start()
			.when(card, (el) => el.mx(8).rounded(8).bg(t.raised))
			.when(confirming, (el) => el.border_1().border_color(t.blocked))
			.hover((s) => s.bg(t.hover))
			.child(div().w(64).flex_none().font_family(mono).font_semibold().text_color(t.foreground).child(String(row.port)))
			.child(v_flex().flex_1().min_w(0).gap(2)
				.child(div().truncate().text_color(t.foreground).child(row.command || "Unknown process"))
				.child(div().truncate().text_size(11).text_color(confirming ? t.blocked : t.dim)
					.child(confirming ? `Kill pid ${row.pid}? Every port it holds closes.`
						: `${row.address} · pid ${row.pid} · ${terminal ? `from ${terminal}` : "outside Herdr"}`)))
			.when(confirming, (el) => el.child(h_flex().gap(6).flex_none()
				.child(pill(`cancel-${key}`, "Cancel", t.hover, t.foreground, (cx) => { this.confirming = null; cx.notify(); }))
				.child(pill(`confirm-${key}`, "Kill", t.blocked, t.background, (cx) => { this.confirming = null; this.kill(row, cx); }))))
			.when(!confirming, (el) => el.child(h_flex().gap(2).flex_none()
				.child(this.iconButton(`open-${key}`, "monitor", t, (cx) => cx.open_url(url)))
				.child(this.iconButton(`copy-${key}`, "file-text", t, (cx) => {
					cx.write_to_clipboard(url);
					notify({ title: `Copied ${url}`, timeout: 2000 });
				}))
				.when(killable, (el) => el.child(this.iconButton(`kill-${key}`, "mods/ports/trash.svg", t, (cx) => { this.confirming = key; cx.notify(); }, true)))));
	}

	render(cx) {
		const t = theme();
		const mono = settings().font_family || "JetBrains Mono";
		const roots = spaceRoots();
		const spaceOf = (p) => {
			const term = this.origin[p.pid];
			if (term) return spaceOfTerminal(term);
			return roots.find(({ roots }) => roots.some((r) => inside(this.cwd[p.pid], r)))?.space.id;
		};
		const owner = new Map(this.ports.map((p) => [p, spaceOf(p)]));
		const allGroups = spaces().filter((s) => !s.machine)
			.map((space) => ({ space, rows: this.ports.filter((p) => owner.get(p) === space.id) }))
			.filter((g) => g.rows.length);
		const allExternal = this.ports.filter((p) => !allGroups.some((g) => g.space.id === owner.get(p)));
		if (this.scope !== "all" && this.scope !== "external" && !allGroups.some((g) => g.space.id === this.scope)) this.scope = "all";

		const f = this.filter.trim().toLowerCase();
		const match = (p) => !f || `${p.port} ${p.command} ${p.pid} ${p.address}`.toLowerCase().includes(f);
		const groups = allGroups
			.filter((g) => this.scope === "all" || this.scope === g.space.id)
			.map((g) => ({ space: g.space, rows: g.rows.filter(match) }))
			.filter((g) => g.rows.length);
		const external = this.scope === "all" || this.scope === "external" ? allExternal.filter(match) : [];
		const shown = groups.reduce((n, g) => n + g.rows.length, 0) + external.length;
		const contentH = (this.contentH ?? 0) / (settings().zoom || 1);
		const listH = Math.max(40, Math.min(LIST_MAX, contentH));
		// Folded by default; shown when the External chip is picked or a filter is typed, so matches aren't hidden.
		const externalOpen = this.externalOpen || this.scope === "external" || !!f;

		const header = (label, count, id, onClick) => h_flex().id(id).px(12).py(8).gap(8).items_center()
			.text_size(11).font_semibold().text_color(t.muted)
			.when(!!onClick, (el) => el.hover((s) => s.text_color(t.foreground)).on_click(onClick))
			.child(div().flex_1().truncate().child(label))
			.child(div().text_color(t.dim).child(String(count)));

		const chip = (id, label, count) => {
			const on = this.scope === id;
			return h_flex().id(`scope-${id}`).gap(5).px(8).py(3).rounded(6).items_center().text_size(11.5)
				.border_1().border_color(on ? t.accent : t.border).bg(on ? t.selected : t.popover)
				.text_color(on ? t.foreground : t.muted).hover((s) => s.text_color(t.foreground))
				.on_click((_e, cx) => { this.scope = id; cx.notify(); })
				.child(label).child(div().text_color(t.dim).child(String(count)));
		};

		return v_flex().id("ports").track_focus(this.handle)
			.on_key_down((e, cx) => {
				if (e.key !== "escape") return;
				if (this.confirming) { this.confirming = null; cx.notify(); }
				else closeOverlay(props().overlay);
			})
			.size_full().min_h(0).bg(t.popover).text_size(12.5)
			.child(v_flex().flex_none()
			.child(h_flex().px(12).py(10).gap(8).items_center().border_b(1).border_color(t.border)
				.child(div().flex_1().font_semibold().text_color(t.foreground).child("Ports"))
				.child(div().text_size(11).text_color(t.dim)
					.child(`${allGroups.length} workspace${allGroups.length === 1 ? "" : "s"} · ${allExternal.length} external`))
				.child(this.iconButton("refresh", "clock", t, (cx) => this.refresh(cx))))
			.child(v_flex().px(12).pt(10).pb(8).gap(8)
				.child(Input.new(this.input).h(32).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground))
				.child(h_flex().flex_wrap().gap(6)
					.child(chip("all", "All", this.ports.length))
					.children(allGroups.map((g) => chip(g.space.id, g.space.name, g.rows.length)))
					.child(chip("external", "External", allExternal.length))))
			.when(!!this.error, (el) => el.child(div().px(12).py(6).text_color(t.blocked).child(this.error))))
			// A popup sizes to its content, so flex_1/max_h leave the list without a definite height and
			// overflow never scrolls. Measure the rows and give the list min(rows, LIST_MAX) px, as the
			// shipped `changes` mod does. Sizes are reported zoomed and set unzoomed (as picker does).
			.child(v_flex().id("ports-list").flex_none().h(listH).overflow_y_scrollbar().mode("always")
				.child(v_flex().id("ports-rows").flex_none().pb(8)
					.on_size_change((size, cx) => { if (size.height !== this.contentH) { this.contentH = size.height; cx.notify(); } })
				.children(groups.map((g) => v_flex().gap(4).pb(6)
					.child(header(g.space.name, g.rows.length, `space-${g.space.id}`))
					.children(g.rows.map((row) => this.portRow(row, t, mono, true)))))
				.when(external.length > 0, (el) => el
					.child(header(`${externalOpen ? "▾" : "▸"} EXTERNAL PORTS`, external.length, "external",
						(_e, cx) => { this.externalOpen = !this.externalOpen; cx.notify(); }))
					.when(externalOpen, (el) => el.children(external.map((row) => this.portRow(row, t, mono, false)))))
				.when(!shown && !this.error, (el) => el.child(div().p(12).text_color(t.dim)
					.child(this.ports.length ? "No ports match" : "No listening ports")))));
	}
}
