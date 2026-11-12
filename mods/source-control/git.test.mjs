// node mods/source-control/git.test.mjs
import assert from "node:assert/strict";
import { parseStatus, parseNumstat, checkState, treeRows } from "./git.js";

const files = parseStatus(["M  src/ui/list.ts", " M src/app.ts", "AM new.ts", "?? docs/import.md", "UU c.ts", " D gone.ts", ""].join("\0"));
assert.deepEqual(files.map((f) => [f.path, f.letter, f.staged, f.untracked]), [
  ["src/ui/list.ts", "M", "all", false],
  ["src/app.ts", "M", "none", false],
  ["new.ts", "A", "some", false],
  ["docs/import.md", "U", "none", true],
  ["c.ts", "!", "none", false],
  ["gone.ts", "D", "none", false],
]);

assert.deepEqual(parseNumstat("1\t2\ta.ts\0-\t-\tb.png\0", parseNumstat("3\t0\ta.ts\0")),
  { "a.ts": { add: 4, del: 2, binary: false }, "b.png": { add: 0, del: 0, binary: true } });

assert.equal(checkState(files.slice(0, 1)), "all");
assert.equal(checkState(files.slice(0, 2)), "some");
assert.equal(checkState(files.slice(1, 2)), "none");
assert.equal(checkState([]), "none");

const tracked = files.slice(0, 2);
const rows = treeRows([...tracked, { path: "a/b/c/d.ts" }], new Set(), "t");
assert.deepEqual(rows.map((r) => `${r.depth}${r.dir ? "D" : "F"}:${r.name}${r.dir ? "#" + r.files.length : ""}`),
  ["0D:a/b/c#1", "1F:d.ts", "0D:src#2", "1D:ui#1", "2F:list.ts", "1F:app.ts"]);
assert.deepEqual(treeRows(tracked, new Set(["t:src"]), "t").map((r) => r.name), ["src"]);

console.log("ok");
