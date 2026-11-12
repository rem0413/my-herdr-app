// Listening TCP ports on this computer and every machine that holds spaces, grouped by space.
// The scan is done by status-ports (shared "ports.scan"); this popup only draws it. A port belongs
// to a space when its process was started from one of that space's terminals (HC_TERMINAL_ID), else
// when it runs inside the space's folders. Ports of a space can be killed; other processes are view-only.
// Opened with `mod.open ports` (cmd-alt-p). Only processes lsof can see (yours) are listed.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, spaces, focused, shared, setShared, theme, settings, props, closeOverlay, notify } from "herdr";
// Same keys as mods/status-ports/scan.js (a mod can't import from another mod's folder).
const SHARED_KEY = "ports.scan", RESCAN_KEY = "ports.rescan";

const ICON = "mods/workspace-chrome";
const LIST_MAX = 440; // px at zoom 1; past this the list scrolls
const rescan = () => setShared(RESCAN_KEY, Date.now());

export default class Ports extends View {
	init(_props, cx) {
		this.gone = new Set(); // `${machine}:${pid}` killed, hidden until the next scan drops them
		this.externalOpen = false;
		this.scope = "all"; // "all" or a space id
		this.confirming = null; // row key awaiting kill confirmation
		this.filter = "";
		this.input = InputState.new({ placeholder: "Filter port, process, pid, machine…" });
		this.input.on("change", (_e, cx) => { this.filter = this.input.value(); cx.notify(); });
		this.input.focus();
		cx.timer.after(600, () => this.input.focus());
		this.handle = cx.focus_handle();
		rescan();
	}

	kill(row, cx) {
		cx.spawn(async (cx) => {
			const r = await exec("kill", [String(row.pid)], { on: row.machine }).catch((e) => ({ code: 1, stderr: String(e) }));
			if (r.code !== 0) notify({ title: `Couldn't kill ${row.command} (${row.pid})`, body: r.stderr.trim(), level: "error" });
			else {
				notify({ title: `Killed ${row.command} on :${row.port}${row.machine ? ` (${row.machine})` : ""}`, level: "success", timeout: 3000 });
				this.gone.add(`${row.machine}:${row.pid}`);
			}
			rescan();
			cx.notify();
		});
	}

	iconButton(id, icon, t, action, danger = false) {
		return div().id(id).p(4).rounded(6).text_color(t.muted)
			.hover((s) => s.bg(t.hover).text_color(danger ? t.blocked : t.foreground))
			.on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
			.child(svg(icon.includes("/") ? icon : `${ICON}/${icon}.svg`).size(14));
	}

