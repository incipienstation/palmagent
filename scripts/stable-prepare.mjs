#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareVersion } from './release-version.mjs';
import { versionPolicy, compareVersions } from './lib/release-version.mjs';
import { preparationFiles, assertPreparation } from './lib/preview-plan.mjs';
import { releaseBot } from './lib/release-bot.mjs';
import { github, githubPages, registryMetadata } from './lib/release-github.mjs';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Preparation only: CI and reviewed merge rules still own integration. This
// workflow never tags, promotes by direct push, or dispatches publication.
export async function prepareStable(cwd, env, {
  api = github, pages = githubPages, registry = registryMetadata, identity = releaseBot,
  push = (branch) => git(cwd, '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
    'push', 'origin', `HEAD:refs/heads/${branch}`),
} = {}) {
  assert(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REF === 'refs/heads/develop', 'Stable preparation runs only on develop in Actions');
  assert(env.RELEASE_APP_CLIENT_ID && env.GH_TOKEN, 'Stable preparation requires the release App');
  const repository = env.GH_REPO, source = env.RELEASE_COMMIT, version = env.RELEASE_VERSION, phase = env.RELEASE_PHASE;
  assert(/^[\w.-]+\/[\w.-]+$/.test(repository ?? ''), 'Missing repository identity');
  assert(/^[a-f0-9]{40}$/.test(source ?? ''), 'An exact source commit is required');
  assert(['prepare', 'promote'].includes(phase), 'Choose prepare or promote');
  assert(['true', 'false'].includes(env.RELEASE_DRY_RUN), 'Explicit dry-run selection is required');
  assert(versionPolicy(version).channel === 'latest', 'Choose an exact Stable version');
  assert(!git(cwd, 'status', '--porcelain') && git(cwd, 'rev-parse', 'HEAD') === source, 'Source checkout must be clean and match the requested commit');
  const bot = identity(env);
  const develop = () => api(repository, 'git/ref/heads/develop').object.sha;
  assert(develop() === source, 'Develop changed; review its new head before retrying');
  const metadata = await registry();
  assert(!metadata.versions[version], 'Stable version is already published');
  assert(!git(cwd, 'tag', '--list', `v${version}`), 'Stable tag already exists; inspect release recovery');
  const current = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).version;
  const base = phase === 'prepare' ? 'develop' : 'main';
  const branch = phase === 'prepare' ? `feature/stable-${version}` : 'develop';
  const marker = `<!-- palmagent-stable:${JSON.stringify({ phase, source, version })} -->`;
  const existing = pages(repository, `pulls?state=all&base=${base}&head=${repository.split('/')[0]}:${branch}`);
  // Older closed develop->main promotions are normal; a version branch is single use.
  const matches = phase === 'prepare' ? existing : existing.filter((pr) => pr.state === 'open' || pr.body?.includes(marker));
  assert(matches.length <= 1, 'Multiple Stable preparation PRs; inspect before retrying');
  const prior = matches[0];
  if (prior) {
    assert(prior.user.login === bot.login && prior.body?.includes(marker) && !prior.draft
      && prior.state === 'open' && prior.base.ref === base && prior.head.ref === branch
      && prior.head.repo?.full_name === repository, 'Existing PR differs from this release request');
  }
  let head = source;
  if (phase === 'prepare') {
    assert(compareVersions(version, current) > 0, 'Stable preparation must advance the source version');
    // Maintainers review Unreleased before dispatch. Do not invent Stable notes.
    prepareVersion(cwd, version, { apply: true });
    git(cwd, 'add', '--', ...preparationFiles);
    const tree = git(cwd, 'write-tree');
    if (prior) {
      git(cwd, 'fetch', 'origin', `refs/heads/${branch}`);
      head = git(cwd, 'rev-parse', 'FETCH_HEAD');
      assert(head === prior.head.sha && git(cwd, 'rev-parse', `${head}^{tree}`) === tree, 'Retained preparation differs from requested metadata');
      assertPreparation(cwd, source, head, version);
    } else if (env.RELEASE_DRY_RUN === 'false') {
      git(cwd, '-c', `user.name=${bot.login}`, '-c', `user.email=${bot.id}+${bot.login}@users.noreply.github.com`,
        'commit', '-m', `chore(release): prepare ${version}`);
      head = git(cwd, 'rev-parse', 'HEAD');
      assertPreparation(cwd, source, head, version);
      assert(develop() === source, 'Develop changed during preparation; no branch was pushed');
      push(branch);
    }
  } else {
    assert(current === version, 'Promotion source version differs');
    for (const path of preparationFiles.filter((path) => path.endsWith('.json'))) {
      assert(JSON.parse(readFileSync(join(cwd, path))).version === version, 'Promotion versions differ');
    }
    assert(readFileSync(join(cwd, 'CHANGELOG.md'), 'utf8').includes(`\n## ${version}\n`), 'Promotion needs reviewed release notes');
    const main = api(repository, 'git/ref/heads/main').object.sha;
    assert(main !== source, 'Source is already on main');
    git(cwd, 'merge-base', '--is-ancestor', main, source);
    if (prior) assert(prior.head.sha === source, 'Promotion PR head changed');
  }
  const result = { phase, version, source, head, base, branch, mergeMethod: phase === 'prepare' ? 'squash' : 'merge' };
  if (env.RELEASE_DRY_RUN === 'true') return { ...result, action: 'validated' };
  assert(develop() === source, 'Develop changed; review before creating the PR');
  const pr = prior ?? api(repository, 'pulls', { method: 'POST', body: {
    title: phase === 'prepare' ? `chore(release): prepare ${version}` : `chore(release): promote ${version} to main`,
    head: branch, base,
    body: `Prepare Stable ${version} from ${source}. Merge with ${result.mergeMethod} after required CI and review. `
      + `Tagging and publication still wait for the exact candidate's npm-latest approval.\n\n${marker}\n`,
  } });
  return { ...result, action: prior ? 'retained' : 'opened', pr: pr.number, url: pr.html_url };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await prepareStable(resolve(process.argv[2] ?? '.'), process.env);
    console.log(JSON.stringify(result));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `Stable preparation\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n\nNo tag or publication was created.\n`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
