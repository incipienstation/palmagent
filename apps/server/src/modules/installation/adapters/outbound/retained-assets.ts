import { readFileSync, realpathSync } from "node:fs";
import { join, relative, isAbsolute, sep } from "node:path";

/** Only the two immutable releases of this installation's last activation qualify. */
export function retainedWebDirectory(dataDir: string, activePackage: string): string | undefined {
  try {
    const receipt = JSON.parse(readFileSync(join(dataDir, "application-activation.json"), "utf8"));
    const releases = realpathSync(join(dataDir, "releases"));
    const active = realpathSync(activePackage);
    if (!["applying", "succeeded", "restored", "recovery-required"].includes(receipt.status)) return;
    const pair = [receipt.previous, receipt.target];
    if (pair.some(config => config.dataDir !== dataDir || typeof config.pkgDir !== "string")) return;
    const dirs = pair.map(config => realpathSync(config.pkgDir));
    if (!dirs.includes(active)) return;
    const other = dirs.find(path => path !== active);
    if (!other) return;
    for (const path of dirs) {
      const rel = relative(releases, path);
      if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return;
    }
    const web = join(other, "web");
    if (realpathSync(web) === web) return web;
  } catch { /* Initial install or already reclaimed release. */ }
}
