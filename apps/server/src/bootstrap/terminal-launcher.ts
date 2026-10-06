// Retained bootstrap. Only the platform installer chooses the runtime and release roots.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve, sep } from "node:path";
const directory = resolve(process.argv[2] ?? "");
const id = process.argv[3] ?? "";
if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid terminal identity");
const path = join(directory, id + ".json");
const stat = statSync(path);
if (stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error("Terminal descriptor must be private");
const descriptor = JSON.parse(readFileSync(path, "utf8"));
if (descriptor.protocol !== 1 || descriptor.id !== id || descriptor.directory !== directory) throw new Error("Invalid terminal descriptor");
const release = realpathSync(descriptor.release);
const node = realpathSync(descriptor.node);
if (!release.startsWith(realpathSync(join(directory, "..", "releases")) + sep) ||
    !node.startsWith(realpathSync(join(directory, "..", "runtimes")) + sep)) throw new Error("Terminal artifacts must be retained");
const child = spawn(node, [join(release, "terminal-host.js"), directory, id], { stdio: "inherit", cwd: release });
child.once("error", () => { process.exitCode = 1; });
child.once("exit", code => { process.exitCode = code ?? 1; });
