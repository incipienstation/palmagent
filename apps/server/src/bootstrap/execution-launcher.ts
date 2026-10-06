// Stable bootstrap: built with Node built-ins only and retained outside release
// directories. The service manager owns this process and the execution cgroup.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve, sep } from "node:path";
const directory = resolve(process.argv[2] ?? "");
const id = process.argv[3] ?? "";
if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid execution identity");
const path = join(directory, `${id}.json`);
const stat = statSync(path);
if (stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error("Execution descriptor must be private and owner-controlled");
const descriptor = JSON.parse(readFileSync(path, "utf8"));
if (descriptor.protocol !== 1 || descriptor.id !== id || descriptor.directory !== directory) throw new Error("Invalid execution descriptor");
const releaseRoot = realpathSync(join(directory, "..", "releases"));
const runtimeRoot = realpathSync(join(directory, "..", "runtimes"));
const release = realpathSync(descriptor.release);
const node = realpathSync(descriptor.node);
if (!release.startsWith(releaseRoot + sep) || !node.startsWith(runtimeRoot + sep)) throw new Error("Execution artifacts must be retained in the installation");
const child = spawn(node, [join(release, "execution-host.js"), directory, id], { stdio: "inherit", cwd: release });
child.once("error", () => { process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
