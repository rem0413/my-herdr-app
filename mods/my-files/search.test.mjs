// node mods/my-files/search.test.mjs
import assert from "node:assert/strict";
import { matchFiles, bytes, parseListing } from "./search.js";

const files = ["src/app.ts", "src/ui/App.tsx", "docs/app-notes.md", "lib/mapper.ts", "README.md"];
const lower = files.map((f) => f.toLowerCase());
// exact name, then prefix, then contains, then path-only; ties by length.
assert.deepEqual(matchFiles(files, lower, "app.ts").files, ["src/app.ts", "src/ui/App.tsx"]);
assert.deepEqual(matchFiles(files, lower, "app").files, ["src/app.ts", "src/ui/App.tsx", "docs/app-notes.md", "lib/mapper.ts"]);
assert.deepEqual(matchFiles(files, lower, "src app").files, ["src/app.ts", "src/ui/App.tsx"]);
assert.deepEqual(matchFiles(files, lower, "  ").files, []);
assert.equal(matchFiles(files, lower, "a", 2).total, 5);
assert.equal(matchFiles(files, lower, "a", 2).files.length, 2);

assert.equal(bytes(0), "0 B");
assert.equal(bytes(1536), "1.5 KB");
assert.equal(bytes(50 * 1048576), "50 MB");
assert.equal(bytes(undefined), "");

const list = parseListing(["f", "a b", "d", "dir", "o", "dang", "f", "c'd", "s", "0", "s", "12", ""].join("\0"));
assert.deepEqual(list, [{ name: "a b", dir: false, size: 0 }, { name: "dir", dir: true }, { name: "dang", dir: false }, { name: "c'd", dir: false, size: 12 }]);
// a file vanished between listing and stat: no sizes rather than shifted ones.
assert.equal(parseListing(["f", "x", "f", "y", "s", "1", ""].join("\0"))[0].size, undefined);
console.log("ok search");
