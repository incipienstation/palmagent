// Build the single distributable npm package into build/pkg/.
//
//   pnpm pkg:build          # bundle + assemble build/pkg/
//   pnpm pkg:pack           # the above, then `npm pack` → a tarball
//
// Output (build/pkg/): cli.js (the bin), server.js, runner-daemon.js (all
// esbuild-bundled ESM, with @palmagent/shared bundled IN), web/ (the
// prebuilt PWA), and a generated package.json.
//
// Native / self-contained deps (better-sqlite3, @simplewebauthn/server,
// web-push) are kept EXTERNAL and listed as real dependencies so npm
// fetches/rebuilds them on the consuming host. We never bundle the .node.
//
// The generated package is private by default. Candidate automation may set
// PKG_PUBLISHABLE=1 to inspect the real manifest, but publishing still requires
// the protected Trusted Publishing workflow.
import { build, type Plugin } from "esbuild";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { BRANDING } from "../packages/shared/src/branding.js";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "apps", "server");
const WEB_DIST = join(ROOT, "apps", "web", "dist");
const OUT = join(ROOT, "build", "pkg");

// NodeNext source uses explicit ".js" specifiers that actually resolve to ".ts"
// on disk. esbuild won't rewrite those, so map relative ".js" → ".ts" when a
// sibling .ts exists (leaves real .js files and bare specifiers alone).
const tsResolve: Plugin = {
  name: "nodenext-js-to-ts",
  setup(b) {
    b.onResolve({ filter: /\.js$/ }, (args) => {
      if (!args.path.startsWith(".")) return; // bare specifier / external
      const ts = join(args.resolveDir, args.path.replace(/\.js$/, ".ts"));
      return existsSync(ts) ? { path: ts } : undefined;
    });
  },
};

// External: native (better-sqlite3) + libs with their own runtime deps we'd
// rather npm install than inline. These become `dependencies` of the package.
const EXTERNAL = ["better-sqlite3", "@simplewebauthn/server", "web-push"];

const common = {
  bundle: true,
  platform: "node" as const,
  format: "esm" as const,
  target: "node22",
  external: EXTERNAL,
  plugins: [tsResolve],
  logLevel: "info" as const,
  sourcemap: false,
  // Minification keeps the self-hosted bundle compact. The source remains public
  // and the assembled tarball is leak-scanned independently.
  minify: true,
};

