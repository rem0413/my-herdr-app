"""Running in-process subagents of Claude Code and Codex terminals, read from their own files.

Read-only: never writes agent sessions or databases. Runs on the machine the agents live on.
argv[1]: JSON {"agents": [{"address": "t7", "kind": "claude" | "codex"}]} with bare addresses.
Prints {"nodes": [{address, parent, name, task, status, state}]}; parents are bare addresses
of the agent terminal or another node's address.
"""
import glob
import json
import os
import re
import sqlite3
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
TAIL = 256 * 1024
# A Claude subagent whose transcript hasn't changed this long is taken as gone: one stopped
# with TaskStop or lost in a crash never gets `finished` written.
CLAUDE_STALE_S = 15 * 60


def foreground_pid(address):
    result = subprocess.run(["hc", "get", address, "--json"], capture_output=True, text=True, timeout=10)
    if result.returncode:
        return None
    pid = (json.loads(result.stdout).get("foreground") or {}).get("pid")
    return pid if isinstance(pid, int) else None


def node(address, parent, name, task):
    return {"address": address, "parent": parent, "name": name, "task": task, "status": "working", "state": "live"}


def claude_dirs():
    dirs = [os.environ.get("CLAUDE_CONFIG_DIR")] if os.environ.get("CLAUDE_CONFIG_DIR") else []
    try:
        dirs += [os.path.join(HOME, d) for d in os.listdir(HOME) if d.startswith(".claude")]
    except OSError:
        pass
    real = dict.fromkeys(os.path.realpath(d) for d in dirs)
    return [d for d in real if os.path.isdir(os.path.join(d, "sessions"))]


def claude(address, pid, dirs):
    for config in dirs:
        try:
            with open(os.path.join(config, "sessions", f"{pid}.json")) as f:
                session = json.load(f)
        except (OSError, ValueError):
            continue
        sid = session.get("sessionId") or ""
        if not re.fullmatch(r"[0-9A-Za-z-]+", sid):
            continue
        slug = re.sub(r"[^A-Za-z0-9]", "-", session.get("cwd") or "")
        folder = os.path.join(config, "projects", slug, sid, "subagents")
        if not os.path.isdir(folder):
            found = glob.glob(os.path.join(config, "projects", "*", sid, "subagents"))
            if not found:
                return []
            folder = found[0]
        running = {}
        now = time.time()
        for meta_path in glob.glob(os.path.join(folder, "agent-*.meta.json")):
            try:
                with open(meta_path) as f:
                    meta = json.load(f)
                transcript = meta_path[: -len(".meta.json")] + ".jsonl"
                touched = os.path.getmtime(transcript) if os.path.exists(transcript) else os.path.getmtime(meta_path)
            except (OSError, ValueError):
                continue
            if meta.get("finished") or now - touched > CLAUDE_STALE_S:
                continue
            agent_id = os.path.basename(meta_path)[len("agent-"): -len(".meta.json")]
            running[agent_id] = meta
        nodes = []
        for agent_id, meta in running.items():
            parent = meta.get("parentAgentId")
            # A parent that already finished leaves its child under the session's own agent.
            parent_address = f"claude:{parent}" if parent in running else address
            name = meta.get("description") or meta.get("agentType") or "subagent"
            nodes.append(node(f"claude:{agent_id}", parent_address, name, meta.get("agentType") or ""))
        return nodes
    return []


def descendants(pid):
    listed = subprocess.run(["ps", "-A", "-o", "pid=,ppid="], capture_output=True, text=True, timeout=10).stdout
    kids = {}
    for line in listed.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            kids.setdefault(int(parts[1]), []).append(int(parts[0]))
    found, frontier = [pid], [pid]
    while frontier:
        frontier = [k for p in frontier for k in kids.get(p, []) if k not in found]
        found += frontier
    return found


def codex_owned(pid):
    """Thread ids this Codex terminal writes (they hold their lock files open), and its Codex home.
    Interactive Codex writes from a child `codex app-server`, so its descendants count too."""
    pids = ",".join(str(p) for p in descendants(pid))
    # No -b: with it, lsof leaves these lock files out of its list.
    opened = subprocess.run(["lsof", "-nP", "-a", "-p", pids, "-Fn"], capture_output=True, text=True, timeout=10)
    ids, home = set(), None
    for line in opened.stdout.splitlines():
        match = re.match(r"^n(.*)/thread-writer-locks/([0-9A-Za-z-]+)\.lock$", line)
        if match:
            home = match.group(1)
            ids.add(match.group(2))
    return home, ids


def codex_running(rollout):
    if not rollout or not os.path.isfile(rollout) or not rollout.endswith(".jsonl"):
        return False
    with open(rollout, "rb") as f:
        f.seek(0, 2)
        f.seek(max(0, f.tell() - TAIL))
        lines = f.read().split(b"\n")
    for line in reversed(lines):
        if b'"event_msg"' not in line:
            continue
        try:
            kind = (json.loads(line).get("payload") or {}).get("type")
        except (ValueError, AttributeError):
            continue
        if kind == "task_started":
            return True
        if kind in ("task_complete", "turn_aborted"):
            return False
    return False


def codex_db(home):
    def version(path):
        match = re.search(r"state_(\d+)\.sqlite$", path)
        return int(match.group(1)) if match else -1
    found = sorted(glob.glob(os.path.join(home, "state_*.sqlite")), key=version)
    return found[-1] if found else None


def codex(address, pid):
    home, owned = codex_owned(pid)
    db = codex_db(home) if home else None
    if not db or not owned:
        return []
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2)
    try:
        edges = con.execute("SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges").fetchall()
        # Every descendant of a thread this process owns, however deep.
        children, frontier = {}, set(owned)
        while frontier:
            found = {child: parent for parent, child in edges if parent in frontier and child not in children}
            children.update(found)
            frontier = set(found)
        if not children:
            return []
        marks = ",".join("?" * len(children))
        rows = con.execute(
            f"SELECT id, agent_nickname, agent_role, agent_path, rollout_path FROM threads WHERE id IN ({marks})",
            list(children),
        ).fetchall()
    finally:
        con.close()
    running = {row[0]: row for row in rows if codex_running(row[4])}
    nodes = []
    for thread_id, nickname, role, path, _ in running.values():
        parent = children[thread_id]
        parent_address = f"codex:{parent}" if parent in running else address
        name = nickname or (path or "").rsplit("/", 1)[-1] or "subagent"
        task = " · ".join(x for x in (role, path) if x)
        nodes.append(node(f"codex:{thread_id}", parent_address, name, task))
    return nodes


def main(request):
    dirs = None
    nodes = []
    for agent in request.get("agents", []):
        address, kind = agent.get("address"), agent.get("kind")
        # One agent that can't be read must not hide every other agent's children.
        try:
            pid = foreground_pid(address)
            if not pid:
                continue
            if kind == "claude":
                dirs = dirs if dirs is not None else claude_dirs()
                nodes += claude(address, pid, dirs)
            elif kind == "codex":
                nodes += codex(address, pid)
        except (OSError, ValueError, sqlite3.Error, subprocess.TimeoutExpired):
            continue
    return {"nodes": nodes}


if __name__ == "__main__":
    try:
        print(json.dumps(main(json.loads(sys.argv[1]))))
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
