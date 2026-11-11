// node mods/my-files/icons.test.mjs
import assert from "node:assert/strict";
import { iconFor } from "./icons.js";

const I = "mods/my-files/icons/", M = "mods/my-files/material/";
const cfg = { icons: { theme: "classic", default: { icon: "file", color: "#0" }, folder: { color: "#f" }, folders: { src: "#s" },
  extensions: { ts: { icon: "code", color: "#t" }, "d.ts": { icon: "code", color: "#d" } },
  names: { "package.json": { icon: "json", color: "#p" }, "x.y": { icon: "my/own.svg" } } } };
assert.deepEqual(iconFor("a.d.ts", false, cfg), { path: `${I}code.svg`, color: "#d", tint: true });
assert.deepEqual(iconFor("lib/A.TS", false, cfg), { path: `${I}code.svg`, color: "#t", tint: true });
assert.deepEqual(iconFor("package.json", false, cfg), { path: `${I}json.svg`, color: "#p", tint: true });
assert.deepEqual(iconFor("x.y", false, cfg), { path: "my/own.svg", color: null, tint: true });
assert.deepEqual(iconFor("x.zzz", false, cfg), { path: `${I}file.svg`, color: "#0", tint: true });
assert.deepEqual(iconFor("src", true, cfg), { path: `${I}folder.svg`, color: "#s", tint: true });

// Material: name beats extension, longest extension wins, path rules, open folders, light variants, fallbacks.
const m = (rel, dir, o) => iconFor(rel, dir, {}, o).path;
assert.equal(m("app.ts"), `${M}typescript.svg`);
assert.equal(m("a.spec.ts"), `${M}test-ts.svg`);
assert.equal(m("x/package.json"), `${M}nodejs.svg`);
assert.equal(m("src", true), `${M}folder-src.svg`);
assert.equal(m("src", true, { open: true }), `${M}folder-src-open.svg`);
assert.equal(m("weird.zzz"), `${M}file.svg`);
assert.equal(m("nothing", true), `${M}folder.svg`);
assert.equal(iconFor("a.ts", false, {}).tint, false);
for (const p of [m("app.ts"), m("a.spec.ts"), m("src", true, { open: true }), m(".github/workflows", true)])
  assert.ok((await import("node:fs")).existsSync(new URL(`../../${p}`, import.meta.url)), p);
console.log("ok icons");
