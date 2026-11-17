// One machine's part of the workspace tree, kept in a file on that machine
// ($HOME/.config/herdr-app/workspace-tree/tree.json, alone in its folder so the local
// window can watch it), so every Herdr window showing its
// spaces reads and writes the same tree. Folding stays per window.
// In the file, ids are that machine's own (no "<machine>/" prefix): the machine's own
// window and a window connected to it from elsewhere read the same file.
// Pure functions only; main.js does the reading and writing.

export const DIR = "workspace-tree"; // under the app home
export const FILE = `$HOME/.config/herdr-app/${DIR}/tree.json`;
export const READ = `cat "${FILE}" 2>/dev/null || true`;
export const WRITE = `f="${FILE}"; mkdir -p "\${f%/*}" && printf '%s' "$1" > "$f.tmp" && mv "$f.tmp" "$f"`;

// Fields compared to tell whether the tree changed (name, folder: kept for reopening only).
const SYNCED = ["id", "space", "parent", "manual", "autoParent", "dismissed", "pinned", "color"];
const ID_FIELDS = ["id", "space", "parent", "autoParent"];
// Kept from this window's entry when the file has it too.
const KEEP_LOCAL = ["folded", "name", "named", "folder"];

const own = (machine) => (entry) => (entry.machine ?? null) === machine;
const toFile = (id, machine) => (machine && typeof id === "string" && id.startsWith(`${machine}/`) ? id.slice(machine.length + 1) : id);
const fromFile = (id, machine) => (machine && typeof id === "string" && !id.includes("/") ? `${machine}/${id}` : id);
// A root folder's space: "<machine>/<id>" on another machine, a bare id here.
const ownerOf = (space) => (space.includes("/") ? space.slice(0, space.indexOf("/")) : null);

// The file content for `machine` (null: this computer).
export function fileOf(tree, roots, tags, machine) {
	const entries = (tree?.entries ?? []).filter(own(machine)).map((entry) => {
		const out = {};
		for (const [key, value] of Object.entries(entry)) {
			if (key === "folded" || key === "machine" || value === undefined) continue;
			out[key] = ID_FIELDS.includes(key) ? toFile(value, machine) : value;
		}
		return out;
	});
	const ownRoots = {};
	for (const [space, folder] of Object.entries(roots ?? {})) if (ownerOf(space) === machine) ownRoots[toFile(space, machine)] = folder;
	return { entries, roots: ownRoots, tags: { ...(tags ?? {}) } };
}

const sorted = (object) => Object.fromEntries(Object.entries(object ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

// What decides "changed": order, parents, pins, colors, roots, tag names.
export function treeKey(file) {
	return JSON.stringify({
		entries: (file?.entries ?? []).map((entry) => SYNCED.map((key) => entry[key] ?? null)),
		roots: sorted(file?.roots),
		tags: sorted(file?.tags),
	});
}

// A file's text, or null when absent or not a tree.
export function parseFile(text) {
	if (!text) return null;
	try {
		const file = JSON.parse(text);
		return file && Array.isArray(file.entries) ? file : null;
	} catch {
		return null;
	}
}

// Replace `machine`'s part of the tree, roots and tags with the file's, in the slot its
// entries had (else at the end), keeping this window's folds.
export function applyFile(tree, roots, tags, machine, file) {
	const entries = tree?.entries ?? [];
	const mine = new Map(entries.filter(own(machine)).map((entry) => [entry.id, entry]));
	const incoming = file.entries
		.filter((entry) => entry && typeof entry.id === "string")
		.map((entry) => {
			const next = { ...entry, machine };
			for (const key of ID_FIELDS) if (key in next) next[key] = fromFile(next[key], machine);
			const old = mine.get(next.id);
			for (const key of KEEP_LOCAL) if (old && old[key] !== undefined) next[key] = old[key];
			next.folded = Boolean(old?.folded);
			return next;
		});
	const first = entries.findIndex(own(machine));
	const others = entries.filter((entry) => !own(machine)(entry));
	const at = first < 0 ? others.length : entries.slice(0, first).filter((entry) => !own(machine)(entry)).length;
	const nextRoots = {};
	for (const [space, folder] of Object.entries(roots ?? {})) if (ownerOf(space) !== machine) nextRoots[space] = folder;
	for (const [space, folder] of Object.entries(file.roots ?? {})) nextRoots[fromFile(space, machine)] = folder;
	return {
		tree: { entries: [...others.slice(0, at), ...incoming, ...others.slice(at)], reopen: tree?.reopen ?? null },
		roots: nextRoots,
		tags: file.tags && typeof file.tags === "object" ? { ...file.tags } : { ...(tags ?? {}) },
	};
}
