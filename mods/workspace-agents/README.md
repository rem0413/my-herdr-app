# Workspace agents: native OMP children

The Agents panel reads native OMP task transcripts without hooks or changing how tasks launch. Existing herdr-core terminal children remain supported.

Local macOS OMP processes are matched to root sessions using `hc get` foreground PID and `lsof` open-file identity, never newest-session or cwd guesses. Discovery runs when OMP terminals appear/disappear or OMP session-owner files change. Python 3 and macOS `/usr/sbin/lsof` must be available.

Process discovery passes `lsof -nP -b` to skip hostname/port resolution and blocking kernel operations; the subprocess retains a 10-second deadline. Discovery failures preserve the previous child snapshot and show a dismissible warning. The × button hides the current warning without modifying agent sessions; a later failure can report a new warning.

Herdr `watchFolder` watches OMP session-owner and active project-session directories. Events inside any active child artifact scope trigger refresh, coalesced for 250 ms; directory-level events also refresh. Shared project directories cover every active root, not only the first. Each child reader retains its byte offset and metadata in memory and reads only appended complete JSONL records. Initial discovery reads existing child history once. No periodic transcript scan runs. Unchanged visible snapshots do not notify the UI. Watchers and async tasks belong to the mod and stop when Herdr unloads it.

Only working native OMP children appear beneath their parent, with the OMP program logo and assigned agent name. Child lists are collapsed by default; the parent's chevron and count expand or collapse them. Child rows are display-only: clicking does not open a transcript, tab, or terminal.

Status follows persisted user/assistant messages: user or tool-use continuation is working, assistant stop is done, assistant error is blocked. Only working children enter the visible list. These are last-recorded states, not a live runtime heartbeat; a process crash or an unrecorded pending request cannot be proven from transcripts. Remote OMP sessions and Claude native children are not handled by this reader.

Check:

```sh
python3 mods/workspace-agents/omp-reader-check.py
herdr-app check ~/.config/herdr-app/mods/workspace-agents
```

Verified on 2026-11-04: three real native OMP tasks (ReaderCheck, WatcherCheck, DisplayCheck) appeared together with OMP logos and assigned names. A resumed ReaderCheck disappeared after completion without a mod edit. Native mod check and incremental-reader checks passed. A temporary tab rendered a real transcript and was closed after inspection.
