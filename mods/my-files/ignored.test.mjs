// Run: node mods/my-files/ignored.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = mkdtempSync(join(tmpdir(), "herdr-ignore-"));
const git = (...args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
};
try {
  git("init", "-q");
  writeFileSync(join(root, ".gitignore"), "cache/\n*.log\n!keep.log\n");
  mkdirSync(join(root, "cache"));
  for (const name of ["debug.log", "keep.log", "tracked.log", "normal.txt", "cache/child.txt"]) writeFileSync(join(root, name), "");
  git("add", "-f", "tracked.log");
  const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
  const method = source.slice(source.indexOf("  async loadFolder("), source.indexOf("\n  refresh(cx)"));
  const exec = async (cmd, args, options) => {
    const result = spawnSync(cmd, args, { cwd: options.cwd, encoding: "utf8" });
    return { code: result.status, stdout: result.stdout };
  };
  const directory = async path => path === root
    ? ["cache", "debug.log", "keep.log", "tracked.log", "normal.txt"].map(name => ({ name, dir: name === "cache" }))
    : [{ name: "child.txt", dir: false }];
  const Files = new Function("exec", "directory", "PER_FOLDER", "TOTAL", `return class { ${method} }`)(exec, directory, 500, 5000);
  const files = new Files();
  Object.assign(files, { entries: new Map(), folders: new Set(["cache"]), current: () => true });
  await files.loadFolder("", { cwd: root });
  assert.deepEqual(Object.fromEntries(files.entries.get("").map(e => [e.name, e.ignored])), {
    cache: true, "debug.log": true, "keep.log": false, "normal.txt": false, "tracked.log": false,
  });
  await files.loadFolder("cache", { cwd: root });
  assert.equal(files.entries.get("cache")[0].ignored, true);
  console.log("Ignored files, folders, descendants, negations and tracked files: passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
