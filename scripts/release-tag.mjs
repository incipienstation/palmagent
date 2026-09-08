#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { versionPolicy } from "./lib/release-version.mjs";

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

export function releaseNotes(cwd, version) {
  const sections = readFileSync(join(cwd, "CHANGELOG.md"), "utf8").split(/^## /m).slice(1);
  const section = sections.find((entry) => entry.split("\n")[0].trim() === version);
  assert(section && section.slice(section.indexOf("\n")).trim(), "CHANGELOG.md needs a nonempty '## <version>' section");
  return "## " + section.trim() + "\n";
}

export function checkTag(cwd, tag, expectedCommit, expectedTagObject) {
  const version = json(join(cwd, "package.json")).version;
  const policy = versionPolicy(version);
  assert(tag === `v${version}`, "Release tag must equal v<root-version>");
  assert(/^[0-9a-f]{40}$/.test(expectedCommit ?? ""), "Expected commit SHA is required");
  const ref = `refs/tags/${tag}`;
  assert(git(cwd, "cat-file", "-t", ref) === "tag", "Release tag must be annotated");
  const tagObject = git(cwd, "rev-parse", ref);
  const commit = git(cwd, "rev-parse", `${ref}^{commit}`);
  assert(commit === expectedCommit && git(cwd, "rev-parse", "HEAD") === commit, "Tag and checkout must match the workflow commit");
  assert(!expectedTagObject || tagObject === expectedTagObject, "Release tag object changed");
  git(cwd, "merge-base", "--is-ancestor", commit, `refs/remotes/origin/${policy.branch}`);
  releaseNotes(cwd, version);
  return { tag, tagObject, commit, ...policy };
}

export function prepareBundle(cwd, directory, identity, runUrl) {
  const filename = `palmagent-${identity.version}.tgz`;
  assert(readdirSync(directory).filter((name) => name.endsWith(".tgz")).join() === filename, "Expected exactly one versioned package tarball");
  const manifest = { ...identity, filename, sha256: hash(join(directory, filename)), runUrl };
  writeFileSync(join(directory, "release.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(directory, "SHA256SUMS"), `${manifest.sha256}  ${filename}\n`);
  writeFileSync(join(directory, "RELEASE_NOTES.md"), releaseNotes(cwd, identity.version)
    + `\nSource commit: \`${identity.commit}\`\n\nValidation: ${runUrl}\n\n`
    + "Publishing this release requests npm publication through the protected channel environment. Host deployment remains a separate operator action.\n");
  return manifest;
}

function gh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  return result;
}

export function createDraft(cwd, directory, env, call = gh) {
  const manifest = json(join(directory, "release.json"));
  const identity = checkTag(cwd, env.RELEASE_TAG, env.RELEASE_COMMIT, manifest.tagObject);
  for (const key of Object.keys(identity)) assert(manifest[key] === identity[key], `Release manifest mismatch: ${key}`);
  const filename = `palmagent-${identity.version}.tgz`;
  assert(manifest.filename === filename, "Unexpected package filename");
  assert(hash(join(directory, filename)) === manifest.sha256, "Package checksum mismatch");
  assert(readFileSync(join(directory, "SHA256SUMS"), "utf8") === `${manifest.sha256}  ${filename}\n`, "Checksum file mismatch");
  assert(/^[\w.-]+\/[\w.-]+$/.test(env.GH_REPO ?? ""), "GH_REPO is required");
  const endpoint = `repos/${env.GH_REPO}`;
  const api = (path, ...options) => {
    const result = call(["api", `${endpoint}/${path}`, ...options]);
    assert(result.status === 0, "GitHub API request failed");
    return JSON.parse(result.stdout);
  };
  const remote = api(`git/ref/tags/${identity.tag}`);
  assert(remote.object.type === "tag" && remote.object.sha === identity.tagObject, "Remote tag changed after validation");
  // The by-tag endpoint only returns published releases. List all pages so that
  // existing drafts also block a rerun, even after many newer releases exist.
  const matchingReleases = () => api("releases?per_page=100", "--paginate", "--slurp")
    .flat().filter((release) => release.tag_name === identity.tag);
  assert(matchingReleases().length === 0, "Release already exists; refusing to overwrite drafts or published assets");
  const assets = [filename, "SHA256SUMS", "release.json"];
  const args = ["release", "create", identity.tag, ...assets.map((name) => join(directory, name)),
    "--repo", env.GH_REPO, "--verify-tag", "--draft", "--latest=false",
    "--title", `Palmagent ${identity.version}`, "--notes-file", join(directory, "RELEASE_NOTES.md")];
  if (identity.channel === "next") args.push("--prerelease");
  assert(call(args).status === 0, "Draft creation failed; inspect any partial draft before retrying");
  const matches = matchingReleases();
  assert(matches.length === 1, "Expected exactly one draft release after creation");
  const [release] = matches;
  assert(release.draft === true && release.tag_name === identity.tag
    && release.prerelease === (identity.channel === "next"), "Draft release metadata mismatch");
  for (const name of assets) {
    assert(release.assets.some((asset) => asset.name === name && asset.size === readFileSync(join(directory, name)).length), "Draft release asset missing or incomplete");
  }
  return release.html_url;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const cwd = process.cwd();
    const env = process.env;
    const command = process.argv[2];
    if (command === "check") {
      const identity = checkTag(cwd, env.RELEASE_TAG, env.RELEASE_COMMIT);
      if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `tag-object=${identity.tagObject}\n`);
      console.log(JSON.stringify(identity));
    } else if (command === "prepare") {
      const identity = checkTag(cwd, env.RELEASE_TAG, env.RELEASE_COMMIT, env.RELEASE_TAG_OBJECT);
      prepareBundle(cwd, resolve("build/release"), identity,
        `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`);
    } else if (command === "draft") {
      console.log(createDraft(cwd, resolve("build/release"), env));
    } else throw new Error("Usage: node scripts/release-tag.mjs check|prepare|draft");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
