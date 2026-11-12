// Run: node --experimental-vm-modules mods/file-editor/editor.test.mjs
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, symlink, chmod, stat, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

const data = new Map(), calls = [], jobs = [], notices = [];
let tabs = [{ id: 'shell' }];
let execImpl = async () => { throw new Error('stat unavailable'); };
const shared = key => data.get(key);
const setShared = (key, value) => data.set(key, value);
const spaces = () => [{ id: 'space', tabs }];
const run = (command, args) => {
  calls.push([command, args]);
  if (command === 'tab.close') tabs = tabs.filter(t => t.id !== args.id);
};
const host = { shared, setShared, spaces, run, notify: n => notices.push(n), hc: async () => ({ code: 0, stdout: '' }), home: () => '',
  panes: () => [], props: () => ({}), theme: () => ({}), settings: () => ({}), window: () => ({}),
  appHome: () => '', exec: (...a) => execImpl(...a),
  readTextFile: path => readFile(path, 'utf8'),
  writeTextFile: async (path, text, expected) => {
    if (await readFile(path, 'utf8') !== expected) throw new Error('Changed on disk');
    await writeFile(path, text);
  }, watchFolder: () => {}, focused: () => null, openOverlay: () => {} };
async function load(path, extra = '') {
  const mod = new vm.SourceTextModule(await readFile(path, 'utf8') + extra);
  await mod.link(async name => {
    const values = name === 'herdr' ? host : name === 'gpui-kit' ? { View: class {}, div() {}, svg() {}, image() {} }
      : name === 'gpui-base' ? { v_flex() {}, h_flex() {}, Editor: {}, EditorState: {}, TextView: {}, InputState: {}, Input: {}, Scrollbar: {}, v_virtual_list() {} }
      : name === './lang.js' ? { language() {}, syntaxFor() {} }
      : name === './search.js' ? { matchFiles() {}, bytes() {}, parseListing() {} } : { iconFor() {} };
    return new vm.SyntheticModule(Object.keys(values), function () { for (const [k, v] of Object.entries(values)) this.setExport(k, v); });
  });
  await mod.evaluate();
  return mod.namespace;
}
const { openFile } = await load('mods/my-files/main.js', '\nexport { openFile };');
tabs.push({ id: 'preview' });
data.set('editor.tabs', { 'space|/a.txt': 'preview' });
data.set('editor.preview', { space: 'preview' });
data.set('editor.state', { preview: { dirty: false } });
openFile('space', '/b.txt', null, null);
assert.equal(tabs.some(t => t.id === 'preview'), false, 'clean preview replaced');
assert.equal(calls.at(-1)[1].props.preview, true);
tabs.push({ id: 'preview' });
data.set('editor.state', { preview: { dirty: true } });
calls.length = 0;
openFile('space', '/b.txt', null, null);
assert(!calls.some(([c]) => c === 'tab.close'), 'dirty preview must survive');
openFile('space', '/a.txt', null, null, { keep: true });
assert.equal(shared('editor.preview').space, undefined, 'double-click promotes existing preview');
assert.equal(calls.at(-1)[0], 'tab.select', 'existing file reused');

const { default: FileEditor, writeRemote } = await load('mods/file-editor/main.js', '\nexport { writeRemote };');
const folder = await mkdtemp(join(tmpdir(), 'herdr-editor-test-'));
try {
  const file = join(folder, 'text.txt');
  await writeFile(file, 'original');
  const editor = new FileEditor();
  Object.assign(editor, { file, original: 'original', dirty: true, state: { value: () => 'edited' }, publish() {} });
  const cx = { notify() {}, spawn(fn) { jobs.push(fn(cx)); } };
  let closed = false;
  editor.save(cx, () => { closed = true; });
  await Promise.all(jobs.splice(0));
  assert.equal(await readFile(file, 'utf8'), 'edited');
  assert.equal(editor.dirty, false);
  assert.equal(closed, true);
  await writeFile(file, 'external edit');
  editor.dirty = true; closed = false;
  editor.save(cx, () => { closed = true; });
  await Promise.all(jobs.splice(0));
  assert.equal(await readFile(file, 'utf8'), 'external edit', 'conflicting save preserves disk');
  assert.equal(editor.dirty, true, 'conflicting save preserves unsaved buffer');
  assert.equal(closed, false, 'failed save must not close tab');
  assert.equal(notices.at(-1).level, 'error');

  // Typing while a save is in flight stays unsaved, and a save-and-close keeps the tab open.
  await writeFile(file, 'edited');
  let buffer = 'second';
  Object.assign(editor, { original: 'edited', dirty: true, state: { value: () => buffer } });
  closed = false;
  editor.save(cx, () => { closed = true; });
  buffer = 'second, then more';
  await Promise.all(jobs.splice(0));
  assert.equal(await readFile(file, 'utf8'), 'second');
  assert.equal(editor.dirty, true, 'edits typed during a save stay dirty');
  assert.equal(closed, false, 'save-and-close must not drop edits typed during the save');

  // Remote save, with a real sh: through a symlink, keeping the mode, an emoji across a chunk edge.
  execImpl = (cmd, args) => new Promise(res => execFile(cmd, args, (e, stdout, stderr) => res({ code: e ? e.code ?? 1 : 0, stdout, stderr })));
  const target = join(folder, 'remote.md'), link = join(folder, 'link.md');
  await writeFile(target, 'old'); await chmod(target, 0o640); await symlink(target, link);
  const big = 'a'.repeat(29999) + '😀' + 'b'.repeat(40000);
  await writeRemote(link, big, 'old', 'vps');
  assert.equal(await readFile(target, 'utf8'), big, 'remote save keeps every character');
  assert.equal((await lstat(link)).isSymbolicLink(), true, 'remote save keeps the link');
  assert.equal((await stat(target)).mode & 0o777, 0o640, 'remote save keeps the mode');
  await assert.rejects(writeRemote(link, 'x', 'stale', 'vps'), /Changed on disk/);
} finally { await rm(folder, { recursive: true, force: true }); }
console.log('PASS: preview replacement, dirty preservation, promotion, reuse, save, conflict protection, edits during save, remote save');