async function main(): Promise<void> {
  console.log(`[build-pkg] cleaning ${OUT}`);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  const buildInfo = {
    version: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version,
    sourceCommit: git("rev-parse", "HEAD"),
    dirty: git("status", "--porcelain", "--untracked-files=normal") !== "",
  };
  console.log("[build-pkg] bundling server / runner-daemon / cli …");
  await build({
    ...common,
    entryPoints: [join(SERVER, "src/server.ts")],
    define: { __PALMAGENT_BUILD__: JSON.stringify(buildInfo) },
    outfile: join(OUT, "server.js"),
  });
  await build({
    ...common,
    entryPoints: [join(SERVER, "src/runner-daemon.ts")],
    outfile: join(OUT, "runner-daemon.js"),
  });
  await build({
    ...common,
    entryPoints: [join(SERVER, "src/cli/index.ts")],
    outfile: join(OUT, "cli.js"),
    banner: { js: "#!/usr/bin/env node" },
  });

  // Static assets: require and copy the built PWA.
  if (!existsSync(join(WEB_DIST, "index.html"))) {
    throw new Error(
      "[build-pkg] apps/web/dist missing — run `pnpm --filter @palmagent/web build` first",
    );
  }
  cpSync(WEB_DIST, join(OUT, "web"), { recursive: true });
  console.log("[build-pkg] copied web/ (PWA dist)");

  // Generated package.json — product identity comes from BRANDING, while the
  // root private package version is the single release-version source.
  const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const serverPkg = JSON.parse(
    readFileSync(join(SERVER, "package.json"), "utf8"),
  );
  const pick = (name: string): string => {
    const v = serverPkg.dependencies?.[name];
    if (!v)
      throw new Error(
        `[build-pkg] expected ${name} in apps/server dependencies`,
      );
    return v;
  };
  const version = String(rootPkg.version ?? "");
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version) ||
    version === "0.0.0"
  ) {
    throw new Error(
      `[build-pkg] root package version must be a releasable SemVer, got ${JSON.stringify(version)}`,
    );
  }
  const publishable = process.env.PKG_PUBLISHABLE === "1";
  writeFileSync(join(OUT, "build-info.json"), JSON.stringify(buildInfo, null, 2) + "\n");

  const pkg = {
    name: BRANDING.packageName,
    version,
    description: `${BRANDING.productName} — self-hosted Claude Code + Codex dispatcher`,
    type: "module",
    license: "MIT",
    keywords: ["self-hosted", "agent", "claude", "codex", "pwa"],
    repository: {
      type: "git",
      url: "git+https://github.com/incipienstation/palmagent.git",
    },
    homepage: "https://github.com/incipienstation/palmagent#readme",
    bugs: { url: "https://github.com/incipienstation/palmagent/issues" },
    // Hard block against accidental publish until launch (PKG_PUBLISHABLE=1).
    private: !publishable,
    bin: { [BRANDING.cliName]: "./cli.js" },
    files: [
      "cli.js",
      "server.js",
      "runner-daemon.js",
      "build-info.json",
      "web",
      "README.md",
      "LICENSE",
    ],
    engines: { node: ">=22" },
    publishConfig: { access: "public" },
    dependencies: {
      "better-sqlite3": pick("better-sqlite3"),
      "@simplewebauthn/server": pick("@simplewebauthn/server"),
      "web-push": pick("web-push"),
    },
    // Refuse every accidental local or CI publication until the publish workflow
    // and npm trusted publisher are separately approved.
    scripts: {
      prepublishOnly:
        "node -e \"if(process.env.ALLOW_PUBLISH!=='1'){console.error('publishing is disabled — set ALLOW_PUBLISH=1');process.exit(1)}\"",
    },
  };
  writeFileSync(join(OUT, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

  // A self-contained README. It references ONLY what the tarball actually ships +
  // the CLI's own commands — no `docs/…` path (the docs are not in the package) and
  // no repo/handle. `<cli> --help`/`doctor` are the in-package guidance surface.
  const cli = BRANDING.cliName;
  const readme = [
    `# ${BRANDING.productName}`,
    "",
    "Self-hosted dispatcher that drives the Claude Code and Codex CLIs headless on your own",
    "host, normalizes their two event streams into one schema, and serves an installable,",
    "mobile-first PWA over SSE (read) + REST (control).",
    "",
    "## Requirements",
    "",
    "- Node.js >= 22",
    "- At least one of the `claude` or `codex` CLIs on PATH and authenticated",
    "- A public domain pointing at this host (TLS + passkey auth need a real https origin)",
    "- Linux with systemd + nginx and sudo (the installer writes units + an nginx vhost)",
    "",
    "## Quickstart",
    "",
    "Use the Palmagent operator plugin in Claude Code or Codex to install and manage the service.",
    "The plugin handles CLI installation and commands internally; users do not run this CLI directly.",
    "Ask the plugin to install Palmagent, show settings, choose Preview, or update the service.",
    "",
    "Stable is the default for new users. Preview is an explicit choice available to everyone.",
    "Both plugins share ~/.palmagent/config.json; settings survive updates and service reinstalls.",
    "Changing the saved channel does not deploy a release. Updates refuse downgrades and",
    "prereleases on Stable; a missing Stable release does not fall back to Preview.",
    "",
    "## Internal commands",
    "",
    `- \`${cli} config\`     Shared user settings: get, init, set --channel stable|preview`,
    `- \`${cli} install\`    First-run setup: systemd units, nginx, TLS (certbot), first passkey`,
    `- \`${cli} setup\`      Reconfigure an existing install + re-render units/nginx`,
    `- \`${cli} doctor\`     Diagnose a running instance + suggest fixes`,
    `- \`${cli} update\`     Apply config; \`--pull\` updates an npm install on its release channel`,
    `- \`${cli} uninstall\`  Remove the units + nginx vhost (data preserved unless \`--purge\`)`,
    `- \`${cli} passkey\`    Mint a fresh device-enroll link`,
    "",
    `Run \`${cli} --help\` for the full option list.`,
    "",
  ].join("\n");
  writeFileSync(join(OUT, "README.md"), readme);
  cpSync(join(ROOT, "LICENSE"), join(OUT, "LICENSE"));

  // Fail closed on secret or context-denylist matches in the assembled public
  // tarball surface. Output contains locations only, never matched values.
  console.log("[build-pkg] leak-scanning build/pkg …");
  execFileSync(
    process.execPath,
    [join(ROOT, "scripts", "pkg-leakcheck.mjs"), OUT],
    { stdio: "inherit" },
  );

  console.log(
    `[build-pkg] done → ${OUT}  (private=${pkg.private}, bin=${BRANDING.cliName})`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
