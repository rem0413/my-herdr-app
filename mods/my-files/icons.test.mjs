// node mods/my-files/icons.test.mjs
import assert from "node:assert/strict";
import { iconFor } from "./icons.js";

const I = "mods/my-files/icons/";
const cfg = { icons: { default: { icon: "file", color: "#0" }, folder: { color: "#f" }, folders: { src: "#s" },
  extensions: { ts: { icon: "code", color: "#t" }, "d.ts": { icon: "code", color: "#d" } },
  names: { "package.json": { icon: "json", color: "#p" }, "x.y": { icon: "my/own.svg" } } } };
assert.deepEqual(iconFor("a.d.ts", false, cfg), { path: `${I}code.svg`, color: "#d" });
assert.deepEqual(iconFor("A.TS", false, cfg), { path: `${I}code.svg`, color: "#t" });
assert.deepEqual(iconFor("package.json", false, cfg), { path: `${I}json.svg`, color: "#p" });
assert.deepEqual(iconFor("x.y", false, cfg), { path: "my/own.svg", color: null });
assert.deepEqual(iconFor("x.zzz", false, cfg), { path: `${I}file.svg`, color: "#0" });
assert.deepEqual(iconFor("src", true, cfg), { path: `${I}folder.svg`, color: "#s" });
assert.deepEqual(iconFor("lib", true, cfg), { path: `${I}folder.svg`, color: "#f" });
assert.deepEqual(iconFor("x", false, {}), { path: `${I}file.svg`, color: null });
console.log("ok icons");
