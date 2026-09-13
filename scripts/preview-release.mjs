#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareVersions, RELEASE_VERSION, versionPolicy } from './lib/release-version.mjs';
import { productChanges, nextPreviewVersion, preparationFiles, assertPreparation } from './lib/preview-plan.mjs';
import { prepareVersion } from './release-version.mjs';
import { inspectSource, candidateArtifact } from './release-candidate.mjs';
import { ensureReleaseTag } from './release-finalize.mjs';
import { github, githubPages, registryMetadata, registryTarball, delay } from './lib/release-github.mjs';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ancestor = (cwd, a, b) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd, stdio: 'ignore' }).status === 0;
const preview = (version) => RELEASE_VERSION.test(version) && version.includes('-');

export function releaseBot(env, lookup = (login) => JSON.parse(execFileSync('gh', ['api', `users/${login}`], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}))) {
  const app = Boolean(env.RELEASE_APP_CLIENT_ID);
  const slug = app ? env.RELEASE_APP_SLUG : 'github-actions';
  assert(typeof slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug), 'Missing or invalid release App identity');
  assert(app || !env.RELEASE_APP_SLUG, 'Release App identity requires a configured client ID');
  const login = `${slug}[bot]`;
  const bot = lookup(login);
  assert(bot.type === 'Bot' && bot.login === login && Number.isSafeInteger(bot.id) && bot.id > 0,
    'Unexpected release bot identity');
  return bot;
}

export function preparationMarker(pr) {
  const match = /<!-- palmagent-preview:(\{[^\n]+\}) -->/.exec(pr.body ?? '');
  if (!match) return null;
  const value = JSON.parse(match[1]);
  assert(preview(value.version) && /^[a-f0-9]{40}$/.test(value.source ?? ''), 'Invalid Preview preparation marker');
  return value;
}

export async function successfulPreview(cwd, releases, registry, { manifest, tarball = registryTarball } = {}) {
  const candidates = releases.filter((release) => !release.draft && release.prerelease && preview(release.tag_name.slice(1)))
    .sort((a, b) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)));
  for (const release of candidates) {
    const version = release.tag_name.slice(1);
    const pkg = registry.versions[version];
    if (!pkg) continue; // A public legacy draft may precede a failed npm upload.
    const receipt = await manifest(release);
    assert(receipt.version === version && receipt.tag === release.tag_name && receipt.channel === 'next' && receipt.branch === 'develop', 'Published Preview metadata differs from its release');
    assert(git(cwd, 'cat-file', '-t', receipt.tag) === 'tag'
      && git(cwd, 'rev-parse', receipt.tag) === receipt.tagObject
      && git(cwd, 'rev-parse', `${receipt.tag}^{commit}`) === receipt.commit, 'Published Preview tag identity differs');
    const bytes = await tarball(pkg);
    assert(createHash('sha256').update(bytes).digest('hex') === receipt.sha256
      && `sha512-${createHash('sha512').update(bytes).digest('base64')}` === pkg.dist.integrity, 'Published Preview bytes differ from its release');
    return receipt;
  }
  return null;
}

export function planPreview(cwd, source, baseline, registry, tags) {
  const changes = productChanges(cwd, baseline?.commit ?? null, source);
  if (!changes.length) return { action: 'skip', reason: 'No product changes since the last successful Preview', source };
  let current = JSON.parse(git(cwd, 'show', `${source}:package.json`)).version;
  versionPolicy(current);
  if (!preview(current)) {
    if (!registry.versions[current]) return { action: 'skip', reason: 'Stable preparation is in progress; its version is not published yet', source };
    const [major, minor, patch] = current.split('.').map(Number);
    assert(Number.isSafeInteger(patch + 1), 'Version sequence exhausted');
    current = `${major}.${minor}.${patch + 1}-alpha.1`;
  }
  const version = nextPreviewVersion(current, [...Object.keys(registry.versions), ...tags]);
  return { action: 'prepare', source, version, changes };
}

