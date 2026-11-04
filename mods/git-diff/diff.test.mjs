// node mods/git-diff/diff.test.mjs
import assert from "node:assert/strict";
import { pairRows } from "./diff.js";

const rows = pairRows(["diff --git a/x b/x", "--- a/x", "+++ b/x",
  "@@ -1,3 +1,4 @@", " a", "-b", "+B", "+B2", " c", "@@ -10,1 +11,1 @@", "-z", "\\ No newline at end of file"].join("\n"));
const s = (x) => x && `${x.kind}${x.n}:${x.text}`;
assert.deepEqual(rows.map((r) => r.gap ? "gap" : [s(r.l), s(r.r)]), [
  [" 1:a", " 1:a"],
  ["-2:b", "+2:B"],
  [null, "+3:B2"],
  [" 3:c", " 4:c"],
  "gap",
  ["-10:z", null],
]);
console.log("ok");
