// Listening TCP ports on this computer and on every machine that holds spaces, each matched to a space.
// One `sh` per machine per scan; a process's folder and Herdr terminal are cached per [machine, pid]
// (neither changes while it runs), so only new pids cost more than the listener list.
import { exec, spaces, panes, terminals, machines } from "herdr";

export const SHARED_KEY = "ports.scan";     // { rows: Row[], errors: { [machine]: text } }
export const RESCAN_KEY = "ports.rescan";   // a timestamp: the popup asks for a scan now

// Prints `lsof -F pcn` listener records, then "X<pid>\t<HC_TERMINAL_ID>\t<cwd>" for pids not in "$@".
// HC_TERMINAL_ID comes from /proc (Linux) or `ps -E` (macOS); children inherit it, also after nohup.
const SCRIPT = `skip=" $* "
out=$(lsof -nP +c 0 -iTCP -sTCP:LISTEN -F pcn 2>/dev/null) || [ -n "$out" ] || command -v lsof >/dev/null || { echo "lsof not found" >&2; exit 2; }
printf '%s\\n' "$out"
for p in $(printf '%s\\n' "$out" | sed -n 's/^p//p' | sort -u); do
  case "$skip" in *" $p "*) continue;; esac
  c=$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
  if [ -r "/proc/$p/environ" ]; then h=$(tr '\\0' '\\n' < "/proc/$p/environ" 2>/dev/null | sed -n 's/^HC_TERMINAL_ID=//p' | head -1)
  else h=$(ps -E -ww -o command= -p "$p" 2>/dev/null | grep -o 'HC_TERMINAL_ID=[^ ]*' | head -1 | cut -d= -f2); fi
  printf 'X%s\\t%s\\t%s\\n' "$p" "$h" "$c"
done`;

const info = new Map(); // JSON [machine, pid] -> { terminal, cwd }
const k = (on, pid) => JSON.stringify([on, pid]);

function parse(on, text) {
  const rows = new Map();
  let pid = 0, command = "";
  for (const line of text.split("\n")) {
    const tag = line[0], value = line.slice(1);
    if (tag === "p") pid = Number(value);
    else if (tag === "c") command = value;
    else if (tag === "n" && pid) {
      const port = Number(value.slice(value.lastIndexOf(":") + 1));
      if (port && !rows.has(`${pid}:${port}`)) rows.set(`${pid}:${port}`, { machine: on, pid, port, command, address: value.replace(/^\*/, "0.0.0.0") });
    } else if (tag === "X") {
      const [p, terminal, cwd] = value.split("\t");
      info.set(k(on, Number(p)), { terminal: terminal || null, cwd: cwd || null });
    }
  }
  return [...rows.values()];
}

async function scanMachine(on) {
  const cached = [...info.keys()].map(JSON.parse).filter(([m]) => m === on).map(([, p]) => String(p));
  const r = await exec("sh", ["-c", SCRIPT, "ports", ...cached], { on, timeout: 15000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
  const rows = parse(on, r.stdout);
  const live = new Set(rows.map((x) => k(on, x.pid)));
  for (const key of info.keys()) if (JSON.parse(key)[0] === on && !live.has(key)) info.delete(key);
  return rows;
}

// A space's folders: its own and its terminals' live ones.
// ponytail: folders 2 levels deep or less ("/", "/Users/me", "/home/me") are skipped, else home would claim every process.
function owners() {
  const shallow = (d) => !d || d.split("/").filter(Boolean).length < 3;
  return spaces().map((s) => {
    const tabs = new Set(s.tabs.map((t) => t.id));
    const dirs = [s.folder, ...panes().filter((p) => tabs.has(p.tab)).map((p) => p.cwd)];
    return { id: s.id, machine: s.machine ?? null, roots: [...new Set(dirs)].filter((d) => !shallow(d)) };
  });
}
const inside = (dir, root) => dir === root || dir?.startsWith(root + "/");

// The space of a Herdr terminal: the tab its pane is in, else its herdr.space label.
function spaceOfTerminal(address) {
  const pane = panes().find((p) => p.terminal === address);
  const bySpace = pane && spaces().find((s) => s.tabs.some((t) => t.id === pane.tab))?.id;
  if (bySpace) return bySpace;
  const label = terminals().find((t) => t.address === address)?.labels?.["herdr.space"];
  const machine = address.includes("/") ? address.split("/")[0] : null;
  return label ? (machine ? `${machine}/${label}` : label) : null;
}

// Scans in parallel; a machine that fails keeps its rows from `previous`.
export async function scan(previous) {
  const down = new Set(machines().filter((m) => m.layout === "unavailable").map((m) => m.name));
  const targets = [null, ...new Set(spaces().map((s) => s.machine).filter((m) => m && !down.has(m)))];
  const results = await Promise.allSettled(targets.map(scanMachine));
  const own = owners();
  const rows = [], errors = {};
  results.forEach((r, i) => {
    const on = targets[i];
    if (r.status === "rejected") {
      errors[on ?? "this computer"] = String(r.reason?.message ?? r.reason);
      rows.push(...(previous?.rows ?? []).filter((x) => x.machine === on));
      return;
    }
    for (const row of r.value) {
      const { terminal, cwd } = info.get(k(on, row.pid)) ?? {};
      const address = terminal && (on ? `${on}/${terminal}` : terminal);
      const space = (address && spaceOfTerminal(address))
        || own.find((s) => s.machine === on && s.roots.some((root) => inside(cwd, root)))?.id || null;
      rows.push({ ...row, terminal: address || null, cwd: cwd || null, space });
    }
  });
  rows.sort((a, b) => (a.machine ?? "").localeCompare(b.machine ?? "") || a.port - b.port);
  return { rows, errors };
}
