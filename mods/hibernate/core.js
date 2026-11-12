// What runs in a terminal, how to stop it, and how to start it again.
import { hc, exec, home, readTextFile } from "herdr";

const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "csh", "nu", "xonsh", "pwsh", "login"]);
const base = (s) => String(s ?? "").split("/").pop().replace(/^-/, "");
const isShell = (s) => SHELLS.has(base(s));

export async function get(address) {
  const r = await hc(["get", "--json", address]).catch(() => null);
  if (!r || r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

// null when the core can't be asked: callers must not read that as "nothing runs".
export async function list() {
  const r = await hc(["ls", "--json"]).catch(() => null);
  if (!r || r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout).terminals ?? [];
  } catch {
    return null;
  }
}

// The program running in a terminal now, or null for an idle shell.
export function program(g) {
  const f = g?.foreground;
  if (!f || g.state !== "live") return null;
  if (f.pid === g.pid && isShell(f.argv?.[0] ?? f.name)) return null;
  return f;
}

export const idleShell = (g) => g?.state === "live" && !!g.foreground && program(g) === null;

function kind(g, f) {
  const app = g.status?.app;
  const b = base(f.argv?.[0]);
  if (app === "claude-code" || b === "claude") return "claude";
  if (app === "codex" || b === "codex") return "codex";
  if (app === "omp" || b === "omp") return "omp";
  return "program";
}

async function claudeSession(pid) {
  const text = await readTextFile(`${home()}/.claude/sessions/${pid}.json`).catch(() => null);
  try {
    return text ? JSON.parse(text).sessionId ?? null : null;
  } catch {
    return null;
  }
}

// Codex keeps its rollout file open; its name ends with the session id.
async function codexSession(pid) {
  const kids = await exec("pgrep", ["-P", String(pid)]).catch(() => null);
  const pids = [String(pid), ...(kids?.stdout ?? "").split(/\s+/).filter(Boolean)];
  const r = await exec("lsof", ["-p", pids.join(","), "-Fn"]).catch(() => null);
  const m = (r?.stdout ?? "").match(/rollout-[^\n]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/);
  return m ? m[1] : null;
}

// omp keeps its session .jsonl open; its name ends with the session id.
async function ompSession(pid) {
  const r = await exec("lsof", ["-p", String(pid), "-Fn"]).catch(() => null);
  const m = (r?.stdout ?? "").match(/\.omp\/agent\/sessions\/[^\n]*_([0-9a-f-]{36})\.jsonl/);
  return m ? m[1] : null;
}

// A snapshot entry for a terminal, or null when it runs nothing.
// `sessions`: optional Map of "<address>:<pid>" -> session id; a running program keeps
// its session, so a found id is not looked up again (lsof is not cheap).
export async function describe(g, sessions = null) {
  const f = program(g);
  if (!f) return null;
  const k = kind(g, f);
  const cacheKey = `${g.address}:${f.pid}`;
  let session = sessions?.get(cacheKey) ?? null;
  if (!session) {
    session = k === "claude" ? await claudeSession(f.pid) : k === "codex" ? await codexSession(f.pid) : k === "omp" ? await ompSession(f.pid) : null;
    if (session && sessions) sessions.set(cacheKey, session);
  }
  return {
    address: g.address,
    shellPid: g.pid,
    argv: f.argv ?? [],
    cwd: f.cwd || g.cwd,
    kind: k,
    session,
    name: k === "claude" ? "Claude Code" : k === "codex" ? "Codex" : k === "omp" ? "omp" : base(f.argv?.[0]) || f.name,
    status: g.status?.state ?? null,
    space: g.labels?.["herdr.space"] ?? null,
    tab: g.labels?.["herdr.tab"] ?? null,
    parent: g.parent ?? null,
  };
}

// Flags worth carrying over to a resumed agent.
const KEEP = {
  claude: { flags: ["--dangerously-skip-permissions", "--verbose"], valued: ["--model", "--permission-mode", "--add-dir", "--agent"] },
  codex: { flags: ["--dangerously-bypass-approvals-and-sandbox", "--yolo", "--search"], valued: ["--model", "-m", "--profile", "-p", "--sandbox", "-s"] },
};

function kept(argv, k) {
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    if (KEEP[k].flags.includes(argv[i])) out.push(argv[i]);
    else if (KEEP[k].valued.includes(argv[i]) && i + 1 < argv.length) out.push(argv[i], argv[++i]);
  }
  return out;
}

export function resumeArgv(e) {
  if (e.kind === "claude") return ["claude", ...kept(e.argv, "claude"), ...(e.session ? ["--resume", e.session] : ["--continue"])];
  if (e.kind === "codex") return ["codex", "resume", "--no-daemon", ...kept(e.argv, "codex"), e.session ?? "--last"];
  if (e.kind === "omp") return ["omp", e.session ? `--resume=${e.session}` : "--continue"];
  return e.argv;
}

const q = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
export const commandLine = (e) => `cd ${q(e.cwd)} && ${resumeArgv(e).map(q).join(" ")}`;

// Starts an entry again in its idle shell; never types into a busy one.
// Returns true when started, false when it can't start now (busy, no answer),
// and "gone" when its terminal exited or was killed: that is not resumed.
export async function start(e) {
  const g = await get(e.address);
  if (!g) {
    // No answer from the core is not "gone": only a listing without the address is.
    const all = await list();
    return all && !all.some((t) => t.address === e.address) ? "gone" : false;
  }
  if (g.state !== "live") return "gone";
  if (!idleShell(g)) return false;
  const r = await hc(["send", e.address, commandLine(e)]).catch(() => null);
  return r?.code === 0;
}

async function waitIdle(cx, address, ms) {
  for (let left = ms; left > 0; left -= 400) {
    await cx.sleep(400);
    const g = await get(address);
    if (!g || g.state !== "live" || idleShell(g)) return true;
  }
  return false;
}

// SIGTERM to the program's process group: ctrl+c (SIGINT) makes Herdr's launcher
// shell (zsh -lic '"$@"; exec "$0" -li') abort instead of returning to its prompt.
async function term(address) {
  const g = await get(address);
  const f = program(g);
  if (!f || f.pid === g.pid) return;
  const r = await exec("kill", ["-TERM", `-${f.pid}`]).catch(() => null);
  if (r?.code !== 0) await exec("kill", ["-TERM", String(f.pid)]).catch(() => null);
}

// Stops what runs in a terminal and leaves its shell in place.
export async function stop(cx, e) {
  if (e.kind === "claude" || e.kind === "codex") {
    if (e.status === "working" || e.status === "blocked") await hc(["interrupt", e.address, "--timeout", "5"]).catch(() => null);
    await hc(["send", e.address, e.kind === "claude" ? "/exit" : "/quit"]).catch(() => null);
    if (await waitIdle(cx, e.address, 10000)) return true;
  }
  await term(e.address);
  if (await waitIdle(cx, e.address, 5000)) return true;
  const g = await get(e.address);
  const f = program(g);
  if (f && f.pid !== g.pid) {
    const r = await exec("kill", ["-KILL", `-${f.pid}`]).catch(() => null);
    if (r?.code !== 0) await exec("kill", ["-KILL", String(f.pid)]).catch(() => null);
  }
  return waitIdle(cx, e.address, 3000);
}
