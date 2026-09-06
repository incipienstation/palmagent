import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRANDING } from "@palmagent/shared";
import {
  DEFAULT_CAPS,
  assertSafeInstallerIdentity,
  assertSafePurgeTarget,
  authFromDomain,
  installEnvPath,
  loadConfig,
  saveConfig,
  validateInstallInput,
  type InstallConfig,
} from "../src/cli/config.js";
import {
  type Flags,
  gatherConfig,
  loadInstalledConfig,
  postUpgradeArgs,
  update,
} from "../src/cli/install.js";
import { renderNginx } from "../src/cli/nginx.js";
import {
  recordRunnerArtifact,
  runnerArtifactChanged,
} from "../src/cli/runner-state.js";
import { renderUnits, runnerUnitName, webUnitName } from "../src/cli/units.js";

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) {
    console.log("✓ " + message);
    return;
  }
  failures++;
  console.error("✗ " + message);
}

const loopback = ["127", "0", "0", "1"].join(".");
const sourceRoot = "/srv/palmagent";
const dataRoot = "/var/lib/palmagent";
const domain = "palmagent.example.com";
const config: InstallConfig = {
  mode: "source",
  user: "palmagent",
  group: "palmagent",
  dataDir: dataRoot,
  runnerSocket: join(dataRoot, "runner.sock"),
  dbPath: join(dataRoot, "palmagent.db"),
  repoDir: sourceRoot,
  workingDir: join(sourceRoot, "apps", "server"),
  execPath: "/usr/local/bin:/usr/bin:/bin",
  domain,
  host: loopback,
  port: 4100,
  concurrency: 4,
  rpId: domain,
  rpName: BRANDING.productName,
  authOrigin: "https://" + domain,
  pushSubject: "https://push.example.com/contact",
  repoRoots: "/srv/repos",
  claudeConfigDir: "/var/lib/palmagent/claude",
  caps: DEFAULT_CAPS,
};

const sourceUnits = renderUnits(config, { nodeBin: "/usr/bin/node" });
check(
  sourceUnits.web.name === webUnitName(),
  "web unit uses the Palmagent unit name",
);
check(
  sourceUnits.runner.name === runnerUnitName(),
  "runner unit uses the Palmagent unit name",
);
check(
  sourceUnits.web.text.includes("Environment=AUTH_ORIGIN=https://" + domain),
  "WebAuthn origin is HTTPS",
);
check(
  !sourceUnits.web.text.includes("Environment=AUTH_ORIGIN=http://"),
  "unit renderer never emits a plaintext authentication origin",
);
check(
  sourceUnits.web.text.includes("Environment=HOST=" + loopback),
  "web service binds to loopback",
);
check(
  sourceUnits.runner.text.includes("src/runner-daemon.ts"),
  "source mode launches the TypeScript runner",
);

const packageRoot = "/opt/palmagent";
const packageConfig: InstallConfig = {
  ...config,
  mode: "package",
  pkgDir: packageRoot,
  repoDir: undefined,
  workingDir: packageRoot,
};
const packageUnits = renderUnits(packageConfig, { nodeBin: "/usr/bin/node" });
check(
  packageUnits.web.text.includes(
    "ExecStart=/usr/bin/node " + packageRoot + "/server.js",
  ),
  "package mode launches the bundled server",
);
check(
  packageUnits.runner.text.includes(
    "ExecStart=/usr/bin/node " + packageRoot + "/runner-daemon.js",
  ),
  "package mode launches the bundled runner",
);
check(
  packageUnits.web.text.includes(
    "Environment=STATIC_DIR=" + packageRoot + "/web",
  ),
  "package mode pins the bundled PWA directory",
);

const nginx = renderNginx(config);
const plaintextServer = nginx.vhost.text.split("server {")[1] ?? "";
check(
  plaintextServer.includes("return 308 https://$host$request_uri;"),
  "port 80 redirects to HTTPS",
);
check(
  !plaintextServer.includes("proxy_pass"),
  "port 80 never proxies the application",
);
check(
  nginx.vhost.text.includes("listen 443 ssl;"),
  "permanent vhost terminates TLS",
);
check(
  nginx.vhost.text.includes("Strict-Transport-Security"),
  "permanent vhost enables HSTS",
);
check(
  nginx.bootstrap.text.includes("return 404;"),
  "ACME bootstrap denies application requests",
);
check(
  !nginx.bootstrap.text.includes("proxy_pass"),
  "ACME bootstrap never proxies the application",
);
check(
  !nginx.bootstrap.text.includes("listen 443"),
  "ACME bootstrap does not impersonate HTTPS",
);
const upstreams = [...nginx.vhost.text.matchAll(/proxy_pass\s+([^;]+);/g)].map(
  (match) => match[1],
);
check(upstreams.length > 0, "permanent vhost contains reverse-proxy locations");
check(
  upstreams.every(
    (value) => value === "http://" + loopback + ":" + config.port,
  ),
  "all upstream HTTP transport is host-local loopback only",
);

