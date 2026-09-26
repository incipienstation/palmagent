import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const failures = [];

async function files(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch { return []; }
  const found = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await files(path));
    else if ([".ts", ".tsx"].includes(extname(path))) found.push(path);
  }
  return found;
}

async function inspect(paths, check) {
  for (const path of paths) {
    const source = await readFile(path, "utf8");
    for (const message of check(source)) failures.push(`${relative(root, path)}: ${message}`);
  }
}

const importedModules = (source) => [...source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)].map((match) => match[1]);
const applicationFiles = await files(join(root, "apps/server/src/application"));
await inspect(applicationFiles, (source) => {
  const violations = [];
  for (const module of importedModules(source)) {
    if (module === "node:crypto") continue; // deterministic skill fingerprints only
    if (module.startsWith("node:") || module === "hono" || module.startsWith("hono/")
      || ["better-sqlite3", "web-push", "@simplewebauthn/server"].includes(module)
      || (module.startsWith("../") && module !== "../errors.js")) {
      violations.push(`application code imports outer adapter ${module}`);
    }
  }
  return violations;
});

const routeFiles = await files(join(root, "apps/server/src/http"));
await inspect(routeFiles, (source) => {
  const forbidden = importedModules(source).filter((module) =>
    /(?:^|\/)(?:db|attachments|native-session|paths|worktree|terminal\/store)(?:\.js)?$/.test(module));
  return forbidden.map((module) => `HTTP adapter imports host or persistence implementation ${module}`);
});

const viewFiles = [
  ...await files(join(root, "apps/web/src/components")),
  ...await files(join(root, "apps/web/src/auth")),
].filter((path) => !path.endsWith("/useSignOut.ts"));
await inspect(viewFiles, (source) => {
  const violations = [];
  if (/\bapi\s*\./.test(source)) violations.push("view calls the HTTP client directly; use a feature operation hook");
  if (/import\s+(?:\{[^}]*\bapi\b|\*\s+as\s+api)\s+from\s+["'][^"']*api(?:-client)?(?:\.js)?["']/.test(source)) {
    violations.push("view imports the HTTP client directly; use a feature operation hook");
  }
  return violations;
});

const sharedFiles = await files(join(root, "packages/shared/src"));
await inspect(sharedFiles, (source) => importedModules(source)
  .filter((module) => module === "hono" || module.startsWith("hono/") || module.startsWith("node:") || module === "@simplewebauthn/browser")
  .map((module) => `shared contracts import runtime-specific dependency ${module}`));

if (failures.length) {
  console.error(`Architecture boundary check failed (${failures.length}):\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("Architecture boundaries are intact.");
}
