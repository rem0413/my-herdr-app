// Run: node --experimental-vm-modules mods/file-editor/editor.test.mjs
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

const data = new Map(), calls = [], jobs = [], notices = [];
let tabs = [{ id: 'shell' }];
const shared = key => data.get(key);
const setShared = (key, value) => data.set(key, value);
const spaces = () => [{ id: 'space', tabs }];
const run = (command, args) => {
  calls.push([command, args]);
  if (command === 'tab.close') tabs = tabs.filter(t => t.id !== args.id);
};
const host = { shared, setShared, spaces, run, notify: n => notices.push(n),
  panes: () => [], props: () => ({}), theme: () => ({}), settings: () => ({}), window: () => ({}),
  appHome: () => '', exec: async () => { throw new Error('stat unavailable'); },
  readTextFile: path => readFile(path, 'utf8'),
  writeTextFile: async (path, text, expected) => {
    if (await readFile(path, 'utf8') !== expected) throw new Error('Changed on disk');
    await writeFile(path, text);
  }, watchFolder: () => {}, focused: () => null, openOverlay: () => {} };
async function load(path, extra = '') {
  const mod = new vm.SourceTextModule(await readFile(path, 'utf8') + extra);
  await mod.link(async name => {
    const values = name === 'herdr' ? host : name === 'gpui-kit' ? { View: class {}, div() {}, svg() {}, image() {} }
      : name === 'gpui-base' ? { v_flex() {}, h_flex() {}, Editor: {}, EditorState: {}, TextView: {}, InputState: {}, Input: {} }
      : name === './lang.js' ? { language() {}, syntaxFor() {} } : { iconFor() {} };
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

const { default: FileEditor } = await load('mods/file-editor/main.js');
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
} finally { await rm(folder, { recursive: true, force: true }); }
console.log('PASS: preview replacement, dirty preservation, promotion, reuse, save, conflict protection');
