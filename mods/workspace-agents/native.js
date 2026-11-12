// In-process subagents of Claude Code and Codex (any machine), and OMP children on other
// machines (this computer's OMP children come from omp.js). Read by native-children.py and
// omp-reader.py on the agents' own machine, polled only while such agents are live there.
import { exec, appHome } from "herdr";
import * as fs from "fs/promises";

const LOCAL_MS = 2000;
const REMOTE_MS = 5000;
const NATIVE = "mods/workspace-agents/native-children.py";
const OMP = "mods/workspace-agents/omp-reader.py";

function kindOf(a) {
  const key = `${a.app ?? ""} ${a.program?.key ?? ""}`;
  return /claude/i.test(key) ? "claude" : /codex/i.test(key) ? "codex" : /\bomp\b/i.test(key) ? "omp" : null;
}

const machineOf = (address) => (address.includes("/") ? address.slice(0, address.indexOf("/")) : "");
const bare = (address) => address.slice(address.indexOf("/") + 1);

export class NativeChildren {
  // onChange: called after the nodes change, even while the mod isn't drawn.
  constructor(onChange) {
    this.onChange = onChange;
    this.nodes = [];
    this.error = null;
    this.machines = new Map(); // "" (this computer) or a machine name -> { agents, signature, nodes, omp, loop }
    this.sources = {};
  }

  // Agents worth reading, by machine. This computer's OMP agents are left to omp.js.
  update(list, cx) {
    const wanted = new Map();
    for (const a of list) {
      const kind = kindOf(a);
      const machine = machineOf(a.address);
      if (!kind || (kind === "omp" && !machine)) continue;
      if (!wanted.has(machine)) wanted.set(machine, []);
      wanted.get(machine).push({ address: bare(a.address), kind, program: a.program });
    }
    for (const machine of new Set([...wanted.keys(), ...this.machines.keys()])) {
      const agents = wanted.get(machine) ?? [];
      const signature = agents.map((a) => `${a.kind}:${a.address}`).sort().join(",");
      let m = this.machines.get(machine);
      if (!m) this.machines.set(machine, (m = { agents: [], signature: "", nodes: [], omp: { roots: {}, files: {} }, loop: false }));
      m.agents = agents;
      if (signature !== m.signature) m.discover = true;
      m.signature = signature;
      if (agents.length && !m.loop) this.poll(machine, cx);
    }
  }

  poll(machine, cx) {
    const m = this.machines.get(machine);
    m.loop = true;
    cx.spawn(async (cx) => {
      try {
        while (m.agents.length) {
          try {
            const nodes = await this.read(machine, m);
            this.error = null;
            const before = JSON.stringify(m.nodes);
            m.nodes = nodes;
            if (JSON.stringify(nodes) !== before) this.publish(cx);
          } catch (error) {
            this.error = `Subagents${machine ? ` on ${machine}` : ""}: ${error.message ?? error}`;
            cx.notify();
          }
          await cx.sleep(machine ? REMOTE_MS : LOCAL_MS);
        }
        if (m.nodes.length) { m.nodes = []; this.publish(cx); }
      } finally {
        m.loop = false;
      }
    });
  }

  publish(cx) {
    this.nodes = [...this.machines.values()].flatMap((m) => m.nodes);
    this.onChange?.();
    cx.notify();
  }

  // Runs a reader on that machine: this computer by path, another by its source.
  async run(machine, script, request) {
    let result;
    if (!machine) {
      result = await exec("python3", [`${appHome()}/${script}`, JSON.stringify(request)], { timeout: 20000 });
    } else {
      this.sources[script] ??= await fs.readFile(`${appHome()}/${script}`, "utf8");
      result = await exec("python3", ["-c", this.sources[script], JSON.stringify(request)], { on: machine, timeout: 20000 });
    }
    const data = JSON.parse(result.stdout || "{}");
    if (data.error) throw new Error(data.error);
    return data;
  }

  async read(machine, m) {
    const native = m.agents.filter((a) => a.kind !== "omp");
    const omp = m.agents.filter((a) => a.kind === "omp");
    let nodes = [];
    if (native.length) {
      nodes = (await this.run(machine, NATIVE, { agents: native.map(({ address, kind }) => ({ address, kind })) })).nodes;
    }
    if (omp.length) {
      const discover = m.discover;
      m.discover = false;
      const data = await this.run(machine, OMP, { addresses: omp.map((a) => a.address), discover, roots: m.omp.roots, files: m.omp.files });
      m.omp = { roots: data.roots, files: data.files };
      nodes = [...nodes, ...data.nodes.map(({ transcript, ...n }) => n)];
    }
    // Each child carries the program of the agent it belongs to, for its icon.
    const program = new Map(m.agents.map((a) => [a.address, a.program]));
    const parentOf = new Map(nodes.map((n) => [n.address, n.parent]));
    const rootOf = (address) => {
      for (let seen = 0; parentOf.has(address) && seen < 50; seen++) address = parentOf.get(address);
      return address;
    };
    // OMP node addresses hold a path, so every address gets the machine, slash or not.
    const at = (address) => (machine ? `${machine}/${address}` : address);
    return nodes.map((n) => ({ ...n, program: program.get(rootOf(n.address)), address: at(n.address), parent: at(n.parent) }));
  }
}
