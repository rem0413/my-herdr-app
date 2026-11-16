// node mods/file-editor/csv.test.mjs
import assert from "node:assert/strict";
import { parseCsv, delimiterFor } from "./csv.js";

assert.deepEqual(parseCsv("a,b\n1,2\n").rows, [["a", "b"], ["1", "2"]]);
assert.deepEqual(parseCsv("a,b\r\n1,2").rows, [["a", "b"], ["1", "2"]]);
assert.deepEqual(parseCsv('"x, y","say ""hi"""\n').rows, [["x, y", 'say "hi"']]);
assert.deepEqual(parseCsv('"line\nbreak",z').rows, [["line\nbreak", "z"]]);
assert.deepEqual(parseCsv("a,,c\n,\n").rows, [["a", "", "c"], ["", ""]]);
assert.deepEqual(parseCsv("﻿h1,h2").rows, [["h1", "h2"]]);
assert.deepEqual(parseCsv("a\tb", "\t").rows, [["a", "b"]]);
const cut = parseCsv("1\n2\n3\n4\n", ",", 2);
assert.deepEqual(cut, { rows: [["1"], ["2"]], truncated: true });
assert.equal(parseCsv("1\n2\n", ",", 2).truncated, false);
assert.equal(delimiterFor("x.tsv", "a,b"), "\t");
assert.equal(delimiterFor("x.csv", "a;b;c\n1,2"), ";");
assert.equal(delimiterFor("x.csv", '"a;b",c'), ",");
console.log("ok csv");
