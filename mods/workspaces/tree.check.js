// Run: bun mods/workspaces/tree.check.js  (exit 0 = pass)
import assert from "node:assert/strict";
import { EMPTY, canParent, flatten, reconcile, setParent, startReopen, togglePin } from "./tree.js";

const sp = (id, name = id, machine = null) => ({ id, name, named: true, folder: `/w/${name}`, machine });
// "<depth>[x if closed]:<entry id>" per visible row.
const view = (state, live, auto) =>
	flatten(state, new Set(live.map((space) => space.id)), auto).map((row) => `${row.depth}${row.closed ? "x" : ""}:${row.entry.id}`);

// Live spaces become entries; closing an unpinned one drops it.
let live = [sp("a"), sp("b")];
let s = reconcile(EMPTY, live);
assert.deepEqual(view(s, live), ["0:a", "0:b"]);
live = [sp("a")];
s = reconcile(s, live);
assert.deepEqual(view(s, live), ["0:a"]);
assert.equal(s.entries.length, 1);

// Pin keeps a closed entry with its folder; unpin drops it.
live = [sp("a"), sp("b")];
s = togglePin(reconcile(EMPTY, live), "b");
live = [sp("a")];
s = reconcile(s, live);
assert.deepEqual(view(s, live), ["0:a", "0x:b"]);
assert.equal(s.entries.find((e) => e.id === "b").folder, "/w/b");
s = reconcile(togglePin(s, "b"), live);
assert.deepEqual(view(s, live), ["0:a"]);
assert.equal(s.entries.length, 1);

// Closed unpinned parent with a live child keeps the branch; once the child is gone, both go.
live = [sp("p"), sp("c")];
s = setParent(reconcile(EMPTY, live), "c", "p");
live = [sp("c")];
s = reconcile(s, live);
assert.deepEqual(view(s, live), ["0x:p", "1:c"]);
live = [sp("z")];
s = reconcile(s, live);
assert.deepEqual(view(s, live), ["0:z"]);
assert.equal(s.entries.length, 1);

// Cycles, self, and cross-machine parents are refused.
live = [sp("a"), sp("b"), sp("r", "r", "vps")];
s = setParent(reconcile(EMPTY, live), "b", "a");
assert.equal(canParent(s.entries, "a", "b"), false);
assert.equal(canParent(s.entries, "a", "a"), false);
assert.equal(canParent(s.entries, "a", "r"), false);
assert.equal(setParent(s, "a", "b"), s);
assert.equal(setParent(s, "a", "r"), s);

// Folding hides descendants but keeps the parent row.
s = toggleFoldFor(s, "a");
assert.deepEqual(view(s, live), ["0:a", "0:r"]);

// Reopen: the replacement space adopts the pinned entry and keeps its children.
live = [sp("p"), sp("c"), sp("o")];
s = setParent(togglePin(reconcile(EMPTY, live), "p"), "c", "p");
live = [sp("c"), sp("o")];
s = reconcile(s, live);
assert.deepEqual(view(s, live), ["0x:p", "1:c", "0:o"]);
s = startReopen(s, "p", 1000);
live = [sp("c"), sp("o"), sp("p2", "p")];
s = reconcile(s, live, () => true, 1500);
assert.equal(s.entries.length, 3);
assert.equal(s.entries.find((e) => e.id === "p").space, "p2");
assert.deepEqual(view(s, live), ["0:p", "1:c", "0:o"]);
assert.equal(s.reopen, null);

// An expired reopen marker does not adopt a stranger; a different machine never adopts.
live = [sp("c"), sp("o")];
s = reconcile(s, live);
s = startReopen(s, "p", 1000);
live = [sp("c"), sp("o"), sp("n")];
s = reconcile(s, live, () => true, 99999);
assert.equal(s.entries.find((e) => e.id === "n").space, "n");
s = startReopen(s, "p", 100000);
live = [sp("c"), sp("o"), sp("n"), sp("q", "q", "vps")];
s = reconcile(s, live, () => true, 100500);
assert.equal(s.entries.find((e) => e.id === "q").space, "q");
assert.notEqual(s.entries.find((e) => e.id === "p")?.space, "q");

// Unreadable machine: its closed entries are kept. Empty live list: state is returned untouched.
live = [sp("r", "r", "vps"), sp("a")];
s = reconcile(EMPTY, live);
live = [sp("a")];
s = reconcile(s, live, (machine) => machine !== "vps");
assert.ok(s.entries.some((e) => e.id === "r"));
assert.equal(reconcile(s, []), s);

// Remote IDs/offline: a throwing/undefined/false readable keeps that machine's closed entries; local ones still prune.
live = [sp("r1", "r1", "vps"), sp("a"), sp("b")];
s = reconcile(EMPTY, live);
live = [sp("a")];
for (const readable of [(m) => { if (m === "vps") throw new Error("offline"); return true; }, (m) => (m === "vps" ? undefined : true), (m) => m !== "vps"]) {
	const kept = reconcile(s, live, readable);
	assert.deepEqual(kept.entries.map((e) => e.id), ["r1", "a"]);
}
assert.deepEqual(reconcile(s, live, () => true).entries.map((e) => e.id), ["a"]);
// Remote entry returns by stable id and is rematched, not duplicated.
live = [sp("r1", "r1", "vps"), sp("a")];
assert.equal(reconcile(reconcile(s, [sp("a")], () => false), live).entries.length, 2);
// Empty live list never prunes or changes state, even with an unreadable machine.
assert.equal(reconcile(s, [], () => false), s);

// Reopen is conservative: wrong folder, ambiguous matches, or a non-null machine mismatch adopt nothing.
live = [sp("p"), sp("o")];
s = togglePin(reconcile(EMPTY, live), "p");
s = reconcile(s, [sp("o")]);
s = startReopen(s, "p", 1000);
let other = { ...sp("x", "p"), folder: "/elsewhere/p" };
let t = reconcile(s, [sp("o"), other], () => true, 1500);
assert.equal(t.entries.find((e) => e.id === "p").space, "p");
assert.equal(t.entries.find((e) => e.id === "x").space, "x");
assert.deepEqual(t.reopen, s.reopen);
t = reconcile(s, [sp("o"), sp("p2", "p"), sp("p3", "p")], () => true, 1500);
assert.equal(t.entries.find((e) => e.id === "p").space, "p");
assert.equal(t.entries.length, 4);
t = reconcile(s, [sp("o"), sp("p2", "p", "vps")], () => true, 1500);
assert.equal(t.entries.find((e) => e.id === "p").space, "p");
// Duplicate space ids in the live list create one entry.
t = reconcile(EMPTY, [sp("d"), sp("d")]);
assert.equal(t.entries.length, 1);

// Automatic (worktree) nesting applies unless a manual parent was chosen.
live = [sp("m"), sp("w"), sp("x")];
s = reconcile(EMPTY, live);
assert.deepEqual(view(s, live, { w: "m" }), ["0:m", "1:w", "0:x"]);
s = setParent(s, "w", "x");
assert.deepEqual(view(s, live, { w: "m" }), ["0:m", "0:x", "1:w"]);
s = setParent(s, "w", null);
assert.deepEqual(view(s, live, { w: "m" }), ["0:m", "0:w", "0:x"]);

console.log("tree.check ok");

function toggleFoldFor(state, id) {
	return { ...state, entries: state.entries.map((e) => (e.id === id ? { ...e, folded: true } : e)) };
}
