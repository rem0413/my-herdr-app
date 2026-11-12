# Workspace sidebar

Personal clone of Herdr Spaces. `layouts/main-layout.json` uses `workspaces` and `workspace-agents`; shipped mods remain unchanged.

- `sidebar-lists` is a stack: the Spaces | Agents bar at the top of each mod switches it with `layout.select`.
- Each space lists its tabs (not settled) under it on a tree line: an icon for the program running now, the tab name, then the agent state (spinner = working, dot = done, ring = idle, "Needs you" = blocked). Clicking a row opens that tab.
- Under each tab, its agents' live sub-agents on a nested tree line, display only: terminals started with a parent (`hc run`) and in-process subagents of Claude Code, Codex and OMP. The latter come from `shared("agents.children")`, which `workspace-agents` reads and publishes, so they need that mod in the layout (a hidden stack child still publishes).
- The checkout's newest PR sits at the right of the row (`pr-status.js`, from munza/herdr-mods better-sidebar, Apache-2.0). Green = open, gray = draft, purple = merged, red = closed or checks failed. Cmd-click opens it. It needs `gh` logged in locally and refreshes at most once a minute.

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
