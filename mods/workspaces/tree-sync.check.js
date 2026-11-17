// Run: bun mods/workspaces/tree-sync.check.js  (exit 0 = pass)
import assert from "node:assert/strict";
import { applyFile, fileOf, parseFile, treeKey } from "./tree-sync.js";

const e = (id, machine, extra = {}) => ({ id, space: id, parent: null, manual: false, pinned: false, folded: false, machine, ...extra });

// A remote machine's file has its own bare ids, no folds, only its entries and roots.
const tree = {
	entries: [
		e("sp1", null),
		e("mini/sp2", "mini", { folded: true, name: "api" }),
		e("mini/sp3", "mini", { parent: "mini/sp2", manual: true, pinned: true }),
		e("sp4", null),
	],
	reopen: null,
};
const roots = { sp1: "/here", "mini/sp2": "/there" };
const file = fileOf(tree, roots, { ansi1: "bugs" }, "mini");
assert.deepEqual(file.entries.map((x) => [x.id, x.space, x.parent]), [["sp2", "sp2", null], ["sp3", "sp3", "sp2"]]);
assert.ok(file.entries.every((x) => !("folded" in x) && !("machine" in x)));
assert.deepEqual(file.roots, { sp2: "/there" });
assert.deepEqual(fileOf(tree, roots, {}, null).roots, { sp1: "/here" });

// The same tree read on the machine itself (ids bare, machine null) gives the same file.
const atHome = applyFile({ entries: [], reopen: null }, {}, {}, null, file);
assert.equal(treeKey(fileOf(atHome.tree, atHome.roots, atHome.tags, null)), treeKey(file));
assert.deepEqual(atHome.roots, { sp2: "/there" });

// Folding is not a change; order, parent, pin, color, roots and tags are.
const k = treeKey(file);
assert.equal(treeKey(fileOf({ entries: tree.entries.map((x) => ({ ...x, folded: !x.folded })) }, roots, { ansi1: "bugs" }, "mini")), k);
assert.notEqual(treeKey(fileOf({ entries: [tree.entries[0], tree.entries[2], tree.entries[1]] }, roots, { ansi1: "bugs" }, "mini")), k);
assert.notEqual(treeKey(fileOf({ entries: tree.entries.map((x) => ({ ...x, color: "ansi2" })) }, roots, { ansi1: "bugs" }, "mini")), k);
assert.notEqual(treeKey(fileOf(tree, { "mini/sp2": "/else" }, { ansi1: "bugs" }, "mini")), k);
assert.notEqual(treeKey(fileOf(tree, roots, {}, "mini")), k);

// Applying a remote file replaces that machine's entries in their slot, keeps folds
// and other machines' entries and roots.
const remote = { entries: [{ id: "sp3", space: "sp3", parent: null, manual: true }, { id: "sp2", space: "sp2", parent: "sp3", manual: true, color: "ansi4" }, { id: "sp5", space: "sp5", parent: null }], roots: { sp5: "/new" }, tags: { ansi4: "infra" } };
const next = applyFile(tree, roots, { ansi1: "bugs" }, "mini", remote);
assert.deepEqual(next.tree.entries.map((x) => x.id), ["sp1", "mini/sp3", "mini/sp2", "mini/sp5", "sp4"]);
assert.equal(next.tree.entries.find((x) => x.id === "mini/sp2").parent, "mini/sp3");
assert.equal(next.tree.entries.find((x) => x.id === "mini/sp2").folded, true);
assert.equal(next.tree.entries.find((x) => x.id === "mini/sp2").name, "api");
assert.equal(next.tree.entries.find((x) => x.id === "mini/sp5").machine, "mini");
assert.deepEqual(next.roots, { sp1: "/here", "mini/sp5": "/new" });
assert.deepEqual(next.tags, { ansi4: "infra" });

// A machine with no entries yet appends at the end.
assert.deepEqual(applyFile({ entries: [e("sp1", null)] }, {}, {}, "box", { entries: [{ id: "sp9", space: "sp9" }] }).tree.entries.map((x) => x.id), ["sp1", "box/sp9"]);

// Absent or broken files are ignored.
assert.equal(parseFile(""), null);
assert.equal(parseFile("{oops"), null);
assert.equal(parseFile('{"x":1}'), null);
assert.deepEqual(parseFile('{"entries":[]}'), { entries: [] });

console.log("tree-sync: ok");