export function addMaintenanceNotes(cwd, repository, baseline, source) {
  const path = join(cwd, 'CHANGELOG.md');
  const content = readFileSync(path, 'utf8');
  const section = /^## Unreleased\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(content);
  assert(section, 'CHANGELOG.md needs an Unreleased section');
  if (section[1].trim()) return;
  const link = baseline ? `https://github.com/${repository}/compare/${baseline.commit}...${source}`
    : `https://github.com/${repository}/tree/${source}`;
  const notes = `### Changed\n\n- Product maintenance update. See the [source changes](${link}) for details.\n\n`;
  writeFileSync(path, content.replace(section[0], `## Unreleased\n\n${notes}`));
}

export async function waitForPublication(repository, commit, { api = github, pages = githubPages, sleep = delay, timeoutMs = 30 * 60 * 1000 } = {}) {
  const title = `Publish ${commit}`;
  const runs = () => pages(repository, 'actions/workflows/npm-publish.yml/runs?event=workflow_dispatch&branch=develop', 'workflow_runs')
    .filter((run) => run.display_title === title).sort((a, b) => b.id - a.id);
  let run = runs()[0];
  if (!run || run.status === 'completed' && run.conclusion !== 'success') {
    let candidateRun = '';
    // A failure after candidate upload must reuse that artifact, including a partial npm upload.
    if (run) {
      const artifacts = pages(repository, `actions/runs/${run.id}/artifacts`, 'artifacts');
      if (artifacts.some((artifact) => artifact.name === `palmagent-candidate-${commit}`)) {
        candidateArtifact(commit, run.id, repository, { reuse: true, api, pages });
        candidateRun = String(run.id);
      } else {
        // A recovery run can have reused an older producer. Recover it from the named artifact
        // in an earlier run; never replace already uploaded candidate bytes with a rebuild.
        for (const earlier of runs().slice(1)) {
          const assets = pages(repository, `actions/runs/${earlier.id}/artifacts`, 'artifacts');
          if (!assets.some((artifact) => artifact.name === `palmagent-candidate-${commit}`)) continue;
          candidateArtifact(commit, earlier.id, repository, { reuse: true, api, pages });
          candidateRun = String(earlier.id); break;
        }
      }
    }
    const previousId = run?.id ?? 0;
    api(repository, 'actions/workflows/npm-publish.yml/dispatches', { method: 'POST', body: {
      ref: 'develop', inputs: { commit, candidate_run: candidateRun },
    } });
    const deadline = Date.now() + 60000;
    do {
      await sleep(3000);
      run = runs().find((candidate) => candidate.id > previousId);
    } while (!run && Date.now() < deadline);
    assert(run, 'Publication dispatch is not visible; inspect Actions before retrying');
  }
  const deadline = Date.now() + timeoutMs;
  while (run.status !== 'completed' && Date.now() < deadline) {
    await sleep(15000);
    run = api(repository, `actions/runs/${run.id}`);
  }
  assert(run.status === 'completed' && run.conclusion === 'success', `Publication did not succeed: ${run.html_url}`);
  return run;
}

export async function preparationValidation(repository, pr, expectedHead, { pages = githubPages, sleep = delay } = {}) {
  const deadline = Date.now() + 60000;
  do {
    const runs = pages(repository, 'actions/workflows/ci.yml/runs?event=pull_request', 'workflow_runs')
      .filter((run) => run.head_sha === expectedHead && run.pull_requests?.some((item) => item.number === pr.number))
      .sort((a, b) => b.id - a.id);
    if (runs.length) return runs[0].id;
    await sleep(3000);
  } while (Date.now() < deadline);
  throw new Error('Preparation PR CI is not visible; inspect Actions before retrying');
}

export function assertPreparationRun(run, repository, branch, expectedHead) {
  assert(run.repository?.full_name === repository && run.path === '.github/workflows/ci.yml'
    && run.event === 'pull_request' && run.head_branch === branch && run.head_sha === expectedHead,
  'Preparation CI identity differs from the selected PR');
}

