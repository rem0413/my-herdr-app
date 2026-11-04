import assert from "node:assert/strict";
import { tabTitle } from "./title.js";
const auto = { name: "1", named: false };
const pane = { title: "🔀 SCM: Build source control mod", program: { name: "omp", key: "omp" } };
assert.equal(tabTitle(auto, pane), "🔀 SCM: Build source control mod");
assert.equal(tabTitle({ name: "Login fix", named: true }, pane), "Login fix");
assert.equal(tabTitle(auto, { ...pane, title: "🔧 Fix auth" }), "🔧 Fix auth");
for (const title of ["", "omp", "~/repo", "/tmp/repo", "C:\\repo", "user@host:repo"]) {
  assert.equal(tabTitle(auto, { ...pane, title }), "omp");
}
assert.equal(tabTitle(auto), "1");
assert.equal(tabTitle({ name: "notes.md", named: true }), "notes.md");
console.log("ok live tab titles, explicit names, shell fallback");
