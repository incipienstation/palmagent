#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const errors = [];
const fail = (message) => errors.push(message);
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const rootPackage = readJson("package.json");
const version = String(rootPackage.version ?? "");

if (rootPackage.name !== "palmagent")
  fail("root package name must be palmagent");
if (rootPackage.private !== true) fail("root workspace must remain private");
if (!semver.test(version) || version === "0.0.0") {
  fail("root package version must be a releasable SemVer, not 0.0.0");
}

for (const path of [
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/shared/package.json",
]) {
  const pkg = readJson(path);
  if (pkg.private !== true) fail(path + " must remain private");
  if (pkg.version !== "0.0.0")
    fail(path + " must stay at internal version 0.0.0");
}

for (const path of [
  "plugins/claude/.claude-plugin/plugin.json",
  "plugins/codex/plugins/palmagent/.codex-plugin/plugin.json",
]) {
  const plugin = readJson(path);
  if (plugin.version !== version) {
    fail(path + " version must match root version " + version);
  }
}

const tag = process.env.RELEASE_TAG;
if (tag && tag !== "v" + version) {
  fail("RELEASE_TAG must equal v" + version);
}

const expectedChannel = version.includes("-") ? "next" : "latest";
const channel = process.env.RELEASE_CHANNEL;
if (channel && channel !== expectedChannel) {
  fail("RELEASE_CHANNEL must be " + expectedChannel + " for " + version);
}

if (process.argv.includes("--artifact")) {
  const path = "build/pkg/package.json";
  if (!existsSync(join(root, path))) {
    fail(path + " is missing; run pnpm pkg:build first");
  } else {
    const artifact = readJson(path);
    if (artifact.name !== "palmagent")
      fail("artifact package name must be palmagent");
    if (artifact.version !== version)
      fail("artifact version must match root version");
    const expectedPublishable = /^(?:1|true)$/i.test(
      process.env.EXPECT_PUBLISHABLE ?? "",
    );
    if (expectedPublishable && artifact.private === true) {
      fail("candidate artifact is unexpectedly private");
    }
    if (!expectedPublishable && artifact.private !== true) {
      fail("local artifact must remain private unless EXPECT_PUBLISHABLE=1");
    }
  }
}

if (errors.length) {
  console.error("release check failed:");
  for (const error of errors) console.error("  - " + error);
  process.exit(1);
}

console.log(
  "release check passed: version=" +
    version +
    " channel=" +
    expectedChannel +
    (process.argv.includes("--artifact") ? " artifact=checked" : ""),
);
