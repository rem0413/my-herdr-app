# Workspace sidebar

Personal clone of Herdr Spaces. `layouts/main-layout.json` uses `workspaces` and `workspace-agents`; shipped mods remain unchanged.

- Drag onto the top/bottom half of a row and release promptly to reorder before/after it, at its parent level. A horizontal line previews insertion. Hold over the row for 700 ms until its border highlights to make it a child instead. Child rows use folder icons. Descendants move with their parent. Cycles and cross-machine parents are refused; terminals are never migrated between machines.
- Root rows use a hierarchy icon; child rows use an outlined folder. Drag onto empty space below the rows to detach a space from its parent; no dedicated drop-target label is shown.
- Right-click for Pin/Unpin and Set parent. Pinned closed entries remain listed; closed ancestors remain while they have retained children.
- Remote spaces arrive through Herdr's connected-machine model. Unknown/offline machines do not lose saved entries. Reopening sends `space.new` to the saved machine with the saved folder. Adoption requires a unique new space matching machine and folder; ambiguous spaces remain separate.
- `shared("workspace.tree")` stores stable entry IDs and core-space links. `shared("workspace.rows")` publishes the complete effective hierarchy, including automatic worktree parents and folded descendants, for the Agents panel.
- Agents' Grouped by space view uses this hierarchy. Its folds are independent of Spaces. Priority, pinned agents, and sub-agent trees retain their existing behavior.

Checks:

```sh
bun mods/workspaces/tree.check.js
herdr-app check mods/workspaces
herdr-app check mods/workspace-agents
```

Remote regression cases run without SSH. A real remote smoke requires a connected non-temporary machine; this installation had none during implementation.
