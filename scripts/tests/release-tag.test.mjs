import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { checkTag, prepareBundle, createDraft } from "../release-tag.mjs";

function fixture(t, version = "0.1.0-alpha.1") {
  const cwd = mkdtempSync(join(tmpdir(), "palmagent-release-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "Release Test", GIT_COMMITTER_NAME: "Release Test",
      GIT_AUTHOR_EMAIL: "release-test@localhost", GIT_COMMITTER_EMAIL: "release-test@localhost",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
  git("init", "-b", "main");
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(cwd, "CHANGELOG.md"), `# Changelog\n\n## Unreleased\n\nFuture changes.\n\n## ${version}\n\n- Release changes.\n\n## 0.0.1\n\nOld changes.\n`);
  git("add", ".");
  git("commit", "-m", "Release fixture");
  const commit = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", commit);
  git("update-ref", "refs/remotes/origin/develop", commit);
  const tag = `v${version}`;
  git("tag", "-a", tag, "-m", "Release fixture");
  const directory = join(cwd, "bundle");
  mkdirSync(directory);
  return { cwd, git, tag, commit, directory };
}

function bundle(f) {
  const identity = checkTag(f.cwd, f.tag, f.commit);
  writeFileSync(join(f.directory, `palmagent-${identity.version}.tgz`), "synthetic package bytes");
  return prepareBundle(f.cwd, f.directory, identity, "https://example.invalid/validation/1");
}

function fakeGithub(f, manifest, options = {}) {
  const calls = [];
  let created = false;
  const call = (args) => {
    calls.push(args);
    const ok = (value) => ({ status: 0, stdout: JSON.stringify(value) });
    if (args[0] === "release") {
      created = true;
      return { status: 0, stdout: "" };
    }
    if (args[1].includes("git/ref/")) return ok({ object: { type: "tag", sha: options.remoteObject ?? manifest.tagObject } });
    if (options.apiFailure) return { status: 1, stdout: JSON.stringify({ status: 403 }) };
    assert(args.includes("--paginate") && args.includes("--slurp"));
    if (!created) return ok([[], options.existing ? [{ draft: true, tag_name: f.tag }] : []]);
    return ok([[{ draft: true, tag_name: f.tag, prerelease: manifest.channel === "next", html_url: "https://example.invalid/release",
      assets: [manifest.filename, "SHA256SUMS", "release.json"].map((name) => ({ name, size: readFileSync(join(f.directory, name)).length })) }]]);
  };
  return { call, calls };
}

for (const version of ["0.1.0-alpha.1", "0.1.0-beta.2", "0.1.0-rc.3", "0.1.0"]) {
  test(`annotated ${version} creates only a draft with the correct channel and assets`, (t) => {
    const f = fixture(t, version);
    const manifest = bundle(f);
    const notes = readFileSync(join(f.directory, "RELEASE_NOTES.md"), "utf8");
    assert.match(notes, /Release changes/);
    assert.doesNotMatch(notes, /Future changes|Old changes/);
    const fake = fakeGithub(f, manifest);
    createDraft(f.cwd, f.directory, { RELEASE_TAG: f.tag, RELEASE_COMMIT: f.commit, GH_REPO: "example/project" }, fake.call);
    const commands = fake.calls.filter((args) => args[0] === "release");
    assert.equal(commands.length, 1);
    const args = commands[0];
    assert.deepEqual(args.slice(0, 3), ["release", "create", f.tag]);
    for (const option of ["--draft", "--verify-tag", "--latest=false", "--notes-file"]) assert(args.includes(option));
    assert.equal(args.includes("--prerelease"), version.includes("-"));
    assert(!args.includes("--clobber"));
    assert(args.includes(join(f.directory, manifest.filename)));
  });
}

test("rejects lightweight tags", (t) => {
  const f = fixture(t);
  f.git("tag", "-d", f.tag);
  f.git("tag", f.tag);
  assert.throws(() => checkTag(f.cwd, f.tag, f.commit), /annotated/);
});

test("rejects missing tags, mismatched versions and missing workflow identity", (t) => {
  const f = fixture(t);
  assert.throws(() => checkTag(f.cwd, "v9.9.9", f.commit), /root-version/);
  assert.throws(() => checkTag(f.cwd, f.tag), /SHA is required/);
  f.git("tag", "-d", f.tag);
  assert.throws(() => checkTag(f.cwd, f.tag, f.commit));
});

test("rejects tags outside the channel source ancestry", (t) => {
  const f = fixture(t);
  f.git("commit", "--allow-empty", "-m", "Unpromoted work");
  f.git("tag", "-f", "-a", f.tag, "-m", "Unpromoted tag");
  assert.throws(() => checkTag(f.cwd, f.tag, f.git("rev-parse", "HEAD")));
});

test("accepts an older main commit after main advances", (t) => {
  const f = fixture(t, "0.1.0");
  f.git("commit", "--allow-empty", "-m", "Later main commit");
  f.git("update-ref", "refs/remotes/origin/main", f.git("rev-parse", "HEAD"));
  f.git("checkout", "--detach", f.commit);
  assert.equal(checkTag(f.cwd, f.tag, f.commit).commit, f.commit);
});

test("prereleases can originate on develop before main promotion", (t) => {
  const f = fixture(t);
  f.git("commit", "--allow-empty", "-m", "Develop candidate");
  const commit = f.git("rev-parse", "HEAD");
  f.git("update-ref", "refs/remotes/origin/develop", commit);
  f.git("tag", "-f", "-a", f.tag, "-m", "Develop candidate");
  assert.equal(checkTag(f.cwd, f.tag, commit).branch, "develop");
});

test("stable versions cannot be tagged on unpromoted develop work", (t) => {
  const f = fixture(t, "0.1.0");
  f.git("commit", "--allow-empty", "-m", "Not promoted");
  const commit = f.git("rev-parse", "HEAD");
  f.git("update-ref", "refs/remotes/origin/develop", commit);
  f.git("tag", "-f", "-a", f.tag, "-m", "Not promoted");
  assert.throws(() => checkTag(f.cwd, f.tag, commit));
});

test("rejects changed tag objects and a checkout different from the event commit", (t) => {
  const f = fixture(t);
  const identity = checkTag(f.cwd, f.tag, f.commit);
  f.git("tag", "-f", "-a", f.tag, "-m", "Replaced annotation");
  assert.throws(() => checkTag(f.cwd, f.tag, f.commit, identity.tagObject), /object changed/);
  assert.throws(() => checkTag(f.cwd, f.tag, "0".repeat(40)), /workflow commit/);
  f.git("commit", "--allow-empty", "-m", "Different checkout");
  assert.throws(() => checkTag(f.cwd, f.tag, f.commit), /workflow commit/);
});

test("requires version-specific release notes", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\nChanges.\n");
  assert.throws(() => checkTag(f.cwd, f.tag, f.commit), /nonempty/);
});