export async function mergePreparation(cwd, repository, pr, expectedHead, source, { api = github, pages = githubPages, sleep = delay, validation = preparationValidation } = {}) {
  let runId, approvalReported = false;
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    const current = api(repository, `pulls/${pr.number}`);
    assert(current.head.sha === expectedHead && current.base.ref === 'develop', 'Preparation PR identity changed');
    if (current.merged) return current.merge_commit_sha;
    assert(current.state === 'open' && !current.draft, 'Preparation PR was closed or held as a draft');
    const head = api(repository, 'git/ref/heads/develop').object.sha;
    if (head !== source) return null; // Reprepare the same owned branch against the newer source.
    runId ??= await validation(repository, current, expectedHead, { api, pages, sleep });
    const run = api(repository, `actions/runs/${runId}`);
    assertPreparationRun(run, repository, current.head.ref, expectedHead);
    if (run.conclusion === 'action_required' && !approvalReported) {
      console.log(`Preparation CI needs maintainer approval: ${run.html_url}`);
      approvalReported = true;
    }
    assert(run.status !== 'completed' || ['success', 'action_required'].includes(run.conclusion), 'Preparation CI failed; inspect its run');
    if (run.status === 'completed' && run.conclusion === 'success' && current.mergeable) {
      const jobs = pages(repository, `actions/runs/${runId}/jobs?filter=latest`, 'jobs');
      const validate = jobs.filter((job) => job.name === 'validate');
      assert(validate.length === 1 && validate[0].head_sha === expectedHead && validate[0].status === 'completed'
        && validate[0].conclusion === 'success', 'Preparation CI has no successful validate job on the selected head');
      try {
        api(repository, `pulls/${pr.number}/merge`, { method: 'PUT', body: { sha: expectedHead, merge_method: 'squash' } });
      } catch (error) {
        const result = api(repository, `pulls/${pr.number}`);
        if (result.merged && result.head.sha === expectedHead) return result.merge_commit_sha;
        if (api(repository, 'git/ref/heads/develop').object.sha !== source) return null;
        throw error; // Never bypass protections or a review hold.
      }
      const result = api(repository, `pulls/${pr.number}`);
      assert(result.merged && result.head.sha === expectedHead, 'Preparation merge was not confirmed');
      return result.merge_commit_sha;
    }
    await sleep(15000);
  }
  throw new Error('Preparation CI or review requirements did not finish; approve the retained PR workflow if required, then resume Preview');
}

async function prepare(cwd, repository, baseline, registry, tags, bot) {
  let pr, version;
  for (let attempt = 0; attempt < 6; attempt++) {
    git(cwd, 'fetch', 'origin', 'develop', '--tags');
    const source = git(cwd, 'rev-parse', 'origin/develop');
    git(cwd, 'checkout', '--detach', source);
    const plan = planPreview(cwd, source, baseline, registry, tags);
    if (plan.action === 'skip') return plan;
    version ??= plan.version;
    const branch = `feature/preview-${version}`;
    const matches = githubPages(repository, `pulls?state=all&base=develop&head=${repository.split('/')[0]}:${branch}`);
    assert(matches.length <= 1, 'Multiple preparation PRs for a version');
    pr = matches[0];
    let oldHead;
    if (pr) {
      assert(pr.user.login === bot.login && pr.state === 'open' && !pr.draft, 'Existing preparation is not an open task-owned PR');
      const marker = preparationMarker(pr);
      assert(marker?.version === version && pr.head.ref === branch, 'Existing preparation marker differs');
      git(cwd, 'fetch', 'origin', `refs/heads/${branch}`);
      oldHead = git(cwd, 'rev-parse', 'FETCH_HEAD');
      assert(oldHead === pr.head.sha, 'Preparation branch changed');
      assertPreparation(cwd, marker.source, oldHead, version);
      if (marker.source === source) {
        const merged = await mergePreparation(cwd, repository, pr, oldHead, source);
        if (merged) return { action: 'publish', commit: merged, version };
        continue;
      }
    }
    addMaintenanceNotes(cwd, repository, baseline, source);
    prepareVersion(cwd, version, { apply: true });
    git(cwd, 'add', '--', ...preparationFiles);
    git(cwd, '-c', `user.name=${bot.login}`, '-c', `user.email=${bot.id}+${bot.login}@users.noreply.github.com`, 'commit', '-m', `chore(release): prepare ${version}`);
    const head = git(cwd, 'rev-parse', 'HEAD');
    assertPreparation(cwd, source, head, version);
    git(cwd, '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push',
      ...(oldHead ? [`--force-with-lease=refs/heads/${branch}:${oldHead}`] : []), 'origin', `HEAD:refs/heads/${branch}`);
    const body = `Prepare Preview ${version} from ${source}. This PR changes only product versions and release notes. Required CI and develop protections apply.\n\n<!-- palmagent-preview:${JSON.stringify({ source, version })} -->\n`;
    pr = pr ? github(repository, `pulls/${pr.number}`, { method: 'PATCH', body: { body } })
      : github(repository, 'pulls', { method: 'POST', body: { title: `chore(release): prepare ${version}`, head: branch, base: 'develop', body } });
    const merged = await mergePreparation(cwd, repository, pr, head, source);
    if (merged) {
      git(cwd, 'fetch', 'origin', 'develop');
      assert(git(cwd, 'rev-parse', `${merged}^{tree}`) === git(cwd, 'rev-parse', `${head}^{tree}`), 'Merged preparation differs from its verified tree');
      return { action: 'publish', commit: merged, version };
    }
  }
  throw new Error('Develop kept advancing; the next queued Preview run can resume the retained preparation PR');
}

