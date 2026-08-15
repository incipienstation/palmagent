// Packed-install smoke test (Phase 1 acceptance). Proves the distributable
// package actually installs from a tarball on a clean host and boots:
//   build/pkg → `npm pack` → install into a scratch dir → run the bin `start`
//   → GET /api/health == 200 → palmagent.db created (better-sqlite3 loaded).
//
// Run `pnpm pkg:build` first (this does not build). Exits non-zero on any failure.
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(ROOT, "build", "pkg");
const PORT = 4099;
const LOOPBACK_IPV4 = ["127", "0", "0", "1"].join(".");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (msg) => {
  console.error(`[smoke] FAIL: ${msg}`);
  process.exit(1);
};

if (!existsSync(join(PKG, "package.json")))
  die("build/pkg not found — run `pnpm pkg:build` first");
const pkgJson = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
const binName = Object.keys(pkgJson.bin ?? {})[0];
if (!binName) die("no bin in build/pkg/package.json");

console.log("[smoke] npm pack …");
execFileSync("npm", ["pack"], { cwd: PKG, stdio: "inherit" });
const tarball = readdirSync(PKG).find((f) => f.endsWith(".tgz"));
if (!tarball) die("no tarball produced");
const tarballPath = join(PKG, tarball);
const entries = execFileSync("tar", ["-tf", tarballPath], { encoding: "utf8" })
  .trim()
  .split("\n");
const hasEntry = (suffix) =>
  entries.some(
    (e) => e === `package/${suffix}` || e.startsWith(`package/${suffix}/`),
  );
if (!hasEntry("web/index.html")) die("tarball is missing web/index.html");
if (!hasEntry("README.md")) die("tarball is missing README.md");
if (!hasEntry("LICENSE")) die("tarball is missing LICENSE");
if (hasEntry("public"))
  die("tarball must not include the server public fallback");
if (hasEntry("docs/archive")) die("tarball must not include archived docs");
console.log(
  "[smoke] tarball surface OK (web, README, and license present; fallback/archive absent)",
);

const scratch = mkdtempSync(join(tmpdir(), "palmagent-smoke-"));
const dataDir = join(scratch, "data");
let serverProc;
const cleanup = () => {
  try {
    serverProc?.kill("SIGKILL");
  } catch {}
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {}
  try {
    rmSync(tarballPath, { force: true });
  } catch {}
};
process.on("exit", cleanup);

try {
  console.log(`[smoke] installing tarball into ${scratch} …`);
  execFileSync("npm", ["init", "-y"], { cwd: scratch, stdio: "ignore" });
  execFileSync("npm", ["install", tarballPath], {
    cwd: scratch,
    stdio: "inherit",
  });

  const bin = join(scratch, "node_modules", ".bin", binName);
  if (!existsSync(bin)) die(`bin not installed at ${bin}`);
  const installedVersion = execFileSync(bin, ["--version"], {
    encoding: "utf8",
  }).trim();
  if (installedVersion !== pkgJson.version) {
    die(
      `installed CLI version ${installedVersion} does not match package ${pkgJson.version}`,
    );
  }
  console.log(`[smoke] CLI --version → ${installedVersion}`);

  console.log(
    `[smoke] booting \`${binName} start\` on ${LOOPBACK_IPV4}:${PORT} …`,
  );
  serverProc = spawn(bin, ["start"], {
    cwd: scratch,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: LOOPBACK_IPV4,
      DISPATCHER_DATA_DIR: dataDir,
      AUTH_DISABLED: "1",
      NODE_ENV: "test",
    },
    stdio: "inherit",
  });
  serverProc.on("exit", (code) => {
    if (code && code !== 0)
      console.error(`[smoke] server exited early with code ${code}`);
  });

  const url = `http://${LOOPBACK_IPV4}:${PORT}/api/health`;
  let ok = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const r = await fetch(url);
      if (r.ok) {
        const j = await r.json();
        if (j?.ok === true) {
          ok = true;
          break;
        }
      }
    } catch {
      /* not up yet */
    }
  }
  if (!ok) die("server did not become healthy within 20s");
  console.log("[smoke] /api/health → 200 {ok:true}");

  const shell = await fetch(`http://${LOOPBACK_IPV4}:${PORT}/`);
  if (!shell.ok) die(`PWA shell did not serve from / (status ${shell.status})`);
  const html = await shell.text();
  if (!html.includes('<div id="root"'))
    die("PWA shell response does not look like the built React app");
  console.log("[smoke] / → built PWA shell");

  if (!existsSync(join(dataDir, "palmagent.db"))) {
    die("palmagent.db not created — better-sqlite3 likely failed to load");
  }
  if ((statSync(dataDir).mode & 0o777) !== 0o700) {
    die("data directory is not owner-only (expected mode 0700)");
  }
  if ((statSync(join(dataDir, "palmagent.db")).mode & 0o777) !== 0o600) {
    die("palmagent.db is not owner-only (expected mode 0600)");
  }
  console.log("[smoke] palmagent.db created (better-sqlite3 loaded + opened)");
  console.log("[smoke] PASS");
} finally {
  cleanup();
}
