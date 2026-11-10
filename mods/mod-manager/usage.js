// Layout references include pane headers, stack headers, floating blocks and menus.
export function usesMod(node, name) {
  if (!node || typeof node !== "object") return false;
  return node.mod === name || node.terminal_menu === name
    || Object.values(node).some(value => usesMod(value, name));
}

export function usage(name, tree, { disabled = false, pane = false, overlay = false } = {}) {
  let mounted = false, visible = false;
  function visit(node, shown = true) {
    if (!node || typeof node !== "object") return;
    shown = shown && !node.hidden;
    if (node.content?.mod === name) { mounted = true; visible ||= shown; }
    if (node.header?.mod === name || node.header?.content?.mod === name) {
      mounted = true; visible ||= shown;
    }
    const frame = node.content?.pane?.header?.content;
    if (frame?.mod === name) { mounted = true; visible ||= shown; }
    for (const child of node.children ?? []) visit(child, shown && (node.type !== "stack" || child.id === node.active));
    for (const child of node.floating ?? []) visit(child, shown);
  }
  visit(tree);
  if (overlay) return "Running · overlay";
  if (disabled) return "Off · disabled by kit";
  if (visible) return "Running · current layout";
  if (pane) return "Loaded · tab pane";
  if (mounted) return "Hidden · may remain running";
  if (tree?.terminal_menu === name || (!tree?.terminal_menu && name === "menu")) return "On demand · terminal menu";
  return "Not in current layout / open panes";
}
