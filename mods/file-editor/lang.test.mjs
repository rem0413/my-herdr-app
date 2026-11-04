// node mods/file-editor/lang.test.mjs
import assert from "node:assert/strict";
import { language, syntaxFor } from "./lang.js";

const cases = [
  ["a/x.png.meta", '{\n  "ver": "1.0.25",\n  "uuid": "abc"\n}', "json"],            // Cocos Creator
  ["a/x.png.meta", "fileFormatVersion: 2\nguid: 0123\nTextureImporter:\n", "yaml"], // Unity
  ["a/Hero.prefab", "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!1 &1\n", "yaml"],
  ["a/Hero.prefab", '[\n  { "__type__": "cc.Prefab" }\n]', "json"],
  ["a/x.ts", "const a: number = 1", "js"],
  ["a/run", "#!/usr/bin/env python3\nprint(1)", "python"],
  ["a/run", "#!/bin/sh\necho", "bash"],
  ["a/.env.local", "A=1", "bash"],
  ["a/Dockerfile", "FROM node", "bash"],
  ["a/x.unknown", "<root/>", "xml"],
  ["a/x.unknown", "\uFEFF{}", "json"],
  ["a/notes", "just some words", "text"],
  ["a/x.md", "# Title", "md"],
];

// Config: overrides beat detection; per-language syntax layers on base.
assert.equal(language("a/build.gradle", "x", { gradle: "java" }), "java");
assert.equal(language("a/x.meta", "{}", { meta: "yaml" }), "yaml");
assert.deepEqual(syntaxFor("xml", { syntax: { "//": "note", string: "#111111", function: "#222", bad: "red" }, languageSyntax: { xml: { function: "#333333" } } }), { string: "#111111", function: "#333333" });
console.log("ok config");
for (const [path, text, want] of cases) assert.equal(language(path, text), want, `${path}: ${JSON.stringify(text.slice(0, 20))}`);
console.log(`ok ${cases.length}`);
