import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DISTRIBUTION } from "@palmagent/shared";
import { BundleIdentitySchema, ChannelIndexSchema, RELEASE_PUBLIC_KEYS, StandaloneManifestSchema, StandaloneSelectionSchema,
  versionAtLeast, type Distribution, type StandaloneManifest, type StandaloneSelection, type StandaloneTarget } from "@palmagent/shared/standalone";
import { ensurePrivateDirectory } from "../../../../platform/filesystem/private-files.js";
import { extractReleaseArchive, MAX_RELEASE_DOCUMENT_BYTES, sha256File, verifySignedPayload } from "../../../../platform/filesystem/release-artifact.js";
import type { InstallConfig } from "../../domain/installation.js";
import type { ReleaseChannel } from "../../domain/release-policy.js";
import { pinNode } from "./retained-node.js";

export function installedDistribution(cfg?: Pick<InstallConfig, "distribution" | "pkgDir">): Distribution {
  if (cfg?.distribution) return cfg.distribution;
  if (cfg?.pkgDir && existsSync(join(dirname(cfg.pkgDir), "bundle.json"))) {
    BundleIdentitySchema.parse(JSON.parse(readFileSync(join(dirname(cfg.pkgDir), "bundle.json"), "utf8")));
    return "standalone";
  }
  return "npm";
}

