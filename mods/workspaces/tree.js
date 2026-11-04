// Workspace tree state kept in shared("workspace.tree"):
// { entries: [{ id, space, parent, manual, pinned, folded, name, named, folder, machine }],
//   reopen: { id, at } | null }
// `space` is the core space id; an entry whose space is not live is "closed".
// Pure functions only: callers write results with setShared.

export const EMPTY = { entries: [], reopen: null };
const REOPEN_MS = 10000;

const live = (entry, ids) => ids.has(entry.space);

// Sync entries with live spaces. `spaces`: [{ id, name, named, folder, machine }].
// Spaces absent from the list never prune anything while the list is empty
// (app start, core reload): ids are stable, so entries re-match when they return.
// `readable(machine)`: false/throwing means that machine's spaces are unknown, so its
// closed entries are kept. A reopen marker adopts a new space only when machine and
// folder (name when the entry has no folder) match and exactly one new space qualifies.
const sameMachine = (a, b) => (a ?? null) === (b ?? null);
const same = (a, b) => a !== undefined && a !== null && a === b;
const isReadable = (readable, machine) => {
	try {
		return Boolean(readable(machine ?? null));
	} catch {
		return false;
	}
};

export function reconcile(state, spaces, readable = () => true, now = Date.now()) {
	if (!Array.isArray(spaces) || !spaces.length) return state;
	const entries = state.entries.map((entry) => ({ ...entry }));
	const ids = new Set(spaces.map((space) => space.id));
	let reopen = state.reopen && now - state.reopen.at < REOPEN_MS ? state.reopen : null;
	const owned = new Set(entries.map((entry) => entry.space));
	const fresh = spaces.filter((space, index) => !owned.has(space.id) && spaces.findIndex((item) => item.id === space.id) === index);
	const candidates = reopen ? entries.filter((entry) => entry.id === reopen.id && !live(entry, ids)) : [];
	const adopts = (entry, space) =>
		sameMachine(entry.machine, space.machine) && (entry.folder != null ? same(entry.folder, space.folder) : same(entry.name, space.name));
	const adopted = new Map();
	for (const entry of candidates.slice(0, 1)) {
		const matches = fresh.filter((space) => adopts(entry, space));
		if (matches.length === 1) adopted.set(matches[0].id, entry);
	}
	for (const space of fresh) {
		const target = adopted.get(space.id);
		if (target) {
			target.space = space.id;
			reopen = null;
		} else {
			entries.push({ id: space.id, space: space.id, parent: null, manual: false, pinned: false, folded: false });
		}
	}
	for (const space of spaces) {
		const info = { name: space.name, named: space.named, folder: space.folder, machine: space.machine ?? null };
		for (const entry of entries) if (entry.space === space.id) Object.assign(entry, info);
	}
	// Drop unpinned closed leaves; every ancestor of a retained entry stays.
	let removed;
	do {
		removed = false;
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (live(entry, ids) || entry.pinned || !isReadable(readable, entry.machine)) continue;
			if (entries.some((child) => child.parent === entry.id)) continue;
			entries.splice(index, 1);
			removed = true;
		}
	} while (removed);
	// The tree keeps its own order: new entries append (as the core does) and a
	// reopened entry keeps its slot instead of following its replacement space.
	return { entries, reopen };
}

// Can `id` take `parent` (null: top level)? Same machine, no cycles.
export function canParent(entries, id, parent) {
	const entry = entries.find((item) => item.id === id);
	if (!entry) return false;
	if (parent === null) return true;
	const target = entries.find((item) => item.id === parent);
	if (!target || target.machine !== entry.machine) return false;
	const seen = new Set([id]);
	for (let current = target; current; current = entries.find((item) => item.id === current.parent)) {
		if (seen.has(current.id)) return false;
		seen.add(current.id);
	}
	return true;
}

const update = (state, id, change) => ({
	...state,
	entries: state.entries.map((entry) => (entry.id === id ? { ...entry, ...change } : entry)),
});

export const togglePin = (state, id) => update(state, id, { pinned: !state.entries.find((entry) => entry.id === id)?.pinned });
export const toggleFold = (state, id) => update(state, id, { folded: !state.entries.find((entry) => entry.id === id)?.folded });

export function setParent(state, id, parent) {
	return canParent(state.entries, id, parent) ? update(state, id, { parent, manual: true }) : state;
}

export const startReopen = (state, id, now = Date.now()) => ({ ...state, reopen: { id, at: now } });


// Rows in display order. `liveIds`: Set of core space ids that exist now. `automatic`:
// { entryId: parentEntryId } (git worktree nesting), overridden by a manual choice.
// Closed entries show when pinned or when they hold a shown entry.
export function flatten(state, liveIds, automatic = {}) {
	const { entries } = state;
	const ids = liveIds;
	const parentOf = (entry) => (entry.manual ? entry.parent : (automatic[entry.id] ?? entry.parent));
	const known = new Set(entries.map((entry) => entry.id));
	const kids = new Map(entries.map((entry) => [entry.id, []]));
	for (const entry of entries) {
		const parent = parentOf(entry);
		if (parent && parent !== entry.id && known.has(parent)) kids.get(parent).push(entry);
	}
	const shown = new Map();
	const visible = (entry, path = new Set()) => {
		if (shown.has(entry.id)) return shown.get(entry.id);
		if (path.has(entry.id)) return false;
		path.add(entry.id);
		const result = live(entry, ids) || entry.pinned || kids.get(entry.id).some((kid) => visible(kid, path));
		path.delete(entry.id);
		shown.set(entry.id, result);
		return result;
	};
	const rows = [];
	const placed = new Set();
	// Descendants of a folded entry count as placed: hidden, not orphaned.
	const hide = (entry) => {
		for (const kid of kids.get(entry.id)) {
			if (placed.has(kid.id)) continue;
			placed.add(kid.id);
			hide(kid);
		}
	};
	const visit = (entry, depth) => {
		if (placed.has(entry.id) || !visible(entry)) return;
		placed.add(entry.id);
		const children = kids.get(entry.id).filter((kid) => visible(kid));
		rows.push({ entry, depth, kids: children.length, closed: !live(entry, ids) });
		if (entry.folded) hide(entry);
		else for (const kid of children) visit(kid, depth + 1);
	};
	for (const entry of entries) {
		const parent = parentOf(entry);
		if (!parent || parent === entry.id || !known.has(parent)) visit(entry, 0);
	}
	// A parent cycle left unreachable from any root: show it flat rather than hide it.
	for (const entry of entries) visit(entry, 0);
	return rows;
}