test("rejects unsupported or noncanonical versions", (t) => {
  const f = fixture(t);
  for (const version of ["01.1.0", "0.1.0-alpha.01", "0.1.0-dev.1", "0.1.0+meta", "0.0.0"]) {
    writeFileSync(join(f.cwd, "package.json"), JSON.stringify({ version }));
    assert.throws(() => checkTag(f.cwd, `v${version}`, f.commit), /Unsupported/);
  }
});

for (const failure of ["existing", "apiFailure", "remoteObject", "checksum", "manifest", "sums"]) {
  test(`draft creation fails closed on ${failure}`, (t) => {
    const f = fixture(t);
    const manifest = bundle(f);
    if (failure === "checksum") writeFileSync(join(f.directory, manifest.filename), "changed bytes");
    if (failure === "manifest") writeFileSync(join(f.directory, "release.json"), JSON.stringify({ ...manifest, commit: "0".repeat(40) }));
    if (failure === "sums") writeFileSync(join(f.directory, "SHA256SUMS"), "changed checksum file");
    const fake = fakeGithub(f, manifest, { [failure]: failure === "remoteObject" ? "0".repeat(40) : true });
    assert.throws(() => createDraft(f.cwd, f.directory, { RELEASE_TAG: f.tag, RELEASE_COMMIT: f.commit, GH_REPO: "example/project" }, fake.call));
    assert.equal(fake.calls.filter((args) => args[0] === "release").length, 0);
  });
}

test("refuses multiple tarballs in the release bundle", (t) => {
  const f = fixture(t);
  const identity = checkTag(f.cwd, f.tag, f.commit);
  writeFileSync(join(f.directory, "extra.tgz"), "unexpected package");
  assert.throws(() => prepareBundle(f.cwd, f.directory, identity, "https://example.invalid/run"), /exactly one/);
});