	// killable: the port belongs to a space. Other processes (Postgres, Discord...) are view-only.
	// Open/copy only for this computer: another machine's localhost isn't this one's.
	portRow(row, t, mono, card) {
		const killable = !!row.space;
		const url = row.machine ? null : `http://localhost:${row.port}`;
		const key = `${row.machine}:${row.pid}:${row.port}`;
		const confirming = this.confirming === key;
		const where = [row.machine, row.address, `pid ${row.pid}`, row.terminal ? `from ${row.terminal}` : row.space ? "in folder" : null].filter(Boolean).join(" · ");
		const pill = (id, label, bg, fg, action) => div().id(id).px(10).py(3).rounded(6).bg(bg).text_color(fg).text_size(11)
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
					.child(confirming ? `Kill pid ${row.pid}${row.machine ? ` on ${row.machine}` : ""}? Every port it holds closes.` : where)))
			.when(confirming, (el) => el.child(h_flex().gap(6).flex_none()
				.child(pill(`cancel-${key}`, "Cancel", t.hover, t.foreground, (cx) => { this.confirming = null; cx.notify(); }))
				.child(pill(`confirm-${key}`, "Kill", t.blocked, t.background, (cx) => { this.confirming = null; this.kill(row, cx); }))))
			.when(!confirming, (el) => el.child(h_flex().gap(2).flex_none()
				.when(!!url, (el) => el
					.child(this.iconButton(`open-${key}`, "monitor", t, (cx) => cx.open_url(url)))
					.child(this.iconButton(`copy-${key}`, "file-text", t, (cx) => {
						cx.write_to_clipboard(url);
						notify({ title: `Copied ${url}`, timeout: 2000 });
					})))
				.when(killable, (el) => el.child(this.iconButton(`kill-${key}`, "mods/ports/trash.svg", t, (cx) => { this.confirming = key; cx.notify(); }, true)))));
	}

	render(cx) {
		const t = theme();
		const mono = settings().font_family || "JetBrains Mono";
		const data = shared(SHARED_KEY);
		const live = new Set((data?.rows ?? []).map((r) => `${r.machine}:${r.pid}`));
		for (const g of this.gone) if (!live.has(g)) this.gone.delete(g);
		this.ports = (data?.rows ?? []).filter((r) => !this.gone.has(`${r.machine}:${r.pid}`));
		const errors = Object.entries(data?.errors ?? {});
		this.error = errors.length ? errors.map(([m, e]) => `${m}: ${e}`).join(" · ") : null;
		// Machine first, then spaces of that machine. "*" = every machine. It starts on the focused
		// space's machine each time the popup opens (init clears it), so a remote space shows its remote.
		const machineKey = (m) => m ?? "local";
		const machineLabel = (k) => k === "*" ? "All machines" : k === "local" ? "This computer" : k;
		const machineKeys = ["local", ...new Set(spaces().map((s) => s.machine).filter(Boolean))];
		if (this.machine === undefined || (this.machine !== "*" && !machineKeys.includes(this.machine))) {
			const id = focused()?.space;
			this.machine = machineKey((spaces().find((s) => s.id === id) ?? spaces().find((s) => s.active))?.machine);
		}
		const onMachine = (m) => this.machine === "*" || machineKey(m) === this.machine;
		const perMachine = Object.fromEntries(machineKeys.map((k) => [k, this.ports.filter((p) => machineKey(p.machine) === k).length]));
		const ports = this.ports.filter((p) => onMachine(p.machine));
		const allGroups = spaces().filter((s) => onMachine(s.machine))
			.map((space) => ({ space, rows: ports.filter((p) => p.space === space.id) }))
			.filter((g) => g.rows.length);
		const allExternal = ports.filter((p) => !allGroups.some((g) => g.space.id === p.space));
		if (this.scope !== "all" && !allGroups.some((g) => g.space.id === this.scope)) this.scope = "all";
		const spaceName = (s) => s.machine && this.machine === "*" ? `${s.name} · ${s.machine}` : s.name;

		const f = this.filter.trim().toLowerCase();
		const match = (p) => !f || `${p.port} ${p.command} ${p.pid} ${p.address} ${p.machine ?? ""}`.toLowerCase().includes(f);
		const groups = allGroups
			.filter((g) => this.scope === "all" || this.scope === g.space.id)
			.map((g) => ({ space: g.space, rows: g.rows.filter(match) }))
			.filter((g) => g.rows.length);
		const external = this.scope === "all" ? allExternal.filter(match) : [];
		const shown = groups.reduce((n, g) => n + g.rows.length, 0) + external.length;
		const contentH = (this.contentH ?? 0) / (settings().zoom || 1);
		const listH = Math.max(40, Math.min(LIST_MAX, contentH));
		// Folded by default; shown when a filter is typed, so matches aren't hidden.
		const externalOpen = this.externalOpen || !!f;

		const header = (label, count, id, onClick) => h_flex().id(id).px(12).py(8).gap(8).items_center()
			.text_size(11).font_semibold().text_color(t.muted)
			.when(!!onClick, (el) => el.hover((s) => s.text_color(t.foreground)).on_click(onClick))
			.child(div().flex_1().truncate().child(label))
			.child(div().text_color(t.dim).child(String(count)));

		// One row however many spaces: All stays put, spaces scroll beside it (wheel or trackpad),
		// and a long space name is cut with … (the tooltip has it whole).
		const chip = (id, label, count) => {
			const on = this.scope === id;
			return h_flex().id(`scope-${id}`).flex_none().max_w(160).gap(5).px(8).py(3).rounded(6).items_center().text_size(11)
				.border_1().border_color(on ? t.accent : t.border).bg(on ? t.selected : t.popover)
				.text_color(on ? t.foreground : t.muted).hover((s) => s.text_color(t.foreground))
				.tooltip(`${label} · ${count} port${count === 1 ? "" : "s"}`)
				.on_click((_e, cx) => { this.scope = id; cx.notify(); })
				.child(div().min_w(0).truncate().child(label)).child(div().flex_none().text_color(t.dim).child(String(count)));
		};

		const option = (k, count) => h_flex().id(`machine-${k}`).px(10).py(6).gap(8).items_center().rounded(6)
			.bg(this.machine === k ? t.selected : t.popover).hover((s) => s.bg(t.hover))
			.on_click((_e, cx) => { this.machine = k; this.scope = "all"; this.machineOpen = false; cx.notify(); })
			.child(svg(`${ICON}/${k === "local" ? "monitor" : "server"}.svg`).size(13).text_color(t.muted))
			.child(div().flex_1().text_color(t.foreground).child(machineLabel(k)))
			.child(div().text_size(11).text_color(t.dim).child(String(count)));
		const zoom = settings().zoom || 1;
		// The machine button sits right of the filter: icon and name only (cut with … when long). Its menu
		// floats over the list (an absolute last child of the root, painted on top), right-aligned under it,
		// wide enough for full names and counts.
		const row = this.width ? this.width / zoom - 24 : 400;
		const machineButton = h_flex().id("machine").flex_none().w((row - 8) / 4).h(32).px(10).gap(6).items_center().rounded(8).border_1()
			.border_color(this.machineOpen ? t.accent : t.input).bg(t.background).hover((s) => s.border_color(t.accent))
			.tooltip(`${machineLabel(this.machine)} · ${ports.length} ports`)
			.on_click((_e, cx) => { this.machineOpen = !this.machineOpen; cx.notify(); })
			.child(svg(`${ICON}/${this.machine === "local" ? "monitor" : "server"}.svg`).size(13).flex_none().text_color(t.muted))
			.child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(machineLabel(this.machine)));
		const machineMenu = v_flex().id("machine-menu").absolute().right(12).top((this.headerH ?? 41 * zoom) / zoom + 10 + 32 + 4).w(Math.min(220, row))
			.p(4).gap(2).rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_lg()
			.children(machineKeys.map((k) => option(k, perMachine[k])))
			.when(machineKeys.length > 1, (el) => el.child(option("*", this.ports.length)));

		return v_flex().id("ports").track_focus(this.handle)
			.on_key_down((e, cx) => {
				if (e.key !== "escape") return;
				if (this.machineOpen) { this.machineOpen = false; cx.notify(); }
				else if (this.confirming) { this.confirming = null; cx.notify(); }
				else closeOverlay(props().overlay);
			})
			.size_full().min_h(0).bg(t.popover).text_size(12)
			.on_size_change((size, cx) => { if (size.width !== this.width) { this.width = size.width; cx.notify(); } })
			.child(v_flex().flex_none()
			.child(h_flex().id("ports-header").px(12).py(10).gap(8).items_center().border_b(1).border_color(t.border)
				.on_size_change((size, cx) => { if (size.height !== this.headerH) { this.headerH = size.height; cx.notify(); } })
				.child(div().flex_1().font_semibold().text_color(t.foreground).child("Ports"))
				.child(div().text_size(11).text_color(t.dim)
					.child(`${allGroups.length} workspace${allGroups.length === 1 ? "" : "s"} · ${allExternal.length} external`))
				.child(this.iconButton("refresh", "clock", t, () => rescan())))
			.child(v_flex().px(12).pt(10).pb(8).gap(8)
				.child(h_flex().gap(8)
					.child(Input.new(this.input).flex_1().h(32).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12).text_color(t.foreground))
					.child(machineButton))
				.child(h_flex().gap(6).items_center()
					.child(chip("all", "All", ports.length))
					.child(h_flex().id("scope-scroll").flex_1().min_w(0).gap(6).items_center().overflow_x_scrollbar()
						.children(allGroups.map((g) => chip(g.space.id, spaceName(g.space), g.rows.length))))))
			.when(!!this.error, (el) => el.child(div().px(12).py(6).text_color(t.blocked).child(this.error))))
			// A popup sizes to its content, so flex_1/max_h leave the list without a definite height and
			// overflow never scrolls. Measure the rows and give the list min(rows, LIST_MAX) px, as the
			// shipped `changes` mod does. Sizes are reported zoomed and set unzoomed (as picker does).
			.child(v_flex().id("ports-list").flex_none().h(listH).overflow_y_scrollbar().mode("always")
				.child(v_flex().id("ports-rows").flex_none().pb(8)
					.on_size_change((size, cx) => { if (size.height !== this.contentH) { this.contentH = size.height; cx.notify(); } })
				.children(groups.map((g) => v_flex().gap(4).pb(6)
					.child(header(spaceName(g.space), g.rows.length, `space-${g.space.id}`))
					.children(g.rows.map((row) => this.portRow(row, t, mono, true)))))
				.when(external.length > 0, (el) => el
					.child(header(`${externalOpen ? "▾" : "▸"} EXTERNAL PORTS`, external.length, "external",
						(_e, cx) => { this.externalOpen = !this.externalOpen; cx.notify(); }))
					.when(externalOpen, (el) => el.children(external.map((row) => this.portRow(row, t, mono, false)))))
				.when(!shown && !this.error, (el) => el.child(div().p(12).text_color(t.dim)
					.child(!data ? "Scanning…" : this.ports.length ? "No ports match" : "No listening ports")))))
			.when(!!this.machineOpen, (el) => el.child(machineMenu));
	}
}