export function standaloneHost(platform = process.platform, arch = process.arch,
  glibc = (process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime): { target: StandaloneTarget; glibc: string } {
  if (platform !== "linux" || !["x64", "arm64"].includes(arch) || !glibc)
    throw new Error("Standalone requires Linux x64 or arm64 with glibc; this platform is unsupported");
  return { target: `linux-${arch}-glibc` as StandaloneTarget, glibc };
}

export function releaseManifestUrl(version: string): string {
  return `${DISTRIBUTION.repositoryUrl}/releases/download/v${version}/standalone.json`;
}

function metadata(url: string): Buffer {
  return execFileSync("curl", ["--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--proto-redir", "=https",
    "--connect-timeout", "10", "--max-time", "30", "--max-filesize", String(MAX_RELEASE_DOCUMENT_BYTES), "--url", url],
  { maxBuffer: MAX_RELEASE_DOCUMENT_BYTES, timeout: 35_000, stdio: ["ignore", "pipe", "pipe"] });
}

export interface StandaloneCatalogIO {
  read(url: string): Buffer;
  keys: Readonly<Record<string, string>>;
  host: { target: StandaloneTarget; glibc: string };
}

function verifiedManifest(bytes: Buffer, version: string, io: StandaloneCatalogIO): StandaloneManifest {
  const manifest = StandaloneManifestSchema.parse(verifySignedPayload(bytes, io.keys));
  if (manifest.version !== version) throw new Error("Release manifest version differs from the selected target");
  for (const artifact of manifest.artifacts) {
    if (artifact.url !== `${DISTRIBUTION.repositoryUrl}/releases/download/v${version}/${artifact.filename}`)
      throw new Error("Release artifact is outside the official versioned release");
  }
  return manifest;
}

export function selectStandaloneRelease(channel: ReleaseChannel, requested?: string,
  io: StandaloneCatalogIO = { read: metadata, keys: RELEASE_PUBLIC_KEYS, host: standaloneHost() }): StandaloneSelection {
  let version = requested, expectedHash: string | undefined;
  if (!version) {
    const index = ChannelIndexSchema.parse(verifySignedPayload(io.read(`${DISTRIBUTION.releaseOrigin}/channels/${channel}.json`), io.keys));
    if (index.channel !== channel || index.releaseManifestUrl !== releaseManifestUrl(index.version))
      throw new Error("Release channel identity is invalid");
    version = index.version;
    expectedHash = index.releaseManifestSha256;
  }
  // Parse before interpolating a caller-supplied version into a URL.
  const urlVersion = BundleIdentitySchema.shape.version.parse(version);
  if (channel === "stable" && urlVersion.includes("-")) throw new Error("Stable cannot select a prerelease");
  const manifestUrl = releaseManifestUrl(urlVersion), bytes = io.read(manifestUrl);
  const manifestSha256 = createHash("sha256").update(bytes).digest("hex");
  if (expectedHash && manifestSha256 !== expectedHash) throw new Error("Channel manifest checksum mismatch");
  const manifest = verifiedManifest(bytes, urlVersion, io);
  const artifact = manifest.artifacts.find((entry) => entry.target === io.host.target)!;
  if (!versionAtLeast(io.host.glibc, artifact.minGlibc)) throw new Error(`Standalone requires glibc ${artifact.minGlibc} or newer`);
  return { distribution: "standalone", version: urlVersion, manifestUrl, manifestSha256, artifact };
}

export function verifyStandaloneSelection(value: StandaloneSelection,
  io: StandaloneCatalogIO = { read: metadata, keys: RELEASE_PUBLIC_KEYS, host: standaloneHost() }): StandaloneManifest {
  const selected = StandaloneSelectionSchema.parse(value);
  if (selected.manifestUrl !== releaseManifestUrl(selected.version) || selected.artifact.target !== io.host.target)
    throw new Error("Selected standalone platform or manifest URL is invalid");
  const bytes = io.read(selected.manifestUrl);
  if (createHash("sha256").update(bytes).digest("hex") !== selected.manifestSha256) throw new Error("Pinned release manifest changed");
  const manifest = verifiedManifest(bytes, selected.version, io);
  const artifact = manifest.artifacts.find((entry) => entry.target === selected.artifact.target)!;
  if (JSON.stringify(artifact) !== JSON.stringify(selected.artifact) || !versionAtLeast(io.host.glibc, artifact.minGlibc))
    throw new Error("Pinned release artifact or host requirements changed");
  return manifest;
}

export function verifyStandaloneBundle(root: string, manifest: StandaloneManifest, selected: StandaloneSelection): void {
  const bundle = BundleIdentitySchema.parse(JSON.parse(readFileSync(join(root, "bundle.json"), "utf8")));
  if (bundle.version !== manifest.version || bundle.sourceCommit !== manifest.sourceCommit || bundle.target !== selected.artifact.target ||
      bundle.nodeVersion !== manifest.nodeVersion || bundle.nodeAbi !== manifest.nodeAbi || bundle.minGlibc !== selected.artifact.minGlibc)
    throw new Error("Standalone bundle identity differs from its signed manifest");
  const app = join(root, "app"), node = join(root, "runtime/bin/node");
  const pkg = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
  const info = JSON.parse(readFileSync(join(app, "build-info.json"), "utf8"));
  if (pkg.version !== bundle.version || info.version !== bundle.version || info.sourceCommit !== bundle.sourceCommit || info.dirty !== false)
    throw new Error("Standalone application identity differs from its signed manifest");
  const probe = execFileSync(node, ["--input-type=module", "-e", `
    import { createRequire } from 'node:module';
    const require = createRequire(process.cwd() + '/package.json');
    const Database = require('better-sqlite3'); const db = new Database(':memory:');
    if (db.prepare('select 1 as n').get().n !== 1) throw new Error('SQLite probe failed'); db.close();
    const pty = require('node-pty').spawn('/bin/sh', ['-c', 'printf standalone-ready'], { env: process.env });
    let output = ''; pty.onData(data => output += data);
    const timeout = setTimeout(() => process.exit(1), 5000);
    pty.onExit(({ exitCode }) => { clearTimeout(timeout); if (exitCode || !output.includes('standalone-ready')) process.exit(1);
      console.log(JSON.stringify({ version: process.versions.node, abi: process.versions.modules })); });
  `], { cwd: app, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" } });
  const runtime = JSON.parse(probe.trim());
  if (runtime.version !== bundle.nodeVersion || runtime.abi !== bundle.nodeAbi) throw new Error("Bundled Node identity mismatch");
}

export function stageStandaloneRelease(cfg: InstallConfig, selected: StandaloneSelection): InstallConfig {
  const manifest = verifyStandaloneSelection(selected);
  const releases = join(cfg.dataDir, "releases");
  ensurePrivateDirectory(releases);
  const id = `${selected.version}-${selected.artifact.target}-${selected.artifact.sha256}`;
  const directory = join(releases, id);
  const download = mkdtempSync(join(tmpdir(), "palmagent-download-"));
  const staging = join(releases, `.staging-${randomUUID()}`);
  ensurePrivateDirectory(staging);
  try {
    {
      const archive = join(download, "release.tar.gz");
      execFileSync("curl", ["--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--proto-redir", "=https",
        "--connect-timeout", "10", "--max-time", "600", "--max-filesize", String(selected.artifact.size), "--output", archive, "--url", selected.artifact.url],
      { timeout: 610_000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe"] });
      if (sha256File(archive) !== selected.artifact.sha256) throw new Error("Standalone archive checksum mismatch");
      extractReleaseArchive(archive, staging, selected.artifact.size, selected.artifact.unpackedSize);
      verifyStandaloneBundle(join(staging, "palmagent"), manifest, selected);
      writeFileSync(join(staging, "selection.json"), JSON.stringify(selected) + "\n", { mode: 0o600 });
      if (!existsSync(directory)) renameSync(staging, directory);
      else {
        const tree = (path: string): string => {
          const files: string[] = [];
          const walk = (current: string, relative: string) => {
            const stat = lstatSync(current);
            if (stat.isDirectory()) {
              for (const name of readdirSync(current).sort()) walk(join(current, name), `${relative}/${name}`);
            } else if (stat.isFile()) files.push(`${relative}:${stat.mode & 0o777}:${sha256File(current)}`);
            else throw new Error("Retained standalone bundle contains a link or special file");
          };
          walk(path, ""); return files.join("\n");
        };
        if (tree(join(staging, "palmagent")) !== tree(join(directory, "palmagent")))
          throw new Error("Retained standalone bundle differs from the verified archive");
      const prior = StandaloneSelectionSchema.parse(JSON.parse(readFileSync(join(directory, "selection.json"), "utf8")));
      if (JSON.stringify(prior) !== JSON.stringify(selected)) throw new Error("Retained standalone selection differs");
      verifyStandaloneBundle(join(directory, "palmagent"), manifest, selected);
      }
    }
    const root = join(directory, "palmagent"), pkgDir = join(root, "app");
    const executionNode = pinNode(cfg.dataDir, join(root, "runtime/bin/node"));
    return { ...cfg, distribution: "standalone", artifactId: id, pkgDir, workingDir: pkgDir, executionNode };
  } finally {
    rmSync(download, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}
