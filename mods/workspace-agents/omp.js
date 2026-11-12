import { exec, home, appHome, watchFolder } from "herdr";
import * as fs from "fs/promises";

// The request goes through a file, not argv: its state grows with every session read
// (tasks included), and argv is both size-limited and visible to `ps`.
export async function readOmp(request) {
  const dir = `${appHome()}/data/workspace-agents`;
  const file = `${dir}/omp-request-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  await fs.writeFile(file, JSON.stringify(request));
  try {
    const result = await exec("python3", [`${appHome()}/mods/workspace-agents/omp-reader.py`, file]);
    const data = JSON.parse(result.stdout);
    if (data.error) throw new Error(data.error);
    return data;
  } finally {
    await fs.unlink(file).catch(() => {});
  }
}

export class OmpChildren {
  constructor(cx) {
    this.nodes = [];
    this.roots = {};
    this.files = {};
    this.watched = new Set();
    this.addresses = [];
    this.signature = "";
    this.visibleSignature = "[]";
    this.watch(`${home()}/.omp/run/session-owners`, cx, true);
  }

  update(list, cx) {
    const addresses = list.filter(a => !a.address.includes("/") && (a.app === "omp" || a.program?.key === "omp")).map(a => a.address).sort();
    const signature = addresses.join(",");
    if (signature === this.signature) return;
    this.signature = signature;
    this.addresses = addresses;
    this.refresh(cx, true);
  }

  watch(directory, cx, discover = false, artifact = null) {
    if (this.watched.has(directory)) return;
    this.watched.add(directory);
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          const paths = await watchFolder(directory);
          if (artifact && !paths.some(path => path === directory || Object.keys(this.roots).some(root => {
            const scope = root.slice(0, -6);
            return root.startsWith(directory + "/") && (path === scope || path.startsWith(scope + "/") || scope.startsWith(path + "/"));
          }))) continue;
          this.refresh(cx, discover);
        }
      } catch (error) {
        this.error = `OMP watcher: ${error.message ?? error}`;
        cx.notify();
      }
    });
  }

  refresh(cx, discover = false) {
    this.pending = true;
    this.discover = this.discover || discover;
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        while (this.pending) {
          await cx.sleep(250);
          this.pending = false;
          const discover = this.discover;
          this.discover = false;
          const data = await readOmp({ addresses: this.addresses, discover, roots: this.roots, files: this.files });
          this.roots = data.roots;
          this.files = data.files;
          const signature = JSON.stringify(data.nodes);
          const changed = signature !== this.visibleSignature || Boolean(this.error);
          if (changed) {
            this.nodes = data.nodes;
            this.visibleSignature = signature;
          }
          this.error = null;
          for (const root of Object.keys(this.roots)) {
            const slash = root.lastIndexOf("/");
            this.watch(root.slice(0, slash), cx, false, root.slice(0, -6));
          }
          if (changed) cx.notify();
        }
      } catch (error) {
        this.error = `OMP discovery: ${error.message ?? error}`;
        cx.notify();
      } finally {
        this.busy = false;
      }
    });
  }
}