let schemeDomainRejected = false;
try {
  validateInstallInput({
    domain: "https://" + domain,
    host: loopback,
    port: 4100,
    concurrency: 4,
    pushSubject: "",
  });
} catch {
  schemeDomainRejected = true;
}
check(
  schemeDomainRejected,
  "command-line domain rejects a scheme and remains HTTPS-derived",
);

const subcommandHelp = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "apps/server/src/cli/index.ts",
    "setup",
    "--help",
  ],
  { encoding: "utf8" },
);
check(
  subcommandHelp.status === 0 &&
    subcommandHelp.stdout.includes("Usage: palmagent <command>"),
  "subcommand --help prints usage without running the command",
);

const scratch = mkdtempSync(join(tmpdir(), "palmagent-cli-check-"));
try {
  const fallback = loadConfig({ dataDir: scratch });
  check(
    fallback.domain === "",
    "fresh config has no host-specific domain default",
  );
  check(fallback.host === loopback, "fresh config binds to loopback");
  check(
    fallback.dbPath === join(scratch, "palmagent.db"),
    "fresh config uses palmagent.db",
  );

  const derived = authFromDomain(domain);
  check(
    derived.authOrigin === "https://" + domain,
    "domain derives an HTTPS authentication origin",
  );

  const written: InstallConfig = {
    ...fallback,
    user: "palmagent",
    group: "palmagent",
    mode: "package",
    pkgDir: packageRoot,
    workingDir: packageRoot,
    dataDir: scratch,
    runnerSocket: join(scratch, "runner.sock"),
    dbPath: join(scratch, "palmagent.db"),
    domain,
    rpId: domain,
    authOrigin: "https://" + domain,
    pushSubject: "https://push.example.com/contact",
    execPath: "/usr/local/bin:/usr/bin:/bin",
  };
  chmodSync(scratch, 0o755);
  saveConfig(written);
  check(
    (statSync(scratch).mode & 0o777) === 0o700,
    "saving config tightens the data directory to mode 0700",
  );
  check(
    (statSync(installEnvPath(scratch)).mode & 0o777) === 0o600,
    "install config is owner-readable only",
  );
  const roundTrip = loadConfig({ dataDir: scratch, pkgDir: packageRoot });
  check(
    roundTrip.domain === domain,
    "install config round-trips the public domain",
  );
  check(
    roundTrip.authOrigin === "https://" + domain,
    "round-trip keeps HTTPS identity derivation",
  );
  check(
    roundTrip.pushSubject.startsWith("https://"),
    "round-trip accepts an HTTPS push contact",
  );
  const customFlags: Flags = {
    dryRun: true,
    nonInteractive: true,
    force: false,
    purge: false,
    pull: false,
    get: (key) => (key === "data-dir" ? scratch : undefined),
  };
  check(
    loadInstalledConfig(customFlags).domain === domain,
    "all installed-state commands resolve an explicit data directory",
  );

  let rootRejected = false;
  try {
    assertSafeInstallerIdentity(0);
  } catch {
    rootRejected = true;
  }
  check(rootRejected, "installer refuses to make root the agent service user");
  let regularUserAccepted = true;
  try {
    assertSafeInstallerIdentity(1000);
  } catch {
    regularUserAccepted = false;
  }
  check(regularUserAccepted, "installer accepts an unprivileged service owner");

  let broadPurgeRejected = false;
  const fakeHome = join(scratch, "operator-home");
  try {
    assertSafePurgeTarget(fakeHome, fakeHome);
  } catch {
    broadPurgeRejected = true;
  }
  check(broadPurgeRejected, "purge rejects a broad operator home target");
  let dedicatedPurgeAccepted = true;
  try {
    assertSafePurgeTarget(join(fakeHome, ".local", "state", "palmagent"), fakeHome);
  } catch {
    dedicatedPurgeAccepted = false;
  }
  check(dedicatedPurgeAccepted, "purge accepts a dedicated Palmagent state target");

  const bundleDir = join(scratch, "bundle");
  mkdirSync(bundleDir);
  writeFileSync(join(bundleDir, "runner-daemon.js"), "runner-v1\n");
  const fingerprinted: InstallConfig = {
    ...written,
    pkgDir: bundleDir,
    workingDir: bundleDir,
  };
  check(
    runnerArtifactChanged(fingerprinted),
    "an unstamped runner artifact requires a restart",
  );
  recordRunnerArtifact(fingerprinted);
  check(
    !runnerArtifactChanged(fingerprinted),
    "the applied runner fingerprint suppresses an unnecessary restart",
  );
  writeFileSync(join(bundleDir, "runner-daemon.js"), "runner-v2\n");
  check(
    runnerArtifactChanged(fingerprinted),
    "changed runner bundle content requires a restart even with a stable unit path",
  );
  check(
    (statSync(join(scratch, "runner-artifact.sha256")).mode & 0o777) ===
      0o600,
    "runner fingerprint state is owner-readable only",
  );
  check(
    postUpgradeArgs(fingerprinted, customFlags).includes(scratch),
    "the upgraded CLI re-exec preserves an explicit data directory",
  );
  const captured: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values: unknown[]) =>
    captured.push(values.map(String).join(" "));
  console.error = (...values: unknown[]) =>
    captured.push(values.map(String).join(" "));
  let dryRunCode: number;
  try {
    dryRunCode = await update(customFlags);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  check(dryRunCode === 0, "update accepts --data-dir for installed state");
  check(
    !existsSync(join(scratch, "render")),
    "dry-run renders to output without writing a render directory",
  );

  const sourceRoot = join(scratch, "source-checkout");
  saveConfig({
    ...written,
    mode: "source",
    pkgDir: undefined,
    repoDir: sourceRoot,
    workingDir: join(sourceRoot, "apps", "server"),
  });
  console.log = (...values: unknown[]) =>
    captured.push(values.map(String).join(" "));
  console.error = (...values: unknown[]) =>
    captured.push(values.map(String).join(" "));
  let sourcePullCode: number;
  try {
    sourcePullCode = await update({ ...customFlags, pull: true });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  check(
    sourcePullCode !== 0,
    "source checkout self-update is rejected before Git mutation",
  );
  check(
    captured.some((line) => line.includes("maintainer-managed")),
    "source update rejection explains the maintainer workflow",
  );
  saveConfig(written);

  let setupRequiresInstall = false;
  const missingFlags: Flags = {
    ...customFlags,
    get: (key) =>
      key === "data-dir" ? join(scratch, "missing-install") : undefined,
  };
  try {
    await gatherConfig(missingFlags, true);
  } catch {
    setupRequiresInstall = true;
  }
  check(setupRequiresInstall, "setup refuses to create a fresh installation");

  const envPath = installEnvPath(scratch);
  writeFileSync(
    envPath,
    [
      "MODE=package",
      "DOMAIN=" + domain,
      "HOST=" + domain,
      "PKG_DIR=" + packageRoot,
      "WORKING_DIR=" + packageRoot,
      "",
    ].join("\n"),
  );
  let publicBindRejected = false;
  try {
    loadConfig({ dataDir: scratch, pkgDir: packageRoot });
  } catch {
    publicBindRejected = true;
  }
  check(publicBindRejected, "installer config rejects a public service bind");

  writeFileSync(
    envPath,
    [
      "MODE=package",
      "DOMAIN=" + domain,
      "HOST=" + loopback,
      "PUSH_SUBJECT=http://push.example.com/contact",
      "PKG_DIR=" + packageRoot,
      "WORKING_DIR=" + packageRoot,
      "",
    ].join("\n"),
  );
  let plaintextPushRejected = false;
  try {
    loadConfig({ dataDir: scratch, pkgDir: packageRoot });
  } catch {
    plaintextPushRejected = true;
  }
  check(
    plaintextPushRejected,
    "installer config rejects a plaintext push contact",
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(
  failures
    ? "\nFAIL: " + failures + " check(s) failed"
    : "\nPASS: all CLI checks green",
);
process.exit(failures ? 1 : 0);
