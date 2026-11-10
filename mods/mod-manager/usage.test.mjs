import assert from "node:assert/strict";
import { usesMod, usage } from "./usage.js";

const block = { id: "a", content: { mod: "example" } };
assert.equal(usage("example", block), "Running · current layout");
assert.equal(usage("example", { hidden: true, children: [block] }), "Hidden · may remain running");
assert.equal(usage("example", { type: "stack", active: "b", children: [block, { id: "b" }] }), "Hidden · may remain running");
assert.equal(usage("example", { floating: [block] }), "Running · current layout");
assert.equal(usage("example", block, { disabled: true }), "Off · disabled by kit");
assert.equal(usage("example", null, { overlay: true }), "Running · overlay");
assert.equal(usage("example", null, { pane: true }), "Loaded · tab pane");
assert.equal(usage("example", { terminal_menu: "example" }), "On demand · terminal menu");
assert.equal(usage("example", null), "Not in current layout / open panes");
const header = { content: { pane: { header: { content: { mod: "example" } } } } };
assert.equal(usesMod(header, "example"), true);
assert.equal(usage("example", header), "Running · current layout");
assert.equal(usesMod({ terminal_menu: "example" }, "example"), true);
assert.equal(usesMod({ content: { props: { label: "example" } } }, "example"), false);
console.log("mod-manager usage checks passed");
