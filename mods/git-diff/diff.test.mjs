// node mods/git-diff/diff.test.mjs
import assert from "node:assert/strict";
import { pairRows, unifiedRows, countPatch } from "./diff.js";

const patch = ["diff --git a/x b/x", "--- a/x", "+++ b/x",
  "@@ -1,3 +1,4 @@", " a", "-b", "+B", "+B2", " c", "@@ -10,1 +11,1 @@", "-z", "\\ No newline at end of file"].join("\n");
const s = (x) => x && `${x.kind}${x.n}:${x.text}`;
assert.deepEqual(pairRows(patch).map((r) => r.hunk ? "hunk" : [s(r.l), s(r.r)]), [
  "hunk",
  [" 1:a", " 1:a"],
  ["-2:b", "+2:B"],
  [null, "+3:B2"],
  [" 3:c", " 4:c"],
  "hunk",
  ["-10:z", null],
]);
assert.deepEqual(unifiedRows(patch).map((r) => r.hunk ? "hunk" : `${r.kind}${r.o ?? "_"}/${r.n ?? "_"}:${r.text}`),
  ["hunk", " 1/1:a", "-2/_:b", "+_/2:B", "+_/3:B2", " 3/4:c", "hunk", "-10/_:z"]);
assert.deepEqual(countPatch(patch), { add: 2, del: 2 });
console.log("ok");
