# Agent children

A headless mod, docked in a 0px block of the layout so it runs from start whatever the sidebar shows. It reads agents' in-process children (OMP tasks, Claude Code and Codex subagents) on every machine and publishes them as shared `agents.children`, with the latest discovery error as `agents.children.error`. The `workspaces` (Spaces) and `workspace-agents` (Agents) lists only read that key; neither polls. Children started as terminals (`hc run`) come from `terminals()` and need no reader.

It reads native OMP task transcripts without hooks or changing how tasks launch.

Local macOS OMP processes are matched to root sessions using `hc get` foreground PID and `lsof` open-file identity, never newest-session or cwd guesses. Discovery runs when OMP terminals appear/disappear or OMP session-owner files change. Python 3 and macOS `/usr/sbin/lsof` must be available.

Process discovery passes `lsof -nP -b` to skip hostname/port resolution and blocking kernel operations; the subprocess retains a 10-second deadline. Discovery failures preserve the previous child snapshot and are published as `agents.children.error`; the Agents list shows it as a dismissible warning. The × button hides the current warning without modifying agent sessions; a later failure can report a new warning.

Herdr `watchFolder` watches OMP session-owner and active project-session directories. Events inside any active child artifact scope trigger refresh, coalesced for 250 ms; directory-level events also refresh. Shared project directories cover every active root, not only the first. Each child reader retains its byte offset and metadata in memory and reads only appended complete JSONL records. Initial discovery reads existing child history once. No periodic transcript scan runs. Unchanged visible snapshots do not notify the UI. Watchers and async tasks belong to the mod and stop when Herdr unloads it. Only working children enter the published list.

Only working native OMP children are published, with the OMP program and assigned agent name. In the lists, child rows are display-only: clicking does not open a transcript, tab, or terminal.

Status follows persisted user/assistant messages: user or tool-use continuation is working, assistant stop is done, assistant error is blocked. These are last-recorded states, not a live runtime heartbeat; a process crash or an unrecorded pending request cannot be proven from transcripts. Remote OMP sessions and Claude/Codex native children are handled by `native.js` (below).

## Claude Code and Codex subagents, and remote OMP

`native.js` lists in-process subagents of Claude Code and Codex under their parent, on this computer and on other machines, without hooks. `native-children.py` runs on the agents' machine (by path here, as `python3 -c <source>` through `exec({on})` elsewhere) and resolves each terminal's foreground PID with `hc get`:

- Claude Code: `<config>/sessions/<pid>.json` gives the session; each `projects/<cwd>/<session>/subagents/agent-<id>.meta.json` without `finished` is running. `parentAgentId` nests children. A subagent whose transcript hasn't changed for 15 minutes is dropped (TaskStop and crashes never write `finished`).
- Codex: the process holds `thread-writer-locks/<thread>.lock` open for its threads (`lsof`); `thread_spawn_edges` in `state_*.sqlite` (opened `mode=ro`) gives descendants. The edge `status` stays `open` after a child ends, so a child is running only while the last of `task_started` / `task_complete` / `turn_aborted` in its rollout is `task_started`.
- OMP on other machines: `omp-reader.py` with the request passed inline; its incremental state is kept per machine in the mod.

It polls every 2 s here and 5 s on other machines, only while such agents are live there. Each machine needs `python3`, `hc` and (for Codex and OMP) `lsof`. These are undocumented on-disk formats, verified with Claude Code 2.1.322 and Codex 0.162.1; a format change hides the rows rather than erroring.

Check:

```sh
python3 mods/agent-children/omp-reader-check.py
herdr-app check ~/.config/herdr-app/mods/agent-children
```

Verified on 2026-11-04: three real native OMP tasks (ReaderCheck, WatcherCheck, DisplayCheck) appeared together with OMP logos and assigned names. A resumed ReaderCheck disappeared after completion without a mod edit. Native mod check and incremental-reader checks passed. A temporary tab rendered a real transcript and was closed after inspection.
