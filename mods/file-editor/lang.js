// Which editor language a file gets: its name or extension first, else its content.
// Ambiguous extensions (.meta: Cocos is JSON, Unity is YAML) and unknown ones are sniffed.
// Languages the editor highlights: js json yaml html xml css python rust go bash sql java c lua ruby.

const BY_EXT = {
  js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "js", tsx: "js", mts: "js", cts: "js",
  json: "json", jsonc: "json", json5: "json", prefab: null, scene: null, anim: null,
  yaml: "yaml", yml: "yaml", toml: "yaml",
  html: "html", htm: "html", vue: "html", svelte: "html",
  xml: "xml", svg: "xml", plist: "xml", csproj: "xml", xaml: "xml",
  css: "css", scss: "css", less: "css",
  py: "python", rs: "rust", go: "go", sql: "sql", java: "java", kt: "java", cs: "java",
  c: "c", h: "c", cpp: "c", cc: "c", hpp: "c", m: "c", lua: "lua", rb: "ruby",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash", env: "bash",
};
const BY_NAME = { Dockerfile: "bash", Makefile: "bash", Gemfile: "ruby", Rakefile: "ruby", ".env": "bash", ".bashrc": "bash", ".zshrc": "bash" };
const SHEBANG = { node: "js", bun: "js", deno: "js", python: "python", python3: "python", ruby: "ruby", lua: "lua", sh: "bash", bash: "bash", zsh: "bash" };

// From the first 2 KB: JSON, YAML (Unity's %YAML and fileFormatVersion), XML/HTML, shebangs.
export function sniff(text) {
  const head = text.slice(0, 2048).replace(/^\uFEFF/, "");
  const first = head.trimStart();
  const bang = /^#!\s*(?:\S*\/)?(?:env\s+)?(\w+)/.exec(head);
  if (bang) return SHEBANG[bang[1]] ?? "bash";
  if (/^[{[]/.test(first)) return "json";
  if (/^<!doctype html|^<html/i.test(first)) return "html";
  if (first.startsWith("<")) return "xml";
  if (/^%YAML|^---\s*$/m.test(first.split("\n")[0]) || /^[\w.-]+:(\s|$)/.test(first)) return "yaml";
  return null;
}

// overrides: file-editor.json "languages" (extension or file name -> language), beats everything.
export function language(path, text, overrides = {}) {
  const name = path.split(/[\\/]/).pop();
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  if (overrides[name] || overrides[ext]) return overrides[name] || overrides[ext];
  if (BY_NAME[name]) return BY_NAME[name];
  if (name.startsWith(".env")) return "bash";
  return BY_EXT[ext] ?? sniff(text) ?? (ext || "text");
}

// Theme colors for a language: base syntax with that language's overrides on top.
// Only #hex values pass ("//" notes and typos would make the editor throw).
export function syntaxFor(lang, config) {
  const all = { ...(config?.syntax ?? {}), ...(config?.languageSyntax?.[lang] ?? {}) };
  return Object.fromEntries(Object.entries(all).filter(([, v]) => /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)));
}
