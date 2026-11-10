import assert from "node:assert/strict";
import { dependencies, keyReferences, reachable, canDelete } from "./references.js";
const names = ["panel", "viewer", "menu", "orphan"];
assert.deepEqual(dependencies('openOverlay({ mod: "viewer" }); svg("mods/menu/icon.svg"); run("panel.refresh");', names, "panel"), ["viewer", "menu"]);
assert.deepEqual(dependencies('"viewer-other"; "unrelated"', names, "panel"), []);
assert.deepEqual(keyReferences({ global: { "cmd-a": "mod.open:viewer", "cmd-b": { command: "mod.open", args: { name: "viewer" } }, "cmd-c": "viewer.refresh", "cmd-d": "mod.open:viewer-other" } }, "viewer"), ["global: cmd-a", "global: cmd-b", "global: cmd-c"]);
const used = reachable(["panel"], { panel: ["viewer"], viewer: ["menu"], menu: ["viewer"], orphan: ["orphan"] });
assert.deepEqual([...used], ["panel", "viewer", "menu"]);
// An isolated dependency cycle must remain a cleanup candidate.
assert.equal(reachable([], { panel: ["viewer"], viewer: ["panel"] }).size, 0);
const mod = { name: "orphan", source: "local" }, unused = { unused: true, callers: [] };
assert.equal(canDelete(mod, unused, true), true);
assert.equal(canDelete(mod, unused, false), false);
assert.equal(canDelete(mod, { unused: false, callers: [] }, true), false);
assert.equal(canDelete(mod, { unused: true, callers: ["other"] }, true), false);
assert.equal(canDelete({ ...mod, source: "herdr" }, unused, true), false);
assert.equal(canDelete({ ...mod, source: "repo", shipped: true }, unused, true), false);
assert.equal(canDelete({ ...mod, name: "../other" }, unused, true), false);
console.log("mod-manager references checks passed");