export async function runPreview(cwd, env) {
  assert(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REF === 'refs/heads/develop', 'Preview automation runs only on develop in Actions');
  assert(env.PREVIEW_RELEASE_ENABLED === 'true', 'Automatic Preview is not enabled');
  assert(env.GH_TOKEN, 'Missing release GitHub token');
  assert(/^[\w.-]+\/[\w.-]+$/.test(env.GH_REPO ?? ''), 'Missing repository identity');
  assert(!git(cwd, 'status', '--porcelain'), 'Preview source checkout must be clean');
  const repository = env.GH_REPO;
  const bot = releaseBot(env);
  git(cwd, 'fetch', 'origin', 'develop', '--tags');
  const source = git(cwd, 'rev-parse', 'origin/develop');
  const registry = await registryMetadata();
  const releases = githubPages(repository, 'releases');
  const baseline = await successfulPreview(cwd, releases, registry, {
    manifest: (release) => {
      const assets = release.assets.filter((asset) => asset.name === 'release.json');
      assert(assets.length === 1, 'Published Preview has no unique release receipt');
      return JSON.parse(github(repository, `releases/assets/${assets[0].id}`, { binary: true }).toString());
    },
  });
  const tags = git(cwd, 'tag', '--list', 'v*').split('\n').filter(Boolean);
  // Resume a merged preparation or tag before allocating a new version. A queued push may
  // include newer product changes, which remain unconsumed until a subsequent release.
  const pending = tags.filter((tag) => preview(tag.slice(1)) && (!baseline || compareVersions(tag.slice(1), baseline.version) > 0))
    .map((tag) => ({ version: tag.slice(1), commit: git(cwd, 'rev-parse', `${tag}^{commit}`) }));
  for (const pr of githubPages(repository, 'pulls?state=closed&base=develop')) {
    if (!pr.merged_at || pr.user.login !== bot.login || !pr.head.ref.startsWith('feature/preview-')) continue;
    const marker = preparationMarker(pr);
    if (marker && (!baseline || compareVersions(marker.version, baseline.version) > 0)) pending.push({ version: marker.version, commit: pr.merge_commit_sha });
  }
  const resume = pending.filter((item) => ancestor(cwd, item.commit, source)).sort((a, b) => compareVersions(a.version, b.version))[0];
  let plan = resume ? { action: 'publish', ...resume } : await prepare(cwd, repository, baseline, registry, tags, bot);
  if (plan.action === 'skip') return plan;
  git(cwd, 'fetch', 'origin', 'develop');
  git(cwd, 'checkout', '--detach', plan.commit);
  const identity = inspectSource(cwd, plan.commit);
  assert(identity.channel === 'next' && identity.version === plan.version, 'Preview source version or channel differs');
  ensureReleaseTag(cwd, identity, (path, options) => github(repository, path, options));
  const run = await waitForPublication(repository, plan.commit);
  const result = { ...plan, runUrl: run.html_url };
  // A resumed release can predate already-merged changes. Explicitly queue another comparison;
  // bot-created push events are not relied on as the only recovery mechanism.
  git(cwd, 'fetch', 'origin', 'develop');
  const latest = git(cwd, 'rev-parse', 'origin/develop');
  if (productChanges(cwd, plan.commit, latest).length) github(repository, 'actions/workflows/preview-release.yml/dispatches', {
    method: 'POST', body: { ref: 'develop' },
  });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runPreview(resolve(process.argv[2] ?? '.'), process.env);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Preview result\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`);
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
